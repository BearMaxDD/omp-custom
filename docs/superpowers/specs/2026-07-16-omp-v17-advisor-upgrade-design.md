# OMP v17 Advisor 合规监督升级设计

> 日期：2026-07-16
> 状态：已确认
> 适用仓库：`BearMaxDD/oh-my-pi`、`BearMaxDD/omp-custom`
> 最低宿主版本：Oh My Pi `v17.0.1`

## 1. 背景

当前定制宿主以官方 `v16.4.8` 为共同基线，叠加了 13 个 Advisor 协议与合规接线提交。官方 `v17.0.1` 已在 Advisor 运行稳定性、工具隔离、延迟建议送达、上下文增量合并、失败回滚和静默审查处理方面进行了大幅增强，同时引入以下架构变化：

- 使用 `essential` 与 `discoverable` 两级工具加载模型。
- 以 `xd://` 取代 BM25 工具发现和 MCP 单工具选择机制。
- 将 `irc`、`job` 和 `launch` 合并为 `hub`。
- 使用 `xd://propose`、`xd://resolve` 和 `xd://reject` 承载计划审批动作。
- Extension 和 Custom Tool 默认以 `discoverable` 模式加载。

旧定制功能不能直接通过合并或逐提交 rebase 搬入 v17。升级必须以官方 `v17.0.1` 为干净基线，重新建立最小、通用、可持续跟版的 Advisor 扩展协议，并让全部监督政策继续留在独立 `omp-custom` 仓库。

## 2. 目标

本次升级必须完整保留并升级以下能力：

- Completion Gate。
- Brainstorm Advisor 评审。
- 多 trigger 监督调度。
- Evidence 收集与持久化。
- 正式 TDD 与轻量任务契约监管。
- 子代理任务分配与完成证据监管。
- Codebase-First 代码定位和影响分析。
- Advisor 失败关闭、自动恢复和可审计人工越权。
- macOS ARM64 与 Linux x64 二进制交付。

系统仅支持 OMP `v17.0.1+`，不提供 v16 运行、发布、测试或兼容入口。

## 3. 非目标

- 不保留 v16 兼容 Adapter。
- 不维护 `legacy/v16` 分支。
- 不把 TDD、Evidence 或 Completion 状态机并入 OMP 核心。
- 不重写 Git 历史以删除旧 commit 对象。
- 不把所有扩展工具强制迁移到 `xd://`。
- 不复制官方 v17 已实现的 Advisor quarantine、delta coalescing、失败回滚或 late blocker 逻辑。
- 不允许主代理直接调用 Advisor 裁决工具。

## 4. 核心决策

| 决策 | 结论 |
|---|---|
| 支持版本 | 仅支持 `v17.0.1+` |
| 迁移方式 | 从官方 `v17.0.1` 创建干净分支并重新接线 |
| 宿主补丁 | 只保留通用 Advisor 最小协议补丁 |
| 工具接入 | 控制面 essential、检索面 `xd://`、裁决面临时注入 |
| 失败策略 | 默认失败关闭，允许可审计人工越权 |
| 多 trigger | 单 Advisor Runtime、优先级队列、Evidence revision 去重 |
| 子代理 | 实质任务强制委派，允许可审计例外 |
| TDD | 实质任务绑定正式 TDD，微小任务使用轻量契约 |
| 代码定位 | Codebase-First 硬门，禁止无图谱证据开始实质修改或通过 |
| v16 清理 | 删除分支、tag、产物、兼容代码和文档入口，保留历史对象 |

## 5. 目标架构

```text
用户 / 主代理
    |
    v
oh-my-pi v17.0.1+ 宿主
    |-- 官方 Agent / Advisor Runtime
    |-- Extension Runner
    |-- xd:// / hub
    `-- 最小 Advisor 扩展协议
            |
            v
omp-custom 独立监督扩展
    |-- Contract Binder
    |-- Codebase Evidence
    |-- Delegation Supervisor
    |-- Review Scheduler
    |-- Completion Gate
    |-- Brainstorm Review
    |-- Evidence Store
    `-- Status / History / Override
```

架构原则：

1. OMP 宿主提供机制，不解释 Compliance 业务语义。
2. `omp-custom` 拥有全部监督政策和状态。
3. 官方 Advisor Runtime 负责可靠执行，`omp-custom` 负责决定任务是否合规完成。
4. 主代理不能自证完成，Advisor Runtime 正常结束也不等于 Compliance 通过。
5. 只有与当前 Review Envelope 匹配的结构化 `pass` verdict 才能开放完成门。

