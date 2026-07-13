# OMP Compliance 扩展：监督、触发与验证增强设计

## 概要

为 `@bearmaxdd/omp-compliance` 扩展三层能力，使 Advisor 从被动响应变为主动监管。

- **第 1 层**：上游补丁——类型化 trigger 透传，让 Advisor 知道"为什么被触发"
- **第 2 层**：TriggerRegistry + Dispatcher——标准化多触发源管理，统一调度
- **第 3 层**：监督门禁——review 前注入规则、review 中实时巡检、review 前完成验证

---

## 第 1 层：上游 OMP 补丁

### 改动文件

| 文件 | 改动 |
|------|------|
| `extensibility/extensions/types.ts` | `AdvisorRunTrigger` 扩展为联合类型；`AdvisorReviewRequest` 增加 `trigger` 字段 |
| `advisor/runtime.ts` | `requestReview` 签名从 `trigger: "compliance_review"` → `trigger: AdvisorRunTrigger`；硬编码标题 `### Compliance review` → `### ${trigger} review` |
| `session/agent-session.ts` | 路由从硬编码改为透传 + fallback + 未知 trigger 告警 |
| `transcript-recorder.ts` | 持久化真实 trigger；新增事件类型 `advisor_review_triggered` |
| `runner.ts` | `advisor_before_run` 传递真实 trigger |

### 类型定义

```typescript
// extensibility/extensions/types.ts（单一权威来源）
export type AdvisorRunTrigger =
  | "turn_end"
  | "compliance_review"
  | "impact_analysis"    // 新增：影响分析
  | "git_pre_push"
  | "file_change"
  | "scheduled"
  | "manual_review";

export type AdvisorReviewRequestTrigger =
  Exclude<AdvisorRunTrigger, "turn_end">;

export interface AdvisorReviewRequest {
  reviewId: string;
  trigger?: AdvisorReviewRequestTrigger;
  metadata?: Record<string, unknown>;
}
```

`advisor/runtime.ts` `import type { AdvisorRunTrigger }` 从此处导入。CI 添加类型一致性测试。

### 路由逻辑

```typescript
// agent-session.ts
import { isKnownReviewTrigger, FALLBACK_TRIGGER } from "./trigger-registry";

const { trigger, ...rest } = request;
const resolvedTrigger = trigger !== undefined && isKnownReviewTrigger(trigger)
  ? trigger
  : FALLBACK_TRIGGER;

if (trigger !== undefined && !isKnownReviewTrigger(trigger)) {
  logger.warn(`Unknown trigger "${trigger}", falling back to ${FALLBACK_TRIGGER}`);
}

// 透传 fallback 元数据，由扩展自行落盘
return advisors[0].runtime.requestReview({
  trigger: resolvedTrigger,
  ...rest,
  metadata: {
    ...rest.metadata,
    ...(trigger !== undefined && !isKnownReviewTrigger(trigger)
      ? { originalTrigger: trigger, triggerFallback: true }
      : {}),
  },
});
```

```typescript
// advisor/runtime.ts —— 标记 OMP-CUSTOM-PATCH
const title = `### ${trigger} review`;
```

### 向后兼容

- 未传 `trigger` → `"compliance_review"`（行为不变）
- 传入未知值 → fallback + 告警 + `events.jsonl` 记录（不静默）
- Agent Hub：新 `trigger` 字段向后兼容，旧记录没有该字段

---

## 第 2 层：TriggerRegistry + Dispatcher

### 架构

```
producer  →  TriggerEvent  →  Dispatcher  →  AdvisorRuntime
                    ↑              │
               BackpressureQueue ←─┤
                    │              └→ 上下文注入 → 信封注册
               storagePath
               (.omp/compliance/queue/)

config  →  TriggerRegistry
              ├─ GitPrePushProducer
              ├─ FileWatchProducer
              ├─ ScheduledProducer
              └─ ManualProducer
