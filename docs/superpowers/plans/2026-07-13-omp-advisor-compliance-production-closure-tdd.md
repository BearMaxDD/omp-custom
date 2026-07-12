# OMP Advisor 合规生产闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `@bearmaxdd/omp-compliance` 的完成门接入真实 OMP Advisor 会话，使 completion review 在单次 Advisor run 中获得合规上下文与临时 `compliance_verdict` 工具，并以统一协议驱动完成或返修。

**架构：** `omp-custom` 拥有合同、Evidence、规则、review envelope、verdict 校验和状态机；`oh-my-pi-v16.4.6-compliance` 只增加会话级 `requestAdvisorReview()`、`advisor_before_run` 和单次 run augmentation。专用 review 进入现有 Advisor 串行队列，Hook 结果仅在对应 prompt 的 `try/finally` 作用域内生效，普通 `turn_end` 行为不变。

**技术栈：** TypeScript、Bun、ArkType/TypeBox、OMP Extension API、`@oh-my-pi/pi-agent-core`、Biome、Git。

---

## 执行边界与基线

- 业务事实源：`/Users/mima1234/Code/super/omp-custom`
- 宿主适配仓库：`/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance`
- 已批准 TRD：`/Users/mima1234/Code/super/omp-custom/docs/TRD/2026-07-13-omp-advisor-compliance-production-closure-trd.md`
- 禁止修改 `/Users/mima1234/Code/super/oh-my-pi` 主 checkout。
- 两仓未跟踪的 `.codebase-memory/` 不得提交。
- 新链路的真实集成测试通过之前不得删除旧 bridge。
- 最终必须删除长期 `AgentSessionConfig.complianceVerdictSink` 和 fork 简化协议。
- 当前无 `openspec/` 且无 OpenSpec MCP；需求覆盖由本文追踪矩阵、测试矩阵和最终 codebase 图谱验证完成。

开始前记录基线：

```bash
git -C /Users/mima1234/Code/super/omp-custom status --short
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance status --short
bun --cwd=/Users/mima1234/Code/super/omp-custom test
bun --cwd=/Users/mima1234/Code/super/omp-custom run check
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor packages/coding-agent/test/extensibility
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent run check:types
```

预期基线：除 `.codebase-memory/` 外无用户改动；扩展默认测试可能触发已知 5 秒安装测试超时，两仓 Biome 有已知错误。这些质量债必须在任务 10 关闭。

## 文件结构

### OMP 宿主适配仓库

创建：

- `packages/coding-agent/src/advisor/run-augmentation.ts`：单次 prompt 临时安装 context/tools，并在异常路径恢复 Agent state。
- `packages/coding-agent/test/advisor/run-augmentation.test.ts`：追加、冲突、异常恢复测试。
- `packages/coding-agent/test/advisor/runtime.test.ts`：专用 review 队列、去重、失败隔离测试。
- `packages/coding-agent/test/extensibility/advisor-before-run.test.ts`：Hook 顺序、冻结、冲突、超时测试。
- `packages/coding-agent/test/extensibility/advisor-review-api.test.ts`：ConcreteExtensionAPI 到 session action 的转发测试。
- `packages/coding-agent/test/session/advisor-review-runtime.test.ts`：AgentSession 到 AdvisorRuntime/Hook 的接线测试。
- `packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts`：真实 loader、ExtensionRunner、AgentSession/Advisor 闭环。

修改：

