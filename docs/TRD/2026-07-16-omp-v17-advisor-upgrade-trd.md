# OMP v17 Advisor 合规监督升级技术需求文档

> 日期：2026-07-16
>
> 状态：待实现
>
> 设计依据：`docs/superpowers/specs/2026-07-16-omp-v17-advisor-upgrade-design.md`
>
> 适用仓库：`BearMaxDD/oh-my-pi`、`BearMaxDD/omp-custom`
>
> 宿主基线：官方 Oh My Pi `v17.0.1`（`6ae7cdbf9`）
>
> 扩展包：`@bearmaxdd/omp-compliance`
>
> 支持范围：仅 OMP `>=17.0.1 <18`

## 1. 文档目的

本文把已确认的 OMP v17 Advisor 升级设计细化为可直接指导编码、测试、跨仓联调和发布验收的技术需求。本文不重新讨论产品方向，重点回答以下问题：

1. 官方 v17 宿主最少需要修改哪些类型、运行时和接线入口。
2. `omp-custom` 如何适配 v17 Extension API、`xd://`、`hub` 和官方 Advisor Runtime。
3. Completion Gate、Brainstorm、Codebase-First、子代理监管、Evidence 和人工越权如何形成闭环。
4. 如何保证失败关闭、重启恢复、跨项目隔离和结构化裁决不可伪造。
5. 两个仓库分别需要增加或修改哪些文件，以及每一阶段如何验证。

本文是技术需求文档，不是逐提交实施计划。后续 TDD 实现计划必须引用本文的绝对路径和 SHA-256，并进一步拆成可独立执行的测试优先任务。

## 2. Codebase 分析基线

### 2.1 图谱范围

本 TRD 基于两份新鲜 codebase-memory 图谱：

| 图谱 | 基线 | 规模 | 用途 |
|---|---|---:|---|
| `oh-my-pi-v17-trd` | 官方 `v17.0.1` | 91,833 节点 / 362,796 边 | 定位 Extension、Advisor、`xd://`、会话和运行模式接线 |
| `omp-custom` | 当前 `master` | 1,420 节点 / 2,971 边 | 定位现有 Completion、Brainstorm、Evidence、Codebase 和委派实现 |

### 2.2 官方 v17 已有能力

以下能力直接复用，不在定制分支中重写：

- `packages/coding-agent/src/advisor/runtime.ts` 已实现增量合并、失败回合回滚、连续三次失败通知、quarantine 后重建上下文和静默审查正常结束语义。
- `packages/coding-agent/src/extensibility/extensions/runner.ts` 的 `emitToolCall()` 已在工具执行前运行；处理器超时或抛错时返回 `block: true`，可以直接承载失败关闭的写前门。
- `packages/coding-agent/src/extensibility/extensions/types.ts` 的 `ToolDefinition` 已支持 `loadMode: "essential" | "discoverable"`、`approval: "read" | "write" | "exec"`、MCP 元数据和 v17 `execute()` 签名。
- `packages/coding-agent/src/tools/xdev.ts` 的 `XdevRegistry` 已支持动态设备发现、参数校验和执行，执行结果在 `details.xdev` 中保留逻辑工具、参数和内部结果。
- 官方 `task`、`hub`、Extension Runner、ACP 与非交互任务执行入口继续作为宿主基础设施。

### 2.3 官方 v17 缺口

| 缺口 | 当前代码位置 | 技术结论 |
|---|---|---|
| Extension 无专用 Advisor Review 请求 | `extensions/types.ts` 的 `ExtensionActions` | 增加通用 `requestAdvisorReview()`，不加入 Compliance 语义 |
| Advisor 只消费普通 turn delta | `advisor/runtime.ts` 的 `PendingDelta`、`#drain()` | 增加带 `reviewId` 的专用 Review 工作项，复用原失败恢复循环 |
| Advisor 回合不能临时注入上下文和工具 | `AdvisorAgent.prompt(input)` | 增加一次性 `AdvisorRunAugmentation`，回合结束后恢复原状态 |
| Extension 收不到专用 Review 生命周期 | Extension 事件类型与 Runner | 增加 before-run 和 queued/started/completed/failed/cancelled 事件 |
| 多运行模式动作接线不完整 | Interactive、ACP、task executor 初始化 | 所有 `ExtensionRunner.initialize()` 入口都必须提供 Review action |

### 2.4 当前 omp-custom 缺口

| 缺口 | 当前代码位置 | v17 目标 |
|---|---|---|
| peer dependency 仍为 `16.4.x` | `packages/omp-compliance/package.json` | 改为 `>=17.0.1 <18`，删除 v16 条件分支 |
| 自定义 Extension 类型为本地复制 | `src/types.ts` | 改用官方类型导入，只保留扩展自己的领域契约 |
| 工具使用旧 `handler` 形态，缺少 `label/loadMode/approval` | `compliance-complete-tool.ts`、Brainstorm 工具 | 迁移到 v17 `execute()`，控制面固定为 `essential` |
| 项目根使用 `process.cwd()` | `src/extension.ts` | 使用 `ExtensionContext.cwd` 和稳定项目 UUID |
| Review 由领域 Runtime 直接请求 | `ComplianceRuntime.requestCompletion()`、`BrainstormRuntime.submitTopic()` | 统一进入 Review Scheduler，领域 Runtime 不直接操作宿主队列 |
| Evidence 是 `<taskId>.jsonl` 单文件 | `evidence/evidence-store.ts` | 迁移为 project/task/review/codebase/delegation 分层目录 |
| Codebase 只识别旧短工具名 | `signals/codebase-memory.ts` | 支持 MCP 命名空间、`xd://` 外层事件和完整只读工具集 |
| 委派只识别 `task` | `signals/task-delegation.ts` | 同时规范化 `task` 与 `hub` 生命周期 |
| Collector 只采集不拦截 | `tool-event-collector.ts` | 保留被动采集，新增独立 `PreToolPolicy` 执行写前硬门 |
| 失败状态与 Review 重试耦合不完整 | Compliance/Brainstorm Runtime | `stalled` 持久化，指数退避，不把模型正常停止当通过 |

## 3. 总体技术架构

```text
主代理
  | essential 控制工具
  v
omp-custom Extension Composition Root
  |-- ProjectContext / ContractBinder
  |-- PreToolPolicy <------ tool_call（写前、失败关闭）
  |-- EventCollector <----- tool_call / tool_result（被动采集）
  |-- ReviewScheduler
  |     `-- requestAdvisorReview()
  |             |
  v             v
