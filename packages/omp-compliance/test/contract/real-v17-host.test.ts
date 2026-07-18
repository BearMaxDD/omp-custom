import { describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import { selectAdvisorReadOnlyToolNames } from "../../src/extension";
import { READONLY_CODEBASE_TOOLS } from "../../src/xdev/codebase-tool-policy";

type ComplianceExtensionModule = typeof import("../../src/extension");

const hostInput = process.env.OMP_V17_HOST;
if (!hostInput) throw new Error("OMP_V17_HOST must point to the real v17 host worktree");
const host = realpathSync(hostInput);
const codingAgent = join(host, "packages", "coding-agent");
const extensionEntry = realpathSync(join(import.meta.dir, "../../src/extension.ts"));

async function importHost<T>(relativePath: string): Promise<T> {
	return (await import(pathToFileURL(join(codingAgent, relativePath)).href)) as T;
}

async function loadRealHostModules() {
	const loader = await importHost<typeof import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader")>(
		"src/extensibility/extensions/loader.ts",
	);
	const runner = await importHost<typeof import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner")>(
		"src/extensibility/extensions/runner.ts",
	);
	const sessionManager = await importHost<typeof import("@oh-my-pi/pi-coding-agent/session/session-manager")>(
		"src/session/session-manager.ts",
	);
	const eventBus =
		await importHost<typeof import("@oh-my-pi/pi-coding-agent/utils/event-bus")>("src/utils/event-bus.ts");
	return { ...loader, ...runner, ...sessionManager, ...eventBus };
}

function extensionActions(toolNames: readonly string[]) {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [...toolNames],
		getAllTools: () => [...toolNames],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	};
}

const contextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: async () => {},
	getSystemPrompt: () => [],
};

