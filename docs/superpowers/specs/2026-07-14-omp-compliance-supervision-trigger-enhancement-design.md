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
const { trigger, ...rest } = request;
const resolvedTrigger = trigger ?? "compliance_review";
if (trigger !== undefined && !isKnownTrigger(trigger)) {
  logger.warn(`Unknown trigger "${trigger}", falling back to compliance_review`);
  writeTriggerEvent("trigger_fallback", { originalTrigger: trigger, resolved: "compliance_review" });
}
return advisors[0].runtime.requestReview({ trigger: resolvedTrigger, ...rest });
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
  │   │   └── 是 → 请求 impact_analysis review
  │   │         └── Advisor 分析改动 → 返回结构化 ImpactPlan
  │   │               { affectedModules, affectedTests, suggestedCommands }
  │   └── 执行 suggestedCommands
  │         └── 结果写入证据
  │
  ├── Phase 2: Completion Review
  │   ├── 冒烟测试（预定义命令）
  │   ├── 影响测试结果（Phase 1 产出，如有）
  │   ├── 证据合并到 EvidenceSnapshot
  │   └── 冻结 snapshot → requestAdvisorReview → verdict
```

### ImpactPlan 结构

```typescript
export interface ImpactPlan {
  schema_version: 1;
  affectedModules: Array<{ path: string; confidence: "high" | "medium" | "low" }>;
  affectedTests: string[];
  suggestedCommands: string[];    // 需要执行的测试命令
}
```

### 冒烟测试

```typescript
export interface SmokeTestConfig {
  commands: string[];
  timeoutMs: number;
  failOn: "first" | "all";
}
```

在 Phase 2 的 snapshot 冻结前执行。结果写入 `EvidenceSnapshot.smokeTestResults`。失败不自动阻断——Advisor 看到结果后发出 remediation。

### 实时巡检（Detector）

```typescript
export interface SupervisionHook {
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
