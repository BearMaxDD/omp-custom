# OMP Advisor Brainstorm 专题评审实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让主代理在实质 brainstorming 议题收敛后自动请求顶级 Advisor 做独立反方评审，按需开放项目绑定的只读 codebase-memory 工具，并由主代理汇总为决策卡交给用户最终拍板。

**架构：** 复用 OMP 已有的 `requestAdvisorReview -> AdvisorRuntime.requestReview -> advisor_before_run` 专用审查链路，在 OMP fork 中只增加 `brainstorm_review` trigger 和受限的只读工具名解析。专题状态、指纹、代码证据、`BrainstormReview` 协议、自动触发提示、决策历史和展示全部实现于独立包 `@bearmaxdd/omp-compliance`，并与 `ComplianceVerdict` 和开发完成门严格隔离。

**技术栈：** TypeScript、Bun、`bun:test`、Biome、OMP ExtensionAPI、AdvisorRuntime、`advisor_before_run`、codebase-memory MCP、JSONL。

---

## 1. 实施依据与当前代码事实

本计划以 `/Users/mima1234/Code/super/oh-my-pi/docs/TRD/2026-07-13-omp-advisor-brainstorm-topic-review-trd.md` 为需求源，并基于两个已就绪的 codebase-memory 项目重新核对：

- `Users-mima1234-Code-super-oh-my-pi`：90,309 个节点、348,081 条边；
- `Users-mima1234-Code-super-omp-custom`：933 个节点、1,827 条边。

### 1.1 已存在且必须复用的链路

| 现有能力 | 真实源码锚点 | 计划约束 |
| --- | --- | --- |
| 专用 Advisor 请求队列 | `oh-my-pi/packages/coding-agent/src/advisor/runtime.ts` 的 `AdvisorRuntime.requestReview()` | 扩展 trigger，不再创建第二套 Advisor runner |
| 单次运行临时上下文/工具 | `src/advisor/run-augmentation.ts` 的 `withAdvisorRunAugmentation()` | 专题工具只在一次 review 中存在 |
| 扩展审查 API | `src/extensibility/extensions/types.ts` 的 `AdvisorReviewRequest` 与 `ExtensionAPI.requestAdvisorReview()` | 保持现有 compliance 调用向后兼容 |
| Advisor 运行前 Hook | `ExtensionRunner.emitBeforeRun()` 与 `AgentSession.#buildAdvisorRuntime()` | 专题包、规则和结果工具从独立扩展注入 |
| 合规 review 参考实现 | `omp-custom/src/advisor/compliance-advisor-hook.ts` | 复用结构，不复用 verdict 类型或状态机 |
| 主协调器 | `omp-custom/src/runtime/compliance-runtime.ts` | 专题另建 `BrainstormRuntime`，不膨胀 `ComplianceRuntime` |
| 工具事件证据 | `src/signals/tool-event-collector.ts` 与 `src/signals/codebase-memory.ts` | 复用只读快照，不复制 MCP 解析器 |
| 扩展接线 | `omp-custom/src/extension.ts` 的 `activate()` | 同一包内组合两个互不干扰的 runtime |

### 1.2 对 TRD 的代码现实收敛

TRD 编写时保留了“官方能力不足时新增 BrainstormReviewTool 核心桥接”的条件分支。当前主分支已经具备：

```text
ExtensionAPI.requestAdvisorReview
AdvisorRuntime.requestReview
advisor_before_run
additionalSystemContext
additionalTools
```

因此本计划不创建新的核心结果桥。唯一 OMP 兼容改动是：

1. 把 review trigger 从 `turn_end | compliance_review` 扩展为 `turn_end | compliance_review | brainstorm_review`；
2. 允许 `advisor_before_run` 按名称请求当前会话中已存在、且通过只读白名单的 codebase-memory 工具；
3. `trigger` 省略时继续默认 `compliance_review`，现有扩展和测试不改行为。

### 1.3 明确不做

- 不修改 `ComplianceVerdict`、`ComplianceRuntime` 状态语义或无限修复循环；
- 不让 Brainstorm Review 产生 `pass`、`remediate`、`completed` 或 `required_fix`；
- 不恢复 PlanRun、严格角色路由、模型锁或批量角色模型分配；
- 不让 Advisor 获得 write、edit、bash、browser、task、Git 或 `index_repository`；
- 不为每个普通对话 turn 自动发起顶级模型审查；
- 不用普通 `advise` 文本或正则代替结构化 `BrainstormReview`。

---

## 2. 文件结构决策

### 2.1 OMP fork：最小兼容 API

| 文件 | 操作 | 单一职责 |
| --- | --- | --- |
| `packages/coding-agent/src/advisor/runtime.ts` | 修改 | 支持 `brainstorm_review` 专用队列 trigger |
| `packages/coding-agent/src/advisor/run-augmentation.ts` | 修改 | 保持临时工具合并合同并覆盖命名工具回归 |
| `packages/coding-agent/src/advisor/config.ts` | 修改 | 判断可按名称注入的只读 codebase-memory 工具 |
| `packages/coding-agent/src/extensibility/extensions/types.ts` | 修改 | 扩展 review request/result 类型 |
| `packages/coding-agent/src/extensibility/extensions/loader.ts` | 修改 | 转发 trigger，不改变默认值 |
| `packages/coding-agent/src/extensibility/extensions/runner.ts` | 修改 | 合并 `additionalToolNames` 并拒绝冲突 |
| `packages/coding-agent/src/session/agent-session.ts` | 修改 | 解析白名单工具名并发起对应 trigger |
| `packages/coding-agent/test/advisor/runtime.test.ts` | 修改 | 专题队列、去重和 normal turn 回归 |
| `packages/coding-agent/test/extensibility/advisor-before-run.test.ts` | 修改 | 命名工具合并、冻结和冲突 |
| `packages/coding-agent/test/extensibility/advisor-review-api.test.ts` | 修改 | trigger 全链路转发与默认兼容 |
| `packages/coding-agent/test/session/advisor-review-runtime.test.ts` | 修改 | 会话解析只读工具并拒绝危险工具 |

### 2.2 独立扩展：专题业务

