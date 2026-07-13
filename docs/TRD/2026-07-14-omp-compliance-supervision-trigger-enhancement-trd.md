# OMP Compliance 扩展：监督、触发与验证增强 — 技术需求文档

## 现状/目标差距矩阵

| # | 设计稿假设 | 代码库实际状态 | 差距 | 解决方式 |
|---|-----------|--------------|------|---------|
| 1 | `advisor_after_run` 事件存在 | 仅 `advisor_before_run`（`runner.ts:1086`） | ❌ 不存在 | 改用 `advisor_before_run` + `turn_end` 组合推断运行时状态 |
| 2 | `api.getPlanStatus()` 可查询计划状态 | `ExtensionAPI` 无任何 plan/todo 方法（`types.ts:1061-1371`），`todo_reminder` 事件仅被动推送（`types.ts:1128`） | ❌ 不存在 | 方案 A：上游补丁新增 `getPlanRunState()`。方案 B：`turn_end` 监听 + 推断 |
| 3 | Advisor 子代理/MCP 可观测 | Advisor `ToolSession.sessionId` 为内部 UUIDv7（`runtime.ts`），默认工具仅 `read/grep/glob`（`advise-tool.ts:145`），无可观测钩子 | ❌ 不可观测 | 方案 A：上游补丁暴露 advisor session 事件。方案 B：从 `__advisor.jsonl` 转录推断 |
| 4 | `additionalToolNames` 可传工具名 | `mergeAdvisorBeforeRunResult`（`runner.ts:89-104`）只处理 `additionalSystemContext[]`、`additionalTools[]`（AgentTool 对象）、`metadata` | ❌ 不被处理 | 改用 `additionalTools` 传入完整 `AgentTool` 对象 |
| 5 | `requestReview()` 接受泛化 trigger | 签名 `trigger: "compliance_review"` 硬编码（`runtime.ts:124-168`），不是 `AdvisorRunTrigger` | ❌ 类型限制 | 必须改 `runtime.ts` 签名 + `agent-session.ts:16259` 透传 |
| 6 | `emitAdvisorBeforeRun` 方法名 | 实际名 `emitBeforeRun`（`runner.ts:1086`） | ⚠️ 命名不同 | TRD 使用正确方法名 |
| 7 | TUI 状态栏扩展点 | `ctx.ui.setStatus/setWidget/setFooter/setHeader/setTitle` 存在（`types.ts`） | ✅ 存在 | 直接使用 |
| 8 | Advisor 转录可记录 trigger | `__advisor.jsonl` 使用 `AdvisorTranscriptRecorder`（`transcript-recorder.ts`） | ⚠️ 需确认 trigger 字段 | 转录器记录 AgentMessage，需确认 topic 字段透传 |
| 9 | `compliance_review` 是唯一触发通道 | `agent-session.ts:16259` 硬编码，`AdvisorRunTrigger` 类型只含 `"turn_end" \| "compliance_review"`（`runtime.ts:95`） | ✅ 已知约束 | 上游补丁扩展 trigger 类型 |

---

## 1. 项目概览

基于设计文档 `2026-07-14-omp-compliance-supervision-trigger-enhancement-design.md` 的技术实现方案。分 4 个子项目顺序交付：

| 子项目 | 范围 | 依赖上游补丁 | 预估文件数 |
|--------|------|-------------|-----------|
| SP-1: 上游补丁 | 类型透传 + trigger 扩展 + 转录 | — | 8-10 个 OMP 文件 |
| SP-2: 扩展内部 | TriggerRegistry + Dispatcher + 监督引擎 + 状态面板 | SP-1 | 20-25 个新文件 |
| SP-3: 验证管道 | 冒烟测试 + 影响分析两阶段 | SP-1 + SP-2 | 8-10 个新文件 |
| SP-4: TUI 状态栏 | 实时状态栏渲染 | SP-2 | 3-5 个新文件 |

---

## 2. SP-1：上游 OMP 补丁

### 2.1 改动清单

#### 文件 1：`types.ts` — 类型扩展

