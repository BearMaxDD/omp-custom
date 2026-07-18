import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
/**
 * Upstream API Contract Test.
 *
 * Guards the extension against drifting away from the pinned OMP v17 Host
 * package and against introducing local protocol-type intermediaries.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdvisorBeforeRunEvent } from "@oh-my-pi/pi-coding-agent/advisor/index";
import ts from "typescript";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import activate from "../../src/extension";
import { FakeExtensionAPI } from "../support/fake-extension-api";

const HOST_PACKAGE = "/Users/mima1234/Code/super/.worktrees/oh-my-pi-v17-advisor-protocol/packages/coding-agent";
const HOST_HEAD = "2adbf91f6d73534342f194f99b1a305db37ae1cf";
const PACKAGE_ROOT = join(import.meta.dir, "../..");
const ROOT_TYPES_MODULE = join(PACKAGE_ROOT, "src/types");
const ADVISOR_INDEX_MODULE = "@oh-my-pi/pi-coding-agent/advisor/index";
const PROTOCOL_CALLERS = [
	"src/advisor/compliance-advisor-hook.ts",
	"src/advisor/review-envelope.ts",
	"src/brainstorm/advisor-hook.ts",
	"src/brainstorm/brainstorm-runtime.ts",
	"src/extension.ts",
	"src/runtime/compliance-runtime.ts",
	"test/support/fake-extension-api.ts",
] as const;

function collectTypeScriptFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectTypeScriptFiles(path);
		return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
	});
}

function collectModuleSpecifiers(file: string): string[] {
	const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const specifiers: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			specifiers.push(node.moduleReference.expression.text);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			specifiers.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);
	return specifiers;
}

function resolvesToRootTypes(file: string, specifier: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const target = resolve(dirname(file), specifier).replace(/\.[cm]?[jt]sx?$/, "");
	return target === ROOT_TYPES_MODULE || target === join(ROOT_TYPES_MODULE, "index");
}

const tmpDir = mkdtempSync(join(tmpdir(), "omp-contract-"));
const store = new TopicStore(tmpDir);
const coordinator = new TopicCoordinator(store);

afterAll(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("upstream API contract — REAL shapes", () => {
	describe("OMP v17 extension contract", () => {
		it("keeps the compiler package direct and out of the Host catalog bridge", () => {
			const rootPackageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "../../package.json"), "utf8")) as {
				workspaces?: { catalog?: Record<string, string> };
			};
			const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
				devDependencies?: Record<string, string>;
			};

			expect(rootPackageJson.workspaces?.catalog?.["@typescript/native-preview"]).toBeUndefined();
			expect(packageJson.devDependencies?.["@typescript/native-preview"]).toBe("7.0.0-dev.20260707.2");
		});

		it("resolves the v17 development dependency from the pinned Host worktree", () => {
			const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
				peerDependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};

			expect(packageJson.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe(">=17.0.1 <18");
			expect(packageJson.devDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe(`file:${HOST_PACKAGE}`);

			const resolvedPackageJson = realpathSync(
				fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/package.json")),
			);
			expect(readFileSync(resolvedPackageJson, "utf8")).toBe(readFileSync(join(HOST_PACKAGE, "package.json"), "utf8"));
			const resolvedTypes = join(dirname(resolvedPackageJson), "src/extensibility/extensions/types.ts");
			expect(readFileSync(resolvedTypes, "utf8")).toBe(
				readFileSync(join(HOST_PACKAGE, "src/extensibility/extensions/types.ts"), "utf8"),
			);
			const lockfile = readFileSync(join(import.meta.dir, "../../../../bun.lock"), "utf8");
			expect(lockfile).toContain(
				"@oh-my-pi/pi-coding-agent@file:../oh-my-pi-v17-advisor-protocol/packages/coding-agent",
			);
			expect(
				execFileSync("git", ["-C", HOST_PACKAGE, "rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim(),
			).toBe(HOST_HEAD);
		});

		it("registers all public tools with the v17 execute contract", () => {
			const fake = new FakeExtensionAPI();
			activate(fake.toAPI());

			for (const name of ["compliance_complete", "brainstorm_topic_ready", "brainstorm_decision"]) {
				const tool = fake.toolDefinitions.find((candidate) => candidate.name === name);
				expect(tool, `${name} must be registered`).toBeDefined();
				expect(typeof tool?.label).toBe("string");
				expect(tool?.label.length).toBeGreaterThan(0);
				expect(tool?.loadMode).toBe("essential");
				expect(tool?.approval).toBe("write");
				expect(typeof tool?.execute).toBe("function");
				expect("handler" in (tool as unknown as Record<string, unknown>)).toBe(false);
			}
		});

		it("does not keep a root protocol-types intermediary", () => {
			expect(existsSync(`${ROOT_TYPES_MODULE}.ts`)).toBe(false);
		});

		it("does not re-export or alias Host protocol types from the public index", () => {
			const indexPath = join(PACKAGE_ROOT, "src/index.ts");
			const indexSource = readFileSync(indexPath, "utf8");
			const sourceFile = ts.createSourceFile(indexPath, indexSource, ts.ScriptTarget.Latest, true);
			const hostReExports = sourceFile.statements
				.filter(ts.isExportDeclaration)
				.flatMap((statement) =>
					statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
						? [statement.moduleSpecifier.text]
						: [],
				)
				.filter((specifier) => specifier.startsWith("@oh-my-pi/"));

			expect(hostReExports).toEqual([]);
			for (const hostType of [
				"ExtensionAPI",
				"ExtensionContext",
				"ExtensionHandler",
				"ToolDefinition",
				"RegisteredCommand",
				"AgentTool",
				"AgentToolResult",
				"AdvisorBeforeRunEvent",
				"AdvisorRunAugmentation",
				"AdvisorReviewRequest",
				"AdvisorReviewReceipt",
			]) {
				expect(indexSource).not.toMatch(new RegExp(`\\b${hostType}\\b`));
			}
		});

		it("does not import the root protocol-types intermediary from production or tests", () => {
			const violations = [join(PACKAGE_ROOT, "src"), join(PACKAGE_ROOT, "test")]
				.flatMap(collectTypeScriptFiles)
				.flatMap((file) =>
					collectModuleSpecifiers(file)
						.filter((specifier) => resolvesToRootTypes(file, specifier))
						.map((specifier) => `${file}: ${specifier}`),
				);

			expect(violations).toEqual([]);
		});

		it("does not declare catch-all JavaScript ambient modules", () => {
			const declarationPath = join(PACKAGE_ROOT, "src/host-assets.d.ts");
			const sourceFile = ts.createSourceFile(
				declarationPath,
				readFileSync(declarationPath, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			const ambientModuleNames = sourceFile.statements
				.filter(ts.isModuleDeclaration)
				.flatMap((statement) => (ts.isStringLiteral(statement.name) ? [statement.name.text] : []));

			expect(ambientModuleNames).not.toContain("*.js");
			expect(ambientModuleNames).not.toContain("*");
		});

		it("imports protocol-only Host types from the narrow review-protocol entrypoint", () => {
			const violations = PROTOCOL_CALLERS.flatMap((relativePath) => {
				const file = join(PACKAGE_ROOT, relativePath);
				return collectModuleSpecifiers(file)
					.filter((specifier) => specifier === ADVISOR_INDEX_MODULE)
					.map((specifier) => `${relativePath}: ${specifier}`);
			});

			expect(violations).toEqual([]);
		});

		it("keeps the Fake and event bridge free of double-assertion signature escapes", () => {
			const fakeSource = readFileSync(join(import.meta.dir, "../support/fake-extension-api.ts"), "utf8");
			const extensionSource = readFileSync(join(import.meta.dir, "../../src/extension.ts"), "utf8");

			expect(fakeSource).not.toMatch(/as\s+unknown\s+as/);
			expect(extensionSource).not.toMatch(/as\s+unknown\s+as/);
			expect(fakeSource).toContain('handler: RegisteredCommand["handler"]');
		});
	});

	// ── Brainstorm uses its dedicated v17 trigger ─────────────────────

	it("brainstorm hook matches on brainstorm_review trigger", () => {
		const registry = new BrainstormReviewRegistry();
		const hook = createBrainstormAdvisorHook(registry, coordinator, () => {});

		// Pre-register an envelope so registry.get(reviewId) would succeed
		const reviewId = "br-contract-test";
		registry.put({
			reviewId,
			topicId: "topic-1",
			inputHash: "sha256:abc" as const,
			context: "<c/>",
			rules: "r",
			requestedToolNames: [],
			createdAt: new Date().toISOString(),
		});

		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			metadata: { reviewId },
			primarySessionId: "s1",
			advisorSessionId: "a1",
		};

		// EXPECT: hook matches and returns context/tools
		// BUG: current code gates on !== "brainstorm_review" → returns undefined
		const result = hook(event);
		expect(result).toBeDefined();
		expect(result?.additionalSystemContext).toBeDefined();
		expect(result?.additionalTools).toHaveLength(1);
	});

	// ── No-regression: turn_end must not match ─────────────────────

	it("compliance hook returns undefined on turn_end trigger", () => {
		const registry = new ComplianceReviewRegistry();
		const hook = createComplianceAdvisorHook(registry, {
			acceptVerdict: () => Promise.resolve({ accepted: true }),
		});

		const envelope = createEnvelope({
			sessionId: "s1",
			taskId: "task-1",
			projectId: "123e4567-e89b-42d3-a456-426614174000",
			contractHash: "sha256:abc" as const,
			evidenceRevision: "sha256:evidence" as const,
			gitHead: "abc123",
			diffHash: "sha256:diff" as const,
			trigger: "compliance_review",
			attempt: 1,
			context: "<c/>",
			rules: "r",
		});
		registry.put(envelope);

		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId: envelope.reviewId,
			trigger: "turn_end",
			priority: 100,
			metadata: { reviewId: envelope.reviewId, taskId: "task-1", contractHash: "sha256:abc", attempt: 1 },
			primarySessionId: "s1",
			advisorSessionId: "a1",
		};

		expect(hook(event)).toBeUndefined();
	});

	it("brainstorm hook returns undefined on turn_end trigger", () => {
		const registry = new BrainstormReviewRegistry();
		const hook = createBrainstormAdvisorHook(registry, coordinator, () => {});

		registry.put({
			reviewId: "br-turnend",
			topicId: "t-1",
			inputHash: "sha256:abc" as const,
			context: "<c/>",
			rules: "r",
			requestedToolNames: [],
			createdAt: new Date().toISOString(),
		});

		// After BUG-1 fix (gate becomes === "compliance_review"),
		// this must still return undefined for turn_end
		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId: "br-turnend",
			trigger: "turn_end",
			priority: 80,
			metadata: { reviewId: "br-turnend" },
			primarySessionId: "s1",
			advisorSessionId: "a1",
		};

		// BUG-1 fix changes only the trigger gate, not turn_end behavior
		expect(hook(event)).toBeUndefined();
	});
});