oh-my-pi Extension API -> AgentSession -> AdvisorRuntime
                                      |-- 官方 delta 审查
                                      `-- 专用 Review 工作项
                                               |
                                     advisor_before_run
                                               |
                                      一次性上下文 + 工具
                                               |
                              compliance_verdict / brainstorm_review
                                               |
                                      生命周期与最终回执
                                               v
omp-custom Domain Handler -> State Machine -> Evidence Store
```

### 3.1 责任边界

| 层 | 负责 | 不负责 |
|---|---|---|
| OMP 宿主 | 排队、运行、临时注入、事件、最终回执 | TDD 解析、合规规则、Evidence 判定、Completion 状态 |
| `omp-custom` 调度层 | 优先级、合并、去重、重试和单并发 | 执行模型流、Provider 重试 |
| `omp-custom` 领域层 | Completion、Brainstorm、委派、越权状态 | 直接修改官方 Advisor 内部队列 |
| Evidence 层 | 追加事件、快照、恢复、幂等 | 判断任务是否通过 |
| Advisor | 基于证据提交结构化 verdict | 修改任务状态、绕过契约、替用户做最终 Brainstorm 决策 |

### 3.2 不变量

1. 主代理永远看不到 `compliance_verdict` 和 `brainstorm_review`。
2. 专用裁决工具只在匹配 `reviewId` 的 Advisor 回合存在。
3. Advisor 回合正常结束不等于裁决完成。
4. 只有当前项目、任务、契约和 Evidence revision 全部匹配的 verdict 才有效。
5. 所有实质写操作都先经过 `tool_call` 的 Codebase/契约范围检查。
6. Review Scheduler 同一时刻最多向宿主提交一个专用 Review。
7. 宿主只理解通用 Review 协议，不理解 `pass`、`remediate`、TDD 或项目规则。

## 4. 跨仓协议版本

### 4.1 协议常量

```ts
export const ADVISOR_REVIEW_PROTOCOL_VERSION = 1 as const;

export interface AdvisorReviewCapabilities {
  protocolVersion: 1;
  reviewRequest: true;
  beforeRunAugmentation: true;
  lifecycleEvents: true;
  finalReceipt: true;
}
```

宿主在 `ExtensionAPI` 上暴露只读 `advisorReviewCapabilities` 与可选 `requestAdvisorReview`。`omp-custom` 激活时必须验证协议版本严格等于 `1`；缺失或版本不匹配时：

- 不注册 Completion/Brainstorm 控制工具。
- 不进入降级运行。
- 显示明确诊断：当前宿主不支持 Advisor Review Protocol v1。
- 允许只读 `/compliance doctor` 展示缺失能力，但禁止产生“已监督”假象。

### 4.2 通用 Review 请求

```ts
export type AdvisorReviewTrigger = string;

export interface AdvisorReviewRequest {
  reviewId: string;
  trigger: AdvisorReviewTrigger;
  priority: number;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface AdvisorReviewReceipt {
  reviewId: string;
  status: "accepted" | "deduplicated" | "rejected";
  reason?: string;
  queuedAt?: string;
}
```

宿主把 `trigger` 视为非空、长度受限的透明字符串。优先级业务含义和合法 trigger 集合由 `omp-custom` 管理。宿主只验证：

- `reviewId` 格式合法且当前 Runtime 未存在同 ID。
- `priority` 为有限整数。
- metadata 可序列化并受大小上限约束。
- Advisor Runtime 已启用、未 dispose。

### 4.3 回合前增强

```ts
export interface AdvisorBeforeRunEvent {
  reviewId: string;
  trigger: string;
  priority: number;
  metadata?: Record<string, unknown>;
  primarySessionId: string;
  advisorSessionId: string;
}

export interface AdvisorRunAugmentation {
  additionalSystemContext?: string;
  additionalTools?: ToolDefinition[];
  requestedToolNames?: string[];
  metadata?: Record<string, unknown>;
}
```

合并规则：

- 多个 Extension handler 返回的系统上下文按 Extension 加载顺序拼接，每段带来源边界。
- 临时工具名必须唯一；重名、与 Advisor 静态工具冲突或 schema 非法时，本次 Review 失败。
- `requestedToolNames` 只能从当前会话已注册且允许 Advisor 使用的工具中选择。
- 任一 handler 超时或抛错，本次 Review 失败并发出 `advisor_run_failed`，不得无增强继续执行。
- `additionalSystemContext` 和 metadata 设置单次大小上限，超过时拒绝而不是静默截断关键契约。

### 4.4 生命周期事件

```ts
export interface AdvisorReviewLifecycleBase {
  reviewId: string;
  trigger: string;
  priority: number;
  primarySessionId: string;
  advisorSessionId: string;
  timestamp: string;
}

export type AdvisorReviewLifecycleEvent =
  | (AdvisorReviewLifecycleBase & { type: "advisor_review_queued" })
  | (AdvisorReviewLifecycleBase & { type: "advisor_run_started" })
  | (AdvisorReviewLifecycleBase & {
      type: "advisor_tool_call";
      toolCallId: string;
      toolName: string;
      inputSummary: Record<string, unknown>;
    })
  | (AdvisorReviewLifecycleBase & {
      type: "advisor_tool_result";
      toolCallId: string;
      toolName: string;
      success: boolean;
      resultSummary?: string;
    })
  | (AdvisorReviewLifecycleBase & {
      type: "advisor_run_completed";
      verdictSubmitted: boolean;
      stopReason?: string;
    })
  | (AdvisorReviewLifecycleBase & {
      type: "advisor_run_failed";
      failureClass: "provider" | "hook" | "tool" | "quarantine" | "runtime";
      errorSummary: string;
    })
  | (AdvisorReviewLifecycleBase & {
      type: "advisor_run_cancelled";
      reason?: string;
    });
```

事件不携带完整模型上下文、凭据或未脱敏 Provider 响应。`advisor_tool_call/result` 只为专用 Review 发射，普通 Advisor delta 审查保持官方现状。

## 5. oh-my-pi 宿主改造

### 5.1 Extension 类型与 API

修改 `packages/coding-agent/src/extensibility/extensions/types.ts`：

- 增加第 4 节协议类型。
- 在 `ExtensionAPI` 与 `IExtensionRuntime` 增加 `advisorReviewCapabilities` 和 `requestAdvisorReview()`。
- 在 `ExtensionActions` 增加 `requestAdvisorReview`。
- 在 Extension 事件映射中增加 `advisor_before_run` 和 7 类生命周期事件。
- `advisor_before_run` 是唯一有返回值的新增事件；生命周期事件只通知，不允许修改运行结果。

兼容要求：官方上游不启用定制协议时类型可以保持可选，但定制 v17 发布物必须完整提供。`omp-custom` 不因字段可选而允许降级。