## 6. 仓库与分支模型

升级完成后的有效分支模型：

```text
oh-my-pi
  main           当前可发布的 v17 定制主线
  upstream/main  官方最新主线
  work/*         短期工作分支

omp-custom
  main           仅支持 OMP v17.0.1+
  work/*         短期工作分支
```

迁移工作分支：

```text
oh-my-pi:   work/v17-advisor-protocol
omp-custom: work/v17-omp-custom-adapter
```

旧 v16 分支只在迁移过程中作为只读参考。v17 完成验收并替换 `main` 后，删除 `origin` 中由定制项目维护的所有 v16 分支、归档 tag、二进制、兼容代码及当前文档入口。官方 `upstream` 仓库及其 tag 不在删除范围内；本地 fetch 后出现的官方历史引用不构成受支持入口。

## 7. 宿主最小协议补丁

### 7.1 Review 请求

```ts
interface AdvisorReviewRequest {
  reviewId: string;
  trigger: AdvisorRunTrigger;
  priority: number;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

interface AdvisorReviewReceipt {
  reviewId: string;
  status: "accepted" | "deduplicated" | "rejected";
  reason?: string;
}
```

Extension API 提供 `requestAdvisorReview(request)`，将专用 Review Intent 加入官方 Advisor Runtime。宿主不得读取 TDD、Evidence 或 Compliance 状态。

### 7.2 回合前增强

`advisor_before_run` 根据 `reviewId` 返回一次性增强内容：

- `additionalSystemContext`。
- `additionalTools`。
- `requestedToolNames` 或等价的只读设备授权。
- Review metadata。

增强结果只对当前 Advisor 回合有效，不得污染后续普通 Advisor turn。

### 7.3 生命周期事件

宿主至少发射：

- `advisor_review_queued`。
- `advisor_run_started`。
- `advisor_tool_call`。
- `advisor_tool_result`。
- `advisor_run_completed`。
- `advisor_run_failed`。
- `advisor_run_cancelled`。

事件必须包含 `reviewId`、trigger、Advisor session、主 session、时间和必要的失败摘要。

### 7.4 最终回执

必须区分：

- 模型回合正常结束。
- 结构化裁决已经提交。
- Provider 或 hook 失败。
- Review 被取消。
- Review 因去重未重新执行。

静默停止只代表模型回合结束，不能表示 Compliance `pass`。

## 8. omp-custom 模块边界

```text
src/
  activation/    扩展注册和宿主能力协商
  contracts/     TDD、Review、Verdict、Evidence 契约
  scheduler/     trigger 优先级、去重、合并和退避
  compliance/    Completion Gate 与任务状态机
  brainstorm/    专题审查与用户最终决策
  evidence/      信号采集、规范化和持久化
  delegation/    task/hub 子代理监管
  advisor/       Review Envelope、规则包和临时工具
  xdev/          只读设备发现和授权边界
  commands/      状态、历史、诊断和人工越权
  presentation/  TUI 状态与结果展示
```

各模块通过显式契约通信。Review Scheduler 不直接修改任务状态；领域处理器不直接操作官方 Advisor 队列；Evidence Store 不负责判定任务通过。

## 9. 工具分层与 xd://

### 9.1 控制面工具

以下工具使用 `loadMode: "essential"`，始终作为主代理顶层工具：

- `compliance_complete`。
- `brainstorm_topic_ready`。
- `brainstorm_decision`，或具备同等可靠性的命令入口。

即使 `tools.xdev=false` 或用户显式指定 `--tools`，完成门的必需控制入口也必须存在或明确拒绝启动 Compliance 能力。

### 9.2 检索面工具

Codebase、Evidence 历史、手动影响分析和诊断工具使用 `discoverable`，通过 `xd://` 按需读取和执行。

### 9.3 裁决面工具

- `compliance_verdict`。
- `brainstorm_review`。

裁决工具只在对应 Advisor 回合临时注入，不注册为主代理普通工具，也不作为全局 `xd://` 设备暴露。主代理不得拥有完成裁决权限。

## 10. Codebase-First 硬门

### 10.1 项目身份与隔离

扩展首次在项目中激活时，在 `.omp/compliance/project.json` 创建或读取稳定项目 UUID。项目 UUID 与规范化仓库根路径、Git remote identity 和 codebase-memory projectId 绑定。

