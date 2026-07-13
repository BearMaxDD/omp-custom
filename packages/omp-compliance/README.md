# @bearmaxdd/omp-compliance

为 OMP v16.4.x 的 Advisor 系统扩展**大脑风暴独立评审**和**TDD 合规审查**两个子系统。

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

OMP v16.4.x 内置的 Advisor（`packages/coding-agent/src/advisor/`）在每次主代理 `turn_end` 时自动触发。它读取 `WATCHDOG.yml` 配置和 `WATCHDOG.md` 文件作为系统上下文，拥有只读工具集（`read`, `grep`, `glob`），通过 `advise()` 工具向主代理发送自由文本建议。`EmissionGuard` 负责短语级去重和语义抑制（如重复的 "Stop." / "Done."）。Advisor 对话写入 `__advisor.jsonl`。

原生流程：

```
turn_end 触发 → AdvisorRuntime 收集待处理轮次
  → agent.prompt() 注入 WATCHDOG 规则和上下文文件
    → Advisor 通过 advise() 返回建议
      → EmissionGuard 去重后主代理收到
```

### 我们扩展了什么

| 维度 | OMP 原生 | @bearmaxdd/omp-compliance |
|------|----------|---------------------------|
| **触发方式** | 仅 `turn_end` 自动触发 | 新增 `compliance_review` 按需触发。两个子系统共用同一个上游传输通道——上游 `agent-session.ts:16259` 强制所有扩展评审都用 `compliance_review` trigger |
| **系统上下文** | `WATCHDOG.yml` + `WATCHDOG.md` 静态文件 | 合规：动态构建 `<compliance-task>` XML（合约摘要、验证结果、证据快照、修复记录）。大脑风暴：构建长度限制的话题包（≤16 KB XML，含候选项、约束、成功标准、代码库证据） |
| **注入工具** | 默认 `read`, `grep`, `glob`（可配置） | 合规注入 `compliance_verdict`（校验 `task_id` + `contract_hash` + `attempt` 必须匹配信封）。大脑风暴注入 `brainstorm_review` |
| **接线方式** | 无（扩展 API 接口旁通） | 一个 `advisor_before_run` 回调内先查合规注册表再查大脑风暴注册表，通过 `reviewId` 匹配信封。两个钩子都在 `trigger === "compliance_review"` 时匹配，`turn_end` 不拦截 |
| **审查结果** | `advise()` 自由文本，`EmissionGuard` 短语去重 | 合规：结构化 `ComplianceVerdict`（`pass` / `remediation_required`，带 `findings` 和 `required_fix`）。大脑风暴：结构化 `BrainstormReview`（`support` / `challenge` / `insufficient_evidence`，带 `findings` + `alternatives` + `recommendation`） |
| **结果路由** | `AdviseTool` 放入主代理优先队列 | 合规：verdict 通过 `verdict-sink` → 状态机转换 → `remediate` 时 `sendMessage(triggerTurn)` 注入下一轮。大脑风暴：渲染决策卡片 → `sendMessage` 发送 → 用户通过 `brainstorm_decision` 工具决定 |
| **工作流状态** | 仅对话 JSONL（`__advisor.jsonl`） | 合规：7 状态（`inactive→active→completion_requested→advisor_reviewing→completed/remediation_required/stalled`），带 `contractHash` + `attempt` + 指纹 + 连续失败计数。大脑风暴：7 状态（`drafting→ready_for_advisor_review→advisor_reviewing→awaiting_user_decision→decided/parked`），输入指纹 SHA-256 去重 |
| **状态持久化** | — | `TopicStore`（JSONL，`.omp/compliance/brainstorm/`）+ `EvidenceStore`（JSONL，`.omp/compliance/`），均 append-only，支持崩溃恢复 |
| **重试防护** | `EmissionGuard` 每轮一次配额 + 短语去重 | 合规新增**停滞保护**：连续 3 次相同指纹自动停止注入修复消息，通过 `/compliance resume` 恢复。大脑风暴通过指纹去重防重复 |
| **主代理注入** | `WATCHDOG` 文件 + context files | `before_agent_start` 钩子注入 `brainstorm_topic_ready` / `brainstorm_decision` 使用指引 |
| **证据采集** | 无 | `CollectorRuntime` 监听 `tool_call` / `tool_result` / `turn_end` 归一化三类证据：codebase-memory 交互、子代理委托、验证命令退出码 |
| **合约解析** | 无 | TDD markdown 解析器提取目标、范围、文件、测试、验证、完成条件，计算 SHA-256 哈希，推断执行策略 |

