# OMP Advisor 合规完成门生产闭环修复 TRD

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Technical Requirements Document（TRD） |
| 状态 | 已批准，待实现 |
| 日期 | 2026-07-13 |
| 业务事实源 | `/Users/mima1234/Code/super/omp-custom` |
| 宿主适配仓库 | `/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance` |
| 目标版本 | OMP v16.4.6 / `@bearmaxdd/omp-compliance` 0.1.x |
| 上游设计依据 | `2026-07-13-omp-advisor-compliance-completion-gate-tdd.md` |

## 1. 文档目的

本文定义 Advisor 合规完成门从“组件级测试可通过”修复为“真实安装后生产链路可运行”的技术要求。

修复必须闭合以下链路：

```text
/compliance start <tdd.md>
  -> 采集受管任务 Evidence
  -> compliance_complete
  -> 构造 CompletionSnapshot
  -> 构造 Advisor completion context 与合规规则
  -> 发起一次 compliance_review
  -> advisor_before_run Hook 临时注入上下文和 compliance_verdict
  -> Advisor 返回统一 ComplianceVerdict
  -> ComplianceRuntime.acceptVerdict()
  -> completed | remediation_required | stalled
```

本文同时修复以下已确认问题：

1. 扩展没有把 verdict sink 注册到真实 `AgentSession`；
2. 默认 Advisor 无法获得 `compliance_verdict`；
3. completion context 和默认规则包没有生产调用者；
4. fork 与扩展的 verdict 协议不兼容；
5. 未启动受管任务时扩展仍创建 `.omp/compliance`；
6. 成功的 `index_repository` 不能形成 index-ready Evidence。

## 2. 当前状态与根因

### 2.1 当前扩展侧状态

`@bearmaxdd/omp-compliance` 已具备：

- TDD 合同加载、合同 hash 和执行政策；
- 状态机、Evidence store、脱敏和 fingerprint；
- codebase-memory、TaskTool、验证命令采集；
- completion snapshot；
- Advisor context、规则包和完整 verdict schema；
- remediation 回送、status/history/resume/stop；
- 组件级和 fake 边界行为测试。

但当前 `extension.ts` 只注册命令、工具与被动事件处理器。它没有向真实 OMP Advisor runtime 注册 sink，也没有触发专用 Advisor review。`buildCompletionContext()` 与 `renderCompletionRules()` 只在测试中被调用。

### 2.2 当前 fork 侧状态

fork 已增加：

- `AgentSessionConfig.complianceVerdictSink`；
- `ComplianceVerdictTool`；
- `AgentSession.#buildAdvisorRuntime()` 中的条件注入；
- 两组桥接单元测试。

该实现仍不能形成生产闭环：

- sink 只在测试构造 `AgentSession` 时手工传入；
- 没有 ExtensionAPI 到 `AgentSessionConfig` 的接线；
- 注入受 `names.has("compliance_verdict")` 限制，而默认工具集合不包含该名称；
- 测试检查了可见名称，没有启动真实 Advisor 并执行临时工具；
- fork 使用简化协议，无法被扩展完整 schema 接受。

### 2.3 根本原因

当前方案把合规能力建模为 `AgentSession` 长期配置，但合规 verdict 实际上是一次 completion review 的临时能力。长期字段导致扩展生命周期、Advisor 工具选择、任务 attempt 与 verdict sink 之间缺乏清晰绑定。

本 TRD 将其改为一次性 `advisor_before_run` Hook：只有专用 `compliance_review` 才注入上下文和工具，普通 Advisor 运行保持官方行为。

## 3. 设计原则

### 3.1 业务所有权

- `omp-custom` 是合同、Evidence、规则、状态和 verdict 语义的唯一事实源。
- fork 只提供窄 Hook 与专用 review 请求入口。
- fork 不复制合规状态机，不解释 pass/remediate，不持久化合规 Evidence。

### 3.2 临时能力