- 不允许以进程启动目录代替持久项目身份。
- Session 切换时必须重新验证项目绑定。
- TDD、Evidence、Review、子代理任务和 verdict 必须携带同一 projectId。
- 跨项目 Evidence 或 verdict 一律拒绝，不得自动迁移到当前任务。
- 项目路径变化时通过显式重绑定流程更新路径，不生成新的逻辑项目。

### 10.2 定位流程

凡任务涉及源码、接口、配置接线、迁移或测试影响，必须先执行：

```text
index_status
  -> get_architecture / search_graph
  -> get_code_snippet
  -> trace_path / query_graph（跨模块时）
  -> Codebase Evidence Pack
  -> 才允许实质修改或 Advisor 裁决
```

允许 Advisor 使用的只读 codebase 工具：

- `index_status`。
- `get_architecture`。
- `search_graph`。
- `search_code`。
- `trace_path`。
- `get_code_snippet`。
- `query_graph`。

`index_repository` 会更新图谱，属于写操作，只能由主代理或受控维护流程调用，不得授权给 Advisor。

```ts
interface CodebaseEvidence {
  projectId: string;
  indexRevision: string;
  queriedAt: string;
  symbols: Array<{
    qualifiedName: string;
    file: string;
    line?: number;
  }>;
  traces: Array<{
    source: string;
    target: string;
    direction: "inbound" | "outbound";
  }>;
  affectedFiles: string[];
  unresolvedClaims: string[];
}
```

硬门规则：

- 没有有效 Codebase Evidence Pack，不得开始实质代码修改。
- 图谱不可用或过期时，代码任务进入 `stalled`。
- Advisor 对代码声明必须引用真实图谱和工具结果。
- 实际修改超出声明范围时，必须重新执行影响分析。
- 不允许静默降级为仅靠自然语言或 grep 猜测架构。

### 10.3 写入前拦截

`pre_tool_use` 在执行写入或代码变更前检查当前任务的 Codebase Evidence：

- `edit`、`write`、`ast_edit` 和其他文件修改工具必须命中已分析范围。
- `bash`、`eval` 或 `hub` 中可能修改源码的调用必须声明目标范围并关联 Evidence revision。
- `task` 或 `hub` 委派实质开发任务时，必须携带 Codebase Evidence Pack 或其不可变引用。
- 新增文件必须位于契约允许的目录范围；无法从既有符号推导时，必须在 Evidence 中说明新增边界。
- 实际目标超出 Evidence affectedFiles 或契约 scope 时，拦截调用并要求重新运行影响分析。

只读检索、图谱更新和明确的 Evidence 修复流程不受该写入门阻塞。拦截结果必须作为结构化事件写入 Evidence，不能只向模型返回自然语言警告。

## 11. TDD 与轻量任务契约

```ts
interface TaskContract {
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
}
```

规则：

- 多文件开发、行为变更、迁移和架构调整必须绑定正式 TDD。
- 单文件、低风险且不改变公共行为的修改可使用轻量契约。
- 正式 TDD 通过绝对路径与 SHA-256 绑定。
- 契约发生变化时，现有 Review Envelope 和 verdict 立即失效。
- Completion Gate 只验证当前 contract hash。

## 12. 子代理监管

实质代码修改、测试、迁移或多文件分析必须通过 `task` 或 `hub` 委派子代理。子代理必须接收：

- 工作包范围。
- 允许修改的文件集合。
- TDD 契约摘要。
- Codebase Evidence revision。
- 验收条件和验证命令。

有效子代理 Evidence 包含：

- 子代理身份、模型和角色。
- 分配范围与文件所有权。
- 真实工具调用和结果。
- 实际修改与验证状态。
- 完成、失败、取消或超时状态。

主代理必须在集成后重新执行跨模块验证，不能直接把子代理自然语言结论作为最终 Evidence。

允许的可审计例外：

```ts
interface DelegationException {
  taskId: string;
  reason:
    | "trivial_change"
    | "unsafe_to_parallelize"
    | "emergency_fix"
    | "environment_unavailable";
  explanation: string;
  approvedBy: "user" | "advisor";
  createdAt: string;
}
```

无有效委派 Evidence 且无合法例外时，Advisor 必须返回 `remediate`。

## 13. Trigger 调度

```ts
interface ReviewIntent {
  reviewId: string;
  trigger:
    | "compliance_review"
    | "manual_review"
    | "brainstorm_review"
    | "git_pre_push"
    | "impact_analysis"
    | "file_change"
    | "scheduled";
  taskId?: string;
  topicId?: string;
  evidenceRevision: string;
  contractHash?: string;
  priority: number;
  createdAt: string;
}
```