### 5.2 Extension Runtime 与 Runner

修改：

- `packages/coding-agent/src/extensibility/extensions/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/runner.ts`

`ExtensionRuntime` 增加未初始化保护方法，`ConcreteExtensionAPI` 委派给共享 Runtime。`ExtensionRunner.initialize()` 必须复制新的 action。

Runner 新增：

```ts
emitAdvisorBeforeRun(event): Promise<AdvisorRunAugmentation>
emitAdvisorLifecycle(event): Promise<void>
```

`emitAdvisorBeforeRun()` 使用与 `emitToolCall()` 相同的超时边界和失败关闭语义。生命周期通知失败必须记录 ExtensionError，但不得反向把已完成的模型回合改写为 Provider 失败；宿主最终回执仍需标记 `lifecycleDeliveryFailed`，供扩展在超时后恢复核对。

### 5.3 Advisor Runtime 工作项

修改 `packages/coding-agent/src/advisor/runtime.ts`，保留现有 `PendingDelta`，新增独立工作项：

```ts
interface PendingReview {
  kind: "review";
  request: AdvisorReviewRequest;
  queuedAt: string;
}

type AdvisorWorkItem =
  | { kind: "delta"; delta: PendingDelta }
  | PendingReview;
```

实现要求：

1. 普通 `onTurnEnd()` 继续走原有 delta coalescing，不改变行为。
2. `requestReview()` 把专用 Review 放入独立 FIFO，并通过 `reviewId` 和 `dedupeKey` 防重。
3. 已开始的 Advisor 模型流不被新请求中断。
4. 每个批次边界优先取一个专用 Review，再继续处理普通 delta backlog。
5. 专用 Review 不参与普通消息 delta 合并，不改变 `#seenContext` 的主会话差量语义。
6. 专用 Review 仍复用原有 message snapshot、失败回滚、Provider 重试、quarantine 和连续失败逻辑。
7. Review 终态后从 in-flight/dedupe 表移除；宿主只对仍在队列或执行中的同 ID 返回 `deduplicated`。

`AdvisorAgent` 改为：

```ts
interface AdvisorAgent {
  prompt(input: string, augmentation?: AdvisorRunAugmentation): Promise<void>;
  // 其余保持不变
}
```

不得修改通用 `packages/agent/src/agent.ts` 的 `Agent.prompt()` 协议。增强只存在于 coding-agent 的 Advisor facade，避免扩大核心 Agent API 的影响面。

### 5.4 一次性上下文和工具

在 `packages/coding-agent/src/advisor/run-augmentation.ts` 新增纯函数和作用域辅助器：

- 校验系统上下文、工具名和 requested tools。
- 把 `ToolDefinition` 包装成 Advisor 可执行工具。
- 生成当前回合允许工具名集合，供 Advisor quarantine 校验。
- 在 `try/finally` 中覆盖并恢复 Advisor Agent 的 `systemPrompt`、`tools` 和允许工具集合。

作用域规则：

```text
保存 Advisor 原始 systemPrompt/tools/allowedToolNames
  -> 合并本次 augmentation
  -> 执行 advisorAgent.prompt()
  -> 捕获最终 stop/error
  -> finally 恢复原始状态
```

即使 Provider 抛错、Review 被取消或 Extension hook 失败，也必须恢复。临时工具不能进入：

- 主代理工具表。
- `ExtensionRunner.getAllRegisteredTools()`。
- `XdevRegistry` 动态设备表。
- 后续普通 Advisor turn。

### 5.5 AgentSession 接线

修改 `packages/coding-agent/src/session/agent-session.ts`：

- 增加公开 `requestAdvisorReview()`，只把请求转交当前主 Advisor Runtime。
- 无 Advisor、多个 Advisor 配置冲突或 Runtime 已释放时返回结构化 `rejected`。
- v1 固定选择当前配置中的主 Advisor；不得把一个 Review 广播给多个 Advisor。
- `#buildAdvisorRuntime()` 的 host 实现增加 before-run 与生命周期桥接。
- Advisor tool wrapper 在专用 Review 执行期间发射 tool call/result 生命周期事件。
- 最终 completed/failed/cancelled 事件只发一次，并带同一 `reviewId`。

当前 `#buildAdvisorRuntime()` 已是高复杂度函数，新增逻辑必须下沉到 `advisor/run-augmentation.ts` 和 `advisor/review-lifecycle.ts`，禁止继续把协议组装全部堆入该函数。

### 5.6 所有运行模式必须接线

新增 `requestAdvisorReview` action 时必须覆盖所有 `ExtensionRunner.initialize()` 入口：

| 模式 | 文件 | 要求 |
|---|---|---|
| 交互式 TUI | `modes/controllers/extension-ui-controller.ts` | 转发到当前 `AgentSession` |
| ACP | `modes/acp/acp-agent.ts` | 转发到 managed session；session 不存在时 rejected |
| task/非交互执行 | `task/executor.ts` | 转发到当前 task session，并等待 Evidence 写入刷新 |

若后续新增初始化入口，TypeScript 的 `ExtensionActions` 必填字段必须使其编译失败，防止漏接线。

### 5.7 宿主文件清单

| 文件 | 变更类型 | 核心内容 |
|---|---|---|
| `advisor/review-protocol.ts` | 新增 | 通用请求、回执、事件和增强类型 |
| `advisor/run-augmentation.ts` | 新增 | 一次性上下文/工具作用域 |
| `advisor/review-lifecycle.ts` | 新增 | 事件构造、脱敏和一次性终态 |
| `advisor/runtime.ts` | 修改 | 专用 Review 工作项、回执和失败复用 |
| `session/agent-session.ts` | 修改 | Runtime/facade/Extension 桥接 |
| `extensibility/extensions/types.ts` | 修改 | API、Actions、事件类型 |
| `extensibility/extensions/loader.ts` | 修改 | Runtime 与 Concrete API 委派 |
| `extensibility/extensions/runner.ts` | 修改 | before-run 聚合和生命周期通知 |
| `modes/controllers/extension-ui-controller.ts` | 修改 | 交互式 action 接线 |
| `modes/acp/acp-agent.ts` | 修改 | ACP action 接线 |
| `task/executor.ts` | 修改 | task action 接线 |

## 6. omp-custom 激活与组合根

### 6.1 v17 类型适配

`packages/omp-compliance/src/types.ts` 不再复制完整 Extension API。改为：

```ts
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  AdvisorReviewRequest,
  AdvisorReviewReceipt,
  AdvisorRunAugmentation,
} from "@oh-my-pi/pi-coding-agent";
```