| 文件 | 操作 | 单一职责 |
| --- | --- | --- |
| `packages/omp-compliance/src/brainstorm/types.ts` | 创建 | 专题、packet、review、decision 稳定类型 |
| `src/brainstorm/topic-fingerprint.ts` | 创建 | 规范化输入并生成稳定 SHA-256 |
| `src/brainstorm/topic-packet.ts` | 创建 | 构建有长度上限的 Advisor 专题上下文 |
| `src/brainstorm/topic-store.ts` | 创建 | JSONL 历史和当前状态原子持久化 |
| `src/brainstorm/topic-coordinator.ts` | 创建 | 串行状态、去重、review 接收与用户决策 |
| `src/brainstorm/codebase-evidence.ts` | 创建 | 从现有 collector 快照生成专题代码证据 |
| `src/brainstorm/review-schema.ts` | 创建 | 解析和校验 `BrainstormReview` |
| `src/brainstorm/review-registry.ts` | 创建 | 管理当前 review envelope 和幂等消费 |
| `src/brainstorm/advisor-rules.ts` | 创建 | 独立反方评审规则和工具权限提示 |
| `src/brainstorm/advisor-hook.ts` | 创建 | 为 `brainstorm_review` 注入上下文、工具名和结果工具 |
| `src/brainstorm/topic-ready-tool.ts` | 创建 | 主代理自动提交已收敛实质议题 |
| `src/brainstorm/decision-tool.ts` | 创建 | 主代理根据用户明确选择记录最终决策 |
| `src/brainstorm/main-agent-guidance.ts` | 创建 | 每轮注入自动触发和决策记录规则 |
| `src/brainstorm/decision-card.ts` | 创建 | 生成统一决策卡与原始 review 引用 |
| `src/commands/brainstorm-command.ts` | 创建 | status/history/retry/park 控制面 |
| `src/extension.ts` | 修改 | 组合合规 runtime 与专题 runtime |
| `src/types.ts` | 修改 | 对齐 OMP 新 trigger、命名工具和 before-agent 类型 |
| `src/runtime/compliance-runtime.ts` | 修改 | 将现有 receipt 判断对齐 OMP 的 `accepted` 布尔合同 |
| `src/remediation/inject-required-fix.ts` | 修改 | 将合规修复消息对齐 OMP `CustomMessage` 真实字段 |
| `src/index.ts` | 修改 | 导出专题公共类型，不导出内部状态可变对象 |

---

### 任务 1：扩展 OMP Advisor Review Trigger，并保持合规兼容

**仓库：** `/Users/mima1234/Code/super/oh-my-pi`

**文件：**

- 修改：`packages/coding-agent/src/advisor/runtime.ts:80-130`
- 修改：`packages/coding-agent/src/extensibility/extensions/types.ts:892-921,1080-1160`
- 修改：`packages/coding-agent/src/extensibility/extensions/loader.ts:118-123,270-275`
- 修改：`packages/coding-agent/src/session/agent-session.ts:16241-16257`
- 测试：`packages/coding-agent/test/advisor/runtime.test.ts`
- 测试：`packages/coding-agent/test/extensibility/advisor-review-api.test.ts`
- 测试：`packages/coding-agent/test/session/advisor-review-runtime.test.ts`

- [ ] **步骤 1：编写失败的 trigger 转发测试**

在 `advisor-review-api.test.ts` 增加：

```ts
it("forwards brainstorm_review without changing the compliance default", async () => {
	const received: AdvisorReviewRequest[] = [];
	const runner = createRunner([fakeExtensionNoHandler("brainstorm")], {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
		requestAdvisorReview: async request => {
			received.push(request);
			return { accepted: true, reviewId: request.reviewId };
		},
	});

	await runner["runtime"].requestAdvisorReview({
		reviewId: "topic-review-1",
		trigger: "brainstorm_review",
		metadata: { topicId: "topic-1" },
	});
	await runner["runtime"].requestAdvisorReview({ reviewId: "compliance-1" });

	expect(received[0]?.trigger).toBe("brainstorm_review");
	expect(received[1]?.trigger).toBeUndefined();
});
```

在 `runtime.test.ts` 增加：

```ts
test("brainstorm review is isolated from compliance and turn_end batches", async () => {
	const beforeRun = mock((_input: AdvisorBeforeRunInput) => Promise.resolve(undefined));
	const runtime = new AdvisorRuntime(makeMockAgent(), makeHost({ beforeRun }));

	const receipt = runtime.requestReview({
		trigger: "brainstorm_review",
		reviewId: "topic-review-1",
		metadata: { topicId: "topic-1" },
	});

	expect(receipt.accepted).toBe(true);
	await runtime.waitForCatchup(1000, 1);
	expect(beforeRun).toHaveBeenCalledWith(
		expect.objectContaining({ trigger: "brainstorm_review", reviewId: "topic-review-1" }),
	);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
bun test packages/coding-agent/test/advisor/runtime.test.ts packages/coding-agent/test/extensibility/advisor-review-api.test.ts
```

预期：FAIL，TypeScript 报告 `"brainstorm_review"` 不能赋给现有 trigger 类型。

- [ ] **步骤 3：实现向后兼容的 trigger 类型与转发**

在扩展类型中定义：

```ts
export type AdvisorRunTrigger = "turn_end" | "compliance_review" | "brainstorm_review";
export type AdvisorReviewTrigger = Exclude<AdvisorRunTrigger, "turn_end">;

export interface AdvisorReviewRequest {
	reviewId: string;
	trigger?: AdvisorReviewTrigger;
	metadata?: Record<string, unknown>;
}
```

`AdvisorRuntime.requestReview()` 改为接受 `AdvisorReviewTrigger`，标题按 trigger 生成：