---

## 子系统：大脑风暴话题评审

### 完整工作流

```
① 讨论阶段（drafting）
  主代理与用户讨论设计/架构/范围/迁移/风险

② 收敛（ready_for_advisor_review）
  主代理调用 brainstorm_topic_ready：

  brainstorm_topic_ready({
    topic_kind: "architecture|scope|contract|migration|risk|implementation_route",
    title: "…",                    // ≤200 字符
    candidate_decision: "…",       // ≤4,000 字符
    constraints: ["…", …],         // ≤30 项
    success_criteria: ["…", …],    // ≤30 项
    codebase_relevance: "required|optional|none",
    discussion_summary: "…",       // ≤8,000 字符
    unresolved_questions: ["…", …] // ≤30 项
  })

  → BrainstormRuntime.submitTopic():
    1. 收集证据快照
    2. 指纹去重 + 冲突检测
    3. 构建代码库证据
    4. 打包话题（≤16 KB）
    5. 注册评审信封
    6. 请求 advisor 运行（trigger: compliance_review——上游唯一支持的通道）

③ Advisor 评审（advisor_reviewing）
  advisor_before_run 钩子通过 reviewId 在注册表中查找信封：
  → 注入话题上下文 + 评审规则
  → Advisor 使用 brainstorm_review 工具返回结构化评审

  Advisor 规则：
  - 独立评审，不重复叙述
  - 优先反例、被忽略的约束、迁移风险、替代方案
  - 代码话题用只读工具验证代码库断言
  - 证据不足时用 insufficient_evidence
  - 不做最终决定，用户决定

④ 用户决策（awaiting_user_decision）
  主代理收到决策卡片后调用 brainstorm_decision：

  brainstorm_decision({
    topic_id: "…",
    decision: "accept_candidate|accept_alternative|reopen|park",
    selected_alternative: "…",  // accept_alternative 时必填
    rationale: "…",             // ≤4,000 字符
    user_confirmed: true
  })
```

### 状态转换

```
drafting
  ↓ brainstorm_topic_ready
ready_for_advisor_review
  ↓ BrainstormRuntime.submitTopic()
advisor_reviewing
  ↓ Advisor 返回评审 | 超时
awaiting_user_decision / review_unavailable
  ↓ brainstorm_decision | /brainstorm retry | /brainstorm park
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

  → 加载合约，解析 markdown
  → 计算 SHA-256 合约哈希
  → 推断执行策略（代码/非代码、是否需要 codebase MCP、子代理委托）
  → 初始化任务状态
  → 状态: inactive → active

② 执行（active）
  CollectorRuntime 被动收集三类证据：
  · codebase-memory 交互（search_graph, get_code_snippet, trace_path 等）
  · 子代理委托
  · bash 退出码

③ 请求完成
  compliance_complete({
    summary: "…",                 // 1-4,000 字符
    claimed_verification: ["…"]   // ≤30 项
  })

  → 构建完成快照（合约摘要 + 证据事实 + agent 声明 + 修复历史）
  → 构建 <compliance-task> XML（≤8 KB）
  → 创建信封 + 注册 ComplianceReviewRegistry
  → 请求 advisor 运行（trigger: compliance_review）
  → 状态: active → completion_requested → advisor_reviewing

④ Advisor 评审（advisor_reviewing）
  advisor_before_run 钩子通过 reviewId 在合规注册表中查找信封：
  → 注入合规规则 + 完成上下文 + compliance_verdict 工具

  合规规则：
  · pass 表示满足 TDD 合约——不是所有命令成功
  · 代码任务必须有 codebase MCP 查询 + 子代理委托，否则 remediate
  · Advisor 受限工具：read, grep, glob, advise, compliance_verdict
  · 每个 remediate 发现项必须包含 required_fix

⑤ 判决处理
  
  判决 = pass：
    · 状态 → completed（终态）
    · 无修复消息

  判决 = remediate：
    · 校验 task_id + contract_hash + attempt 与信封匹配
    · 状态 → remediation_required
    · 注入 compliance_remediation 消息到主代理下一轮
    · 消息含：taskId、contractHash、发现项（id + reason + requiredFix + evidenceRefs）
    · 指纹 = SHA-256(worktree_diff + normalized_findings + verification_results + contract_hash)
    · 相同指纹连续 3 次 → stalled

⑥ 修复循环
  主代理应用修复 → 再次调用 compliance_complete → 回到③
  /compliance resume <task_id>：从 stalled 恢复到 active
```