```typescript
// ~/Code/super/oh-my-pi/packages/coding-agent/src/extensibility/extensions/types.ts

// 1. AdvisorRunTrigger 扩展（行 892 附近）
// 当前：export type AdvisorRunTrigger = "turn_end" | "compliance_review";
export type AdvisorRunTrigger =
  | "turn_end"
  | "compliance_review"
  | "impact_analysis"
  | "git_pre_push"
  | "file_change"
  | "scheduled"
  | "manual_review";
// 标记：OMP-CUSTOM-PATCH:SP-1

// 2. AdvisorReviewRequest 增加 trigger（行 912 附近）
export interface AdvisorReviewRequest {
  reviewId: string;
  trigger?: Exclude<AdvisorRunTrigger, "turn_end">; // 新增
  metadata?: Record<string, unknown>;
}
// 标记：OMP-CUSTOM-PATCH:SP-1

// 3. AdvisorReviewReceipt 验证上游形状（行 918 附近）
// 当前：{ status: "accepted" | "rejected"; reviewId: string; reason?: string }
// ✅ 已对齐，无需修改
```

**测试**：
- 编译期类型测试：传入所有新 trigger 值确认编译通过
- `expectTypeOf` 测试确认两处 `AdvisorRunTrigger` 定义一致

#### 文件 2：`runtime.ts` — 签名和标题

```typescript
// ~/Code/super/oh-my-pi/packages/coding-agent/src/advisor/runtime.ts

// 1. requestReview 签名（行 124-135）
// 当前：requestReview(input: { trigger: "compliance_review"; reviewId: string; metadata? })
// 改后：
  requestReview(input: { trigger: AdvisorRunTrigger; reviewId: string; metadata? })
// 标记：OMP-CUSTOM-PATCH:SP-1

// 2. 标题渲染（行 147）
// 当前：const title = "### Compliance review";
// 改后：const title = `### ${trigger} review`;
// 标记：OMP-CUSTOM-PATCH:SP-1

// 3. 需要 import type { AdvisorRunTrigger }
import type { AdvisorRunTrigger } from "../extensibility/extensions/types";
```

#### 文件 3：`agent-session.ts` — 路由透传

```typescript
// ~/Code/super/oh-my-pi/packages/coding-agent/src/session/agent-session.ts

// 行 16251-16259
// 当前：
async requestAdvisorReview(request: {
  reviewId: string;
  metadata?: Record<string, unknown>;
}): Promise<...> {
  ...
  return this.#advisors[0].runtime.requestReview({ trigger: "compliance_review", ...request });
}

// 改后：
async requestAdvisorReview(request: {
  reviewId: string;
  trigger?: AdvisorRunTrigger;       // 新增
  metadata?: Record<string, unknown>;
}): Promise<...> {
  ...
  const { trigger, ...rest } = request;
  const resolvedTrigger = trigger && isKnownReviewTrigger(trigger)
    ? trigger
    : "compliance_review";
  return this.#advisors[0].runtime.requestReview({
    trigger: resolvedTrigger,
    ...rest,
  });
}
// 标记：OMP-CUSTOM-PATCH:SP-1

// 需要新增辅助函数：
function isKnownReviewTrigger(t: string): t is Exclude<AdvisorRunTrigger, "turn_end"> {
  return ["compliance_review", "impact_analysis", "git_pre_push", "file_change", "scheduled", "manual_review"].includes(t);
}
```

#### 文件 4：`transcript-recorder.ts` — 转录

```typescript
// ~/Code/super/oh-my-pi/packages/coding-agent/src/advisor/transcript-recorder.ts

// 在记录 turn 时增加 trigger 字段
// 当前：transcribe({ messages, timestamp })
// 改后：transcribe({ messages, timestamp, trigger })

// 标记：OMP-CUSTOM-PATCH:SP-1
```

**注意**：`__advisor.jsonl` 的 JSONL schema 必须向后兼容——旧记录没有 `trigger` 字段，新记录有。Agent Hub 必须容忍 `trigger` 可选。

#### 文件 5：`runner.ts` — 事件转发

```typescript
// ~/Code/super/oh-my-pi/packages/coding-agent/src/extensibility/extensions/runner.ts