```ts
const heading = input.trigger === "brainstorm_review" ? "Brainstorm topic review" : "Compliance review";
const text = `### ${heading}\n\n**Review ID:** ${input.reviewId}${metadataStr}`;
```

`AgentSession.requestAdvisorReview()` 保持旧调用默认值：

```ts
const trigger = request.trigger ?? "compliance_review";
return this.#advisors[0].runtime.requestReview({ trigger, ...request });
```

同步把 loader/runtime/action 的匿名结构替换为 `AdvisorReviewRequest` 和 `AdvisorReviewReceipt`，避免 fork 与独立扩展出现重复签名。

- [ ] **步骤 4：运行聚焦测试验证通过**

```bash
bun test packages/coding-agent/test/advisor/runtime.test.ts packages/coding-agent/test/extensibility/advisor-review-api.test.ts packages/coding-agent/test/session/advisor-review-runtime.test.ts
```

预期：PASS；省略 trigger 仍进入 `compliance_review`，显式 trigger 进入 `brainstorm_review`。

- [ ] **步骤 5：提交**

```bash
git add packages/coding-agent/src/advisor/runtime.ts packages/coding-agent/src/extensibility/extensions/types.ts packages/coding-agent/src/extensibility/extensions/loader.ts packages/coding-agent/src/session/agent-session.ts packages/coding-agent/test/advisor/runtime.test.ts packages/coding-agent/test/extensibility/advisor-review-api.test.ts packages/coding-agent/test/session/advisor-review-runtime.test.ts
git commit -m "功能：支持 Advisor 专题评审触发器"
```

---

### 任务 2：按名称临时开放受限 codebase-memory 只读工具

**仓库：** `/Users/mima1234/Code/super/oh-my-pi`

**文件：**

- 修改：`packages/coding-agent/src/advisor/config.ts:35-90`
- 修改：`packages/coding-agent/src/advisor/run-augmentation.ts`
- 修改：`packages/coding-agent/src/extensibility/extensions/types.ts:895-909`
- 修改：`packages/coding-agent/src/extensibility/extensions/runner.ts:1078-1105`
- 修改：`packages/coding-agent/src/session/agent-session.ts:2645-2660`
- 测试：`packages/coding-agent/test/advisor/run-augmentation.test.ts`
- 测试：`packages/coding-agent/test/extensibility/advisor-before-run.test.ts`
- 测试：`packages/coding-agent/test/session/advisor-review-runtime.test.ts`

- [ ] **步骤 1：编写失败的命名工具与安全测试**

在 `advisor-before-run.test.ts` 增加：

```ts
it("merges and freezes additionalToolNames", async () => {
	const ext = fakeExtension("brainstorm", async () => ({
		additionalToolNames: [
			"mcp__codebase_memory_mcp__index_status",
			"mcp__codebase_memory_mcp__search_graph",
		],
	}));
	const result = await createRunner([ext]).emitBeforeRun(makeEvent("s1", "a1", "brainstorm_review"));

	expect(result?.additionalToolNames).toEqual([
		"mcp__codebase_memory_mcp__index_status",
		"mcp__codebase_memory_mcp__search_graph",
	]);
	expect(Object.isFrozen(result?.additionalToolNames)).toBe(true);
});
```

在 `advisor-review-runtime.test.ts` 增加：

```ts
it("resolves only read-only codebase-memory tools for a brainstorm review", async () => {
	const allowed = [
		"mcp__codebase_memory_mcp__index_status",
		"mcp__codebase_memory_mcp__search_graph",
		"mcp__codebase_memory_mcp__get_code_snippet",
		"mcp__codebase_memory_mcp__trace_path",
	];
	for (const name of allowed) expect(isAdvisorReadOnlyDiscoveryToolName(name)).toBe(true);
	for (const name of ["bash", "write", "task", "mcp__codebase_memory_mcp__index_repository"]) {
		expect(isAdvisorReadOnlyDiscoveryToolName(name)).toBe(false);
	}
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun test packages/coding-agent/test/extensibility/advisor-before-run.test.ts packages/coding-agent/test/session/advisor-review-runtime.test.ts
```

预期：FAIL，`AdvisorBeforeRunResult` 不存在 `additionalToolNames`，白名单函数尚未定义。

- [ ] **步骤 3：实现只读白名单与名称解析**

在 `advisor/config.ts` 增加：

```ts
const CODEBASE_MEMORY_READ_ONLY_SUFFIXES = new Set([
	"index_status",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
]);

export function isAdvisorReadOnlyDiscoveryToolName(name: string): boolean {
	const marker = "codebase_memory_mcp__";
	const index = name.lastIndexOf(marker);
	if (index < 0) return false;
	return CODEBASE_MEMORY_READ_ONLY_SUFFIXES.has(name.slice(index + marker.length));
}
```

在 `AdvisorBeforeRunResult` 增加：

```ts
additionalToolNames?: readonly string[];
```

`mergeAdvisorBeforeRunResult()` 按扩展加载顺序合并、去重并冻结名称；重复名称抛出 `duplicate advisor tool name`。

`AgentSession` 的 `beforeRun` 回调只从 `this.#advisorTools` 解析白名单名称：

```ts
const requestedNames = new Set(result.additionalToolNames ?? []);
const namedTools = (this.#advisorTools ?? []).filter(
	tool => requestedNames.has(tool.name) && isAdvisorReadOnlyDiscoveryToolName(tool.name),
);
if (namedTools.length !== requestedNames.size) {
	throw new Error("advisor_before_run requested unavailable or non-read-only tools");
}
return {
	additionalSystemContext: result.additionalSystemContext ?? [],
	additionalTools: [...(result.additionalTools ?? []), ...namedTools],
};
```

- [ ] **步骤 4：运行安全回归验证通过**

```bash
bun test packages/coding-agent/test/advisor/run-augmentation.test.ts packages/coding-agent/test/extensibility/advisor-before-run.test.ts packages/coding-agent/test/session/advisor-review-runtime.test.ts
```

预期：PASS；`index_repository`、bash、write、task 均无法按名称注入，临时工具在 Advisor 本轮结束后恢复。

- [ ] **步骤 5：提交**

```bash
git add packages/coding-agent/src/advisor/config.ts packages/coding-agent/src/advisor/run-augmentation.ts packages/coding-agent/src/extensibility/extensions/types.ts packages/coding-agent/src/extensibility/extensions/runner.ts packages/coding-agent/src/session/agent-session.ts packages/coding-agent/test/advisor/run-augmentation.test.ts packages/coding-agent/test/extensibility/advisor-before-run.test.ts packages/coding-agent/test/session/advisor-review-runtime.test.ts
git commit -m "功能：按需开放 Advisor 只读图谱工具"
```

---

### 任务 3：定义专题类型、输入规范化与稳定指纹

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`packages/omp-compliance/src/brainstorm/types.ts`
- 创建：`packages/omp-compliance/src/brainstorm/topic-fingerprint.ts`
- 创建：`packages/omp-compliance/test/brainstorm/fixtures.ts`
- 测试：`packages/omp-compliance/test/brainstorm/topic-fingerprint.test.ts`

- [ ] **步骤 1：编写失败的指纹测试**

```ts
import { describe, expect, it } from "bun:test";
import { computeTopicFingerprint, normalizeTopicInput } from "../../src/brainstorm/topic-fingerprint";

const input = {
	topicKind: "architecture" as const,
	title: "专题评审传输",
	candidateDecision: "复用 advisor_before_run",
	constraints: ["用户最终决定", "只读 Advisor"],
	successCriteria: ["结构化 review", "扩展关闭零副作用"],
	unresolvedQuestions: [],
	codebaseRelevance: "required" as const,
	discussionSummary: "已经完成方案 A/B/C 对比。",
};

describe("topic fingerprint", () => {
	it("ignores list order and surrounding whitespace", () => {
		const reordered = { ...input, constraints: [" 只读 Advisor ", "用户最终决定"] };
		expect(computeTopicFingerprint(input, [])).toBe(computeTopicFingerprint(reordered, []));
	});

	it("changes when a substantive constraint or code reference changes", () => {
		expect(computeTopicFingerprint(input, [])).not.toBe(
			computeTopicFingerprint({ ...input, constraints: [...input.constraints, "单专题串行"] }, []),
		);
		expect(computeTopicFingerprint(input, ["AgentSession.#buildAdvisorRuntime"])).not.toBe(
			computeTopicFingerprint(input, ["ExtensionRunner.emitBeforeRun"]),
		);
	});

	it("rejects non-substantive topic input", () => {
		expect(() => normalizeTopicInput({ ...input, candidateDecision: " " })).toThrow("candidateDecision");
	});
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/topic-fingerprint.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现最小稳定类型和指纹**

在 `types.ts` 定义 TRD 中的 `BrainstormTopicKind`、`BrainstormTopicReadyInput`、`BrainstormTopicPacket`、`BrainstormReview`、`BrainstormDecision`，并额外定义：

```ts
export type BrainstormTopicStatus =
	| "drafting"
	| "ready_for_advisor_review"
	| "advisor_reviewing"
	| "awaiting_user_decision"
	| "review_unavailable"
	| "decided"
	| "parked";

export interface BrainstormTopicState {
	topicId: string;
	inputHash: `sha256:${string}`;
	status: BrainstormTopicStatus;
	attempt: number;
	input: BrainstormTopicReadyInput;
	review?: BrainstormReview;
	decision?: BrainstormDecision;
}
```

`normalizeTopicInput()` trim 字符串、去重排序列表并限制：title 200 字符、candidate 4,000、summary 8,000、每个列表 30 项。`computeTopicFingerprint()` 对规范化对象和排序后的引用做 `Bun.CryptoHasher("sha256")`。

创建共享测试 fixture，后续任务只能从这里导入标准输入，不得各自发明字段名：

```ts
import type { BrainstormReview, BrainstormTopicReadyInput, BrainstormTopicState } from "../../src/brainstorm/types";
import { computeTopicFingerprint, normalizeTopicInput } from "../../src/brainstorm/topic-fingerprint";
import type { EvidenceSnapshot } from "../../src/signals/types";

export function validTopicInput(
	overrides: Partial<BrainstormTopicReadyInput> = {},
): BrainstormTopicReadyInput {
	return {
		topicKind: "architecture",
		title: "Advisor 专题评审接线",
		candidateDecision: "复用 advisor_before_run 专用审查链路",
		constraints: ["用户最终决定", "Advisor 保持只读"],
		successCriteria: ["结构化 review", "扩展关闭零副作用"],
		unresolvedQuestions: [],
		codebaseRelevance: "required",
		discussionSummary: "主代理已经完成候选方案和约束收敛。",
		...overrides,
	};
}

export function emptyEvidenceSnapshot(): EvidenceSnapshot {
	return { calls: [], results: [], codebaseMemory: { indexReady: false, queries: [], references: [] }, subagentDelegations: [], verifications: [] };
}

export function fullCodebaseSnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: ["search_graph", "get_code_snippet"],
			references: ["AgentSession.#buildAdvisorRuntime", "ExtensionRunner.emitBeforeRun"],
		},
	};
}