- `compliance_verdict` 只能存在于单次 `compliance_review` Advisor run。
- 不加入 `ADVISOR_DEFAULT_TOOL_NAMES`。
- 不进入 `/advisor configure` 的持久工具列表。
- 不保存为长期 `AgentSession` 工具。

### 3.3 失败关闭

- 没有合法 Advisor verdict 时不得完成。
- Hook、Advisor 或 Evidence 失败不得降级为普通 `advise`。
- 协议不匹配、过期 attempt 和重复 verdict 必须显式拒绝并留 Evidence。

### 3.4 最小宿主改动

- 不增加通用 `registerAdvisorTool()`。
- 不改变 Advisor 模型、重试、delta、backlog、Emission Guard 或普通 advice 路由。
- 不引入严格模型路由、PlanRun 或角色绑定逻辑。

## 4. 目标架构

### 4.1 总体组件

```text
@bearmaxdd/omp-compliance
  ComplianceRuntime
  CompletionGate
  CompletionContextBuilder
  DefaultRulePack
  ComplianceVerdictSchema
  ComplianceAdvisorHook
            |
            | ExtensionAPI
            v
OMP v16.4.6 fork
  ExtensionRunner
  AdvisorReviewRequestQueue
  AdvisorBeforeRunHookDispatcher
  AdvisorRuntime
```

### 4.2 职责边界

| 组件 | 仓库 | 职责 | 不负责 |
| --- | --- | --- | --- |
| `ComplianceRuntime` | omp-custom | 管理合同、任务状态、completion、verdict 和 remediation | 创建 Advisor、选择模型 |
| `ComplianceAdvisorHook` | omp-custom | 为当前 review envelope 构造临时上下文和工具 | 修改普通 Advisor run |
| `CompletionContextBuilder` | omp-custom | 稳定渲染合同、Evidence、声明和历史修复 | 裁决 pass/remediate |
| `ExtensionAPI` Hook | fork | 注册/注销 Hook，发起专用 review | 理解合规协议语义 |
| `AdvisorBeforeRunHookDispatcher` | fork | 在 Advisor 真正运行前合并附加上下文和工具 | 持久化合规状态 |
| `AdvisorRuntime` | fork | 按官方语义执行 Advisor turn | 本地推断任务是否完成 |

## 5. `advisor_before_run` Hook 合同

### 5.1 Hook 输入

```ts
type AdvisorRunTrigger = "turn_end" | "compliance_review";

interface AdvisorBeforeRunEvent {
  sessionId: string;
  advisorId: string;
  trigger: AdvisorRunTrigger;
  messages: readonly AgentMessage[];
  metadata?: Readonly<Record<string, unknown>>;
}
```

要求：

- `sessionId` 必须是当前 `AgentSession` 的稳定 ID；
- `advisorId` 区分默认和命名 Advisor；
- `messages` 为只读快照；
- `metadata` 只允许 JSON 可序列化值；
- `compliance_review` metadata 至少包含 `taskId`、`contractHash`、`attempt` 和 `reviewId`。

### 5.2 Hook 输出

```ts
interface AdvisorBeforeRunResult {
  additionalSystemContext?: readonly string[];
  additionalTools?: readonly AgentTool[];
  metadata?: Readonly<Record<string, unknown>>;
}
```

合并规则：

1. Hook 只能追加，不能删除、替换或重排官方 system prompt、messages 和 tools；
2. 附加工具名不得与官方工具或其他 Hook 工具冲突；
3. 同一 `reviewId` 的 `compliance_verdict` 最多出现一次；
4. Hook 返回对象在合并前复制并冻结，防止执行期修改；
5. Hook 返回 `undefined` 表示无附加内容；
6. 多 Hook 按扩展加载顺序执行，但任一非法结果使专用 review 失败关闭。

### 5.3 注册生命周期

建议 ExtensionAPI 暴露：