// emitBeforeRun（行 1086-1118）
// 当前：trigger 来自 pending.trigger
// 确认 trigger 已透传：events[0] 的 trigger 已经是透传值
// 无需修改——事件负载中的 trigger 取自 pending 队列
```

**证实**：`runner.ts:1086-1118` 中 `emitBeforeRun` 读取 `pending.trigger`，而 pending 由 `requestReview()` 入队。如果 `requestReview()` 签名改为传递真实 trigger，则 runner 自动传递。无需单独修改。

### 2.2 新增 API（SP-1 必做项）

状态面板需要实时子代理 / MCP 数据，仅 `advisor_before_run` 不足以支持。必须在上游新增以下 advisor 可观测事件：

```typescript
// extensibility/extensions/types.ts 新增

export interface AdvisorRunStartedEvent {
  type: "advisor_run_started";
  sessionId: string;
  advisorSessionId: string;    // 用于关联子代理和 MCP 调用
  reviewId: string;
  trigger: AdvisorRunTrigger;
}

export interface AdvisorRunFinishedEvent {
  type: "advisor_run_finished";
  sessionId: string;
  advisorSessionId: string;
  reviewId: string;
  duration: number;
}

export interface AdvisorToolCallEvent {
  type: "advisor_tool_call";
  advisorSessionId: string;
  reviewId: string;
  toolName: string;
  timestamp: string;
}

export interface AdvisorToolResultEvent {
  type: "advisor_tool_result";
  advisorSessionId: string;
  reviewId: string;
  toolName: string;
  success: boolean;
}

export interface AdvisorSubagentEvent {
  type: "advisor_subagent_started" | "advisor_subagent_progress" | "advisor_subagent_finished";
  advisorSessionId: string;
  reviewId: string;
  subagentId: string;
  task: string;
}
```

**触发时机**：

| 事件 | 触发位置 | 说明 |
|------|----------|------|
| `advisor_run_started` | `AdvisorRuntime.agent.prompt()` 前 | 标记当前 review 开始 |
| `advisor_run_finished` | `AdvisorRuntime.batch 完成后` | 标记当前 review 完成，记录耗时 |
| `advisor_tool_call` | Advisor 的 `toolSession.toolCall` 拦截点 | 每次 Advisor 调用 tool 时 |
| `advisor_tool_result` | Advisor 的 tool 返回时 | 记录 tool 执行结果 |
| `advisor_subagent_*` | Advisor 的 `task` tool 调用/返回时 | 跟踪子代理生命周期 |

**测试**：

| 测试 | 验证内容 |
|------|---------|
| 事件正确触发 | run_started → tool_call/result → run_finished 时序 |
| advisorSessionId 关联 | 同一 review 的所有事件 advisorSessionId 一致 |
| 向后兼容 | 未订阅事件的扩展不受影响 |

### 2.3 新增 API 2（可选）

#### `getPlanRunState()`
## 3. SP-2：扩展内部

### 3.1 新增文件结构

```
src/
├── triggers/
│   ├── index.ts              # 统一导出
│   ├── types.ts              # TriggerEvent + TriggerProducer 接口
│   ├── registry.ts           # TriggerRegistry（生命周期管理）
│   ├── dispatcher.ts         # Dispatcher（去重/并发/路由）
│   ├── backpressure-queue.ts # 持久化有界队列
│   ├── context-injector.ts   # 按 trigger 注入上下文
│   └── producers/
│       ├── git-pre-push.ts
│       ├── file-watch.ts
│       ├── scheduled.ts
│       └── manual.ts
├── supervision/
│   ├── index.ts              # 统一导出
│   ├── types.ts              # SupervisionHook + SupervisionFinding
│   ├── engine.ts             # 监督引擎
│   ├── smoke-test.ts         # 冒烟测试执行器
│   └── detectors/
│       ├── code-write-detector.ts
│       ├── slow-review-detector.ts
│       └── repeat-advise-detector.ts
└── status/
    ├── index.ts
    ├── collector.ts          # StatusCollector（多源聚合）
    ├── snapshot.ts           # StatusSnapshot 类型
    └── cli-renderer.ts       # 终端渲染
```

### 3.2 关键实现细节

#### TriggerEvent 类型

```typescript
// src/triggers/types.ts
import type { AdvisorReviewRequestTrigger } from "../../types";