export function validReview(topic: BrainstormTopicState, overrides: Partial<BrainstormReview> = {}): BrainstormReview {
	return {
		schema_version: 1,
		topic_id: topic.topicId,
		input_hash: topic.inputHash,
		status: "challenge",
		summary: "候选方案可行，但需要限制动态工具权限。",
		findings: [{ category: "risk", statement: "命名工具必须只读白名单", impact: "high" }],
		alternatives: [],
		recommendation: "复用 Hook，同时增加只读工具白名单。",
		confidence: "high",
		...overrides,
	};
}

export function makeTopicState(
	input: BrainstormTopicReadyInput = validTopicInput(),
	evidence: EvidenceSnapshot = fullCodebaseSnapshot(),
): BrainstormTopicState {
	const normalized = normalizeTopicInput(input);
	return {
		topicId: "topic-01",
		inputHash: computeTopicFingerprint(normalized, evidence.codebaseMemory.references),
		status: "ready_for_advisor_review",
		attempt: 1,
		input: normalized,
	};
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/topic-fingerprint.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/brainstorm/types.ts packages/omp-compliance/src/brainstorm/topic-fingerprint.ts packages/omp-compliance/test/brainstorm/fixtures.ts packages/omp-compliance/test/brainstorm/topic-fingerprint.test.ts
git commit -m "功能：定义 Brainstorm 专题与稳定指纹"
```

---

### 任务 4：实现专题状态协调器与独立持久化

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`packages/omp-compliance/src/brainstorm/topic-store.ts`
- 创建：`packages/omp-compliance/src/brainstorm/topic-coordinator.ts`
- 测试：`packages/omp-compliance/test/brainstorm/topic-store.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/topic-coordinator.test.ts`

- [ ] **步骤 1：编写失败的状态和去重测试**

```ts
it("keeps one active topic and reuses a review for an identical fingerprint", async () => {
	const coordinator = fixtureCoordinator();
	const first = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
	const duplicate = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());

	expect(first.kind).toBe("created");
	expect(duplicate).toEqual({ kind: "reused", topic: first.topic });
});

it("keeps brainstorm state free of compliance completion fields", async () => {
	const coordinator = fixtureCoordinator();
	const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
	await coordinator.markReviewRequested(topic.topicId, "review-1");
	await coordinator.acceptReview(validReview(topic));

	expect(coordinator.current()?.status).toBe("awaiting_user_decision");
	expect(coordinator.current()).not.toHaveProperty("taskId");
	expect(coordinator.current()).not.toHaveProperty("contractHash");
});
```

测试文件内使用真实临时目录构造协调器：

```ts
function fixtureCoordinator(): TopicCoordinator {
	return new TopicCoordinator(new TopicStore(tempDir.path()));
}
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/topic-store.test.ts test/brainstorm/topic-coordinator.test.ts
```

- [ ] **步骤 3：实现独立状态转换与存储**

`TopicStore` 使用：

```text
.omp/compliance/brainstorm/state.json
.omp/compliance/brainstorm/topics/<topic_id>.jsonl
```

状态写入采用同目录临时文件后原子 rename；JSONL 记录 `topic_created`、`review_requested`、`review_received`、`review_unavailable`、`decision_recorded`、`topic_reopened`、`topic_parked`。不复用任务 `EvidenceRecord` schema。

`TopicCoordinator.submit()` 返回 discriminated union：

```ts
type SubmitTopicResult =
	| { kind: "created"; topic: BrainstormTopicState }
	| { kind: "reused"; topic: BrainstormTopicState }
	| { kind: "conflict"; activeTopicId: string; reason: "another_topic_waiting" };
```

只允许合法状态转换；`review_unavailable` 可 retry，`decided` 不可被迟到 review 覆盖。

- [ ] **步骤 4：运行恢复和原子写测试**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/topic-store.test.ts test/brainstorm/topic-coordinator.test.ts
```

预期：PASS；进程重建后能恢复当前专题，损坏 JSONL 尾行不覆盖有效 state。

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/brainstorm/topic-store.ts packages/omp-compliance/src/brainstorm/topic-coordinator.ts packages/omp-compliance/test/brainstorm/topic-store.test.ts packages/omp-compliance/test/brainstorm/topic-coordinator.test.ts
git commit -m "功能：增加 Brainstorm 专题状态与历史"
```

---

### 任务 5：从现有 Collector 构建专题代码证据和 Advisor Packet

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`packages/omp-compliance/src/brainstorm/codebase-evidence.ts`
- 创建：`packages/omp-compliance/src/brainstorm/topic-packet.ts`
- 测试：`packages/omp-compliance/test/brainstorm/codebase-evidence.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/topic-packet.test.ts`

- [ ] **步骤 1：编写失败的按需证据测试**

```ts
it("does not require codebase evidence for a product-only topic", () => {
	const evidence = buildTopicCodebaseEvidence("none", emptyEvidenceSnapshot());
	expect(evidence).toEqual({ mode: "not_needed", references: [], requestedToolNames: [] });
});