```ts
interface ExtensionAPI {
  on(
    event: "advisor_before_run",
    handler: (event: AdvisorBeforeRunEvent) =>
      | AdvisorBeforeRunResult
      | Promise<AdvisorBeforeRunResult | undefined>
      | undefined,
  ): ExtensionSubscription;

  requestAdvisorReview(request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt>;
}
```

`ExtensionSubscription.dispose()` 必须在扩展卸载、session dispose 或 reload 时注销 Hook。禁止使用进程级静态 sink。

## 6. 专用 Advisor Review 请求

### 6.1 请求结构

```ts
interface AdvisorReviewRequest {
  trigger: "compliance_review";
  reviewId: string;
  metadata: {
    taskId: string;
    contractHash: `sha256:${string}`;
    attempt: number;
  };
}

interface AdvisorReviewReceipt {
  accepted: boolean;
  reviewId: string;
  reason?: "advisor_disabled" | "advisor_unavailable" | "duplicate";
}
```

### 6.2 队列语义

- 请求进入现有 Advisor 串行队列，不创建第二套运行器。
- `compliance_review` 不依赖新的主代理 turn。
- 同一 `reviewId` 重复请求返回相同 receipt，不重复执行。
- 普通 `turn_end` delta 继续按官方逻辑执行。
- 专用 review 失败不能吞掉后续普通 Advisor update。

### 6.3 Advisor 不可用

当 Advisor 关闭、无可用模型或 runtime 无法建立时：

- request 返回 `accepted: false`；
- 扩展记录 `advisor_unavailable`；
- 任务保持 `advisor_reviewing`；
- UI/status 提示用户启用或修复 Advisor；
- 不调用普通 `advise` 模拟 verdict。

## 7. 扩展侧生产接线

### 7.1 激活阶段

`activate()` 只允许：

- 创建无持久化副作用的内存 runtime/collector；
- 注册 `/compliance` 命令；
- 注册 `compliance_complete` 工具；
- 注册被动 tool/turn 事件处理器；
- 注册 `advisor_before_run` Hook。

激活阶段禁止：

- 创建 `.omp/compliance`；
- 写 state/evidence；
- 注入 Advisor 工具；
- 发送主代理消息。

### 7.2 启动受管任务

只有 `/compliance start <tdd.md>` 成功加载合同后才：

1. 创建 `.omp/compliance/tasks/<task_id>/`；
2. 写入初始 state 和 active Evidence；
3. 建立当前 session 的 active task binding；
4. 允许后续 `compliance_complete` 发起 review。

### 7.3 Completion 请求

`ComplianceRuntime.requestCompletion()` 必须：

1. 校验 task 为 active；
2. 转换到 `advisor_reviewing`；
3. 构造 `CompletionSnapshot`；
4. 调用 `buildCompletionContext(snapshot)`；
5. 调用 `renderCompletionRules(policy)`；
6. 建立不可变 `ComplianceReviewEnvelope`；
7. 写入 `completion_requested` Evidence；
8. 调用 `requestAdvisorReview()`；
9. 保存 receipt；
10. 在请求被拒绝时记录错误并保持未完成。

```ts
interface ComplianceReviewEnvelope {
  reviewId: string;
  sessionId: string;
  taskId: string;
  contractHash: `sha256:${string}`;
  attempt: number;
  context: string;
  rules: string;
  createdAt: string;
}
```

### 7.4 Hook 处理

扩展 Hook 仅当以下条件全部满足时返回附加内容：

- `event.trigger === "compliance_review"`；
- metadata 指向当前 active/reviewing task；
- reviewId 对应未完成 envelope；
- taskId、contractHash、attempt 全部一致；
- sessionId 与当前 runtime 绑定一致。

返回：

```ts
{
  additionalSystemContext: [envelope.rules, envelope.context],
  additionalTools: [createComplianceVerdictTool(envelope, runtime)],
  metadata: { complianceReviewId: envelope.reviewId }
}
```

工具闭包直接调用 `runtime.acceptVerdict()`，不经过自由文本或正则解析。

## 8. 统一 Verdict 协议