- `packages/coding-agent/src/advisor/runtime.ts`：typed review queue、`requestReview()`、per-run augmentation。
- `packages/coding-agent/src/advisor/index.ts`：导出 review/augmentation 类型。
- `packages/coding-agent/src/extensibility/extensions/types.ts`：事件、结果、request/receipt 和 API/Actions 签名。
- `packages/coding-agent/src/extensibility/extensions/loader.ts`：ExtensionAPI 转发。
- `packages/coding-agent/src/extensibility/extensions/runner.ts`：Hook 聚合与 runtime action 初始化。
- `packages/coding-agent/src/session/agent-session.ts`：ExtensionRunner、AdvisorRuntime 与 Agent state 的真实接线。
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`、`src/modes/acp/acp-agent.ts`、`src/task/executor.ts`：所有 ExtensionActions 构造点暴露 review action。

删除：

- `packages/coding-agent/src/advisor/compliance-verdict-tool.ts`
- `packages/coding-agent/test/advisor/compliance-verdict-tool.test.ts`
- `packages/coding-agent/test/session/advisor-compliance-bridge.test.ts`

### omp-custom 业务仓库

创建：

- `packages/omp-compliance/src/advisor/review-envelope.ts`：不可变 envelope、稳定 reviewId、active registry。
- `packages/omp-compliance/src/advisor/compliance-advisor-hook.ts`：匹配 review 并创建绑定 envelope 的临时工具。
- `packages/omp-compliance/test/advisor/review-envelope.test.ts`
- `packages/omp-compliance/test/advisor/compliance-advisor-hook.test.ts`
- `packages/omp-compliance/test/fixtures/verdict/{pass,remediate,invalid-legacy}.json`

修改：

- `packages/omp-compliance/src/types.ts`：宿主 Hook/API 最小结构类型。
- `packages/omp-compliance/src/extension.ts`：惰性持久化、Hook/action 接线。
- `packages/omp-compliance/src/runtime/compliance-runtime.ts`：context/rules/envelope/receipt 生产链。
- `packages/omp-compliance/src/advisor/verdict-schema.ts`：唯一协议语义。
- `packages/omp-compliance/src/signals/codebase-memory.ts`：`index_repository` ready 证据。
- 对应 `test/extension.test.ts`、`test/runtime/compliance-runtime.test.ts`、`test/signals/codebase-memory.test.ts` 和安装测试。

## 固定数据合同

```ts
export type AdvisorRunTrigger = "turn_end" | "compliance_review";

export interface AdvisorReviewRequest {
	trigger: "compliance_review";
	reviewId: string;
	metadata: Readonly<{
		taskId: string;
		contractHash: `sha256:${string}`;
		attempt: number;
	}>;
}

export interface AdvisorReviewReceipt {
	accepted: boolean;
	reviewId: string;
	reason?: "advisor_disabled" | "advisor_unavailable" | "duplicate";
}

export interface AdvisorBeforeRunEvent {
	type: "advisor_before_run";
	sessionId: string;
	advisorId: string;
	trigger: AdvisorRunTrigger;
	messages: readonly AgentMessage[];
	metadata?: Readonly<Record<string, unknown>>;
}

export interface AdvisorBeforeRunResult {
	additionalSystemContext?: readonly string[];
	additionalTools?: readonly AgentTool[];
	metadata?: Readonly<Record<string, unknown>>;
}
```

唯一业务 verdict：

```ts
export interface ComplianceVerdict {
	schema_version: 1;
	task_id: string;
	contract_hash: `sha256:${string}`;
	attempt: number;
	status: "pass" | "remediate";
	findings: Array<{
		id: string;
		reason: string;
		required_fix?: string;
		evidence_refs?: string[];
	}>;
}
```

## 任务 1：用 fixtures 锁定唯一 verdict 协议

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**
- 创建：`packages/omp-compliance/test/fixtures/verdict/pass.json`
- 创建：`packages/omp-compliance/test/fixtures/verdict/remediate.json`
- 创建：`packages/omp-compliance/test/fixtures/verdict/invalid-legacy.json`
- 修改：`packages/omp-compliance/test/advisor/verdict-schema.test.ts`
- 修改：`packages/omp-compliance/src/advisor/verdict-schema.ts`

- [ ] **步骤 1：写 fixtures**

`pass.json` 使用 task_id `task-9`、64 位 `sha256:a...`、attempt 1、status pass 和空 findings。`remediate.json` 使用同一绑定，并含 `{"id":"F-1","reason":"integration path missing","required_fix":"execute the loaded extension through AgentSession"}`。`invalid-legacy.json` 只含旧字段 `task/hash/action/requiredFix`。

- [ ] **步骤 2：编写失败测试**

```ts
test("canonical fixtures pass and legacy bridge shape fails", () => {
	expect(parseComplianceVerdict(pass).status).toBe("pass");
	expect(parseComplianceVerdict(remediate).findings[0]?.required_fix).toBeTruthy();
	expect(() => parseComplianceVerdict(invalidLegacy)).toThrow("schema_version");
});
test("remediate requires a non-empty required_fix", () => {
	expect(() => parseComplianceVerdict({ ...remediate, findings: [] })).toThrow("required_fix");
});
```

- [ ] **步骤 3：运行并确认红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/advisor/verdict-schema.test.ts
```

预期：FAIL，旧协议错误不稳定或空 remediate 未拒绝。

- [ ] **步骤 4：实现最小语义**

```ts
if (verdict.status === "remediate" && !verdict.findings.some(f => f.required_fix?.trim())) {
	throw new ComplianceVerdictProtocolError("remediate verdict requires a non-empty required_fix");
}
if (verdict.status === "pass" && verdict.findings.some(f => f.required_fix?.trim())) {
	throw new ComplianceVerdictProtocolError("pass verdict cannot contain an open required_fix");
}
```