优先级：

| Trigger | 优先级 |
|---|---:|
| `compliance_review` | 100 |
| `manual_review` | 90 |
| `brainstorm_review` | 80 |
| `git_pre_push` | 70 |
| `impact_analysis` | 60 |
| `file_change` | 40 |
| `scheduled` | 20 |

去重键由 trigger、项目 UUID、任务或专题 ID、contract hash、Evidence revision 和 Git HEAD 共同计算。

调度规则：

- 共用一个顶级 Advisor Runtime。
- 相同去重键只执行一个 Review。
- `file_change` 合并受影响文件集合。
- `impact_analysis` 可吸收未运行的 `file_change`。
- `git_pre_push` 强制刷新 diff 和影响范围。
- `compliance_review` 不与其他 trigger 合并。
- `manual_review` 可显式绕过去重缓存。
- 已开始的模型流不强制中断，队列阶段允许高优先级重排。

## 14. Completion Gate

状态机：

```text
inactive
  -> active
  -> completion_requested
  -> advisor_reviewing
  -> remediation_required -> active
  -> completed
  -> stalled -> advisor_reviewing
  -> stalled -> overridden
```

通过条件必须同时满足：

1. 当前 TDD 或轻量契约有效。
2. Codebase Evidence Pack 有效。
3. 实质任务存在子代理 Evidence 或批准的例外。
4. 测试、构建和静态检查有真实 Tool Result。
5. 实际改动未越界，或越界后已重新分析。
6. Advisor 调用了当前 Review 专属 `compliance_verdict`。
7. verdict 为 `pass`，且 reviewId、taskId、contractHash 和 Evidence revision 全部匹配。

任何 Provider 成功、模型静默结束、普通 Advisor 文本、主代理声明或旧 verdict 都不能打开完成门。

## 15. 失败恢复与人工越权

官方 Runtime 负责单次 Review 的失败回滚和有限重试。达到官方连续失败上限后：

1. 宿主发出失败回执。
2. `omp-custom` 将任务转为 `stalled`。
3. Review Scheduler 按指数退避重新排队。
4. 主代理不得自动宣称完成。

人工越权命令：

```text
/compliance override --reason "<原因>"
```

越权要求：

- 必须由用户显式发起。
- 原因不能为空。
- 永久记录任务、Git HEAD、diff hash、缺失检查、失败原因、用户原因和时间。
- 状态使用 `overridden`，不得伪装为 `completed` 或 `pass`。

## 16. Brainstorm Advisor

仅实质决策自动触发：

- 架构取舍。
- 范围边界。
- 数据、接口或协议契约。
- 迁移路线。
- 高风险实现方案。
- 跨模块设计决策。

Advisor 在议题形成候选结论、约束和成功标准后介入。代码相关议题必须使用只读 codebase 工具；纯产品或创意议题不强制图谱查询。

```ts
interface BrainstormVerdict {
  reviewId: string;
  topicId: string;
  status: "supported" | "challenged" | "insufficient_evidence";
  objections: string[];
  missedConstraints: string[];
  alternatives: Array<{
    title: string;
    tradeoffs: string[];
  }>;
  recommendedDecision?: string;
  codebaseReferences: CodebaseReference[];
}
```

主代理统一呈现当前结论、Advisor 异议、遗漏约束、替代方案和建议决策。用户通过 `brainstorm_decision` 做最终决定。Brainstorm verdict 不得直接改变 Completion 状态。

## 17. Evidence 持久化

```text
.omp/compliance/
  project.json
  tasks/<taskId>/contract.json
  tasks/<taskId>/events.jsonl
  tasks/<taskId>/reviews/<reviewId>.json
  tasks/<taskId>/codebase/<revision>.json
  tasks/<taskId>/delegations/<agentId>.json
  overrides.jsonl
```

Evidence 使用追加写入和 eventId 幂等语义。每条记录至少包含：

- taskId、sessionId、eventId 和时间。
- Git HEAD 与工作区 diff hash。
- contract hash。
- Codebase index revision。
- 工具名称、规范化参数、结果摘要和退出状态。
- Advisor reviewId、trigger 和 verdict。
- 子代理身份与工作范围。

不得持久化凭据、完整模型上下文或不必要的敏感内容。自然语言只能作为辅助说明，不能替代真实工具结果。

## 18. 迁移阶段

### 阶段 1：官方基线

- 从官方 `v17.0.1` 创建干净工作分支。
- 验证未修改的 macOS/Linux 构建。
- 验证官方 Advisor、`xd://` 和 `hub` 基线。