本地仅保留 `ReviewIntent`、`TaskContract`、`Evidence`、`Verdict` 等领域类型。测试替身通过 `Pick<ExtensionAPI, ...>` 或专用窄接口实现，避免再次冻结宿主类型快照。

### 6.2 Composition Root

重构 `src/extension.ts`，只负责依赖组装和事件注册：

```text
activate(api)
  -> CapabilityNegotiator.assertV17()
  -> ProjectContextManager.initialize()
  -> EvidenceRepository.recover()
  -> ContractBinder.recover()
  -> ReviewScheduler.recover()
  -> register essential control tools
  -> register discoverable diagnostics
  -> register before_agent_start guidance
  -> register tool_call PreToolPolicy + EventCollector
  -> register tool_result EventCollector
  -> register advisor_before_run augmentation
  -> register Advisor lifecycle handlers
  -> resume due stalled reviews
```

不得在模块加载时捕获 `process.cwd()`。所有路径依赖通过 `ExtensionContext.cwd` 解析；session 切换事件触发重新验证。

### 6.3 工具注册

| 工具 | loadMode | approval | 可见对象 | 说明 |
|---|---|---|---|---|
| `compliance_complete` | `essential` | `write` | 主代理 | 请求完成审查，不直接完成 |
| `brainstorm_topic_ready` | `essential` | `write` | 主代理 | 提交实质议题 |
| `brainstorm_decision` | `essential` | `write` | 主代理/用户流程 | 记录用户最终决定 |
| `compliance_status` | `discoverable` | `read` | 主代理 | 查询状态 |
| `compliance_history` | `discoverable` | `read` | 主代理 | 查询脱敏 Evidence |
| `compliance_doctor` | `discoverable` | `read` | 主代理 | 诊断协议和项目绑定 |
| `compliance_verdict` | 临时注入 | `write` | 对应 Advisor | Completion 专用裁决 |
| `brainstorm_review` | 临时注入 | `write` | 对应 Advisor | Brainstorm 专用裁决 |

所有 v17 工具必须提供 `name`、`label`、`description`、schema 和 `execute()`。控制工具不得依赖 `xd://` 才能触发。

## 7. 项目身份与隔离

### 7.1 持久项目描述

`.omp/compliance/project.json`：

```ts
interface ProjectBinding {
  schemaVersion: 1;
  projectId: string;             // UUID v4，首次激活生成
  canonicalRoot: string;         // realpath + 规范化分隔符
  gitRemoteIdentity?: string;    // 规范化 owner/repo，不保存凭据
  codebaseProjectId?: string;
  createdAt: string;
  reboundAt?: string;
}
```

### 7.2 绑定算法

1. 从 `ctx.cwd` 向上查找 Git 根，无法找到时以规范化 `ctx.cwd` 为项目根。
2. 读取已有 `project.json`；不存在则原子创建 UUID。
3. 比较 canonical root、Git remote identity 和 codebase projectId。
4. root 变化但 remote 一致时进入 `rebind_required`，不自动生成新 UUID。
5. remote 或 codebase project 不一致时失败关闭，要求显式 `/compliance rebind`。
6. Review、verdict、TDD、委派和 Evidence 都必须携带同一 projectId。

跨项目数据永远不通过 basename、目录相似或当前进程 cwd 猜测迁移。

## 8. 任务契约

### 8.1 统一模型

```ts
interface TaskContract {
  schemaVersion: 1;
  taskId: string;
  projectId: string;
  source: "tdd" | "lightweight";
  documentPath?: string;
  contractHash: string;
  gitHead: string;
  scope: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  delegationRequired: boolean;
  createdAt: string;
}
```

正式 TDD 使用 realpath 后的项目内绝对路径读取，持久化时保存项目相对路径和 SHA-256。现有 `loadComplianceContract()` 的路径逃逸检查、摘要提取和 hash 能力保留，但输出升级为统一 `TaskContract`。

### 8.2 契约分类

以下任一条件成立即要求正式 TDD：

- 修改两个及以上生产文件。
- 改变公开 API、协议、状态机或用户可见行为。
- 涉及数据迁移、跨模块调用、发布流程或二进制。
- 需要子代理并行或跨仓改动。
- 风险分类不低于中等。

轻量契约仅允许单文件、低风险、不改变公共行为的任务，并仍需 scope、验收标准、验证命令和 Codebase Evidence。

### 8.3 漂移失效

以下变化使所有未完成 Review Envelope 失效：

- contract hash 改变。
- Git HEAD 改变且不属于当前受控修复循环。
- diff hash 改变导致 affected files 超出 Evidence。
- projectId 或 codebase index revision 改变。

失效事件必须写入 `events.jsonl`，Scheduler 删除旧 dedupe 缓存并重新生成 Evidence revision。

## 9. Codebase-First Evidence

### 9.1 规范化工具身份

新增 `src/xdev/tool-identity.ts`：

```ts
interface CanonicalToolIdentity {
  transport: "direct" | "xdev";
  serverId?: string;
  toolName: string;
  qualifiedName: string;
}
```

必须识别：

- 直接短名：`search_graph`。
- MCP FQN：`mcp__codebase_memory_mcp__search_graph`。
- 带服务器元数据的 Extension/MCP 工具。
- 外层 `write` + `path: "xd://search_graph"`。

只允许已配置的 codebase-memory serverId 与允许工具集合组合。禁止只按任意名称后缀匹配，避免恶意工具伪装成 `search_graph`。

### 9.2 xd:// 事件展开

新增 `src/xdev/event-unwrapper.ts`：

- `tool_call` 为 `write` 且 path 命中 `xd://<device>` 时，解析 content JSON 为逻辑参数。
- `tool_result.details.xdev` 提取 `tool`、`mode`、`args` 和 `inner`。
- 生成外层调用与逻辑调用的关联 ID。
- 如果宿主同时发出内部 Extension tool 事件，按 `toolCallId + logical tool name` 去重。
- `help` 模式不记为真实检索 Evidence。
- 参数解析失败、result 不完整或工具名不一致时记录 `invalid_xdev_event`，不能算作通过证据。

### 9.3 Codebase Evidence Pack

```ts
interface CodebaseEvidencePack {
  schemaVersion: 1;
  evidenceRevision: string;
  projectId: string;
  codebaseProjectId: string;
  indexRevision: string;
  gitHead: string;
  diffHash: string;
  queriedAt: string;
  tools: CanonicalToolIdentity[];
  symbols: Array<{ qualifiedName: string; file: string; line?: number }>;
  traces: Array<{
    source: string;
    target: string;
    direction: "inbound" | "outbound";
  }>;
  affectedFiles: string[];
  allowedNewFileRoots: string[];
  unresolvedClaims: string[];
}
```