### 状态机

```
                  ┌─────────────────────────────┐
                  ▼                             │
inactive → active → completion_requested → advisor_reviewing
                  │                       │
                  │                ┌──────┴──────┐
                  │                │             │
                  │           completed    remediation_required
                  │            (终态)           │
                  │                     ┌──────┴──────┐
                  │                     │             │
                  │                  active      stalled
                  │                     ↑           │
                  └─────────────────────┘           │
                                           /compliance resume
```

### 停滞保护

连续 3 次相同指纹后触发。指纹 = SHA-256(worktreeDiff + normalizedFindings + verificationResults + contractHash)。停滞不是质量判决——只防无限循环。恢复后指纹变化则重置计数器。

---

## 激活与接线

一个 `advisor_before_run` 回调处理两个子系统：

```typescript
api.on("advisor_before_run", (event) => {
  const e = event as AdvisorBeforeRunEvent;
  // 先查合规注册表
  const complianceResult = createComplianceAdvisorHook(registry, runtime)(e);
  if (complianceResult) return complianceResult;
  // 未匹配再到大脑风暴注册表
  if (e.trigger === "compliance_review") {
    return createBrainstormAdvisorHook(
      brainstormRegistry, coordinator, sendMessage
    )(e);
  }
  return undefined;
});
```

### 上游 API 约束

OMP v16.4.x 的 `agent-session.ts:16259` 强制所有扩展评审的 trigger 为 `compliance_review`。本扩展适配方式：

- 请求评审前先注册信封到对应注册表（合规 vs 大脑风暴）
- `advisor_before_run` 中通过 `reviewId`（在 metadata 中）查注册表匹配，不依赖 trigger 字段
- 两个子系统共享同一个传输通道但完全隔离状态机、持久化和规则
- `turn_end` 触发时两个钩子都返回 `undefined`，不拦截正常 Advisor 运行

### 懒初始化

`EvidenceStore`（`.omp/compliance/`）和 `TopicStore`（`.omp/compliance/brainstorm/`）均在首次使用时构造。`activate()` 本身不创建任何文件或目录。导入模块没有副作用——必须显式调用 `activate(api)`。

### 回执格式

上游 `requestAdvisorReview` 回执使用 `{ status: "accepted" | "rejected" }`（不是 `{ accepted: boolean }`）。两个运行时都检查 `receipt.status === "accepted"`。

---

## 命令参考

### /compliance

| 子命令 | 说明 | 副作用 |
|--------|------|--------|
| `start <tdd.md>` | 加载 TDD 合约，开始追踪 | 写入证据存储 |
| `stop` | 清除当前任务（不做判决） | 写入证据存储 |
| `resume <task_id>` | 从停滞状态恢复 | 写入证据存储 |
| `status` | 只读显示当前任务状态 | 无 |
| `history` | 只读显示当前任务事件日志 | 无 |

### /brainstorm

| 子命令 | 说明 | 副作用 |
|--------|------|--------|
| `status` | 只读显示当前话题状态 | 无 |
| `history <topic_id>` | 只读查看话题事件历史 | 无 |
| `retry <topic_id>` | `review_unavailable` 话题重置可重新提交 | 写入话题存储 |
| `park <topic_id>` | 暂存话题不删历史 | 写入话题存储 |

---

## 工具参考

| 工具 | 子系统 | 调用者 | 说明 |
|------|--------|--------|------|
| `compliance_complete` | 合规 | 主代理 | 请求评审，带摘要和验证声明 |
| `brainstorm_topic_ready` | 大脑风暴 | 主代理 | 提交收敛话题供 Advisor 独立评审 |
| `brainstorm_decision` | 大脑风暴 | 主代理 | 记录用户决策，需要 `user_confirmed: true` |
| `compliance_verdict` | 合规 | Advisor | 返回结构化判决（`pass` / `remediation_required`），身份校验 |
| `brainstorm_review` | 大脑风暴 | Advisor | 返回结构化评审（`support` / `challenge` / `insufficient_evidence`） |

---

## 事件钩子