两仓仅保留以下协议：

```ts
interface ComplianceVerdict {
  schema_version: 1;
  task_id: string;
  contract_hash: `sha256:${string}`;
  attempt: number;
  status: "pass" | "remediate";
  findings: ComplianceFinding[];
}

interface ComplianceFinding {
  id: string;
  reason: string;
  required_fix?: string;
  evidence_refs?: string[];
}
```

约束：

- `pass` 可以有说明性 finding，但不得含未关闭的 `required_fix`；
- `remediate` 至少有一个非空 `required_fix`；
- task、hash、attempt 必须与工具闭包绑定值一致；
- verdict 工具先做 schema 校验，再调用 runtime；
- runtime 再做上下文、幂等、过期 attempt 和 post-pass lock 校验；
- 删除 fork 的 `task/hash/action/requiredFix` 简化协议。

## 9. 状态与幂等

### 9.1 状态要求

```text
active
  -> completion_requested
  -> advisor_reviewing
  -> completed
     | remediation_required
     | stalled
```

只有合法 `status: pass` 可以进入 `completed`。

### 9.2 Review 标识

`reviewId` 必须由稳定字段派生或以 UUID 生成，并与 `(sessionId, taskId, contractHash, attempt)` 唯一绑定。

### 9.3 重复与迟到结果

- 同一 reviewId 只接受一个 verdict；
- 重复相同 verdict 返回幂等成功或明确 duplicate，不重复写完成 Evidence；
- 旧 attempt verdict 记录 protocol error；
- pass 后迟到 remediate 不回滚 completed；
- session dispose 后的 verdict 必须拒绝。

## 10. Codebase-memory Evidence 修复

### 10.1 支持的索引就绪来源

以下任一成功结果可建立 `indexReady: true`：

1. `index_repository` 返回 `status: indexed` 或 `status: ready`；
2. `index_status` 返回 `status: ready`；
3. `index_status` 返回布尔 `ready: true`。

仅调用但没有成功 result 不能建立就绪事实。

### 10.2 工具名规范化

必须识别：

- 短名：`index_repository`；
- MCP FQN：`mcp__codebase_memory_mcp__index_repository`；
- 点号/斜线命名变体；
- deferred MCP wrapper 中可验证的 server/tool metadata。

必须拒绝：

- 其他 server 的同名工具；
- 普通文本中出现工具名；
- 缺少配对 result 的调用；
- `isError: true` 或明确失败状态。

### 10.3 完整 Evidence 条件

代码任务的 codebase-memory Evidence 只有同时满足以下条件才为 `present`：

- index ready；
- 至少一次成功的 `search_graph` 或 `search_code`；
- 至少一次成功的 `get_code_snippet` 或 `trace_path`；
- 至少一个可追溯文件、符号或调用链引用。

Collector 只计算事实，不直接产生 pass/remediate。

## 11. 持久化副作用修复

### 11.1 延迟初始化

`EvidenceStore` 必须支持 lazy open。构造对象不得创建目录或文件。

### 11.2 创建时点

允许创建目录的首个时点是合同加载成功且任务 ID 已确定之后。

### 11.3 关闭/未受管场景

以下场景必须零持久化副作用：

- 只 import 扩展；
- 调用 `activate()` 但不执行 `/compliance start`；
- extension disabled；
- 合同加载失败；
- 普通聊天和普通 Advisor run。

## 12. 错误处理

| 错误 | 状态 | Evidence | 用户可见行为 |
| --- | --- | --- | --- |
| Advisor disabled/unavailable | 保持 `advisor_reviewing` | `advisor_unavailable` | status 显示修复建议 |
| Hook 未注册 | 保持未完成 | `hook_unavailable` | completion 返回失败 |
| Hook 超时/抛错 | 保持未完成 | `hook_error` | 可重新请求 review |
| Hook 返回冲突工具 | 保持未完成 | `hook_contract_error` | 不执行 Advisor run |
| verdict schema 非法 | 保持 `advisor_reviewing` | `protocol_error` | 不注入 remediation |
| task/hash/attempt 不匹配 | 保持 `advisor_reviewing` | `protocol_error` | 拒绝 verdict |
| Evidence 写入失败 | 不得 completed | `pending warning` | status 显示持久化失败 |
| 重复 verdict | 状态不变 | 可选 duplicate 记录 | 幂等返回 |