`evidenceRevision` 由 canonical JSON 的 SHA-256 生成，不能使用递增内存计数。有效 Pack 至少满足：

1. 同 projectId/codebaseProjectId。
2. `index_status` 证明图谱 ready 且 revision 未漂移。
3. 至少一次 `get_architecture` 或 `search_graph`。
4. 至少一次 `get_code_snippet`。
5. 跨模块任务至少一次 `trace_path` 或 `query_graph`。
6. affectedFiles 覆盖当前修改范围。
7. unresolvedClaims 为空，或每项都有阻塞/例外处理。

### 9.4 Advisor 只读边界

Advisor 可临时授权：

- `index_status`
- `get_architecture`
- `search_graph`
- `search_code`
- `trace_path`
- `get_code_snippet`
- `query_graph`

禁止：`index_repository`、任意文件写入、shell 执行和可变 Git 操作。授权器必须按 canonical identity 校验，不能复用主代理的全部活跃工具集合。

## 10. 写前硬门

### 10.1 入口

使用官方 v17 `api.on("tool_call", handler)`，不新增 `pre_tool_use` 宿主事件。`PreToolPolicy` 在被动 Collector 之前运行；若返回 `block: true`，Collector 仍记录被阻止事件，但工具不执行。

### 10.2 工具风险分类

| 类别 | 示例 | 策略 |
|---|---|---|
| 明确只读 | codebase 只读、read、status | 放行并采集 |
| 明确文件写 | edit、write、ast_edit | 校验目标路径、scope 和 Evidence revision |
| 可执行/不透明写 | bash、eval、脚本工具 | 解析声明范围；无法证明只读则按写操作处理 |
| 委派 | task、hub | 校验工作包、文件所有权、Evidence 引用和契约 |
| 图谱维护 | index_repository | 允许主代理受控执行，但使旧 index revision 失效 |
| 裁决 | compliance_verdict、brainstorm_review | 仅匹配 Advisor Review 上下文放行 |

### 10.3 决策接口

```ts
interface PreToolDecision {
  allow: boolean;
  reasonCode?:
    | "missing_contract"
    | "missing_codebase_evidence"
    | "project_mismatch"
    | "scope_violation"
    | "stale_evidence"
    | "delegation_context_missing"
    | "advisor_tool_forbidden";
  message?: string;
  requiredActions?: string[];
}
```

阻止事件包含目标工具、规范化参数摘要、当前 contract/evidence revision、原因码和修复动作。不得把完整 shell 内容或凭据直接写入 Evidence。

### 10.4 范围判断

- 已有文件必须落在 `affectedFiles` 或 contract scope。
- 新文件必须落在 `allowedNewFileRoots`，且契约明确允许新增。
- shell 命令若包含重定向、文件生成、包管理、Git 写操作或未知子命令，按写处理。
- `hub`/`task` 工作包必须引用不可变 `evidenceRevision`，并声明允许修改文件。
- 写入目标无法可靠解析时失败关闭，要求改用结构化工具或重新提交影响范围。

## 11. 子代理监管

### 11.1 委派模型

```ts
interface DelegationRecord {
  schemaVersion: 1;
  taskId: string;
  projectId: string;
  delegationId: string;
  transport: "task" | "hub";
  agentId?: string;
  model?: string;
  role?: string;
  workPackage: string;
  ownedFiles: string[];
  contractHash: string;
  evidenceRevision: string;
  acceptanceCriteria: string[];
  verificationCommands: string[];
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  actualFiles: string[];
  toolEvidenceIds: string[];
  startedAt?: string;
  completedAt?: string;
}
```

### 11.2 task 与 hub 规范化

升级 `signals/task-delegation.ts`：

- 识别 `task` 的创建、等待、结果和中止。
- 识别 `hub` 中创建/派发/等待/取消子代理的 operation。
- 使用真实 agent/session ID 关联，不只解析自然语言输出。
- 子代理返回 completed 但无工具结果或实际文件证据时标记 `insufficient`。
- ownedFiles 与实际修改不一致时产生 `delegation_scope_violation`。

### 11.3 例外

`DelegationException` 必须由用户或 Advisor 显式批准，保存 reason、explanation、approvedBy、Git HEAD、diff hash 和时间。主代理自行写一句“改动很小”不构成例外。

Completion Gate 要求：实质任务至少存在一条 completed 且范围一致的 DelegationRecord，或存在当前 contract/evidence revision 下仍有效的例外。

## 12. Review Scheduler

### 12.1 数据结构

```ts
type ReviewTrigger =
  | "compliance_review"
  | "manual_review"
  | "brainstorm_review"
  | "git_pre_push"
  | "impact_analysis"
  | "file_change"
  | "scheduled";

interface ReviewIntent {
  reviewId: string;
  projectId: string;
  trigger: ReviewTrigger;
  taskId?: string;
  topicId?: string;
  evidenceRevision: string;
  contractHash?: string;
  gitHead: string;
  diffHash: string;
  priority: 20 | 40 | 60 | 70 | 80 | 90 | 100;
  createdAt: string;
  attempt: number;
  notBefore?: string;
}
```

### 12.2 单并发与优先级

- 扩展内部只存在一个 Scheduler 实例和一个 in-flight Review。
- 队列按 priority 降序、createdAt 升序稳定排序。
- 宿主只负责执行已提交 Review，不复制业务优先级队列。
- 新高优先级 Intent 不取消已开始模型流，只在下一次 dispatch 时优先。
- Completion Review 永不被其他 trigger 吸收。

### 12.3 去重与合并

```text
dedupeKey = sha256(
  trigger + projectId + taskId/topicId +
  contractHash + evidenceRevision + gitHead + diffHash
)
```

- 相同 key 的 queued/in-flight/completed Review 不重复执行。
- `manual_review` 带 `force=true` 时增加 nonce，允许绕过去重，但仍记录原 key。
- `file_change` 合并文件集合并生成新 Evidence revision。
- 尚未执行的 `impact_analysis` 吸收同任务 `file_change`。
- contract/evidence 漂移立即取消旧 queued Intent；in-flight 结果到达后按 stale verdict 拒绝。

### 12.4 失败退避

官方 Runtime 完成单次内部重试后若发出 failed/cancelled：

```text
delay = min(5s * 2^(attempt - 1), 5min) + 0..20% jitter
```

- 任务进入 `stalled`，保存 failureClass、attempt、nextRetryAt。
- Scheduler 不设业务重试上限，直到通过、契约失效、用户取消或人工越权。
- 重启时扫描 stalled/queued 事件，恢复到期 Intent。
- Provider 恢复后仍使用同 taskId，但每次尝试使用新 reviewId。

