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

describe("统一任务契约分类", () => {
	it.each([
		[{ affectedFiles: ["src/a.ts", "src/b.ts"], lowRisk: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], lowRisk: true, changesPublicBehavior: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], lowRisk: true, includesMigration: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], lowRisk: true, crossRepository: true }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], lowRisk: false }, "tdd"],
		[{ affectedFiles: ["src/a.ts"], lowRisk: true }, "lightweight"],
	] as const)("%j -> %s", (input, source) => {
		expect(classifyTaskContractSource(input)).toBe(source);
	});

	it("畸形、路径逃逸和空范围输入失败关闭", () => {
		expect(() => classifyTaskContractSource({ affectedFiles: [], lowRisk: true })).toThrow();
		expect(() => classifyTaskContractSource({ affectedFiles: ["../escape.ts"], lowRisk: true })).toThrow();
		expect(() => classifyTaskContractSource(new Proxy({}, {}))).toThrow();
	});
});

describe("正式与轻量任务契约", () => {
	it("正式 TDD 生成完整不可变契约并复用原始 SHA-256", () => {
		const contract = loadTaskContractFromTdd(fixture, repoRoot, {
			projectId: "omp-custom",
			gitHead: "5f3f782",
			affectedFiles: ["packages/omp-compliance/src/a.ts", "packages/omp-compliance/src/b.ts"],
		});

		expect(contract.source).toBe("tdd");
		expect(contract.projectId).toBe("omp-custom");
		expect(contract.gitHead).toBe("5f3f782");
		expect(contract.scope.length).toBeGreaterThan(0);
		expect(contract.acceptanceCriteria.length).toBeGreaterThan(0);
		expect(contract.verificationCommands.length).toBeGreaterThan(0);
		expect(contract.delegationRequired).toBe(true);
		expect(contract.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.affectedFiles)).toBe(true);
	});

	it("轻量契约仅接受单文件低风险任务并复制输入以防可变别名", () => {
		const affectedFiles = ["src/one.ts"];
		const contract = createLightweightTaskContract({
			projectId: "demo",
			gitHead: "abc123",
			affectedFiles,
			scope: ["修正文案"],
			acceptanceCriteria: ["测试通过"],
			verificationCommands: ["bun test"],
			lowRisk: true,
		});
		affectedFiles[0] = "src/changed.ts";

		expect(contract.source).toBe("lightweight");
		expect(contract.affectedFiles).toEqual(["src/one.ts"]);
		expect(contract.delegationRequired).toBe(false);
		expect(Object.isFrozen(contract)).toBe(true);
	});

	it("字段顺序不影响 revision，语义变化触发漂移", () => {
		const base = {
			projectId: "demo",
			gitHead: "abc123",
			affectedFiles: ["src/b.ts"],
			scope: ["B", "A"],
			acceptanceCriteria: ["done"],
			verificationCommands: ["bun test"],
			lowRisk: true as const,
		};
		const first = createLightweightTaskContract(base);
		const reordered = createLightweightTaskContract({ ...base, scope: ["A", "B"] });
		const changed = createLightweightTaskContract({ ...base, acceptanceCriteria: ["different"] });

		expect(first.revision).toBe(reordered.revision);
		expect(compareTaskContractRevision(first, reordered).drifted).toBe(false);
		expect(compareTaskContractRevision(first, changed).drifted).toBe(true);
	});
});