Hook 失败后的附加 context/tools 必须丢弃，不能污染下一次 Advisor run。

## 13. 测试要求

### 13.1 `omp-custom` 单元测试

必须覆盖：

- `activate()` 不创建目录；
- `/compliance start` 才创建任务目录；
- completion request 调用 context builder、rule renderer 和 review API；
- Hook 只处理当前 `compliance_review`；
- 普通 `turn_end` 返回 `undefined`；
- 完整 verdict schema 和上下文校验；
- index_repository/index_status/FQN/deferred MCP；
- Hook unavailable、Advisor unavailable 和 Evidence failure。

### 13.2 fork 单元测试

必须覆盖：

- `advisor_before_run` 只追加、不替换；
- 工具名冲突拒绝；
- Hook 超时和异常隔离；
- `turn_end` 不注入合规工具；
- `compliance_review` 注入一次性工具；
- reviewId 幂等；
- Hook dispose 后不再调用；
- 普通 Advisor retry、Emission Guard 和 advice 行为不变。

### 13.3 跨仓集成测试

集成测试必须：

1. 构建并打包 `@bearmaxdd/omp-compliance`；
2. 通过真实 OMP extension loader 加载包；
3. 创建真实 `AgentSession`；
4. 执行 `/compliance start`；
5. 记录最小 Evidence；
6. 调用 `compliance_complete`；
7. 捕获实际 Advisor 输入；
8. 断言 context/rules 和临时工具存在；
9. 执行临时 verdict 工具；
10. 验证 pass/remediate 状态与 Evidence。

禁止：

- 直接给 `AgentSession` 构造器注入 mock sink 代替扩展加载；
- 直接调用 Collector 内部方法伪造完整证据；
- 直接调用 `runtime.acceptVerdict()` 代替 Advisor 工具路径；
- 使用真实在线 LLM 作为自动测试前提。

### 13.4 回归测试

必须重跑：

- Advisor visibility/config/runtime；
- extensibility；
- TaskTool；
- extension disabled；
- ordinary turn_end Advisor；
- 安装和打包 smoke。

## 14. 质量门与验收命令

### 14.1 独立扩展

```bash
cd /Users/mima1234/Code/super/omp-custom/packages/omp-compliance
bun test
bun run check
bun run build
```

`bun test` 必须使用默认 timeout 通过，不能以提高全局 timeout 掩盖安装测试问题。

### 14.2 v16.4.6 fork

```bash
cd /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance
bun test packages/coding-agent/test/advisor
bun test packages/coding-agent/test/extensibility
bun test packages/coding-agent/test/task/task-spawn.test.ts
bun --cwd=packages/coding-agent run check
```

### 14.3 跨仓闭环

必须提供单一命令运行真实扩展加载集成测试，例如：

```bash
bun test packages/coding-agent/test/integration/omp-compliance-advisor-hook.test.ts
```

实际文件名可在实现计划中细化，但不得拆成两个互不相连的 mock 测试冒充闭环。

### 14.4 Git 与范围

```bash
git -C /Users/mima1234/Code/super/omp-custom diff --check
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance diff --check
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance diff \
  v16.4.6 -- packages/coding-agent/src/codex-plan-run \
              packages/coding-agent/src/task/model-routing.ts
```

最后一个命令必须为空。`.codebase-memory/` 和 `.omp/compliance/` 不进入业务提交。

## 15. 完成定义

以下条件必须全部满足：