- [ ] **步骤 5：运行目标测试和全量测试**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/advisor/verdict-schema.test.ts
bun --cwd=/Users/mima1234/Code/super/omp-custom test
```

预期：目标 PASS；全量不新增协议回归。

- [ ] **步骤 6：提交**

```bash
git -C /Users/mima1234/Code/super/omp-custom add packages/omp-compliance/src/advisor/verdict-schema.ts packages/omp-compliance/test/advisor/verdict-schema.test.ts packages/omp-compliance/test/fixtures/verdict
git -C /Users/mima1234/Code/super/omp-custom commit -m "test(compliance): 固化 Advisor verdict 协议"
```

## 任务 2：建立单次 Advisor run augmentation

**仓库：** `/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance`

**文件：**
- 创建：`packages/coding-agent/src/advisor/run-augmentation.ts`
- 创建：`packages/coding-agent/test/advisor/run-augmentation.test.ts`
- 修改：`packages/coding-agent/src/advisor/index.ts`

- [ ] **步骤 1：编写失败测试**

```ts
test("adds context/tools for one run and restores state", async () => {
	const state = { systemPrompt: ["base"], tools: [{ name: "advise" }] };
	const seen: Array<{ systemPrompt: string[]; tools: AgentTool[] }> = [];
	await withAdvisorRunAugmentation(state, {
		additionalSystemContext: ["rules", "evidence"],
		additionalTools: [{ name: "compliance_verdict" } as AgentTool],
	}, async () => seen.push(structuredClone(state)));
	expect(seen[0]?.systemPrompt).toEqual(["base", "rules", "evidence"]);
	expect(state.systemPrompt).toEqual(["base"]);
	expect(state.tools.map(t => t.name)).toEqual(["advise"]);
});
```

另测同名 tool reject，以及 callback 抛错后 state 仍恢复。

- [ ] **步骤 2：运行红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor/run-augmentation.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 helper**

```ts
export async function withAdvisorRunAugmentation<T>(
	state: AdvisorMutableRunState,
	augmentation: AdvisorRunAugmentation | undefined,
	run: () => Promise<T>,
): Promise<T> {
	if (!augmentation) return await run();
	const context = Object.freeze([...(augmentation.additionalSystemContext ?? [])]);
	const tools = Object.freeze([...(augmentation.additionalTools ?? [])]);
	const names = new Set(state.tools.map(t => t.name));
	for (const tool of tools) {
		if (names.has(tool.name)) throw new Error(`duplicate advisor tool "${tool.name}"`);
		names.add(tool.name);
	}
	const originalPrompt = state.systemPrompt;
	const originalTools = state.tools;
	state.systemPrompt = [...originalPrompt, ...context];
	state.tools = [...originalTools, ...tools];
	try { return await run(); }
	finally { state.systemPrompt = originalPrompt; state.tools = originalTools; }
}
```

- [ ] **步骤 4：运行测试并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor/run-augmentation.test.ts
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance add packages/coding-agent/src/advisor packages/coding-agent/test/advisor/run-augmentation.test.ts
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance commit -m "feat(advisor): 增加单次运行临时上下文和工具"
```

预期：全部 PASS。

## 任务 3：增加 `advisor_before_run` Extension Hook

**文件：**
- 修改 fork 的 `packages/coding-agent/src/extensibility/extensions/types.ts`
- 修改 fork 的 `packages/coding-agent/src/extensibility/extensions/runner.ts`
- 创建 fork 的 `packages/coding-agent/test/extensibility/advisor-before-run.test.ts`

- [ ] **步骤 1：写失败测试**

两个 fake extension 依加载顺序返回 `["rules"]`、`["context"]` 和一个 `compliance_verdict`，断言合并结果顺序固定且数组冻结；再测 tool 冲突 reject、普通 turn 无 handler 返回 undefined、专用 review handler timeout reject。