## 13. Completion Gate

### 13.1 状态模型

```ts
type TaskStatus =
  | "inactive"
  | "active"
  | "completion_requested"
  | "advisor_reviewing"
  | "remediation_required"
  | "stalled"
  | "completed"
  | "overridden";

interface TaskState {
  taskId: string;
  projectId: string;
  status: TaskStatus;
  attempt: number;
  contractHash: string;
  contractSource: "tdd" | "lightweight";
  gitHead: string;
  diffHash: string;
  evidenceRevision: string;
  activeReviewId?: string;
  stalledReason?: string;
  nextRetryAt?: string;
  lastVerdict?: ComplianceVerdict;
  override?: ComplianceOverride;
  createdAt: string;
  updatedAt: string;
}
```

### 13.2 状态转换

```text
inactive --bind_contract--> active
active --compliance_complete--> completion_requested
completion_requested --host_accepted--> advisor_reviewing
completion_requested --host_rejected/failed--> stalled
advisor_reviewing --pass--> completed
advisor_reviewing --remediate--> remediation_required
advisor_reviewing --failed/cancelled/no_verdict--> stalled
remediation_required --repair_started--> active
stalled --retry_dispatched--> advisor_reviewing
stalled --user_override--> overridden
```

`completed` 与 `overridden` 都是终态，但语义严格分离。终态只允许创建新任务，不允许旧任务被后续普通 Advisor 文本改写。

### 13.3 Review Envelope

```ts
interface ComplianceReviewEnvelope {
  schemaVersion: 1;
  reviewId: string;
  taskId: string;
  projectId: string;
  contractHash: string;
  evidenceRevision: string;
  gitHead: string;
  diffHash: string;
  contract: TaskContract;
  codebase: CodebaseEvidencePack;
  delegations: DelegationRecord[];
  verificationEvidenceIds: string[];
  unresolvedGaps: string[];
  createdAt: string;
}
```

Envelope 必须先持久化，再请求宿主。只有收到 `accepted` 后状态才进入 `advisor_reviewing`；`deduplicated` 必须关联到同一有效 in-flight Review，否则按协议错误进入 stalled。

### 13.4 Verdict

```ts
interface ComplianceVerdict {
  reviewId: string;
  taskId: string;
  projectId: string;
  contractHash: string;
  evidenceRevision: string;
  gitHead: string;
  diffHash: string;
  verdict: "pass" | "remediate";
  findings: Array<{
    severity: "must_fix" | "should_fix" | "note";
    code: string;
    message: string;
    evidenceIds: string[];
  }>;
  requiredActions: string[];
  submittedAt: string;
}
```

Verdict 工具执行时原子校验全部绑定字段、Review in-flight 状态和当前 Advisor session。重复 verdict 返回相同 receipt，不重复状态转换；不同 payload 的第二次提交视为冲突并记录安全事件。

### 13.5 通过条件

`pass` 只有在以下检查全部为真时生效：

- 契约当前有效且 hash 相同。
- Codebase Pack 当前有效、范围覆盖且无未处理 claim。
- 委派证据或例外有效。
- contract 声明的验证命令都有真实成功 Tool Result。
- 当前 Git HEAD/diff hash 与 Envelope 一致。
- 没有未解决 must-fix、scope violation 或 blocked write。
- verdict 来自当前 Review 的临时工具。

## 14. Brainstorm Review

### 14.1 触发边界

`before_agent_start` 只向主代理注入判断和调用指引，不直接替主代理提交空议题。主代理在实质议题已形成候选结论、约束和成功标准后调用 `brainstorm_topic_ready`。

### 14.2 调度和隔离

- Brainstorm 通过同一 Scheduler 创建 priority 80 的 `brainstorm_review`。
- 代码相关议题要求只读 Codebase Evidence；纯产品/创意议题允许不提供。
- 使用 `brainstorm_review` 临时 verdict 工具，不复用 `compliance_verdict`。
- Advisor failure 后专题进入 `review_unavailable`/stalled 语义并重试，不永久停在 `advisor_reviewing`。
- Brainstorm verdict 永不修改 Completion TaskState。

### 14.3 用户最终决定

`brainstorm_decision` 仅接受当前 topic/review，记录：当前结论、Advisor 异议、遗漏约束、替代方案、用户选择和理由。Advisor 可以 challenged，但不能代替用户决定。

## 15. Evidence 持久化与恢复

### 15.1 目录结构

```text
.omp/compliance/
  project.json
  scheduler.json
  tasks/<taskId>/
    state.json
    contract.json
    events.jsonl
    reviews/<reviewId>.json
    codebase/<evidenceRevision>.json
    delegations/<delegationId>.json
  topics/<topicId>/
    state.json
    events.jsonl
    reviews/<reviewId>.json
  overrides.jsonl
```

### 15.2 写入语义

- `events.jsonl` 使用真正的 append，不再每次读全文件重写。
- snapshot JSON 使用同目录临时文件、fsync（平台允许时）和原子 rename。
- 每个事件有 UUID `eventId`，恢复时按 eventId 幂等去重。
- append 失败时任务立即进入 `stalled`；不能只缓存在内存后继续宣称合规。
- 可保留短期内存 pending buffer 用于重试，但 Completion 通过要求所有关键 Evidence 已落盘。
- 截断的 JSONL 最后一行在恢复时忽略并记录 `recovery_truncated_tail`。

### 15.3 事件公共字段

```ts
interface EvidenceEventBase {
  schemaVersion: 1;
  eventId: string;
  eventType: string;
  projectId: string;
  taskId?: string;
  topicId?: string;
  sessionId: string;
  timestamp: string;
  gitHead?: string;
  diffHash?: string;
  contractHash?: string;
  evidenceRevision?: string;
  reviewId?: string;
}
```

### 15.4 恢复顺序

1. 验证 project binding。
2. 加载 task/topic snapshot。
3. 重放 snapshot 之后的 JSONL 事件。
4. 把无终态的 `advisor_reviewing` 视为未知执行结果，查询本地 Review 文件；无法证明已完成则转 stalled 并重新排队。
5. 恢复 Scheduler queued/stalled Intent。
6. 清理只存在临时文件但未原子提交的 snapshot。

## 16. 人工越权

命令：

```text
/compliance override --reason "<明确原因>"
```

仅用户命令上下文允许执行；模型工具调用和 Advisor 工具调用均拒绝。记录：