```

### TriggerEvent

```typescript
export interface TriggerEvent {
  trigger: AdvisorReviewRequestTrigger;
  reviewKind: "compliance" | "brainstorm" | "supervision" | "impact_analysis";
  body: Record<string, unknown>;
  meta: {
    source: string;       // "git_hook" | "watcher" | "cron" | "cli"
    sessionId?: string;
    timestamp: string;
  };
}
```

### TriggerProducer 接口

```typescript
export interface TriggerProducer {
  readonly trigger: AdvisorReviewRequestTrigger;
  readonly label: string;
  start(): void;
  stop(): void;
  on(event: "produce", handler: (evt: TriggerEvent) => void): void;
}
```

### 内置 Producer

| Producer | 触发值 | 启动方式 | 去抖 |
|----------|--------|----------|------|
| `GitPrePushProducer` | `git_pre_push` | 外部 CLI 调用 | 无 |
| `FileWatchProducer` | `file_change` | `fs.watch` 递归监听 | 300ms 合并窗口 |
| `ScheduledProducer` | `scheduled` | `setInterval` / cron | 无 |
| `ManualProducer` | `manual_review` | CLI 调用或 tool | 无 |

### Git hook 桥接

使用 CLI 命令跨进程通信：

```bash
omp compliance trigger \
  --trigger git_pre_push \
  --payload '{"branch":"main","commit_range":"HEAD~3..HEAD"}'