- [ ] **步骤 2：运行红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/extensibility/advisor-before-run.test.ts
```

预期：FAIL，事件类型不存在。

- [ ] **步骤 3：在 `types.ts` 加入固定合同及 overload**

```ts
on(
	event: "advisor_before_run",
	handler: ExtensionHandler<AdvisorBeforeRunEvent, AdvisorBeforeRunResult>,
): void;
```

并把 event/result 纳入 `ExtensionEvent`、`RunnerEmitEvent` 和结果映射。

- [ ] **步骤 4：实现 Runner 合并**

```ts
function mergeAdvisorBeforeRunResult(current?: AdvisorBeforeRunResult, next?: AdvisorBeforeRunResult) {
	if (!next) return current;
	const tools = [...(current?.additionalTools ?? []), ...(next.additionalTools ?? [])];
	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name)) throw new Error(`duplicate advisor tool "${tool.name}"`);
		seen.add(tool.name);
	}
	return Object.freeze({
		additionalSystemContext: Object.freeze([...(current?.additionalSystemContext ?? []), ...(next.additionalSystemContext ?? [])]),
		additionalTools: Object.freeze(tools),
		metadata: Object.freeze({ ...(current?.metadata ?? {}), ...(next.metadata ?? {}) }),
	});
}
```

专用 review 的 timeout/非法结果必须 reject，不能只记录 warning。

- [ ] **步骤 5：运行并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/extensibility/advisor-before-run.test.ts packages/coding-agent/test/extensibility
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance add packages/coding-agent/src/extensibility/extensions/types.ts packages/coding-agent/src/extensibility/extensions/runner.ts packages/coding-agent/test/extensibility/advisor-before-run.test.ts
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance commit -m "feat(extensions): 增加 advisor_before_run Hook"
```

预期：全部 PASS，既有事件合并不变。

## 任务 4：专用 review 进入现有 Advisor 串行队列

**文件：**
- 修改 fork 的 `packages/coding-agent/src/advisor/runtime.ts`
- 修改 fork 的 `packages/coding-agent/src/advisor/index.ts`
- 创建 fork 的 `packages/coding-agent/test/advisor/runtime.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
const receipt = runtime.requestReview({
	trigger: "compliance_review", reviewId: "review-1",
	metadata: { taskId: "task-9", contractHash: HASH, attempt: 1 },
});
expect(receipt).toEqual({ accepted: true, reviewId: "review-1" });
await runtime.waitForCatchup(1000, 1);
expect(beforeRun.mock.calls[0]?.[0].trigger).toBe("compliance_review");
expect(runtime.requestReview(request)).toEqual({
	accepted: false, reviewId: "review-1", reason: "duplicate",
});
```

- [ ] **步骤 2：运行红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor/runtime.test.ts
```

预期：FAIL，`requestReview` 不存在。

- [ ] **步骤 3：扩展 pending 和 host**

```ts
interface PendingAdvisorRun {
	text: string; turns: number; trigger: AdvisorRunTrigger;
	reviewId?: string; metadata?: Readonly<Record<string, unknown>>;
}
interface AdvisorRuntimeHost {
	beforeRun?(input: AdvisorBeforeRunInput): Promise<AdvisorRunAugmentation | undefined>;
}
```

普通 `onTurnEnd` 使用 `trigger: "turn_end"`。review push 明确指令 “Perform the requested compliance completion review. Submit exactly one verdict through compliance_verdict.”，维护 `#reviewIds` 去重并启动 `#drain()`。

- [ ] **步骤 4：prompt 前获取 augmentation**

相同 trigger/reviewId 才允许批处理；普通 delta 与专用 review 分批。把 `AdvisorAgent.prompt` 改为 `prompt(input, augmentation?)`，调用：

```ts
const augmentation = await this.host.beforeRun?.({
	trigger: run.trigger, reviewId: run.reviewId,
	metadata: run.metadata, messages: this.agent.state.messages.slice(),
});
await this.agent.prompt(batch, augmentation);
```

- [ ] **步骤 5：补失败隔离测试**

Hook 连续失败走现有三次 retry/notify；随后 `onTurnEnd()` 的普通 update 仍成功，且没有 compliance tool。

- [ ] **步骤 6：运行并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance add packages/coding-agent/src/advisor packages/coding-agent/test/advisor/runtime.test.ts
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance commit -m "feat(advisor): 增加专用合规审查队列"
```

## 任务 5：接通 ExtensionAPI、AgentSession 和 Advisor runtime

**文件：**
- 修改 fork 的 extension `types.ts`、`loader.ts`、`runner.ts`
- 修改 fork 的 `src/session/agent-session.ts`
- 修改 fork 的 interactive、ACP、task executor ExtensionActions 构造点
- 创建 fork 的 `packages/coding-agent/test/extensibility/advisor-review-api.test.ts`
- 创建 fork 的 `packages/coding-agent/test/session/advisor-review-runtime.test.ts`

- [ ] **步骤 1：写 ExtensionAPI 转发失败测试**

初始化 runner 时注入 mock `requestAdvisorReview`，从加载后的真实 `ConcreteExtensionAPI` 调用，并断言 request/receipt 原样转发。

- [ ] **步骤 2：运行测试确认缺少 API**

运行：

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/extensibility/advisor-review-api.test.ts
```