| 钩子 | 处理函数 | 效果 |
|------|----------|------|
| `advisor_before_run` | `createComplianceAdvisorHook` / `createBrainstormAdvisorHook` | 按 reviewId 查注册表匹配，注入上下文 + 工具。均在 `trigger === "compliance_review"` 时匹配 |
| `before_agent_start` | `appendBrainstormGuidance` | 注入 `brainstorm_topic_ready` / `brainstorm_decision` 使用指引到主代理系统提示词 |
| `tool_call` + `tool_result` | `CollectorRuntime` | 配对记录工具调用和结果，用于证据快照 |
| `turn_end` | `CollectorRuntime.recordTurnEnd` | 轮次边界标记 |
| `agent_end` | `CollectorRuntime.refreshPresentation` | 展示刷新 |

---

## 项目结构

```
packages/omp-compliance/
├── src/
│   ├── extension.ts              # 激活入口
│   ├── types.ts                  # 扩展 API 类型
│   ├── index.ts                  # 公共导出
│   ├── advisor/                  # 合规评审
│   │   ├── compliance-advisor-hook.ts  # advisor_before_run 工厂
│   │   ├── review-envelope.ts          # 信封 + 注册表
│   │   ├── verdict-schema.ts           # 判决 schema 校验
│   │   ├── verdict-sink.ts             # 判决接收存储
│   │   ├── completion-context.ts       # <compliance-task> XML
│   │   └── default-rule-pack.ts        # 合规规则模板
│   ├── brainstorm/               # 大脑风暴
│   │   ├── advisor-hook.ts             # advisor_before_run 工厂
│   │   ├── advisor-rules.ts            # Advisor 评审规则
│   │   ├── brainstorm-runtime.ts       # 话题提交编排
│   │   ├── topic-coordinator.ts        # 状态机 + 指纹去重
│   │   ├── topic-store.ts              # JSONL 持久化
│   │   ├── topic-ready-tool.ts         # brainstorm_topic_ready
│   │   ├── decision-tool.ts            # brainstorm_decision
│   │   ├── decision-card.ts            # 决策卡片渲染
│   │   ├── topic-packet.ts             # Advisor 上下文包
│   │   ├── topic-fingerprint.ts        # SHA-256 输入归一化
│   │   ├── review-schema.ts            # 评审 schema
│   │   ├── review-registry.ts          # 信封注册消费
│   │   ├── main-agent-guidance.ts      # before_agent_start 注入
│   │   ├── codebase-evidence.ts        # 代码库证据
│   │   └── types.ts                    # 话题类型定义
│   ├── runtime/                  # 合规运行时
│   │   ├── compliance-runtime.ts       # 主协调器
│   │   └── completion-gate.ts          # 完成快照
│   ├── commands/                 # 命���
│   │   ├── compliance-command.ts
│   │   └── brainstorm-command.ts
│   ├── tools/
│   │   └── compliance-complete-tool.ts
│   ├── signals/                  # 证据信号
│   │   ├── collector-runtime.ts
│   │   ├── tool-event-collector.ts
│   │   ├── codebase-memory.ts
│   │   ├── task-delegation.ts
│   │   ├── verification.ts
│   │   └── types.ts
│   ├── evidence/                 # 证据存储
│   │   ├── evidence-store.ts
│   │   ├── redaction.ts
│   │   └── fingerprint.ts
│   ├── state/                    # 合规状态机
│   │   ├── task-state-machine.ts
│   │   └── types.ts
│   ├── contract/                 # TDD 合约
│   │   ├── load-contract.ts
│   │   ├── markdown-summary.ts
│   │   ├── execution-policy.ts
│   │   └── types.ts
│   ├── status/                   # 只读视图
│   │   ├── history-reader.ts
│   │   └── status-view-model.ts
│   └── remediation/
│       └── inject-required-fix.ts # 修复消息注入
├── test/                         # 558 个测试，47 个文件
└── package.json
```

---

## 开发

```bash
# 编译 TypeScript 到 dist/
bun run build

# 运行全部测试
bun run test

# 代码质量检查（Biome）
bun run check

# 打包单文件
bun run bundle:omp
```

---

## 安装

详见 [../../docs/install-local.md](../../docs/install-local.md)。三种方式：

1. **本地开发** — 符号链接到 `.omp/extensions/`
2. **bun pack** — 压缩包分发：`bun run build && bun pack`
3. **OMP 设置** — 在设置中填写 `dist/extension.js` 路径

### 依赖

- `@oh-my-pi/pi-coding-agent` `16.4.x`（对等依赖）
- `typescript ^5.7`（开发依赖）
- `@biomejs/biome ^1.9`（开发依赖）
