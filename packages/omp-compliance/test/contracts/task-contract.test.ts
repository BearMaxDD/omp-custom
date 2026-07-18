import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import {
	classifyTaskContractSource,
	compareTaskContractRevision,
	createLightweightTaskContract,
	loadTaskContractFromTdd,
} from "../../src/contracts/task-contract";

const repoRoot = resolve(join(__dirname, "..", ".."));
const fixture = join(__dirname, "..", "fixtures", "contracts", "code-task.md");
const createdAt = "2026-07-18T08:00:00.000Z";

describe("统一任务契约分类", () => {
	it.each([
		[{ affectedFiles: ["src/a.ts", "src/b.ts"], risk: "low" }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", changesPublicBehavior: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", includesMigration: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", crossRepository: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", crossModule: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", releaseProcess: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", binaryArtifact: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low", requiresParallelDelegation: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "medium" }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "high" }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], risk: "low" }, "lightweight"],
		[{ affectedFiles: ["src/a.ts"], lowRisk: true }, "lightweight"],
	] as const)("%j -> %s", (input, source) => {
		expect(classifyTaskContractSource(input)).toBe(source);
	});

	it("未知字段、类型、路径逃逸和风险冲突失败关闭", () => {
		expect(() => classifyTaskContractSource({ affectedFiles: [], risk: "low" })).toThrow();
		expect(() => classifyTaskContractSource({ affectedFiles: ["../escape.ts"], risk: "low" })).toThrow();
		expect(() =>
			classifyTaskContractSource({ affectedFiles: ["src/a.ts"], risk: "low", unknown: true } as never),
		).toThrow();
		expect(() => classifyTaskContractSource({ affectedFiles: ["src/a.ts"], risk: "medium", lowRisk: true })).toThrow();
		expect(() =>
			classifyTaskContractSource({ affectedFiles: ["src/a.ts"], risk: "low", binaryArtifact: "yes" } as never),
		).toThrow();
		expect(() => classifyTaskContractSource(new Proxy({}, {}))).toThrow();
	});
});

describe("正式与轻量任务契约", () => {
	it("正式 TDD 生成 TRD 8.1 完整不可变契约", () => {
		const contract = loadTaskContractFromTdd(fixture, repoRoot, {
			projectId: "omp-custom",
			gitHead: "5f3f782",
			affectedFiles: ["packages/omp-compliance/src/a.ts", "packages/omp-compliance/src/b.ts"],
			createdAt,
		});

		expect(contract).toMatchObject({
			schemaVersion: 1,
			source: "tdd",
			projectId: "omp-custom",
			gitHead: "5f3f782",
			delegationRequired: true,
			createdAt,
		});
		expect(contract.taskId).toBe("code-task");
		expect(contract.documentPath).toContain("fixtures/contracts/code-task.md");
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.scope.length).toBeGreaterThan(0);
		expect(contract.acceptanceCriteria.length).toBeGreaterThan(0);
		expect(contract.verificationCommands.length).toBeGreaterThan(0);
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.affectedFiles)).toBe(true);
	});

	it("轻量契约也具有 contractHash，并复制输入防止可变别名", () => {
		const affectedFiles = ["src/one.ts"];
		const contract = createLightweightTaskContract({
			projectId: "demo",
			gitHead: "abc123",
			affectedFiles,
			scope: ["修正文案"],
			acceptanceCriteria: ["测试通过"],
			verificationCommands: ["bun test"],
			risk: "low",
			createdAt,
		});
		affectedFiles[0] = "src/changed.ts";

		expect(contract).toMatchObject({ schemaVersion: 1, source: "lightweight", createdAt });
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.affectedFiles).toEqual(["src/one.ts"]);
		expect(contract.delegationRequired).toBe(false);
	});

	it("createdAt 不参与语义 revision，命令顺序参与且稳定去重", () => {
		const base = {
			projectId: "demo",
			gitHead: "abc123",
			affectedFiles: ["src/a.ts"],
			scope: ["B", "A"],
			acceptanceCriteria: ["done"],
			verificationCommands: ["lint", "test", "lint"],
			risk: "low" as const,
		};
		const first = createLightweightTaskContract({ ...base, createdAt: "2026-07-18T08:00:00.000Z" });
		const replay = createLightweightTaskContract({ ...base, scope: ["A", "B"], createdAt: "2026-07-19T08:00:00.000Z" });
		const reordered = createLightweightTaskContract({ ...base, verificationCommands: ["test", "lint"] });

		expect(first.verificationCommands).toEqual(["lint", "test"]);
		expect(first.revision).toBe(replay.revision);
		expect(first.contractHash).toBe(replay.contractHash);
		expect(first.revision).not.toBe(reordered.revision);
	});

	it("createdAt 必须严格 ISO", () => {
		expect(() =>
			createLightweightTaskContract({
				projectId: "demo",
				gitHead: "abc",
				affectedFiles: ["src/a.ts"],
				scope: ["x"],
				acceptanceCriteria: ["x"],
				verificationCommands: ["test"],
				risk: "low",
				createdAt: "2026-07-18",
			}),
		).toThrow();
	});

	it("revision 比较不执行 Proxy/accessor，并严格校验 sha256", () => {
		let reads = 0;
		const accessor = Object.defineProperty({}, "revision", {
			enumerable: true,
			get: () => {
				reads++;
				return "sha256:x";
			},
		});
		expect(() => compareTaskContractRevision(accessor as never, { revision: `sha256:${"a".repeat(64)}` })).toThrow();
		expect(reads).toBe(0);
		expect(() =>
			compareTaskContractRevision(
				new Proxy(
					{},
					{
						get: () => {
							reads++;
							return "x";
						},
					},
				) as never,
				{ revision: `sha256:${"a".repeat(64)}` },
			),
		).toThrow();
		expect(reads).toBe(0);
		expect(() =>
			compareTaskContractRevision({ revision: "sha256:xyz" as never }, { revision: `sha256:${"a".repeat(64)}` }),
		).toThrow();
	});
});