```ts
interface ComplianceOverride {
  overrideId: string;
  taskId: string;
  projectId: string;
  operator: "user";
  reason: string;
  gitHead: string;
  diffHash: string;
  contractHash: string;
  evidenceRevision: string;
  missingChecks: string[];
  stalledReason: string;
  createdAt: string;
}
```

越权后：

- TaskState 进入 `overridden`。
- 取消 queued retry，但保留全部历史。
- UI/历史始终显示“人工越权”，不得显示绿色 pass。
- 新 Git diff 或新任务不能继承旧越权。

## 17. 状态与展示

### 17.1 状态栏

建议使用简短稳定状态，不展示内部实现说明：

```text
Advisor: queued · compliance · r3
Advisor: reviewing · compliance
Compliance: remediation required · 2 findings
Compliance: stalled · retry in 40s
Compliance: overridden
```

### 17.2 诊断命令

| 命令 | 输出 |
|---|---|
| `/compliance status` | 当前项目、任务、契约、Evidence revision、Review 状态 |
| `/compliance history` | Review、verdict、失败、重试和越权摘要 |
| `/compliance doctor` | 宿主协议、Advisor、xd、codebase、项目绑定和持久化健康状态 |
| `/compliance rebind` | 显式确认项目路径/remote/codebase 重新绑定 |
| `/compliance override` | 用户人工越权 |

状态命令只读取领域 snapshot，不通过扫描模型消息推断状态。

## 18. 安全与隐私

1. Review metadata、Evidence 和生命周期事件写入前统一脱敏 token、Authorization、URL credential 和常见密钥格式。
2. 完整模型 prompt、Provider response 和 shell 环境变量不得落入 `.omp/compliance`。
3. 工具结果只保存摘要、退出状态、artifact/ref 和必要结构化字段。
4. 项目文件路径保存项目相对路径；项目外路径默认拒绝。
5. Verdict 工具需要无法由主代理猜测复用的当前 Review capability，上下文至少绑定 reviewId 和 Advisor session。
6. Extension hook 超时、Evidence 写失败、schema 解析失败和身份不一致全部失败关闭。

## 19. 测试策略

### 19.1 oh-my-pi 单元测试

新增或扩展：

- `test/advisor/review-protocol.test.ts`
- `test/advisor/run-augmentation.test.ts`
- `test/advisor/runtime-review.test.ts`
- `test/extensions-advisor-events.test.ts`
- Interactive/ACP/task executor action 接线测试

必须覆盖：

- accepted、deduplicated、rejected。
- Review 在批次边界优先，但不打断 in-flight 模型流。
- augmentation 只对单回合有效，成功/失败/取消后均恢复。
- 临时工具不进入主代理或 `xd://`。
- hook timeout、tool conflict、Provider error、quarantine、静默 stop。
- completed 与 verdictSubmitted 分离。
- 所有生命周期字段和终态 exactly-once。
- 现有普通 Advisor delta、late blocker、失败回滚无回归。

### 19.2 omp-custom 单元测试

按模块建立测试：

- capability negotiation 与拒绝激活。
- ProjectBinding 创建、路径变化、remote 冲突和 rebind。
- TDD/轻量契约分类、hash 漂移和路径逃逸。
- direct/MCP/xd tool identity、外内事件去重和伪装拒绝。
- Codebase Pack 完整性、revision 漂移和 affectedFiles 覆盖。
- PreToolPolicy 对 edit/write/bash/task/hub/index_repository 的决策。
- task/hub 委派生命周期、越界、失败、超时和例外。
- Scheduler 优先级、合并、去重、force、退避和重启恢复。
- Completion 全部合法/非法转换、旧 verdict、跨项目 verdict、重复 verdict。
- Brainstorm trigger、代码检索要求、review_unavailable 和用户最终决定。
- Evidence append、原子 snapshot、截断恢复、写失败 stalled。
- override 只能由用户执行且永久可审计。

### 19.3 跨仓契约测试

在 `omp-custom` 中以真实 v17 host package 启动最小会话，验证：

1. 三个控制工具为 essential。
2. discoverable 工具可通过 `xd://` 发现和执行。
3. `compliance_verdict` 仅在专用 Advisor Review 中存在。
4. Advisor 能调用只读 codebase 工具但不能调用 `index_repository`。
5. tool_call 阻止结果真正阻止底层写入。
6. Interactive、ACP、task executor 都可请求 Review。

### 19.4 E2E 场景

| 场景 | 预期 |
|---|---|
| 无 TDD 的多文件修改 | 写前拦截 |
| 无 Codebase Evidence 的 edit | 写前拦截并记录原因 |
| Evidence 范围只含 A，尝试改 B | 拦截并要求影响分析 |
| 无 task/hub 委派的实质任务 | Advisor remediate |
| Advisor 返回 remediate | 生成修复工作包，回到 active |
| Advisor 静默停止 | stalled/no_verdict，不通过 |
| Provider 连续失败 | stalled + 退避重试 |
| 旧 reviewId/contract hash verdict | 拒绝并审计 |
| 进程在 reviewing 时退出 | 重启后 stalled 并重审 |
| trigger 风暴 | Completion 优先且相同 revision 去重 |
| 用户显式 override | overridden，永久记录，不伪装 pass |
| `tools.xdev=false` | essential 控制工具仍可用，否则拒绝激活 |

### 19.5 验证命令

oh-my-pi：

```bash
bun run check:ts
bun run ci:test:coding-agent:runtime
bun run ci:test:smoke
bun run ci:release:build-binaries
```

omp-custom 采用仓库现有脚本，至少执行：

```bash
bun install --frozen-lockfile
bun run check
bun test packages/omp-compliance/test
```

跨仓测试必须固定到本次 oh-my-pi commit，不能依赖机器上偶然安装的全局 OMP。

## 20. 二进制与发布验收

### 20.1 平台

- macOS ARM64。
- Linux x64。

### 20.2 打包要求

- 二进制包含宿主 Advisor Protocol v1 补丁。
- 扩展通过正式发现路径加载，不把 `omp-custom` 源码硬编码进宿主 bundle。
- native addon 与 loader 版本 sentinel 一致。
- 启动时 `/compliance doctor` 能证明协议、扩展、Advisor、codebase 和持久化均可用。

### 20.3 真实验收

选择一个真实多文件开发任务：

1. 绑定正式 TDD。
2. 使用 codebase-memory 产生 Evidence Pack。
3. 通过 task/hub 委派子代理。
4. 故意保留一个验收失败，证明 Advisor 返回 remediate 且 Completion 被阻止。
5. 修复后重新验证并提交新 Review。
6. 获得匹配当前 Envelope 的结构化 pass。
7. 分别在 macOS ARM64 与 Linux x64 复现闭环。

## 21. 迁移和删除策略