```

退出码：0=通过（允许 push）、1=发现问题（阻断 push）、2=超时或不可用（允许 push，记录告警）。

扩展不自动管理 `.git/hooks/`，用户手动写入或 `--install-hook` 生成。

### Dispatcher

```typescript
export interface DispatcherConfig {
  queue: BackpressureQueue;
  contextInjector: ContextInjector;
  envelopeRegistry: EnvelopeRegistry;
  requestReview: (req: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
}
```

**流程**：

1. 接收 TriggerEvent
2. 去重检测：同 trigger + 同 payload hash 在 N 秒内丢弃
3. 入队：写入持久化队列
4. 并发控制：同 trigger 类型一次只能一个 in-flight
5. 出队：注入来源上下文 → 注册信封 → `requestAdvisorReview({ trigger, reviewId, metadata })`

### 背压队列

```typescript
interface BackpressureQueueConfig {
  maxSize: number;          // 上限 100
  storagePath: string;      // .omp/compliance/queue/
  perProducerQuota: number; // 单 producer 上限 20
  restartRecovery: boolean; // 重启后恢复
}
```

- 队列未满 → 写入 + 触发
- 队列已满 → `produce()` 返回 `rejected`
- 磁盘写入失败 → 丢弃 + 告警（不阻塞 producer）
- 重启 → 扫描 `storagePath` 重入 Dispatcher

### TODO 完成状态的权威来源

"所有 todo 完成后执行冒烟测试" 的**权威完成标记**来自 writing-plans：

```typescript
export interface PlanCompletionSignal {
  planId: string;
  allTodosCompleted: boolean;
  completedAt: string;
  pendingTodoCount: number;
}
```

**工作流**：

```
writing-plans 创建计划 → PlanRun 开始执行
  → 每个 todo 完成时更新 PlanRun 状态
    → 最后一个 todo 后 PlanRun 触发 completion_requested
      → 扩展监听到 → 冒烟测试 → 写证据 → compliance_review
```

扩展注册 `turn_end` 监听器检查 PlanRun 状态。如果不可用，回退到 `compliance_complete` 的 `claimed_verification`。

### 文件新增

```
src/triggers/
├── producer.ts
├── dispatcher.ts
├── registry.ts
├── backpressure-queue.ts
├── context-injector.ts
└── producers/
    ├── git-pre-push.ts
    ├── file-watch.ts
    ├── scheduled.ts
    └── manual.ts
```

---

## 第 3 层：监督门禁 + 验证管道

### 两阶段完成流程

Advisor 默认工具集只有 `read/grep/glob`（`advise-tool.ts:145`）。`trace_path`/`search_graph` 必须在 WATCHDOG `tools` 中显式授权且实际存在。若不满足，`impact_analysis` 阶段不可用，返回 `impact_unavailable`。

```
requestCompletion()
  │
  ├── Phase 1: Impact Analysis（可跳过）
  │   ├── 能力预检：WATCHDOG tools 是否包含 trace_path/search_graph
  │   │   ├── 否 → impact_unavailable，跳过
  │   └── 执行 suggestedCommands（ImpactCommand[]，经安全校验）
  │
  ├── Phase 2: Completion Review
  │   ├── 冒烟测试（预定义命令）
  │   ├── 影响测试结果（Phase 1 产出，如有）
  │   ├── 证据合并到 EvidenceSnapshot
  │   └── 冻结 snapshot → requestAdvisorReview → verdict
```

### ImpactPlan 结构

禁止 Advisor 直接输出字符串命令——模型输出可能导致命令注入。改为结构化命令描述 + schema 校验：

```typescript
export interface ImpactPlan {
  schema_version: 1;
  affectedModules: Array<{ path: string; confidence: "high" | "medium" | "low" }>;
  affectedTests: string[];
  suggestedCommands: ImpactCommand[];
}

export interface ImpactCommand {
  executable: string;       // 白名单校验：仅允许 "bun" | "npm" | "node" | "bash"
  args: string[];           // 参数数组，不含可执行文件
  cwd: string;              // 必须为仓库内相对路径，禁止 ".."
  timeoutMs?: number;       // 超时上限 60000
}
```

**执行安全策略**：

```typescript
const ALLOWED_EXECUTABLES = new Set(["bun", "npm", "node", "bash"]);
const SAFE_CWD_PATTERN = /^[a-zA-Z0-9_\/-]+$/;

function validateCommand(cmd: ImpactCommand): void {
  if (!ALLOWED_EXECUTABLES.has(cmd.executable)) {
    throw new Error(`Unsafe executable: ${cmd.executable}`);
  }
  if (!SAFE_CWD_PATTERN.test(cmd.cwd)) {
    throw new Error(`Unsafe cwd: ${cmd.cwd}`);
  }
}
```

执行环境限制：超时上限 60s、输出截断 1 MB、环境变量清理（仅保留 `PATH`）。
  beforeReview?(input: {
    trigger: AdvisorReviewRequestTrigger;
    reviewKind: string;
  }): AdditionalContext | undefined;

  onToolResult?(event: ToolResultEvent): SupervisionFinding | undefined;
}
```

| Detector | hook 点 | 检测逻辑 | 告警方式 |
|----------|---------|----------|---------|
| Code Write Detector | `onToolResult` | Advisor 调 `write`/`edit`（只应审查） | `advise(concern)` + 写证据 |
| Slow Review Detector | `onToolResult` | 单条 advise 超 60s | `advise(nit)` + 写证据 |
| Repeat Advise Detector | `onToolResult` | 同内容重复 3+ 次 | 截断 + 写证据 |

### 告警路由（双写）

```typescript
// events.jsonl：按 trigger 分类的独立事件日志（非任务 EvidenceStore）
writeTriggerEvent("supervision_finding", {
  findingId, trigger, detector, severity, message, timestamp
});

// 主代理：去重 + 限频
// 同一 findingId 在 N 秒内只 advise() 一次，severity 升级不受限频
if (dedupe.shouldSend(findingId, severity)) {
  tool.advise({ severity, message });
}
```

### 文件新增

```
src/supervision/
├── hook.ts
├── engine.ts
├── smoke-test.ts
├── detectors/
│   ├── code-write-detector.ts
│   ├── slow-review-detector.ts
│   └── repeat-advise-detector.ts
└── hooks/
    └── review-augmentor.ts
```

---

## 第 4 层：实时状态面板

让开发者在终端中一眼看到 Advisor 的完整运行状态。

### 面板设计

```
┌─ Advisor Status ───────────────────────────────────────────┐
│ 运行时: ● Active       当前: compliance review (task-42)    │
│ 进度:    analyzing evidence (3/5)  耗时: 12s               │
│ ── 活动通道 ────────────────────────────────────────────── │
│ 子代理: 2 running  │  MCP 调用: 7次  │ 建议: 1⛔ 3⚠      │
│ ── 合规任务 ────────────────────────────────────────────── │
│ task-42 ● active  │  尝试:2  │  最后判决: remediate      │
│ ── 大脑风暴 ────────────────────────────────────────────── │
│ 1 topic pending review  (architecture)                    │
└────────────────────────────────────────────────────────────┘
```

### 5 个信息维度的数据来源

| 维度 | 数据来源 | 采集方式 |
|------|----------|----------|
| **运行时状态** | `AdvisorRuntime`（是否 active、当前 reviewId、trigger 类型） | 监听 `advisor_before_run` + `advisor_after_run` 事件 |
| **当前进度** | Advisor 转录中的 tool_call 计数 + emission guard 统计 | `CollectorRuntime` 过滤 advisor 会话的事件 |
| **子代理活动** | Advisor 会话的 `task` tool 调用 | 通过 sessionId 过滤 `tool_call` → `toolName === "task"` |
| **MCP 调用** | Advisor 会话的所有 tool_call | `CollectorRuntime` 按 sessionId 分发 |
| **建议摘要** | `EmissionGuard` 统计 + `AdviseTool` 拦截点 | 监听 advise 调用，按 severity 计数 |
| **合规任务** | `ComplianceRuntime.taskState` | 直接从运行时读取 |
| **大脑风暴** | `TopicCoordinator.current()` | 直接从协调器读取 |

### StatusCollector

```typescript
// src/status/status-collector.ts
export class StatusCollector {
  // 从多个源聚合快照
  snapshot(): StatusSnapshot {
    return {
      runtime: this.collectRuntimeState(),
      advisorSession: this.collectAdvisorSession(),
      subagents: this.collectSubagentActivity(),
      mcpCalls: this.collectMCPCalls(),
      advice: this.collectAdviceSummary(),
      compliance: this.collectComplianceState(),
      brainstorm: this.collectBrainstormState(),
    };
  }

  // 实时增量（用于状态栏的脉冲更新）
  onToolCall(event): void { /* 更新 MCP 计数 */ }
  onAdvisorRunStart(event): void { /* 更新运行时状态 */ }
  onAdvise(severity, message): void { /* 更新建议摘要 */ }
}
```

### StatusSnapshot 类型

```typescript
export interface StatusSnapshot {
  runtime: {
    state: "active" | "idle";
    currentReview?: { reviewId: string; trigger: string; elapsed: number };
    progress?: { current: number; total: number; phase: string };
  };
  advisorSession: {
    subagentCount: number;
    subagentIds: string[];
    mcpCallCount: number;
    lastToolCalls: Array<{ toolName: string; timestamp: string }>;
  };
  advice: {
    blockers: number;
    concerns: number;
    nits: number;
    lastAdvice?: { severity: string; message: string; timestamp: string };
  };
  compliance: {
    active: boolean;
    taskId?: string;
    status?: string;
    attempt: number;
    lastVerdict?: string;
  };
  brainstorm: {
    active: boolean;
    topicId?: string;
    status?: string;
    topicKind?: string;
  };
}
```

### 显示方式

两种显示模式：

#### 1. CLI 快照命令

```bash
# 一次性抓取当前状态
/advisor status
# 或 CLI
omp advisor status
```

输出终端表格或上述面板格式。

#### 2. 实时状态栏（可选增强）

在 OMP 终端底部显示一个固定状态栏，每秒更新。依赖 OMP 的 TUI 框架（需上游支持）。

### 文件新增

```
src/status/
├── status-collector.ts    # 多源聚合器
├── snapshot.ts            # StatusSnapshot 类型 + 构建
├── cli-renderer.ts        # 终端输出渲染
└── tui-renderer.ts        # TUI 状态栏渲染（可选）
```

### extension.ts 集成

```typescript
const statusCollector = new StatusCollector();

api.on("advisor_before_run", (e) => statusCollector.onAdvisorRunStart(e));
api.on("tool_call", (e) => statusCollector.onToolCall(e));
api.on("turn_end", () => statusCollector.onTurnEnd());

// 注册查询命令
api.registerCommand("advisor", {
  handler: async (args) => {
    const snapshot = statusCollector.snapshot();
    console.log(renderCLIStatus(snapshot));
  }
});
```

### 测试覆盖

| 测试 | 数 | 内容 |
|------|----|------|
| StatusSnapshot 构建 | 3 | 各维度数据正确聚合 |
| CLI 渲染 | 2 | 文本输出格式、空状态处理 |
| 事件监听集成 | 4 | onToolCall/onAdvisorRunStart 增量更新正确 |

---

## 与现有系统的集成

### compliance-runtime.ts 改动

```typescript
async requestCompletion(params) {
  // Phase 1: Impact Analysis（可选）
  if (this.canRunImpactAnalysis()) {
    const impactPlan = await this.requestImpactReview();
    if (impactPlan.status === "available") {
      await this.executeImpactCommands(impactPlan.suggestedCommands);
    }
  }

  // Phase 2: 冒烟测试
  const smokeResults = await this.runSmokeTests(config.smokeTests);

  // 现有逻辑
  const snapshot = buildCompletionSnapshot({
    ...this.taskState,
    smokeTestResults: smokeResults,
    impactTestResults: impactResults,
  });
  // ... requestAdvisorReview
}
```

### extension.ts 改动

```typescript
export default function activate(api) {
  // ... 现有初始化

  // 新增：TriggerRegistry
  const triggerRegistry = new TriggerRegistry(dispatcher);
  triggerRegistry.register(new GitPrePushProducer());
  triggerRegistry.register(new FileWatchProducer());
  triggerRegistry.register(new ScheduledProducer());

  // 新增：监督引擎
  const supervision = new SupervisionEngine();
  supervision.register(new CodeWriteDetector());
  supervision.register(new SlowReviewDetector());
  supervision.register(new RepeatAdviseDetector());

  api.on("activate", () => triggerRegistry.startAll());
  api.on("deactivate", () => triggerRegistry.stopAll());
}
```

---

## 配置

`.omp/compliance.yml`：

```yaml
triggers:
  file_watch:
    enabled: false
    paths: ["src/"]
    debounce_ms: 300
  scheduled:
    enabled: false
    cron: "0 6 * * 1"
  git_pre_push:
    enabled: false
    auto_install_hook: false

supervision:
  smoke_tests:
    - command: "bun test src/unit"
      timeout_ms: 30000
  detectors:
    code_write:
      enabled: true
      severity: concern
    slow_review:
      enabled: true
      threshold_ms: 60000
    repeat_advise:
      enabled: true
      max_repeats: 3

impact_analysis:
  enabled: false
  required_tools: ["search_graph", "trace_path", "get_code_snippet"]

backpressure:
  max_queue_size: 100
  per_producer_quota: 20
```

---

## 影响范围

### 新增文件

```
src/triggers/          (7 files)
src/supervision/       (6 files)
```

### 修改文件

| 文件 | 范围 |
|------|------|
| `src/extension.ts` | TriggerRegistry + SupervisionEngine 初始化 |
| `src/runtime/compliance-runtime.ts` | 两阶段 requestCompletion |
| `src/types.ts` | 同步上游类型（impact_analysis 等） |

### 依赖增加

无。`trace_path`/`search_graph` 需在 WATCHDOG `tools` 中显式授权，不满足时 `impact_analysis` 不可用。

### 测试范围

| 测试类别 | 数 | 内容 |
|----------|----|------|
| 上游补丁契约 | 6 | 类型透传、fallback、未知 trigger、标题 |
| TriggerRegistry | 5 | 生命周期、event 格式 |
| Dispatcher | 7 | 路由、背压、上下文注入、重启 |
| 监督引擎 | 5 | hook 注册/执行、告警去重与限频 |
| 冒烟测试 | 3 | 执行、超时、失败策略 |
| 影响分析 | 4 | 能力预检、两阶段、ImpactPlan、不可用降级 |
| Producer | 4/源 | 各 producer 启动/停止/event 格式 |

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| Git hook CLI 跑在没有 OMP 会话的环境中 | CLI 独立运行，无会话也可执行一次审查 |
| File watcher 大仓性能 | 默认关闭；路径范围限制 |
| Advisor 无 trace_path 工具 | `impact_analysis` 能力预检 → 不可用时跳过 |
| 上游补丁被 OMP 升级覆盖 | 补丁处标记 `// OMP-CUSTOM-PATCH` |
| 未知 trigger 类型与老版本不兼容 | trigger 字段可选，fallback 到 `compliance_review` |