it("maps verified graph references and requests only read-only MCP tools", () => {
	const evidence = buildTopicCodebaseEvidence("required", fullCodebaseSnapshot());
	expect(evidence.mode).toBe("available");
	expect(evidence.references).toContainEqual(
		expect.objectContaining({ label: "AgentSession.#buildAdvisorRuntime", source: "snippet" }),
	);
	expect(evidence.requestedToolNames.every(name => !name.endsWith("index_repository"))).toBe(true);
});
```

`topic-packet.test.ts`：

```ts
it("builds deterministic bounded XML-safe advisor context", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	const packet = buildTopicPacket(topic, fullCodebaseSnapshot());
	const rendered = renderTopicPacket(packet);
	expect(rendered).toContain("<brainstorm-topic>");
	expect(rendered).toContain("topic_id:");
	expect(rendered).not.toContain("Authorization:");
	expect(rendered.length).toBeLessThanOrEqual(16_000);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/codebase-evidence.test.ts test/brainstorm/topic-packet.test.ts
```

- [ ] **步骤 3：实现证据映射和 packet**

复用 `ToolEventCollector.snapshot().codebaseMemory`，不重新解析工具事件。规则：

```ts
const READ_ONLY_CODEBASE_SUFFIXES = [
	"index_status",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
] as const;
```

`required` 且 index/search/snippet-or-trace 不完整时返回 `mode: "unavailable"`；`optional` 有引用时为 `available`，无引用时为 `not_needed`。工具名从 `api.getAllTools()` 中按服务器标识和 suffix 精确筛选，不拼造不存在的名称。

`renderTopicPacket()` 使用现有 `redactText()`、固定排序与逐字段上限；代码引用只保存 label/source，不嵌入完整源码。

- [ ] **步骤 4：运行测试验证通过**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/codebase-evidence.test.ts test/brainstorm/topic-packet.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/brainstorm/codebase-evidence.ts packages/omp-compliance/src/brainstorm/topic-packet.ts packages/omp-compliance/test/brainstorm/codebase-evidence.test.ts packages/omp-compliance/test/brainstorm/topic-packet.test.ts
git commit -m "功能：构建专题图谱证据与审查上下文"
```

---

### 任务 6：实现 BrainstormReview Schema、Registry 与 Advisor Hook

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`packages/omp-compliance/src/brainstorm/review-schema.ts`
- 创建：`packages/omp-compliance/src/brainstorm/review-registry.ts`
- 创建：`packages/omp-compliance/src/brainstorm/advisor-rules.ts`
- 创建：`packages/omp-compliance/src/brainstorm/advisor-hook.ts`
- 测试：`packages/omp-compliance/test/brainstorm/review-schema.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/review-registry.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/advisor-hook.test.ts`

- [ ] **步骤 1：编写失败的协议隔离测试**

```ts
it("accepts support, challenge, and insufficient_evidence only", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	for (const status of ["support", "challenge", "insufficient_evidence"] as const) {
		expect(parseBrainstormReview(validReview(topic, { status }), { topicId: topic.topicId, inputHash: topic.inputHash }).status).toBe(status);
	}
	expect(() => parseBrainstormReview({ ...validReview(topic), status: "pass" }, { topicId: topic.topicId, inputHash: topic.inputHash })).toThrow("status");
});

it("rejects compliance identity fields and stale topic identity", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	const context = { topicId: topic.topicId, inputHash: topic.inputHash };
	expect(() => parseBrainstormReview({ ...validReview(topic), task_id: "task-1" }, context)).toThrow();
	expect(() => parseBrainstormReview({ ...validReview(topic), input_hash: "sha256:stale" }, context)).toThrow(
		"input_hash",
	);
});
```

Hook 测试：

```ts
it("injects topic rules, brainstorm_review tool and read-only tool names only for its trigger", () => {
	const hook = createBrainstormAdvisorHook(registry, coordinator);
	const result = hook(brainstormEvent(activeEnvelope()));
	expect(result?.additionalSystemContext).toHaveLength(2);
	expect(result?.additionalTools?.map(tool => tool.name)).toEqual(["brainstorm_review"]);
	expect(result?.additionalToolNames?.every(isCodebaseReadOnlyName)).toBe(true);
	expect(hook({ ...brainstormEvent(activeEnvelope()), trigger: "compliance_review" })).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/review-schema.test.ts test/brainstorm/review-registry.test.ts test/brainstorm/advisor-hook.test.ts
```

- [ ] **步骤 3：实现结构化结果工具**

`createBrainstormReviewTool()` 的 schema 对应 TRD 5.3，并在 `execute` 中：

```ts
const review = parseBrainstormReview(params, {
	topicId: envelope.topicId,
	inputHash: envelope.inputHash,
});
await coordinator.acceptReview(review);
registry.consume(envelope.reviewId);
return {
	content: [{ type: "text" as const, text: "Brainstorm review accepted." }],
	details: { topicId: review.topic_id, status: review.status },
};
```

规则提示明确：独立检查、指出反例、代码议题按需核验、用户最终决定、必须调用 `brainstorm_review`；允许工具严格为 read/grep/glob/advise、动态 codebase 只读工具和 `brainstorm_review`。

- [ ] **步骤 4：运行协议测试验证通过**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/review-schema.test.ts test/brainstorm/review-registry.test.ts test/brainstorm/advisor-hook.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/brainstorm/review-schema.ts packages/omp-compliance/src/brainstorm/review-registry.ts packages/omp-compliance/src/brainstorm/advisor-rules.ts packages/omp-compliance/src/brainstorm/advisor-hook.ts packages/omp-compliance/test/brainstorm/review-schema.test.ts packages/omp-compliance/test/brainstorm/review-registry.test.ts packages/omp-compliance/test/brainstorm/advisor-hook.test.ts
git commit -m "功能：增加 Advisor 专题评审协议"
```

---

### 任务 7：实现主代理自动专题提交与 review 请求

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`packages/omp-compliance/src/brainstorm/main-agent-guidance.ts`
- 创建：`packages/omp-compliance/src/brainstorm/topic-ready-tool.ts`
- 创建：`packages/omp-compliance/src/brainstorm/brainstorm-runtime.ts`
- 测试：`packages/omp-compliance/test/brainstorm/main-agent-guidance.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/topic-ready-tool.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/brainstorm-runtime.test.ts`

- [ ] **步骤 1：编写失败的自动触发测试**

```ts
it("guides the main agent to auto-call the tool only for substantive converged topics", () => {
	const guidance = renderMainAgentBrainstormGuidance();
	expect(guidance).toContain("architecture | scope | contract | migration | risk | implementation_route");
	expect(guidance).toContain("candidate_decision");
	expect(guidance).toContain("success_criteria");
	expect(guidance).toContain("Do not call for wording, simple clarification, or factual lookup");
});

it("submits a topic and requests the dedicated advisor trigger", async () => {
	const reviewRequests: AdvisorReviewRequest[] = [];
	const harness = createBrainstormRuntimeHarness({
		requestAdvisorReview: async request => {
			reviewRequests.push(request);
			return { accepted: true, reviewId: request.reviewId };
		},
	});
	const result = await harness.runtime.submitTopic(validTopicInput());
	expect(reviewRequests).toEqual([
		expect.objectContaining({
			trigger: "brainstorm_review",
			reviewId: result.reviewId,
			metadata: expect.objectContaining({ topicId: result.topic.topicId, inputHash: result.topic.inputHash }),
		}),
	]);
	expect(result.status).toBe("advisor_reviewing");
});
```

测试 harness 使用任务 4 的真实 store/coordinator，并仅替换外部 review action：

```ts
function createBrainstormRuntimeHarness(overrides: {
	requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
}) {
	const collector = new CollectorRuntime();
	const store = new TopicStore(tempDir.path());
	const coordinator = new TopicCoordinator(store);
	const registry = new BrainstormReviewRegistry();
	const api = new FakeExtensionAPI();
	const runtime = new BrainstormRuntime({
		api: api.toAPI(),
		collector,
		coordinator,
		registry,
		requestAdvisorReview: overrides.requestAdvisorReview,
		getAllTools: () => [],
		sessionId: () => "session-1",
	});
	return { runtime, coordinator, registry, api };
}
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/main-agent-guidance.test.ts test/brainstorm/topic-ready-tool.test.ts test/brainstorm/brainstorm-runtime.test.ts
```

- [ ] **步骤 3：实现每轮 guidance 和工具**

`before_agent_start` handler 返回当前 system prompt 追加专题规则：

```ts
export function appendBrainstormGuidance(event: BeforeAgentStartEvent): BeforeAgentStartEventResult {
	return { systemPrompt: [...event.systemPrompt, renderMainAgentBrainstormGuidance()] };
}
```

`brainstorm_topic_ready` 工具采用严格 object schema，字段与 `BrainstormTopicReadyInput` 一致。其 handler 调用 `BrainstormRuntime.submitTopic()`；重复指纹返回已有 review，冲突返回当前 topic id，不覆盖旧专题。

`BrainstormRuntime.submitTopic()`：

1. 获取 collector snapshot 和可用工具名；
2. 构建 codebase evidence、topic state、packet、rules 和 envelope；
3. registry put 后调用：

```ts
api.requestAdvisorReview({
	trigger: "brainstorm_review",
	reviewId: envelope.reviewId,
	metadata: {
		topicId: topic.topicId,
		inputHash: topic.inputHash,
		codebaseRelevance: topic.input.codebaseRelevance,
	},
});
```

4. rejected/throw 时状态改为 `review_unavailable`，不伪造 support。

- [ ] **步骤 4：运行测试验证通过**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/main-agent-guidance.test.ts test/brainstorm/topic-ready-tool.test.ts test/brainstorm/brainstorm-runtime.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/brainstorm/main-agent-guidance.ts packages/omp-compliance/src/brainstorm/topic-ready-tool.ts packages/omp-compliance/src/brainstorm/brainstorm-runtime.ts packages/omp-compliance/test/brainstorm/main-agent-guidance.test.ts packages/omp-compliance/test/brainstorm/topic-ready-tool.test.ts packages/omp-compliance/test/brainstorm/brainstorm-runtime.test.ts
git commit -m "功能：自动发起实质议题 Advisor 评审"
```

---

### 任务 8：生成统一决策卡并记录用户最终决定

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`packages/omp-compliance/src/brainstorm/decision-card.ts`
- 创建：`packages/omp-compliance/src/brainstorm/decision-tool.ts`
- 创建：`packages/omp-compliance/src/commands/brainstorm-command.ts`
- 测试：`packages/omp-compliance/test/brainstorm/decision-card.test.ts`
- 测试：`packages/omp-compliance/test/brainstorm/decision-tool.test.ts`
- 测试：`packages/omp-compliance/test/commands/brainstorm-command.test.ts`

- [ ] **步骤 1：编写失败的决策卡和最终权限测试**

```ts
it("preserves high-impact advisor findings and alternatives", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	const reviewed = { ...topic, status: "awaiting_user_decision" as const, review: validReview(topic) };
	const card = renderDecisionCard(reviewed);
	expect(card).toContain("当前结论");
	expect(card).toContain("Advisor 异议");
	expect(card).toContain("迁移期间双写可能丢状态");
	expect(card).toContain("可选替代方案");
	expect(card).toContain("需要用户明确选择");
});

it("records only an explicit user decision and cannot decide from advisor support", async () => {
	const coordinator = await fixtureCoordinatorWithReview();
	await expect(coordinator.recordDecision({ decision: "accept_candidate", userConfirmed: false })).rejects.toThrow("user confirmation");
	await coordinator.recordDecision({
		decision: "accept_candidate",
		userConfirmed: true,
		rationale: "采用官方 Hook，保持核心改动最小",
	});
	expect(coordinator.current()?.status).toBe("decided");
});
```

`fixtureCoordinatorWithReview()` 必须通过公开状态方法建立前置状态，不得直接改私有字段：

```ts
async function fixtureCoordinatorWithReview(): Promise<TopicCoordinator> {
	const coordinator = new TopicCoordinator(new TopicStore(tempDir.path()));
	const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
	await coordinator.markReviewRequested(topic.topicId, "review-1");
	await coordinator.acceptReview(validReview(topic));
	return coordinator;
}
```

相应测试先 `const coordinator = await fixtureCoordinatorWithReview();`。

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/decision-card.test.ts test/brainstorm/decision-tool.test.ts test/commands/brainstorm-command.test.ts
```

- [ ] **步骤 3：实现卡片、决策工具和命令**

Advisor review 被接受后，runtime 使用：

```ts
api.sendMessage(
	{
		customType: "brainstorm_review",
		content: renderDecisionCard(topic),
		display: true,
		attribution: "agent",
		details: { topicId: topic.topicId, review: topic.review },
	},
	{ deliverAs: "nextTurn", triggerTurn: true },
);
```

`brainstorm_decision` 仅由主代理在用户明确选择后调用，参数含 `topic_id`、`decision`、`selected_alternative`、`rationale`、`user_confirmed: true`。`support` 不能自动写 decided。

`/brainstorm` 子命令实现：

```text
status
history
retry <topic_id>
park <topic_id>
```

`retry` 仅接受 `review_unavailable`，`park` 不删除历史。

- [ ] **步骤 4：运行测试验证通过**

```bash
bun --cwd=packages/omp-compliance test test/brainstorm/decision-card.test.ts test/brainstorm/decision-tool.test.ts test/commands/brainstorm-command.test.ts
```

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/brainstorm/decision-card.ts packages/omp-compliance/src/brainstorm/decision-tool.ts packages/omp-compliance/src/commands/brainstorm-command.ts packages/omp-compliance/test/brainstorm/decision-card.test.ts packages/omp-compliance/test/brainstorm/decision-tool.test.ts packages/omp-compliance/test/commands/brainstorm-command.test.ts
git commit -m "功能：呈现专题决策卡并记录用户选择"
```

---

### 任务 9：接入扩展入口并验证与合规完成门共存

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 修改：`packages/omp-compliance/src/extension.ts:39-84`
- 修改：`packages/omp-compliance/src/types.ts:1-140`
- 修改：`packages/omp-compliance/src/runtime/compliance-runtime.ts:260-310`
- 修改：`packages/omp-compliance/src/remediation/inject-required-fix.ts:45-70`
- 修改：`packages/omp-compliance/src/index.ts`
- 修改：`packages/omp-compliance/test/support/fake-extension-api.ts`
- 修改：`packages/omp-compliance/test/extension.test.ts`
- 修改：`packages/omp-compliance/test/runtime/compliance-runtime.test.ts`
- 修改：`packages/omp-compliance/test/remediation/inject-required-fix.test.ts`
- 创建：`packages/omp-compliance/test/behavior/brainstorm-compliance-isolation.test.ts`

- [ ] **步骤 1：编写失败的组合接线测试**

```ts
it("registers both workflows while keeping their triggers and tools isolated", async () => {
	const fake = new FakeExtensionAPI();
	activate(fake.toAPI());

	expect(fake.getRegisteredTools()).toEqual(expect.arrayContaining(["compliance_complete", "brainstorm_topic_ready", "brainstorm_decision"]));
	expect(fake.getRegisteredCommands()).toEqual(expect.arrayContaining(["compliance", "brainstorm"]));

	const compliance = await fake.fireAdvisorBeforeRun(complianceEvent());
	const brainstorm = await fake.fireAdvisorBeforeRun(brainstormEvent());
	expect(compliance?.additionalTools?.map(t => t.name)).toEqual(["compliance_verdict"]);
	expect(brainstorm?.additionalTools?.map(t => t.name)).toEqual(["brainstorm_review"]);
});

it("does not create brainstorm state when the extension is loaded but unused", async () => {
	const fake = new FakeExtensionAPI();
	activate(fake.toAPI());
	const stateDir = path.join(process.cwd(), ".omp", "compliance", "brainstorm");
	const exists = await fs.promises.access(stateDir).then(() => true, () => false);
	expect(exists).toBe(false);
});

it("uses the OMP accepted receipt contract for both review kinds", async () => {
	const fake = new FakeExtensionAPI();
	activate(fake.toAPI());
	const receipt = await fake.requestAdvisorReview({
		reviewId: "review-1",
		trigger: "brainstorm_review",
		metadata: { topicId: "topic-1" },
	});
	expect(receipt).toEqual({ accepted: true, reviewId: "review-1" });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
bun --cwd=packages/omp-compliance test test/extension.test.ts test/behavior/brainstorm-compliance-isolation.test.ts
```

- [ ] **步骤 3：组合两个独立 runtime**

`activate()` 创建共享 `CollectorRuntime`，但分别创建 `ComplianceReviewRegistry` 与 `BrainstormReviewRegistry`。注册一个 `advisor_before_run` handler，按 trigger 依次调用两个 hook 并返回唯一匹配结果：

```ts
api.on("advisor_before_run", event => {
	const typed = event as AdvisorBeforeRunEvent;
	return (
		createComplianceAdvisorHook(complianceRegistry, complianceRuntime)(typed) ??
		createBrainstormAdvisorHook(brainstormRegistry, brainstormRuntime)(typed)
	);
});
```

在 `FakeExtensionAPI` 增加真实事件驱动辅助函数，并让 `toAPI()` 提供本功能所需 API：

```ts
public readonly advisorReviewRequests: AdvisorReviewRequest[] = [];
public availableTools: string[] = [];

async fireAdvisorBeforeRun(event: AdvisorBeforeRunEvent): Promise<AdvisorBeforeRunResult | undefined> {
	for (const handler of this.eventHandlers.get("advisor_before_run") ?? []) {
		const result = await handler(event);
		if (result) return result as AdvisorBeforeRunResult;
	}
	return undefined;
}

requestAdvisorReview = async (request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> => {
	this.advisorReviewRequests.push(request);
	return { accepted: true, reviewId: request.reviewId };
};

getAllTools = (): string[] => [...this.availableTools];
```

`toAPI()` 追加 `requestAdvisorReview`、`getAllTools`，并保留原注册与消息记录方法。

注册 `before_agent_start` guidance、两个专题工具和 `/brainstorm`。所有 store 保持 lazy；未使用专题能力时不创建目录。

扩展本地类型与 OMP 对齐：`AdvisorRunTrigger`、`AdvisorReviewRequest.trigger`、`AdvisorBeforeRunResult.additionalToolNames`、`BeforeAgentStartEvent/Result`。同时删除本地 task-specific request 字段，使用真实公共合同：

```ts
export interface AdvisorReviewRequest {
	reviewId: string;
	trigger?: "compliance_review" | "brainstorm_review";
	metadata?: Record<string, unknown>;
}

export interface AdvisorReviewReceipt {
	accepted: boolean;
	reviewId: string;
	reason?: string;
}

export interface CustomMessagePayload<T = unknown> {
	customType: string;
	content: string;
	display: boolean;
	attribution?: "agent" | "user";
	details?: T;
}
```

`ComplianceRuntime.requestCompletion()` 仍把 task/contract/attempt 放进 registry envelope 和 metadata，但请求对象只传 `reviewId`、`trigger`、`metadata`；把 `receipt.status === "accepted"` 改为 `receipt.accepted`。失败状态、Evidence 和 verdict 语义不变。`inject-required-fix.ts` 和运行时通知改用 `customType/content/display/details`，对应 OMP `ExtensionAPI.sendMessage()` 的真实结构；既有修复文本和 `nextTurn` 行为保持不变。

- [ ] **步骤 4：运行扩展全量回归**

```bash
bun --cwd=packages/omp-compliance test
bun --cwd=packages/omp-compliance run check
bun --cwd=packages/omp-compliance run build
```

预期：全部 PASS；现有 compliance 行为夹具、Evidence 和 remediation 测试不变化。

- [ ] **步骤 5：提交**

```bash
git add packages/omp-compliance/src/extension.ts packages/omp-compliance/src/types.ts packages/omp-compliance/src/runtime/compliance-runtime.ts packages/omp-compliance/src/remediation/inject-required-fix.ts packages/omp-compliance/src/index.ts packages/omp-compliance/test/support/fake-extension-api.ts packages/omp-compliance/test/extension.test.ts packages/omp-compliance/test/runtime/compliance-runtime.test.ts packages/omp-compliance/test/remediation/inject-required-fix.test.ts packages/omp-compliance/test/behavior/brainstorm-compliance-isolation.test.ts
git commit -m "功能：接入 Brainstorm 专题评审扩展"
```

---

### 任务 10：跨仓库真实闭环、关闭扩展回归与文档

**仓库：** `/Users/mima1234/Code/super/oh-my-pi` 与 `/Users/mima1234/Code/super/omp-custom`

**文件：**

- 创建：`oh-my-pi/packages/coding-agent/test/integration/omp-brainstorm-advisor-review.test.ts`
- 修改：`omp-custom/README.md`
- 创建：`omp-custom/docs/advisor-brainstorm-workflow.md`
- 修改：`omp-custom/docs/upstream-upgrade-runbook.md`
- 创建：`omp-custom/packages/omp-compliance/test/docs/brainstorm-workflow-docs.test.ts`

- [ ] **步骤 1：编写失败的跨仓库集成测试**

测试通过 `OMP_COMPLIANCE_PACKAGE` 加载真实构建产物，依次执行：

在集成测试文件顶部实现本地辅助函数，直接复用现有 `extensionsResult.extensions[0]`，不引入新的测试框架：

```ts
function extensionTool(name: string): {
	execute?: (id: string, params: Record<string, unknown>) => Promise<unknown>;
	handler?: (params: Record<string, unknown>) => Promise<unknown>;
} {
	const registered = extensionsResult.extensions[0]!.tools.get(name);
	if (!registered) throw new Error(`Missing extension tool: ${name}`);
	return registered.definition as never;
}

async function executeExtensionTool(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const tool = extensionTool(name);
	const value = tool.handler ? await tool.handler(params) : await tool.execute!("integration-call", params);
	return value as Record<string, unknown>;
}

function validArchitectureTopic(): Record<string, unknown> {
	return {
		topic_kind: "architecture",
		title: "Advisor 专题评审接线",
		candidate_decision: "复用 advisor_before_run",
		constraints: ["用户最终决定", "Advisor 只读"],
		success_criteria: ["结构化 review", "关闭扩展零副作用"],
		unresolved_questions: [],
		codebase_relevance: "none",
		discussion_summary: "方案已完成收敛。",
	};
}

function challengeFixture(topic: Record<string, unknown>): Record<string, unknown> {
	return {
		schema_version: 1,
		topic_id: topic.topicId,
		input_hash: topic.inputHash,
		status: "challenge",
		summary: "需要限制动态工具权限。",
		findings: [{ category: "risk", statement: "动态工具必须只读", impact: "high" }],
		alternatives: [],
		recommendation: "增加只读白名单。",
		confidence: "high",
	};
}

async function readTopicState(topicId: string): Promise<Record<string, unknown>> {
	const statePath = path.join(process.cwd(), ".omp", "compliance", "brainstorm", "state.json");
	const state = JSON.parse(await fs.promises.readFile(statePath, "utf-8")) as Record<string, unknown>;
	if (state.topicId !== topicId) throw new Error(`Unexpected topic state: ${String(state.topicId)}`);
	return state;
}
```

```ts
it("runs topic ready -> advisor augmentation -> challenge -> user decision", async () => {
	const topicResult = await executeExtensionTool("brainstorm_topic_ready", validArchitectureTopic());
	expect(topicResult.status).toBe("advisor_reviewing");

	const augmentation = await extensionRunner.emitBeforeRun({
		type: "advisor_before_run",
		sessionId: "session-1",
		advisorId: "advisor-1",
		trigger: "brainstorm_review",
		messages: Object.freeze([]),
		metadata: Object.freeze({
			reviewId: topicResult.reviewId,
			topicId: topicResult.topicId,
			inputHash: topicResult.inputHash,
		}),
	});

	expect(augmentation?.additionalTools?.map(t => t.name)).toEqual(["brainstorm_review"]);
	const reviewTool = augmentation!.additionalTools![0]!;
	await reviewTool.execute("review-call", challengeFixture(topicResult));
	expect(await readTopicState(topicResult.topicId)).toMatchObject({ status: "awaiting_user_decision" });

	await executeExtensionTool("brainstorm_decision", {
		topic_id: topicResult.topicId,
		decision: "accept_candidate",
		user_confirmed: true,
		rationale: "用户确认采用候选方案",
	});
	expect(await readTopicState(topicResult.topicId)).toMatchObject({ status: "decided" });
});
```

另加断言：`turn_end` 和 `compliance_review` 不含 `brainstorm_review` 工具；`--no-extensions` 工具清单和官方 baseline 一致。

- [ ] **步骤 2：运行测试验证失败**

```bash
OMP_COMPLIANCE_PACKAGE=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance bun test packages/coding-agent/test/integration/omp-brainstorm-advisor-review.test.ts
```

预期：FAIL，新集成测试或专题工具尚未接通。

- [ ] **步骤 3：补齐真实 harness 与中文操作文档**

文档必须包含：

- 主代理自动触发的六类实质议题；
- 产品议题不强制代码检索，架构/改造议题按需使用只读图谱；
- 决策卡四段结构和 Advisor 原始 review 的可追溯位置；
- 用户如何 accept alternative、reopen、park；
- `BrainstormReview` 与 `ComplianceVerdict` 的区别；
- 顶级 Advisor 模型沿用现有 Advisor 配置；
- 升级时检查 trigger、命名工具白名单和 extension-disabled 行为。

- [ ] **步骤 4：运行最终验证**

在 `omp-custom`：

```bash
bun --cwd=packages/omp-compliance test
bun --cwd=packages/omp-compliance run check
bun --cwd=packages/omp-compliance run build
git diff --check
```

在 `oh-my-pi`：

```bash
bun test packages/coding-agent/test/advisor/runtime.test.ts packages/coding-agent/test/advisor/run-augmentation.test.ts packages/coding-agent/test/extensibility/advisor-before-run.test.ts packages/coding-agent/test/extensibility/advisor-review-api.test.ts packages/coding-agent/test/session/advisor-review-runtime.test.ts
OMP_COMPLIANCE_PACKAGE=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance bun test packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts packages/coding-agent/test/integration/omp-brainstorm-advisor-review.test.ts
bun --cwd=packages/coding-agent run check
git diff --check
```

预期：两仓库测试、类型检查、Biome、构建和跨仓库闭环全部通过；未启动专题时不创建 `.omp/compliance/brainstorm`。

- [ ] **步骤 5：分别提交**

先提交扩展文档：

```bash
git -C /Users/mima1234/Code/super/omp-custom add README.md docs/advisor-brainstorm-workflow.md docs/upstream-upgrade-runbook.md packages/omp-compliance/test/docs/brainstorm-workflow-docs.test.ts
git -C /Users/mima1234/Code/super/omp-custom commit -m "文档：完善 Advisor 专题评审使用与升级流程"
```

再提交 fork 集成测试：

```bash
git -C /Users/mima1234/Code/super/oh-my-pi add packages/coding-agent/test/integration/omp-brainstorm-advisor-review.test.ts
git -C /Users/mima1234/Code/super/oh-my-pi commit -m "测试：覆盖 Advisor 专题评审真实闭环"
```

---

## 3. 最终验收矩阵

| 场景 | 预期 |
| --- | --- |
| 普通措辞或事实澄清 | 主代理不调用 `brainstorm_topic_ready` |
| 实质架构议题已收敛 | 主代理自动提交 candidate、constraints、success criteria |
| 纯产品议题 | Advisor 不取得 codebase-memory 工具 |
| 代码相关议题且图谱可用 | Advisor 临时取得 index_status/search/snippet/trace 只读工具 |
| 图谱不可用 | packet 标记 unavailable；Advisor 可返回 insufficient_evidence |
| Advisor support | 展示已核对维度，仍等待用户决定 |
| Advisor challenge | 高影响异议和替代方案完整进入决策卡 |
| Advisor timeout/invalid | review_unavailable，不伪装支持，不自动无限重试 |
| 相同专题无变化 | 复用已有 review，不产生新顶级模型调用 |
| 用户补充约束 | 新 input hash，可重新评审 |
| 用户未明确确认 | `brainstorm_decision` 不得写 decided |
| compliance review | 仅有 `compliance_verdict`，不出现 brainstorm 工具 |
| extension disabled | OMP/Advisor 工具、prompt 和运行目录无专题副作用 |

## 4. 计划自检

- TRD 第 1-15 节均映射到任务 1-10 或最终验收矩阵；
- 所有代码任务都包含失败测试、失败命令、最小实现、通过命令和中文提交；
- `BrainstormReview` 只使用 `support | challenge | insufficient_evidence`，没有复用合规状态；
- `AdvisorReviewRequest.trigger` 缺省仍为 `compliance_review`，保证现有扩展兼容；
- codebase-memory 动态工具不包含 `index_repository`，也不能注入 bash/write/task；
- 主代理自动触发通过 `before_agent_start` guidance 与显式工具调用实现，没有额外分类模型；
- 用户最终决定通过 `user_confirmed: true` 的独立工具记录，Advisor 不能自动决定；
- 两个 runtime 仅共享只读 collector，不共享 registry、状态机或结果协议；
- 计划没有未命名文件、模糊错误处理或未给出验证命令的实现步骤。