### 21.1 迁移顺序

1. `oh-my-pi` 从官方 `v17.0.1` 干净分支实现协议，不合并旧 v16 定制提交。
2. 宿主协议单测与官方 Advisor 回归通过。
3. `omp-custom` 升级 peer dependency 和 Extension 接口。
4. 完成项目身份、Evidence、Scheduler、Codebase 和委派适配。
5. 完成跨仓、故障注入和双平台二进制验收。
6. 两仓更新主线后再删除定制项目维护的 v16 入口。

### 21.2 v16 删除范围

删除：

- `origin` 中定制项目维护的 v16 分支和归档 tag。
- v16 二进制和发布附件。
- v16 Adapter、版本判断、兼容测试和当前文档入口。
- package scripts、CI matrix 和 README 中的 v16 使用说明。

不删除：

- Git 历史中的旧 commit 对象。
- 官方 `upstream` 远端及其历史 tag。
- 为审计保留的迁移记录，但记录必须明确“不可运行、不可发布、不受支持”。

## 22. 分阶段交付门

### Gate 1：官方基线可复现

- 官方 `v17.0.1` 未修改构建和核心测试通过。
- Advisor、`xd://`、`hub` 基线行为有记录。

### Gate 2：宿主协议完整

- 四类通用能力全部实现。
- 所有运行模式完成 action 接线。
- 普通 Advisor 行为无回归。

### Gate 3：扩展 v17 适配

- 无 v16 类型和条件分支。
- essential/discoverable/临时工具分层正确。
- 能力不匹配时拒绝激活。

### Gate 4：监督闭环

- Contract、Codebase、Delegation、Verification 均进入 Envelope。
- pass/remediate/stalled/overridden 状态可恢复、可审计。

### Gate 5：跨仓和二进制

- 跨仓契约、E2E、故障注入全部通过。
- macOS ARM64 与 Linux x64 二进制均通过真实项目闭环。

### Gate 6：主线替换与清理

- v17 结果成为两仓主线。
- 定制项目的 v16 可用入口全部删除。
- README、安装、发布和诊断只描述 v17。

## 23. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 修改 Advisor `#drain()` 导致官方稳定性回归 | 高 | 专用 Review 使用独立工作项，复用原 try/catch/rollback；建立原回归矩阵 |
| augmentation 污染后续回合 | 高 | 独立作用域辅助器 + `try/finally` + 成功/失败/取消测试 |
| 只接交互式模式 | 高 | `ExtensionActions` 必填 + ACP/task executor 接线测试 |
| xd 外层与内部事件重复计数 | 中 | canonical identity + correlation/dedupe |
| MCP 工具名伪装 | 高 | serverId allowlist + 精确 toolName，不按后缀宽松匹配 |
| Evidence 写失败仍放行 | 高 | 关键写入失败直接 stalled，pass 要求落盘确认 |
| 无限重试造成资源消耗 | 中 | 指数退避、jitter、单并发、用户可取消/越权和状态可见 |
| host 与扩展版本漂移 | 高 | Protocol v1 能力协商 + peer dependency + 跨仓锁定测试 |
| shell 目标范围难解析 | 中 | 不可证明只读即按写处理，要求结构化工具或显式范围 |
| 多 Advisor 配置导致裁决不确定 | 中 | v1 只绑定主 Advisor，receipt/lifecycle 携带 advisorSessionId |

## 24. 文件级改动总表

### 24.1 oh-my-pi

预计新增 3 个协议/辅助文件，修改约 8 个核心接线文件，并增加对应测试。核心修改范围严格限制在：

```text
packages/coding-agent/src/advisor/
packages/coding-agent/src/extensibility/extensions/
packages/coding-agent/src/session/agent-session.ts
packages/coding-agent/src/modes/controllers/extension-ui-controller.ts
packages/coding-agent/src/modes/acp/acp-agent.ts
packages/coding-agent/src/task/executor.ts
packages/coding-agent/test/
```

不修改 `packages/agent` 通用 prompt API，不修改 `XdevRegistry` 协议，不把 Compliance 类型放入宿主。

### 24.2 omp-custom

建议目标结构：

```text
packages/omp-compliance/src/
  activation/
    capability-negotiation.ts
  project/
    project-context.ts
    project-identity.ts
  contracts/
    task-contract.ts
    review-envelope.ts
    verdict.ts
  scheduler/
    review-intent.ts
    review-scheduler.ts
    dedupe-key.ts
    retry-policy.ts
  runtime/
    pre-tool-policy.ts
    compliance-runtime.ts
  xdev/
    tool-identity.ts
    event-unwrapper.ts
    codebase-tool-policy.ts
  evidence/
    evidence-repository.ts
    event-log.ts
    snapshot-store.ts
  delegation/
    delegation-supervisor.ts
    delegation-exception.ts
  advisor/
    completion-context.ts
    review-augmentation.ts
    verdict-tools.ts
  brainstorm/
  commands/
  presentation/
  extension.ts
```

现有模块优先迁移和拆分，不要求一次性重命名所有文件。任何重构都必须由行为测试保护，不能为了目录整齐扩大第一阶段改动面。

## 25. 最终验收清单

- [ ] 宿主基于官方 `v17.0.1` 干净重建。
- [ ] Extension 可请求专用 Advisor Review 并收到结构化回执。
- [ ] before-run 上下文和工具严格单回合有效。
- [ ] 7 类生命周期事件字段完整、终态唯一。
- [ ] Completion/Brainstorm 控制工具为 essential。
- [ ] 检索工具可经 `xd://` 使用且 Evidence 去重正确。
- [ ] 裁决工具仅对应 Advisor Review 可见。
- [ ] 项目 UUID、remote、cwd 和 codebase project 绑定有效。
- [ ] 无有效 Codebase Pack 时实质写入被阻止。
- [ ] `task` 与 `hub` 委派都有可验证 Evidence。
- [ ] pass 必须匹配当前 review/task/project/contract/evidence/git/diff。
- [ ] Provider 失败、静默 stop 和无 verdict 均不能通过。
- [ ] stalled 自动退避重试，重启后可恢复。
- [ ] 用户越权为独立 `overridden` 终态并永久审计。
- [ ] Interactive、ACP、task executor 行为一致。
- [ ] macOS ARM64 与 Linux x64 二进制完成真实闭环。
- [ ] `omp-custom` 不含 v16 兼容逻辑和发布入口。
- [ ] 定制 `origin` 中 v16 分支、tag、二进制和当前文档入口已清理。

满足以上全部条件后，才能把本次升级标记为“运行时完成并可发布”；仅完成协议类型、扩展编译或单平台启动，不构成整项完成。