预期：TypeScript/运行时 FAIL，方法不存在。

- [ ] **步骤 3：增加 Actions/runtime 转发**

```ts
// ExtensionAPI、ExtensionActions、ExtensionRuntime
requestAdvisorReview(request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt>;

// ConcreteExtensionAPI
requestAdvisorReview(request: AdvisorReviewRequest) {
	return this.runtime.requestAdvisorReview(request);
}

// ExtensionRunner.initialize
this.runtime.requestAdvisorReview = actions.requestAdvisorReview;
```

- [ ] **步骤 4：写 AgentSession 接线失败测试**

启用 Advisor，安装 `advisor_before_run` handler，调用 `session.requestAdvisorReview(request)`，断言 handler 收到 sessionId、advisorId、只读 messages 和 metadata。

- [ ] **步骤 5：实现 AgentSession 方法**

```ts
async requestAdvisorReview(request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> {
	if (!this.#advisorEnabled) return { accepted: false, reviewId: request.reviewId, reason: "advisor_disabled" };
	if (!this.#buildAdvisorRuntime(true) || this.#advisors.length === 0) {
		return { accepted: false, reviewId: request.reviewId, reason: "advisor_unavailable" };
	}
	return this.#advisors[0].runtime.requestReview(request);
}
```

runtime host 的 `beforeRun` 调用 `this.#extensionRunner?.emit({type:"advisor_before_run", ...})`；Agent facade 的 prompt 使用任务 2 helper 包裹 `advisorAgent.prompt(input)`。

- [ ] **步骤 6：补齐所有 Actions 构造点**

interactive、ACP、task executor 均加入 `requestAdvisorReview: request => session.requestAdvisorReview(request)`，使用各文件现有 session 变量。