1. 真实扩展加载后可注册 `advisor_before_run` Hook；
2. `compliance_complete` 会触发一次专用 Advisor review；
3. Advisor 实际输入包含 completion context 和默认规则；
4. `compliance_verdict` 只在该次 review 可见；
5. 两端使用同一完整 `ComplianceVerdict`；
6. 合法 pass 才能 completed；
7. remediate 可回送结构化修复项；
8. 普通 Advisor run 不受影响；
9. 扩展激活但未 start 时不创建运行目录；
10. 成功 index_repository 可建立 index-ready Evidence；
11. 默认测试、check、build 和 diff 检查全部通过；
12. 跨仓真实集成测试通过；
13. 图谱中 `buildCompletionContext()`、`renderCompletionRules()` 和 `acceptVerdict()` 均存在生产入站调用；
14. fork 核心 diff 仅包含 Hook、review 请求入口、协议适配和必要测试；
15. 现有严格路由、PlanRun、模型锁和角色批量分配未迁入新基线。

## 16. 迁移与兼容

### 16.1 删除旧桥接

实现 Hook 后删除：

- `AgentSessionConfig.complianceVerdictSink`；
- `AgentSession.#complianceVerdictSink`；
- 构造器长期 sink 赋值；
- `getAdvisorAvailableToolNames()` 中伪造的 verdict 名称；
- 依赖长期 sink 的旧桥接测试；
- fork 简化 verdict 协议。

### 16.2 保留兼容

- 未安装扩展时行为与官方 v16.4.6 一致；
- 已安装但未启动受管任务时只新增命令/工具声明，不产生运行副作用；
- 普通 Advisor 默认仍是 `read, grep, glob`；
- 原有 `advise` 和 Advisor config 不变；
- 已有 Evidence schema 保持可读，新增事件向后兼容。

### 16.3 上游升级

每次升级必须重新探测官方是否已经提供 Advisor pre-run Hook。若上游出现等价 API：

1. 先新增回归测试覆盖现有闭环；
2. 切换到官方 API；
3. 删除 fork Hook 补丁；
4. 运行完整跨仓验收；
5. 更新 upgrade runbook。

## 17. 明确不在本次修复范围

- 通用 Advisor plugin SDK；
- 允许扩展替换 Advisor prompt/messages/tools；
- Advisor 写文件、执行 shell、浏览器或 TaskTool；
- 严格角色模型路由或 fallback 禁止；
- PlanRun、DAG 或阶段账本；
- 在线 LLM 作为 CI 必需依赖；
- 修改普通聊天的完成语义；
- 把运行 Evidence 或 codebase 图谱提交到业务代码提交。

## 18. 需求追踪矩阵

| 问题 | 设计章节 | 核心验证 |
| --- | --- | --- |
| sink 未接真实 AgentSession | 5、6、7 | 真实 loader + AgentSession 集成测试 |
| 默认 Advisor 无 verdict 工具 | 5、7 | compliance review 临时工具测试 |
| context/rules 无生产调用 | 7.3、7.4 | 调用链与 Advisor 输入断言 |
| verdict 协议不兼容 | 8 | 两仓共享 fixture/schema 测试 |
| 激活即创建目录 | 7.1、11 | activate 零文件副作用测试 |
| index_repository 不 ready | 10 | 工具名与成功结果矩阵 |
| 质量门失败 | 14 | 默认 test/check/build |

## 19. 实施顺序约束

建议后续实现计划按以下依赖顺序拆解：

1. 统一 verdict 协议与共享 fixtures；
2. fork 增加 `advisor_before_run` Hook；
3. fork 增加专用 `requestAdvisorReview()`；
4. 扩展实现 Hook adapter 和 review envelope；
5. 接通 context/rules 生产调用；
6. 延迟 Evidence store 初始化；
7. 修复 codebase-memory 归一化；
8. 编写跨仓真实集成测试；
9. 删除旧长期 sink 桥接；
10. 清理两仓质量门并执行总验收。

步骤 2-5 必须连续完成，禁止把只有 Hook 类型、没有生产调用的中间状态声明为可用。
