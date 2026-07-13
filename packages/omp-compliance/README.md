# @bearmaxdd/omp-compliance

OMP Advisor 扩展——为 OMP v16.4.x 的 Advisor 系统添加**大脑风暴独立评审**和**TDD 合规审查**两个子系统。

通过 `advisor_before_run` 钩子在 Advisor 运行前注入额外系统上下文和专用工具（`run-augmentation` 机制）。

---

## 目录

- [对比官方原版](#对比官方原版)
- [子系统：大脑风暴话题评审](#子系统大脑风暴话题评审)
- [子系统：合规审查](#子系统合规审查)
- [激活与接线](#激活与接线)
- [命令参考](#命令参考)
- [工具参考](#工具参考)
- [事件钩子](#事件钩子)
- [项目结构](#项目结构)
- [开发](#开发)
- [安装](#安装)

---

## 对比官方原版

### OMP 原生 Advisor 运行机制

OMP v16.4.x 内置的 Advisor 系统（`packages/coding-agent/src/advisor/`）在每次主代理 `turn_end` 时自动触发。它读取 `WATCHDOG.yml` 配置和 `WATCHDOG.md` 文件作为系统上下文，拥有一个只读工具集（`read`, `grep`, `glob`），通过 `advise()` 工具向主代理发送自由文本建议。`EmissionGuard` 负责短语级去重和语义抑制（如抑制 "Stop." / "Done." 等无意义重复）。Advisor 对话记录写入 `__advisor.jsonl`。

**原生架构：**

```
turn_end trigger
  → AdvisorRuntime picks up pending turns
    → agent.prompt(batch) — WATCHDOG rules + context files injected
      → Advisor responds with advise() calls
        → EmissionGuard dedupes → primary receives notes
```

### 我们的扩展增加了什么

| 维度 | OMP 原生 | @bearmaxdd/omp-compliance |
|------|----------|---------------------------|
| **触发方式** | 仅 `turn_end` 自动触发 | 新增 `compliance_review` 和 `brainstorm_review` 按需触发。注册一个 `advisor_before_run` handler 通过 `event.trigger` 路由到不同工厂。 |
| **系统上下文构建** | `WATCHDOG.yml` + `WATCHDOG.md` 静态文件 | 合规：动态构建 `<compliance-task>...</compliance-task>` XML 块（含合约摘要、验证结果、证据快照、历史修复记录）。大脑风暴：构建经长度限制的话题包（≤16 KB XML，含候选项、约束、成功标准、代码库证据）。 |
| **注入工具** | 默认 `read, grep, glob`（可配置） | 合规注入 `compliance_verdict` 工具（含身份校验：task_id + contract_hash + attempt 必须匹配信封）。大脑风暴注入 `brainstorm_review` 工具 + codebase 只读工具集（`search_graph`, `get_code_snippet`, `trace_path` 等，`index_repository` 被排除）。 |
| **advisor_before_run 钩子** | 无（扩展 API 接口，上游未使用） | `createComplianceAdvisorHook()` / `createBrainstormAdvisorHook()` 两个工厂函数，通过 event.metadata 中的 reviewId 从各自的 Registry 中查找匹配的信封。 |
| **审查结果** | `advise()` 自由文本建议，EmissionGuard 做短语级去重 | 合规：结构化 `ComplianceVerdict`（schema_version=1，status=pass/remediation_required，含 findings 数组，每个 finding 包含 required_fix）。大脑风暴：结构化 `BrainstormReview`（status=support/challenge/insufficient_evidence，含 findings + alternatives + recommendation，评分卡格式）。 |
| **审查结果路由** | `AdviseTool` 将建议放入主代理 yield queue | 合规：verdict 通过 `verdict-sink.acceptVerdict()` → 任务状态机转换 → `remediation_required` 时通过 `sendMessage(deliverAs: "nextTurn", triggerTurn: true)` 注入修复消息到主代理下一轮。大脑风暴：review 注册到 coordinator → 渲染决策卡片 → 通过 `sendMessage` 发送到主代理 → 用户通过 `brainstorm_decision` 工具做最终决定。 |
| **领域工作流状态** | 仅 advisor 对话持久化（`__advisor.jsonl`） | 合规：7 状态机（inactive → active → completion_requested → advisor_reviewing → completed/remediation_required/stalled），每个任务有 contractHash + attempt + worktreeFingerprint + 连续失败计数器。大脑风暴：7 状态机（drafting → ready_for_advisor_review → advisor_reviewing → awaiting_user_decision → decided/parked），输入指纹去重（相同 normalized 字段 + 代码库证据 → 相同 SHA-256，复用已有 topic）。 |
| **状态持久化** | — | `TopicStore`（JSONL，`.omp/compliance/brainstorm/`）存储话题状态和事件历史。`EvidenceStore`（JSONL，`.omp/compliance/`）存储合规证据记录。均为 append-only，支持崩溃恢复（容忍末行截断）。 |
| **重试防护** | `EmissionGuard` 的每轮一次配额 + 历史去重 | 合规新增 **stalled 保护**：连续 3 次相同指纹（worktree diff + findings + verification + contractHash 的 SHA-256）自动转换到 `stalled`，不再注入修复消息。通过 `/compliance resume` 恢复。大脑风暴通过指纹去重防止重复提交。 |
| **主代理注入** | WATCHDOG 文件 + context files | 通过 `before_agent_start` 钩子注入 `brainstorm_topic_ready` 和 `brainstorm_decision` 工具使用指引到主代理系统提示词。 |
| **被动证据收集** | 无 | `CollectorRuntime` 监听 `tool_call` / `tool_result` / `turn_end` 三个事件，归一化三类业务证据：codebase-memory 交互（搜索/追踪/代码片）、子代理委托记录、验证命令退出码。在 `compliance_complete` 时生成 `EvidenceSnapshot` 供 Advisor 审查。 |
| **合约解析** | 无 | TDD markdown 解析器（`contract/load-contract.ts`）提取 goal、scope、files、tests、verification 和 completionCriteria，计算 SHA-256 合约哈希，推断执行策略（task kind、是否需要 codebase MCP、是否需要子代理委托）。 |

---

## 子系统：大脑风暴话题评审

### 完整工作流

```
① 讨论阶段（drafting）
  主代理与用户讨论设计/架构/范围/迁移/风险等话题
  记录约束、成功标准、未解决问题

② 收敛阶段（ready_for_advisor_review）
  主代理调用 brainstorm_topic_ready 工具：

  brainstorm_topic_ready({
    topic_kind: "architecture|scope|contract|migration|risk|implementation_route",
    title: "…",                    // max 200 chars
    candidate_decision: "…",       // max 4,000 chars
    constraints: ["…", …],         // max 30 items
    success_criteria: ["…", …],    // max 30 items
    codebase_relevance: "required|optional|none",
    discussion_summary: "…",       // max 8,000 chars
    unresolved_questions: ["…", …] // max 30 items
  })

  → BrainstormRuntime.submitTopic():
    1. 收集 ToolEventCollector 证据快照
    2. TopicCoordinator.submit() 做指纹去重 + 冲突检测
    3. 构建代码库证据引用
    4. 打包话题内容（≤16 KB）
    5. 注册 BrainstormReviewEnvelope
    6. 请求 advisor 运行（trigger: brainstorm_review）

③ Advisor 评审阶段（advisor_reviewing）
  advisor_before_run 钩子匹配 brainstorm_review 触发：
  → 查找 BrainstormReviewRegistry 中的匹配信封
  → 注入话题上下文 + 评审规则 + codebase 只读工具
  → Advisor 使用 brainstorm_review 工具返回结构化评审

  Advisor 规则（advisor-rules.ts）：
  - 独立评审，不重复叙述
  - 优先指出反例、被忽略的约束、迁移风险、替代方案
  - 代码相关话题必须用只读工具验证代码库断言
  - evidence 不足时使用 insufficient_evidence
  - 不做最终决定，用户做决定

④ 用户决策阶段（awaiting_user_decision）
  主代理收到决策卡片后，调用 brainstorm_decision：

  brainstorm_decision({
    topic_id: "…",
    decision: "accept_candidate|accept_alternative|reopen|park",
    selected_alternative: "…",  // accept_alternative 时必填
    rationale: "…",             // max 4,000 chars
    user_confirmed: true         // 必须 true
  })
```

### 话题状态转换

```
drafting
  ↓ (brainstorm_topic_ready)
ready_for_advisor_review
  ↓ (BrainstormRuntime.submitTopic)
advisor_reviewing
  ↓ (Advisor 返回 review | 超时)
awaiting_user_decision / review_unavailable
  ↓ (brainstorm_decision | /brainstorm retry | /brainstorm park)
decided / parked / ready_for_advisor_review / drafting
```

### 去重

输入指纹 = SHA-256(normalized topic_kind + title + candidate_decision + constraints + success_criteria + codebase_relevance + discussion_summary + resolved_codebase_evidence)。相同指纹复用已有 topic，不重复调用 Advisor。

---

## 子系统：合规审查

### 完整工作流

```
① 绑定 TDD 合约
  /compliance start <tdd.md>

  → ComplianceRuntime 加载合约：
    · 解析 markdown（goal、scope、files、tests、verification、completionCriteria）
    · 计算 SHA-256 合约哈希
    · 推断执行策略（code/non_code、是否需要 codebase MCP、子代理委托）
    · 初始化任务状态（taskId、attempt=1、worktreeFingerprint）
    · 记录 active 事件到 EvidenceStore
    · 任务状态: inactive → active

② 执行阶段（active）
  主代理正常工作。CollectorRuntime 被动收集三类证据：
  · codebase-memory 交互：search_graph、get_code_snippet、trace_path 等
  · 子代理委托：task 工具调用的 name + task 内容摘要
  · 验证命令：bash 退出码和执行摘要

③ 请求完成
  compliance_complete({
    summary: "实现了 X 功能，添加了 Y 测试",  // 1-4000 chars
    claimed_verification: ["bun test", …]      // max 30 items, 每个 500 chars
  })

  → ComplianceRuntime.requestCompletion():
    1. 构建 CompletionSnapshot（合约摘要 + 证据事实 + agent 声明 + 修复历史）
    2. 构建 <compliance-task> XML 上下文块（≤8 KB）
    3. 创建 ComplianceReviewEnvelope（reviewId = SHA-256(sessionId + taskId + contractHash + attempt)）
    4. 注册信封到 ComplianceReviewRegistry
    5. 请求 advisor 运行（trigger: compliance_review）
    6. 任务状态: active → completion_requested → advisor_reviewing

④ Advisor 评审（advisor_reviewing）
  advisor_before_run 钩子匹配 compliance_review 触发：
  → 查找 ComplianceReviewRegistry 中的匹配信封
  → 注入合规规则 + 完成上下文 + compliance_verdict 工具
  → Advisor 使用 compliance_verdict 返回判决

  合规规则（default-rule-pack.ts）：
  · pass ≠ 所有命令成功——pass 表示满足 TDD 合约
  · 代码任务必须有 codebase MCP 查询 + 子代理委托记录，否则 remediate
  · Advisor 受限工具：read, grep, glob, advise, compliance_verdict
  · 每个 remediate finding 必须包含 required_fix

⑤ 判决处理
  
  判决 = pass:
    · 任务状态 → completed（终态）
    · 无修复消息注入
    · 记录完成证据

  判决 = remediate:
    · validateVerdictIdentity：校验 task_id + contract_hash + attempt 与信封匹配
    · 任务状态 → remediation_required
    · injectRemediation()：发送 compliance_remediation 消息到主代理下一轮
      (deliverAs: "nextTurn", triggerTurn: true)
    · 消息包含：taskId、contractHash、findings（每个含 id + reason + requiredFix + evidenceRefs）
    · 指纹计算：SHA-256(worktree_diff + normalized_findings + verification_results + contract_hash)
    · 相同指纹连续 3 次 → stalled

⑥ 修复循环
  主代理应用修复 → 再次调用 compliance_complete → 回到步骤③
  /compliance resume <task_id>：从 stalled 恢复到 active
```

### 状态机

```
                  ┌─────────────────────────────────────┐
                  │                                     │
                  ▼                                     │
inactive → active → completion_requested → advisor_reviewing
                  │                               │
                  │                        ┌──────┴──────┐
                  │                        │             │
                  │                   completed    remediation_required
                  │                        (终态)       │
                  │                                     │
                  │                              ┌──────┴──────┐
                  │                              │             │
                  │                           active      stalled
                  │                              ↑             │
                  └──────────────────────────────┘             │
                                                               │
                                          /compliance resume ──┘
```

### Stalled 保护

3 次连续相同指纹后触发。指纹 = SHA-256(worktreeDiff + normalizedFindings + verificationResults + contractHash)。Stalled 不是质量判决——只防无限循环。恢复后指纹变化则重置计数器。

---

## 激活与接线

```typescript
// extension.ts — 激活函数
export default function activate(api: ExtensionAPI): void {
  // 基础设施（懒初始化）
  const collector = new CollectorRuntime();
  const getEvidenceStore = createLazyEvidenceStore(repoRoot);
  const getBrainstormInfra = createLazyBrainstormInfra(repoRoot);

  // 审查信封注册表
  const registry = new ComplianceReviewRegistry();
  const brainstormRegistry = new BrainstormReviewRegistry();

  // 单一 advisor_before_run handler，按 trigger 路由
  api.on("advisor_before_run", (event) => {
    const e = event as AdvisorBeforeRunEvent;
    const complianceResult = createComplianceAdvisorHook(registry, runtime)(e);
    if (complianceResult) return complianceResult;
    if (e.trigger === "brainstorm_review") {
      return createBrainstormAdvisorHook(brainstormRegistry, …)(e);
    }
    return undefined;
  });

  // 主代理系统提示注入
  api.on("before_agent_start", (event) =>
    appendBrainstormGuidance(event as BeforeAgentStartEvent));

  // 工具注册
  api.registerTool(createTopicReadyTool({…}));
  api.registerTool(createDecisionTool({…}));
  registerComplianceCompleteTool(api, runtime);

  // 命令注册
  api.registerCommand("compliance", {…});
  api.registerCommand("brainstorm", {…});

  // 被动证据收集
  api.on("tool_call", (e) => collector.recordToolCall(e));
  api.on("tool_result", (e) => collector.recordToolResult(e));
  api.on("turn_end", (e) => collector.recordTurnEnd(e));
  api.on("agent_end", () => collector.refreshPresentation());
}
```

### 懒初始化策略

`EvidenceStore`（写入 `.omp/compliance/`）和 `TopicStore`（写入 `.omp/compliance/brainstorm/`）均在首次使用时才构造。`activate()` 本身不创建任何文件或目录。导入模块没有副作用——必须显式调用 `activate(api)`。

---

## 命令参考

### /compliance

| 子命令 | 描述 | 副作用 |
|--------|------|--------|
| `start <tdd.md>` | 加载 TDD 合约，开始合规追踪 | 写入 EvidenceStore |
| `stop` | 清除当前任务（不做判決） | 写入 EvidenceStore |
| `resume <task_id>` | 从 stalled 恢复 | 写入 EvidenceStore |
| `status` | 只读显示当前任务状态 | 无 |
| `history` | 只读显示当前任务事件日志 | 无 |

### /brainstorm

| 子命令 | 描述 | 副作用 |
|--------|------|--------|
| `status` | 只读显示当前话题状态 | 无 |
| `history <topic_id>` | 只读显示话题事件历史 | 无 |
| `retry <topic_id>` | review_unavailable 话题→ready_for_advisor_review，可重提评审 | 写入 TopicStore |
| `park <topic_id>` | 暂存话题（不删历史） | 写入 TopicStore |

---

## 工具参考

| 工具 | 子系统 | 调用者 | 描述 |
|------|--------|--------|------|
| `compliance_complete` | 合规 | 主代理 | 请求评审：summary + claimed_verification → advisor_reviewing |
| `brainstorm_topic_ready` | 大脑风暴 | 主代理 | 提交收敛话题供 Advisor 独立评审 |
| `brainstorm_decision` | 大脑风暴 | 主代理 | 记录用户决策，需要 `user_confirmed: true` |
| `compliance_verdict` (注入) | 合规 | Advisor | 返回结构化判决（pass/remediation_required），身份校验绑定信封 |
| `brainstorm_review` (注入) | 大脑风暴 | Advisor | 返回结构化评审（support/challenge/insufficient_evidence） |

---

## 事件钩子

| 钩子 | 处理函数 | 效果 |
|------|----------|------|
| `advisor_before_run` | `createComplianceAdvisorHook` \| `createBrainstormAdvisorHook` | 按 trigger 注入上下文 + 工具。compliance 优先（无懒初始化开销），brainstorm 仅在 trigger 匹配时初始化。 |
| `before_agent_start` | `appendBrainstormGuidance` | 注入 `brainstorm_topic_ready`/`brainstorm_decision` 使用指引到主代理系统提示词。 |
| `tool_call` + `tool_result` | `CollectorRuntime.recordToolCall/recordToolResult` | 配对记录工具调用（serverName + toolName + params）和结果（success + resultRef），用于证据快照构建。 |
| `turn_end` | `CollectorRuntime.recordTurnEnd` | 轮次边界标记。 |
| `agent_end` | `CollectorRuntime.refreshPresentation` | 展示刷新。 |

---

## 项目结构

```
packages/omp-compliance/
├── src/
│   ├── extension.ts              # 激活入口：全部接线
│   ├── types.ts                  # ExtensionAPI + AdvisorBeforeRunEvent 类型
│   ├── index.ts                  # 公共导出
│   ├── advisor/                  # 合规评审子系统
│   │   ├── compliance-advisor-hook.ts  # advisor_before_run 工厂
│   │   ├── review-envelope.ts          # 信封 + ComplianceReviewRegistry
│   │   ├── verdict-schema.ts           # ComplianceVerdict schema 校验
│   │   ├── verdict-sink.ts             # 判决接收 + 存储
│   │   ├── completion-context.ts       # <compliance-task> XML 构建
│   │   └── default-rule-pack.ts        # 合规规则模板
│   ├── brainstorm/               # 大脑风暴子系统
│   │   ├── advisor-hook.ts             # advisor_before_run 工厂
│   │   ├── advisor-rules.ts            # Advisor 评审规则
│   │   ├── brainstorm-runtime.ts       # 话题提交编排
│   │   ├── topic-coordinator.ts        # 话题状态机 + 指纹去重
│   │   ├── topic-store.ts              # JSONL 持久化
│   │   ├── topic-ready-tool.ts         # brainstorm_topic_ready 工具
│   │   ├── decision-tool.ts            # brainstorm_decision 工具
│   │   ├── decision-card.ts            # 决策卡片渲染
│   │   ├── topic-packet.ts             # Advisor 上下文包打包
│   │   ├── topic-fingerprint.ts        # SHA-256 输入归一化
│   │   ├── review-schema.ts            # BrainstormReview schema
│   │   ├── review-registry.ts          # 信封注册 + 至多一次消费
│   │   ├── main-agent-guidance.ts      # before_agent_start 注入
│   │   ├── codebase-evidence.ts        # 代码库证据收集
│   │   └── types.ts                    # 话题类型定义
│   ├── runtime/                  # 合规运行时
│   │   ├── compliance-runtime.ts       # 主协调器
│   │   └── completion-gate.ts          # 完成快照构建
│   ├── commands/                 # slash 命令
│   │   ├── compliance-command.ts       # /compliance
│   │   └── brainstorm-command.ts       # /brainstorm
│   ├── tools/                    # 工具
│   │   └── compliance-complete-tool.ts # compliance_complete
│   ├── signals/                  # 证据信号
│   │   ├── collector-runtime.ts        # 事件桥接
│   │   ├── tool-event-collector.ts     # 工具事件收集 + 配对
│   │   ├── codebase-memory.ts          # codebase MCP 归一化
│   │   ├── task-delegation.ts          # 子代理证据归一化
│   │   ├── verification.ts             # bash 退出码捕获
│   │   └── types.ts                    # 证据类型定义
│   ├── evidence/                 # 证据存储
│   │   ├── evidence-store.ts           # JSONL append-only 存储
│   │   ├── redaction.ts                # 路径脱敏
│   │   └── fingerprint.ts              # 工作树指纹
│   ├── state/                    # 合规状态机
│   │   ├── task-state-machine.ts       # 7 状态转换
│   │   └── types.ts                    # 状态类型
│   ├── contract/                 # TDD 合约解析
│   │   ├── load-contract.ts            # markdown 解析 + 哈希
│   │   ├── markdown-summary.ts         # 摘要提取
│   │   ├── execution-policy.ts         # 执行策略推断
│   │   └── types.ts                    # 合约类型
│   ├── status/                   # 只读状态投影
│   │   ├── history-reader.ts           # 事件历史读取
│   │   └── status-view-model.ts        # 状态视图模型
│   └── remediation/              # 修复注入
│       └── inject-required-fix.ts      # compliance_remediation 消息注入
├── test/
│   ├── behavior/                       # 端到端流程测试
│   │   ├── compliance-flow.test.ts     # 9 个合规场景
│   │   ├── advisor-protocol.test.ts    # 判决协议测试
│   │   ├── brainstorm-compliance-isolation.test.ts
│   │   └── extension-disabled.test.ts  # 零副作用验证
│   ├── brainstorm/                     # 大脑风暴单元测试
│   ├── advisor/                        # 合规评审单元测试
│   ├── runtime/                        # 运行时单元测试
│   ├── signals/                        # 证据收集测试
│   ├── state/                          # 状态机测试
│   ├── commands/                       # 命令测试
│   ├── evidence/                       # 存储测试
│   ├── contract/                       # 合约测试
│   ├── tools/                          # 工具测试
│   ├── status/                         # 状态投影测试
│   ├── docs/                           # 文档一致性测试
│   └── support/                        # 测试支撑
│       ├── fake-extension-api.ts       # 模拟 ExtensionAPI
│       ├── fake-advisor.ts             # 模拟 Advisor 判决
│       ├── fake-codebase-memory.ts     # 模拟 codebase MCP
│       └── fake-task-tool.ts           # 模拟 task 工具
└── package.json
```

---

## 开发

### 构建

```bash
bun run build
```

编译 TypeScript 到 `dist/`。可选打包为单文件：

```bash
bun run bundle:omp
# 输出 dist/extension.bundle.js
```

构建产物通过 `package.json` 的 `omp.extensions` 字段被 OMP 发现：
```json
{
  "omp": {
    "extensions": ["./dist/extension.js"]
  }
}
```

### 测试

```bash
bun run test
```

执行 555 个测试（46 个文件，1107 个断言）。覆盖：
- 端到端合规流程（9 个场景：缺失测试、验证失败、超范围、缺失证据、pass、stalled 等）
- 判决协议（schema 校验、上下文绑定、幂等、过期 attempt、post-pass 锁定）
- 大脑风暴流程（提交、评审、决策、指纹去重、冲突检测、持久化）
- 信号归一化（codebase-memory、子代理、验证命令）
- 扩展禁用行为（零副作用验证）
- 安装冒烟测试（npm pack、模块加载、激活）

### 代码检查

```bash
bun run check
```

使用 Biome 检查 `src/` 和 `test/`。

---

## 安装

三种方式，详见 [../../docs/install-local.md](../../docs/install-local.md)：

1. **本地开发** — symlink 到 `.omp/extensions/`
2. **bun pack** — 打包 tarball 分发：`bun run build && bun pack`
3. **OMP 设置** — 在设置中填写 dist/extension.js 路径

### 依赖

- `@oh-my-pi/pi-coding-agent` `16.4.x` (peer dependency)
- `typescript ^5.7` (dev)
- `@biomejs/biome ^1.9` (dev)