export interface TriggerEvent {
  trigger: AdvisorReviewRequestTrigger;
  reviewKind: "compliance" | "brainstorm" | "supervision" | "impact_analysis";
  body: Record<string, unknown>;
  meta: {
    source: "git_hook" | "watcher" | "cron" | "cli";
    sessionId?: string;
    timestamp: string;
    fingerprint: string;       // 用于去重：sha256(trigger + JSON(body))
  };
}
```

#### TriggerProducer 接口

```typescript
// src/triggers/types.ts
export interface TriggerProducer<TEvent extends TriggerEvent = TriggerEvent> {
  readonly trigger: AdvisorReviewRequestTrigger;
  readonly label: string;
  readonly enabled: boolean;

  start(): Promise<void>;       // 启动监听
  stop(): Promise<void>;        // 停止监听（释放资源）

  on(event: "produce", handler: (evt: TEvent) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
}
```

#### 现有工具与监督引擎的关联

**关键发现**：现有代码库已有可复用的信号收集器：

```typescript
// 现有信号收集器（src/signals/ 目录）：
// - ToolEventCollector     — 工具事件配对
// - normalizeCodebaseMemory — codebase MCP 交互归一化
// - normalizeTaskDelegation — 子代理委托归一化
// - normalizeVerification   — bash 退出码归一化

// 监督引擎应复用的：
// - CollectorRuntime（src/signals/collector-runtime.ts）
// - ToolEventCollector（src/signals/tool-event-collector.ts）
// - 已有的 tool_call/tool_result 事件监听
```

监督引擎不需要重新实现工具事件收集——直接挂到现有的 `CollectorRuntime` 管道上：

```typescript
// src/supervision/engine.ts
export class SupervisionEngine {
  constructor(
#### StatusCollector 实现策略

不再用推断——订阅 SP-1 新增的 advisor 事件：

```typescript
// src/status/collector.ts
export class StatusCollector {
  private state: StatusSnapshot = { runtime: { state: "idle" }, ... };

  onAdvisorRunStarted(event: AdvisorRunStartedEvent): void {
    this.state.runtime = {
      state: "active",
      currentReview: { reviewId: event.reviewId, trigger: event.trigger, elapsed: 0 },
    };
  }

  onAdvisorRunFinished(_event: AdvisorRunFinishedEvent): void {
    this.state.runtime.state = "idle";
    this.state.runtime.currentReview = undefined;
  }

  onAdvisorToolCall(event: AdvisorToolCallEvent): void {
    this.state.advisorSession.mcpCallCount++;
    this.state.advisorSession.lastToolCalls.push({
      toolName: event.toolName,
      timestamp: event.timestamp,
    });
  }

  onAdvisorSubagentEvent(event: AdvisorSubagentEvent): void {
    if (event.type === "advisor_subagent_started") {
      this.state.advisorSession.subagentCount++;
      this.state.advisorSession.subagentIds.push(event.subagentId);
    }
  }

  snapshot(): StatusSnapshot { return { ...this.state }; }
}
```

| 信息维度 | 真实数据源 | 数据质量 |
|----------|-----------|---------|
| 运行时 active/idle | `advisor_run_started` + `advisor_run_finished` | 精确 |
| 当前 review | `advisor_run_started` | 精确 |
| 子代理计数 | `advisor_subagent_started` + `advisor_subagent_finished` | 精确 |
| MCP 调用计数 | `advisor_tool_call` | 精确 |
| 建议摘要 | `advise()` tool 调用的 emission guard | 精确 |
| 合规任务 | `ComplianceRuntime.taskState` | 精确 |
| 大脑风暴 | `TopicCoordinator.current()` | 精确 |


#### 告警去重

```typescript
// src/supervision/engine.ts
interface DedupeState {
  findingId: string;
  lastAdvise: number;       // 上次 advise 时间戳
  lastSeverity: Severity;   // 上次 severity
  adviseCount: number;
}

// 规则：
// - 同一 findingId 60s 内不重复 advise
// - severity 升级（nit→concern→blocker）不受限频
// - adviseCount > 5 后静默，只写 evidence
```

### 3.3 SP-2 测试计划

| 测试 | 文件 | 验证内容 |
|------|------|---------|
| TriggerRegistry 生命周期 | `registry.test.ts` | start/stop 不抛异常、producer event 正确路由 |
| Dispatcher 去重 | `dispatcher.test.ts` | 相同 fingerprint 在 T 秒内丢弃 |
| Dispatcher 并发 | `dispatcher.test.ts` | 同 trigger 类型一次一个 in-flight |
| backpressure 队列满 | `backpressure-queue.test.ts` | 超上限返回 rejected |
| backpressure 重启恢复 | `backpressure-queue.test.ts` | 重启后扫描目录恢复未处理 event |
| context injector | `context-injector.test.ts` | 每种 trigger 注入不同上下文 |
| GitPrePush CLI | `git-pre-push.test.ts` | 参数解析、退出码 |
| FileWatch 去抖 | `file-watch.test.ts` | 连续变更 300ms 合并为一个 event |
| 监督引擎注册 | `engine.test.ts` | hook 注册/注销、执行顺序 |
| 告警去重 | `engine.test.ts` | 60s 内不重复、upgrade 不受限 |
| Code Write Detector | `code-write-detector.test.ts` | write/edit 调用触发告警 |
| Slow Review Detector | `slow-review-detector.test.ts` | 超时触发告警 |
| StatusCollector 聚合 | `status-collector.test.ts` | 各维度正确聚合 |
| CLI 渲染 | `cli-renderer.test.ts` | 面板输出格式 |

---

## 4. SP-3：验证管道

### 4.1 两阶段完成流程（修正）

影响分析不能嵌入 `requestCompletion()`——它需要独立的 Advisor review 才能产生 `ImpactPlan`。拆为两个独立阶段：

```
                           requestImpactAnalysis()
                                 │
                    ┌──── 能力预检 ────┐
                    │                    │
              可用工具               不可用
                    │                    │
        ImpactStage.state:         跳过（直接进入 Stage 2）
        "impact_requested"
                    │
         注册 impact 信封 + 请求 review
          (trigger: impact_analysis)
                    │
        ImpactStage.state:
        "impact_reviewing"
                    │
          Advisor 返回 impact_plan
                    │
        ImpactStage.state:
        "impact_tests_running"
                    │
          执行 ImpactCommand[]
                    │
        ImpactStage.state:
        "impact_completed"
                    │
         结果写入证据快照
                    │
         ┌──────────┘
         ▼
   requestCompletion()
         │
   Stage 2: 冒烟测试 + 冻结 snapshot + compliance_review
```

### 4.2 新增类型

```typescript
// src/runtime/impact-stage.ts
export type ImpactStageStatus =
  | "not_started"
  | "impact_requested"
  | "impact_reviewing"
  | "impact_tests_running"
  | "impact_completed"
  | "impact_failed";

export interface ImpactStage {
  status: ImpactStageStatus;
  reviewId?: string;
  impactPlan?: ImpactPlan;
  testResults?: ImpactTestResult[];
  error?: string;
}

export interface ImpactTestResult {
  command: ImpactCommand;
  exitCode: number;
  duration: number;
  outputTruncated: boolean;
}
```

### 4.3 新增信封 + 工具

```typescript
// 新 trigger: "impact_analysis"（已在 SP-1 定义）
// 新工具: "impact_plan"（Advisor 返回结构化 ImpactPlan）
// 新注册表: ImpactReviewRegistry（或复用 ComplianceReviewRegistry 按 reviewId 前缀区分）

// impact_plan tool schema
const impactPlanSchema = {
  type: "object",
  properties: {
    schema_version: { type: "number", const: 1 },
    affected_modules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    affected_tests: { type: "array", items: { type: "string" } },
    suggested_commands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          executable: { type: "string", enum: ["bun", "npm", "node", "bash"] },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          timeout_ms: { type: "number", maximum: 60000 },
        },
        required: ["executable", "args", "cwd"],
      },
    },
  },
  required: ["schema_version", "affected_modules", "suggested_commands"],
};
```

### 4.4 ComplianceRuntime 新增方法

```typescript
async requestImpactAnalysis(): Promise<ImpactStage> {
  if (!this.canRunImpactAnalysis()) {
    return { status: "not_started" };
  }

  // 1. 构建影响分析上下文
  const context = buildImpactContext(this.taskState);
  const reviewId = `impact-${randomUUID()}`;

  // 2. 注册信封
  this.impactRegistry.put({
    reviewId,
    taskId: this.taskState.taskId,
    context,
    rules: IMPACT_ANALYSIS_RULES,
    createdAt: new Date().toISOString(),
  });

  // 3. 请求 advisor review（trigger: impact_analysis）
  const receipt = await this.reviewDeps.requestAdvisorReview({
    trigger: "impact_analysis",
    reviewId,
    metadata: { taskId: this.taskState.taskId, context },
  });

  if (receipt.status !== "accepted") {
    return { status: "impact_failed", error: "Advisor not available" };
  }

  // 4. 等待 Advisor 通过 impact_plan 工具返回结果
  // （依赖 SP-2 的 Dispatcher 排队机制处理背压）
  this.impactStage = { status: "impact_reviewing", reviewId };

  // 5. 通过 Polling / Event 等待结果（带超时）
  return this.waitForImpactPlan(reviewId, 120_000);
}
```

### 4.5 影响分析超时与降级

```typescript
const IMPACT_TIMEOUT_MS = 120_000;

async waitForImpactPlan(reviewId: string, timeoutMs: number): Promise<ImpactStage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelope = this.impactRegistry.consume(reviewId);
    if (envelope?.impactPlan) {
      // 校验 + 执行命令
      const validated = validateImpactCommands(envelope.impactPlan.suggestedCommands);
      const results = await this.executeImpactCommands(validated);
      return { status: "impact_completed", impactPlan: envelope.impactPlan, testResults: results };
    }
    await Bun.sleep(500);
  }
  // 超时 → 降级：记录告警，跳过影响分析
  return { status: "impact_failed", error: "Impact analysis timed out" };
}
```

### 4.6 冒烟测试（阶段 2）

冒烟测试在 `requestCompletion()` 内、snapshot 冻结前执行：

```typescript
async requestCompletion(params) {
  const newState = transition(this.taskState, { type: "completion_requested" });

  // 冒烟测试（snapshot 冻结前）
  let smokeTestResults: SmokeTestResult[] = [];
  if (this.config.smokeTests?.length) {
    smokeTestResults = await this.runSmokeTests(this.config.smokeTests);
  }

  // 合并影响分析结果（如有）
  const impactTestResults = this.impactStage?.status === "impact_completed"
    ? this.impactStage.testResults
    : [];

  // 冻结 snapshot
  const snapshot = buildCompletionSnapshot({
    ...this.taskState,
    smokeTestResults,
    impactTestResults,
  });

  // ... 现有信封 + requestAdvisorReview
}
```

### 4.7 TODO 完成检测

上游无 `getPlanRunState()` API。冒烟测试由 `compliance_complete` 工具手动触发。

### 4.8 SP-3 测试计划

| 测试 | 验证内容 |
|------|---------|
| 影响分析能力预检 | 有/无 WATCHDOG tools 返回正确值 |
| 影响分析信封注册 | reviewId 前缀 `impact-`，注册表正确 |
| 影响分析超时 | 超时后返回 `impact_failed`，不阻塞 completion |
| 影响分析降级 | Advisor 不可用时跳过，completion 继续 |
| ImpactCommand 校验 | 白名单、cwd 安全、超时上限 |
| ImpactCommand 执行 | 命令运行、退出码、超时 |
| 冒烟测试执行 | 命令运行、退出码、超时 |
| 冒烟+影响合并 | snapshot 同时包含两种结果 |
| 两阶段完整流程 | requestImpactAnalysis → 执行 → requestCompletion → review |

---

## 5. SP-4：TUI 状态栏

### 5.1 实现

利用上游已存在的 `ctx.ui.setStatus/setFooter`：

```typescript
// extension.ts
api.on("session_start", (_event, context) => {
  const ui = context.ui;  // ExtensionUIContext
  if (!ui) return;        // 非 TUI 环境跳过

  // 启动状态栏刷新
  const timer = setInterval(async () => {
    const snapshot = statusCollector.snapshot();
    ui.setStatus(formatStatusLine(snapshot));  // 单行摘要
    ui.setFooter(formatFooter(snapshot));       // 底部详细面板
  }, 1000);

  // 会话结束时停止
  api.on("session_stop", () => clearInterval(timer));
});
```

### 5.2 TUI 状态栏格式

```
# 单行状态（setStatus）：
[● Active] compliance · 2 subagents · 7 MCP calls · 1⛔ 3⚠

# 底部面板（setFooter）：
task-42 ● 尝试:2  最后:remediate · 1 topic pending architecture
```

### 5.3 SP-4 测试计划

| 测试 | 验证内容 |
|------|---------|
| setStatus 调用 | 定时器正确调用 setStatus |
| setFooter 调用 | 定时器正确调用 setFooter |
| 无 TUI 环境 | 无 ctx.ui 时跳过 |
| 会话结束清理 | session_stop 清除定时器 |
| 格式化输出 | 状态行格式、面板格式 |

---

## 6. 交付顺序与依赖

```
SP-1（上游补丁）
  └→ SP-2（扩展内部）
       ├→ SP-3（验证管道）
       └→ SP-4（TUI 状态栏）
```

| 顺序 | 子项目 | 预估工作量 | 外部依赖 |
|------|--------|-----------|---------|
| 1 | SP-1 | 8-10 文件改动 | OMP 上游代码库 |
| 2 | SP-2 | 20-25 新文件 | SP-1 |
| 3 | SP-3 | 8-10 新文件 | SP-1 + SP-2 |
| 4 | SP-4 | 3-5 新文件 | SP-2 |

---

## 7. 文件变更总清单

### 上游 OMP（~8 文件）

| 文件 | 改动 | 标记 |
|------|------|------|
| `extensibility/extensions/types.ts` | 类型扩展 | `OMP-CUSTOM-PATCH:SP-1` |
| `advisor/runtime.ts` | 签名 + 标题 | `OMP-CUSTOM-PATCH:SP-1` |
| `session/agent-session.ts` | 路由透传 | `OMP-CUSTOM-PATCH:SP-1` |
| `advisor/transcript-recorder.ts` | trigger 字段 | `OMP-CUSTOM-PATCH:SP-1` |
| `extensibility/extensions/runner.ts` | 确认无需改动 | — |

### 扩展 `@bearmaxdd/omp-compliance`（~40 新文件/改动）

```
src/triggers/          (7 文件)  — SP-2
src/supervision/       (6 文件)  — SP-2
src/status/            (4 文件)  — SP-2
src/extension.ts       (改动)    — SP-2
src/runtime/           (改动)    — SP-3
src/types.ts           (改动)    — SP-1 同步
```

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 上游不批准 `AdvisorRunTrigger` 扩展 | 中 | 高 | fallback 策略已内置；SP-2 核心逻辑不依赖新 trigger 值 |
| 上游不批准 `getAdvisorSessionState()` | 中 | 中 | 子代理/MCP 走推断策略 |
| 上游不批准 `getPlanRunState()` | 低 | 中 | 靠 `compliance_complete` 手动触发 |
| SP-1 在 OMP 升级时被覆盖 | 高 | 中 | 所有 patch 标记 `OMP-CUSTOM-PATCH:SP-1`，升级后逐一验证 |
| TUI 组件不存在于终端环境 | 中 | 低 | 检查 `ctx.ui` 存在后再调用 |
| 504: gateway timeout on Tool Use | unknown | medium | AdvisorRuntime handles tool_call-level timeout (runtime.ts) — impact_analysis must respect per-tool timeout |

---

## 9. 验收标准

1. SP-1：OMP 编译通过，所有 `OMP-CUSTOM-PATCH:SP-1` 标记可搜索
2. SP-1：`requestAdvisorReview` 传 `git_pre_push` → Advisor 收到 `trigger: "git_pre_push"`
3. SP-1：未知 trigger → fallback + 日志告警
4. SP-2：`/advisor status` 命令输出面板格式
5. SP-2：GitPrePush CLI 启动一次审查并正确返回退出码
6. SP-3：`compliance_complete` 自动执行冒烟测试
7. SP-3：冒烟失败 → Advisor 收到 `smokeTestResults` 证据
8. SP-4：TUI 环境底部显示状态栏
9. 全量测试：上游 + 扩展全部测试通过