### 阶段 2：宿主协议

- 实现 Review request。
- 实现 before-run augmentation。
- 实现生命周期事件和最终回执。
- 复用官方 Advisor 稳定性实现，不复制旧 Runtime。

### 阶段 3：扩展基础设施

- 适配 v17 Extension API。
- 配置 `loadMode` 与 Tool Approval。
- 建立宿主能力协商和拒绝启动策略。
- 接入 `xd://` 检索面。

### 阶段 4：监督领域

- TDD 与轻量契约。
- Codebase Evidence。
- 子代理监管。
- Completion Gate。
- Brainstorm Review。
- 多 trigger、人工越权和状态展示。

### 阶段 5：跨仓与二进制验收

- 真实扩展加载。
- macOS ARM64。
- Linux x64。
- Session 重启恢复。
- 故障注入和失败关闭。

### 阶段 6：主线替换与 v16 清理

- 将两仓 v17 结果更新为 `main`。
- 删除 `origin` 中由定制项目维护的 v16 分支和归档 tag。
- 删除 v16 二进制。
- 删除兼容代码和文档入口。
- 不恢复任何 v16 可运行入口。
- 不修改官方 `upstream` 的历史或 tag。

## 19. 测试矩阵

### 19.1 宿主测试

- Review request 接受、拒绝和去重。
- 优先级与 metadata 透传。
- 临时上下文和工具只对当前回合有效。
- 生命周期事件字段完整。
- 正常、失败、取消和静默完成回执正确。
- 官方 quarantine、delta coalescing 和 late blocker 不回归。

### 19.2 omp-custom 测试

- Completion 状态机全部合法和非法转换。
- contract hash 漂移使 verdict 失效。
- Codebase Evidence 缺失、过期和 projectId 错误。
- 子代理缺失、失败、超时、越界和合法例外。
- trigger 优先级、合并和去重。
- 人工越权原因和永久审计。
- Brainstorm 用户最终决策边界。

### 19.3 跨仓契约测试

- Extension API 字段与类型完全匹配。
- essential 工具不被挂载到 `xd://`。
- discoverable 工具可通过 `xd://` 发现和执行。
- 裁决工具只在专用 Advisor 回合存在。
- Advisor 无法调用 `index_repository`。

### 19.4 E2E 与故障注入

- 主代理请求完成，Advisor 返回 remediate，主代理继续修复并再次审查。
- 没有结构化 verdict 的静默停止不能通过。
- 伪造、重复、过期和跨任务 verdict 被拒绝。
- Provider 超时和连续失败进入 `stalled`。
- Session 切换和进程重启后恢复任务。
- trigger 风暴下 Completion Review 保持最高优先级。
- `tools.xdev=false` 和显式 `--tools` 场景仍保证控制面入口或明确拒绝激活。

### 19.5 二进制验收

- macOS ARM64 启动和完整合规闭环。
- Linux x64 启动和完整合规闭环。
- Native addon 版本与 loader sentinel 一致。
- 独立 `omp-custom` 能通过真实扩展发现机制加载。

## 20. 发布验收标准

发布必须同时证明：

1. 未收到合法 `pass` 时，主代理无法完成任务。
2. `remediate` 会产生修复任务并继续执行。
3. 实质代码任务没有 Codebase Evidence 时无法开始或通过。
4. 实质任务没有子代理 Evidence 或合法例外时无法通过。
5. Advisor 失败不会被视为成功，也不会永久丢失任务状态。
6. `omp-custom` 不包含任何 v16 兼容分支逻辑。
7. `origin` 和定制发布入口中不存在受维护的 v16 分支、归档 tag、二进制或当前兼容文档。
8. 两个平台二进制均通过真实项目验收。

真实项目验收必须绑定正式 TDD，先使用 codebase-memory 定位，再委派子代理；验收过程应故意制造一次失败，证明 Advisor 阻止完成，修复后重新审查并获得结构化 `pass`。

## 21. 成功后的目标状态

- OMP 主线基于 `v17.0.1+`。
- 宿主补丁仅包含四类通用 Advisor 协议能力。
- `omp-custom` 是唯一监督政策实现。
- Codebase、TDD、子代理和 Evidence 成为 Completion Gate 的硬性输入。
- `xd://` 用于低频检索，不削弱核心控制工具触发率。
- Advisor 不可用时默认失败关闭，用户越权可审计。
- v16 不再具有任何可运行、可发布或可维护入口。