describe("real OMP v17 host contract", () => {
	it("loads this repository's activate factory through the real host loader", async () => {
		const { EventBus, ExtensionRuntime, loadExtensionFromFactory } = await loadRealHostModules();
		const { default: activate } = (await import(pathToFileURL(extensionEntry).href)) as ComplianceExtensionModule;
		const extension = await loadExtensionFromFactory(
			activate,
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"omp-compliance-real-v17",
		);

		const tools = [...extension.tools.values()].map((registered) => registered.definition);
		const names = tools.map((tool) => tool.name);
		for (const essential of ["compliance_complete", "brainstorm_topic_ready", "brainstorm_decision"]) {
			expect(names).toContain(essential);
			expect(tools.find((tool) => tool.name === essential)?.loadMode).toBe("essential");
		}
		expect(names).not.toContain("compliance_verdict");
		expect(names).not.toContain("brainstorm_review");
		expect(extension.handlers.has("advisor_before_run")).toBe(true);
	});

	it("preserves compliance read-only tools and verdict identity through real ExtensionRunner", async () => {
		const { EventBus, ExtensionRunner, ExtensionRuntime, loadExtensionFromFactory, SessionManager } =
			await loadRealHostModules();
		const registry = new ComplianceReviewRegistry();
		const envelope = createEnvelope({
			sessionId: "primary-contract-session",
			taskId: "contract-task",
			projectId: "123e4567-e89b-42d3-a456-426614174000",
			contractHash: `sha256:${"a".repeat(64)}`,
			evidenceRevision: `sha256:${"b".repeat(64)}`,
			gitHead: "c".repeat(40),
			diffHash: `sha256:${"d".repeat(64)}`,
			trigger: "compliance_review",
			attempt: 1,
			context: "contract context",
			rules: "contract rules",
		});
		registry.put(envelope);
		const trustedSearch = "mcp__codebase_memory_mcp_search_graph";
		const allToolNames = [
			trustedSearch,
			"search_graph",
			"mcp__codebase_memory_mcp_index_repository",
			"mcp__untrusted_search_graph",
			"ordinary_tool",
		];
		const requestedToolNames = selectAdvisorReadOnlyToolNames(allToolNames);
		const extension = await loadExtensionFromFactory(
			(api) => {
				api.on(
					"advisor_before_run",
					createComplianceAdvisorHook(
						registry,
						{ acceptVerdict: async () => ({ accepted: true }) },
						requestedToolNames,
					),
				);
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"omp-compliance-advisor-contract",
		);
		const runtime = new ExtensionRuntime();
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
		runner.initialize(extensionActions(allToolNames), contextActions);

		const augmentation = await runner.emitAdvisorBeforeRun({
			type: "advisor_before_run",
			reviewId: envelope.reviewId,
			trigger: "compliance_review",
			priority: 100,
			primarySessionId: envelope.sessionId,
			advisorSessionId: "advisor-contract-session",
			metadata: {
				taskId: envelope.taskId,
				projectId: envelope.projectId,
				contractHash: envelope.contractHash,
				evidenceRevision: envelope.evidenceRevision,
				gitHead: envelope.gitHead,
				diffHash: envelope.diffHash,
				attempt: envelope.attempt,
			},
		});

		expect(augmentation.requestedToolNames).toEqual([trustedSearch]);
		expect(augmentation.requestedToolNames).not.toContain("search_graph");
		expect(augmentation.requestedToolNames).not.toContain("index_repository");
		expect(augmentation.requestedToolNames).not.toContain("mcp__codebase_memory_mcp_index_repository");
		expect(augmentation.verdictToolNames).toEqual(["compliance_verdict"]);
		expect(augmentation.additionalTools?.map((tool) => tool.name)).toEqual(["compliance_verdict"]);
	});

	it("lists, documents, and dispatches a discoverable probe through real XdevRegistry", async () => {
		const { XdevRegistry } =
			await importHost<typeof import("@oh-my-pi/pi-coding-agent/tools/xdev")>("src/tools/xdev.ts");
		const probe = {
			name: "contract_probe",
			label: "Contract Probe",
			description: "Probe the real xd:// registry contract.",
			loadMode: "discoverable" as const,
			parameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
			execute: async (_toolCallId: string, params: { value: string }) => ({
				content: [{ type: "text" as const, text: `probe:${params.value}` }],
				details: { echoed: params.value },
			}),
		};
		const registry = new XdevRegistry([probe as never]);

		expect(registry.listing()).toContain("xd://contract_probe");
		expect(registry.docs("contract_probe")).toContain("# contract_probe");
		expect(registry.docs("contract_probe")).toContain('"value"');
		const dispatched = await registry.dispatch("contract_probe", JSON.stringify({ value: "v17" }), "xd-contract");
		expect(dispatched.xdev).toMatchObject({ tool: "contract_probe", mode: "execute", args: { value: "v17" } });
		expect(dispatched.result.content).toEqual([{ type: "text", text: "probe:v17" }]);
		expect(dispatched.result.details).toEqual({ echoed: "v17" });
	});

	it("keeps Advisor Codebase access read-only", () => {
		expect([...READONLY_CODEBASE_TOOLS].sort()).toEqual(
			[
				"get_architecture",
				"get_code_snippet",
				"index_status",
				"query_graph",
				"search_code",
				"search_graph",
				"trace_path",
			].sort(),
		);
		expect(READONLY_CODEBASE_TOOLS.has("index_repository")).toBe(false);
	});

	it("wires requestAdvisorReview into two UI paths, ACP, and task executor", () => {
		const uiSource = readFileSync(join(codingAgent, "src/modes/controllers/extension-ui-controller.ts"), "utf8");
		const acpSource = readFileSync(join(codingAgent, "src/modes/acp/acp-agent.ts"), "utf8");
		const executorSource = readFileSync(join(codingAgent, "src/task/executor.ts"), "utf8");
		const actionPattern = /requestAdvisorReview:\s*async\s+request\s*=>/g;

		expect(uiSource.match(actionPattern)).toHaveLength(2);
		expect(acpSource.match(actionPattern)).toHaveLength(1);
		expect(executorSource.match(actionPattern)).toHaveLength(1);
		expect(uiSource.match(/session\.requestAdvisorReview\(request\)/g)?.length).toBeGreaterThanOrEqual(2);
		expect(acpSource).toContain("session.requestAdvisorReview(request)");
		expect(executorSource).toContain("session.requestAdvisorReview(request)");
	});
});