- [ ] **步骤 7：运行并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/session/advisor-review-runtime.test.ts packages/coding-agent/test/extensibility/advisor-review-api.test.ts packages/coding-agent/test/extensibility/advisor-before-run.test.ts
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent run check:types
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance add packages/coding-agent/src packages/coding-agent/test/session packages/coding-agent/test/extensibility
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance commit -m "feat(session): 接通扩展发起的 Advisor 审查"
```

预期：全部 PASS，所有 Actions 构造点类型完整。

## 任务 6：实现 review envelope 和临时 verdict 工具

**仓库：** `/Users/mima1234/Code/super/omp-custom`

**文件：**
- 创建 `src/advisor/review-envelope.ts`、`src/advisor/compliance-advisor-hook.ts`
- 创建对应两个测试
- 修改 `src/types.ts`

- [ ] **步骤 1：写 envelope 失败测试**

固定输入 `session-1/task-9/HASH/attempt 1`，断言 `reviewId` 稳定、对象冻结、registry put/get/consume 后只消费一次。reviewId 使用四字段 JSON tuple 的 SHA-256，格式 `compliance:<64 hex>`。

- [ ] **步骤 2：运行红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/advisor/review-envelope.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 envelope/registry**

```ts
export interface ComplianceReviewEnvelope {
	readonly reviewId: string; readonly sessionId: string; readonly taskId: string;
	readonly contractHash: `sha256:${string}`; readonly attempt: number;
	readonly context: string; readonly rules: string; readonly createdAt: string;
}
export class ComplianceReviewRegistry {
	#active = new Map<string, ComplianceReviewEnvelope>();
	put(v: ComplianceReviewEnvelope) { this.#active.set(v.reviewId, v); }
	get(id: string) { return this.#active.get(id); }
	consume(id: string) { const v = this.#active.get(id); if (v) this.#active.delete(id); return v; }
}
```

- [ ] **步骤 4：写 Hook/工具失败测试**

普通 turn 返回 undefined；metadata 不匹配返回 undefined；匹配时返回 `[rules, context]` 和唯一工具；工具完整 schema 调用 `runtime.acceptVerdict`；旧 attempt 不调用 runtime。

- [ ] **步骤 5：实现 Hook**

```ts
if (event.trigger !== "compliance_review") return undefined;
const reviewId = typeof event.metadata?.reviewId === "string" ? event.metadata.reviewId : "";
const envelope = registry.get(reviewId);
if (!envelope || !matchesEnvelope(event, envelope)) return undefined;
return {
	additionalSystemContext: Object.freeze([envelope.rules, envelope.context]),
	additionalTools: Object.freeze([createComplianceVerdictTool(envelope, runtime)]),
	metadata: Object.freeze({ complianceReviewId: envelope.reviewId }),
};
```

工具先 `parseComplianceVerdict(params)`，逐字段比对 envelope，再 `await runtime.acceptVerdict(verdict)`；只在成功后 consume。

- [ ] **步骤 6：运行并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/advisor
git -C /Users/mima1234/Code/super/omp-custom add packages/omp-compliance/src/advisor packages/omp-compliance/src/types.ts packages/omp-compliance/test/advisor
git -C /Users/mima1234/Code/super/omp-custom commit -m "feat(compliance): 增加审查 envelope 和临时 verdict 工具"
```

## 任务 7：completion 生产路径构造 context/rules 并发起 review

**文件：**
- 修改扩展 `src/runtime/compliance-runtime.ts`、`src/extension.ts`
- 修改 `test/runtime/compliance-runtime.test.ts`、`test/extension.test.ts`

- [ ] **步骤 1：写生产调用失败测试**

注入 `requestAdvisorReview` spy，执行 `requestCompletion(validDeclaration)`，断言一次 request，trigger 为 compliance_review，metadata 绑定 task/hash/attempt；registry envelope 的 context 含 Completion Evidence，rules 含 compliance_verdict。rejected receipt 必须写 `advisor_unavailable` Evidence，状态保持 `advisor_reviewing`。

- [ ] **步骤 2：运行红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/runtime/compliance-runtime.test.ts
```

预期：FAIL，context/rules/review 没有生产调用。

- [ ] **步骤 3：注入窄依赖**

```ts
interface ComplianceReviewDependencies {
	sessionId(): string;
	registry: ComplianceReviewRegistry;
	requestAdvisorReview(request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt>;
}
```

不得把整个 ExtensionAPI 注入状态机。

- [ ] **步骤 4：按固定顺序接通**

snapshot → `buildCompletionContext` → `renderCompletionRules` → frozen envelope → completion_requested Evidence → registry.put → request → receipt Evidence → return `{snapshot,reviewId,receipt}`。request 抛错转换为 rejected receipt，不标完成。

- [ ] **步骤 5：activate 注册 Hook/action**

维护 session_start/session_switch 的当前 session binding；创建 registry；runtime review action 调 `pi.requestAdvisorReview`；注册 `pi.on("advisor_before_run", handler)`。缺少 session binding 时失败关闭。

- [ ] **步骤 6：运行并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/runtime test/extension.test.ts test/tools/compliance-complete-tool.test.ts
git -C /Users/mima1234/Code/super/omp-custom add packages/omp-compliance/src/runtime/compliance-runtime.ts packages/omp-compliance/src/extension.ts packages/omp-compliance/test/runtime packages/omp-compliance/test/extension.test.ts
git -C /Users/mima1234/Code/super/omp-custom commit -m "feat(compliance): 接通完成请求与 Advisor 审查"
```

预期：全部 PASS；context/rules 均有非测试入站调用。

## 任务 8：activate 零持久化副作用与 index-ready

**文件：**
- 修改扩展 `src/extension.ts`、`src/runtime/compliance-runtime.ts`、`src/signals/codebase-memory.ts`
- 修改 `test/extension.test.ts`、`test/signals/codebase-memory.test.ts`

- [ ] **步骤 1：写文件系统失败测试**

activate 后断言 `.omp/compliance` 不存在；执行 `/compliance start <fixture>` 后断言 task state 存在。

- [ ] **步骤 2：运行红灯**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/extension.test.ts
```

预期：FAIL，activate 已创建目录。

- [ ] **步骤 3：实现 lazy store factory**

```ts
const getEvidenceStore = memoize(() => new EvidenceStore(join(cwd, ".omp/compliance")));
```

只有合同成功加载后的 start 首次调用；无 active task 的 status 不调用 factory。

- [ ] **步骤 4：写 index 矩阵**

```ts
test.each([
	["index_repository", { success: true, status: "indexed" }, true],
	["index_repository", { success: true, status: "ready" }, true],
	["index_repository", { success: false, status: "indexed" }, false],
	["index_status", { success: true, status: "ready" }, true],
	["search_graph", { success: true }, false],
])("%s", (toolName, result, ready) => {
	expect(normalizeCodebaseMemory({ toolName, result }).indexReady).toBe(ready);
});
```

- [ ] **步骤 5：实现判定**

```ts
const indexReady = result.success === true && (
	(toolName === "index_repository" && ["indexed", "ready"].includes(status)) ||
	(toolName === "index_status" && status === "ready")
);
```

- [ ] **步骤 6：运行并提交**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/extension.test.ts test/signals/codebase-memory.test.ts
bun --cwd=/Users/mima1234/Code/super/omp-custom test
git -C /Users/mima1234/Code/super/omp-custom add packages/omp-compliance/src packages/omp-compliance/test/extension.test.ts packages/omp-compliance/test/signals/codebase-memory.test.ts
git -C /Users/mima1234/Code/super/omp-custom commit -m "fix(compliance): 延迟 Evidence 初始化并修复索引证据"
```

## 任务 9：真实跨仓闭环测试并删除旧 bridge

**文件：**
- 创建 fork `packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts`
- 修改 fork `packages/coding-agent/src/session/agent-session.ts`（`AgentSessionConfig`、class field、constructor 和 runtime builder 均在此文件）
- 删除 fork 旧 tool 和两份旧 bridge 测试

- [ ] **步骤 1：构建扩展**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom run build
```

预期：退出 0，`packages/omp-compliance/dist/extension.js` 存在。

- [ ] **步骤 2：写真实闭环失败测试**

必须用 OMP `loadExtensions()` 加载 built entry，创建其 ExtensionRunner 和启用 Advisor 的 AgentSession；执行 compliance start、写足 Evidence、执行 compliance_complete；fake Advisor stream 断言 rules/context 和临时 tool，并调用完整 pass fixture；最后断言 state completed 和 Evidence。再执行普通 turn，断言没有 compliance tool。禁止直接构造 mock sink。

- [ ] **步骤 3：运行红灯**

```bash
OMP_COMPLIANCE_PACKAGE=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance \
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts
```

预期：首次因真实安装边界或旧 bridge 残留 FAIL；不得用 sink 注入绕过。

- [ ] **步骤 4：让真实 loader 使用 package entry**

优先读取 package 现有 exports。只有确实缺少 entry 时，在扩展 package 增加 `"./extension":"./dist/extension.js"` 并在 omp-custom 单独提交 `fix(package): 暴露合规扩展运行入口`。

- [ ] **步骤 5：集成测试绿灯后删除旧 bridge**

删除 config 字段、class field、constructor assignment、`#buildAdvisorRuntime()` 条件注入、fork `ComplianceVerdictTool` 及 exports/tests。保留默认工具 read/grep/glob，禁止加入 compliance_verdict。

- [ ] **步骤 6：运行回归**

```bash
OMP_COMPLIANCE_PACKAGE=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance \
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts packages/coding-agent/test/advisor packages/coding-agent/test/extensibility
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent run check:types
! rg -n "complianceVerdictSink|ComplianceVerdictTool" /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent
```

预期：全部退出 0，反回归搜索无输出。

- [ ] **步骤 7：提交 fork**

```bash
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance add -A packages/coding-agent
git -C /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance commit -m "feat(compliance): 完成真实 Advisor 扩展闭环"
```

## 任务 10：关闭默认质量门

**仓库：** 两个仓库。

- [ ] **步骤 1：稳定扩展默认安装测试**

连续运行三次 package layout 测试。若子进程超过默认 5 秒，在测试内显式给该子进程 15 秒；若重复安装依赖，将准备迁入 `beforeAll`，但不得跳过 installed/package-layout 断言。

```bash
for i in 1 2 3; do bun --cwd=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance test test/installation/package-layout.test.ts || exit 1; done
```

- [ ] **步骤 2：运行扩展默认门**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom test
bun --cwd=/Users/mima1234/Code/super/omp-custom run check
bun --cwd=/Users/mima1234/Code/super/omp-custom run build
```

预期：全部退出 0，默认 test 不依赖命令行 timeout。

- [ ] **步骤 3：修复 fork 本次文件 Biome 输出**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent run check
```

按输出修 import order/format/lint，不增加 ignore。

- [ ] **步骤 4：运行 fork 目标门**

```bash
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor packages/coding-agent/test/extensibility packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent run check
```

预期：全部退出 0。

- [ ] **步骤 5：提交实际质量修复**

每仓只提交实际改动；无改动不创建空提交。提交信息分别为 `test(compliance): 稳定默认验收门` 和 `chore(compliance): 通过 Advisor 适配质量门`。

## 任务 11：最终验收、图谱刷新与证据归档

**文件：**
- 创建 `omp-custom/docs/superpowers/verification/2026-07-13-omp-advisor-compliance-production-closure.md`

- [ ] **步骤 1：运行最终命令**

```bash
bun --cwd=/Users/mima1234/Code/super/omp-custom test
bun --cwd=/Users/mima1234/Code/super/omp-custom run check
bun --cwd=/Users/mima1234/Code/super/omp-custom run build
OMP_COMPLIANCE_PACKAGE=/Users/mima1234/Code/super/omp-custom/packages/omp-compliance \
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/integration/omp-compliance-advisor-review.test.ts
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance test packages/coding-agent/test/advisor packages/coding-agent/test/extensibility
bun --cwd=/Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent run check
git -C /Users/mima1234/Code/super/oh-my-pi diff --exit-code
```

预期：全部退出 0。

- [ ] **步骤 2：结构性检查**

```bash
! rg -n "complianceVerdictSink|ComplianceVerdictTool|task/hash/action|requiredFix" /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent/src
rg -n "advisor_before_run|requestAdvisorReview" /Users/mima1234/Code/super/oh-my-pi-v16.4.6-compliance/packages/coding-agent/src
rg -n "buildCompletionContext|renderCompletionRules|requestAdvisorReview" /Users/mima1234/Code/super/omp-custom/packages/omp-compliance/src
```

预期：第一条无匹配；后两条显示定义与生产调用者。

- [ ] **步骤 3：刷新 codebase 图谱**

使用项目已配置的 codebase-memory MCP/CLI 分别重新索引两个实现仓库。图谱必须证明：

1. `buildCompletionContext()` 和 `renderCompletionRules()` 各有非测试入站调用；
2. `requestAdvisorReview()` 从 ExtensionAPI 到 AgentSession/AdvisorRuntime 路径连续；
3. `complianceVerdictSink` 和 fork `ComplianceVerdictTool` 不存在；
4. `acceptVerdict()` 可由临时工具闭包到达。

不得用纯文本搜索替代最终图谱证据。

- [ ] **步骤 4：写验收记录**

记录两个 HEAD SHA、所有命令和退出码、测试数量、真实闭环证据、未跟踪 `.codebase-memory/` 未提交，以及六个原始问题的逐项 PASS/FAIL。表头：

```markdown
| 原始问题 | 修复证据 | 测试/命令 | 结论 |
| --- | --- | --- | --- |
```

- [ ] **步骤 5：提交验收记录**

```bash
git -C /Users/mima1234/Code/super/omp-custom add docs/superpowers/verification/2026-07-13-omp-advisor-compliance-production-closure.md
git -C /Users/mima1234/Code/super/omp-custom commit -m "docs(compliance): 归档 Advisor 生产闭环验收证据"
```

## 需求追踪矩阵

| TRD 要求 | 任务 | 强制证据 |
| --- | --- | --- |
| 真实 ExtensionAPI → AgentSession | 3、4、5、9 | API 转发；真实 loader + AgentSession 集成测试 |
| 默认 Advisor 临时 verdict 工具 | 2、4、5、6、9 | 合规 run 有、普通 run 无 |
| context/rules 生产调用 | 7、11 | runtime 测试 + graph inbound |
| verdict 协议统一 | 1、6、9 | fixtures + 完整工具调用 |
| activate 无目录副作用 | 8 | activate/start 文件系统断言 |
| index_repository ready | 8 | 成功/失败/工具矩阵 |
| 幂等与过期拒绝 | 4、6、7 | duplicate reviewId、attempt mismatch、consume |
| Advisor 不可用失败关闭 | 5、7 | rejected receipt + reviewing 状态 |
| 普通 Advisor 不变 | 3、4、9 | turn_end 回归和工具隔离 |
| 删除旧 sink/协议 | 9、11 | 反回归搜索 + graph absence |
| 默认质量门 | 10、11 | test/check/build 退出 0 |

## 完成定义

- [ ] 真实 loader 加载扩展并由 AgentSession 发起 compliance_review。
- [ ] 单次 run 同时获得 rules、Evidence context 和唯一 verdict tool。
- [ ] 普通 run 不含 verdict tool。
- [ ] pass 完成当前 task/hash/attempt；remediate、旧协议、过期/迟到 verdict 失败关闭。
- [ ] start 前不创建目录，成功 index_repository 形成 ready Evidence。
- [ ] fork 不再含长期 sink、简化 schema 或默认工具 hack。
- [ ] 两仓默认 test/check/build 全绿。
- [ ] codebase 图谱已刷新并能追踪生产链。
- [ ] 验收记录含可复现命令、输出摘要和两个 HEAD SHA。

## 执行交接

按任务 1 → 11 执行。任务 2—7 是不可拆开的 Hook/业务接线主链；任务 9 先写真实红灯测试，再删除旧 bridge；任务 11 必须使用 `verification-before-completion`。

推荐使用 `superpowers:subagent-driven-development`，每任务启用新执行上下文并做规格/质量双审查；若在当前会话批量执行，使用 `superpowers:executing-plans`，每 2—3 个任务设置检查点。
