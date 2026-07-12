import { expect, test } from "bun:test";
import {
	createArtifactWriteRequest,
	createFakeHost,
	createStrictStageRequest,
	runStrictStage,
} from "../../src/index.ts";

const validRequest = () => ({
	taskId: "task-1",
	stageId: "implement",
	roleId: "superpowers:implementer",
	binding: {
		provider: "openai",
		modelId: "gpt-5.6",
		thinkingLevel: "max",
		bindingHash: "abc",
	},
	prompt: "Implement the approved change.",
	artifact: {
		acceptingDir: "/tmp/run",
		relativePath: "tasks/task-1/stages/implement/model-routing-evidence.json",
	},
});

test("creates an exact deeply frozen strict-stage request", () => {
	const request = createStrictStageRequest(validRequest());

	expect(request).toEqual({
		schemaVersion: 1,
		taskId: "task-1",
		stageId: "implement",
		roleId: "superpowers:implementer",
		binding: {
			provider: "openai",
			modelId: "gpt-5.6",
			thinkingLevel: "max",
			bindingHash: "abc",
		},
		prompt: "Implement the approved change.",
		artifact: {
			acceptingDir: "/tmp/run",
			relativePath: "tasks/task-1/stages/implement/model-routing-evidence.json",
		},
	});
	expect(Object.isFrozen(request)).toBe(true);
	expect(Object.isFrozen(request.binding)).toBe(true);
	expect(Object.isFrozen(request.artifact)).toBe(true);
});

test("rejects a parent-traversing task ID", () => {
	expect(() =>
		createStrictStageRequest({ ...validRequest(), taskId: "../task" }),
	).toThrow(TypeError);
});

test("rejects an empty role ID", () => {
	expect(() =>
		createStrictStageRequest({ ...validRequest(), roleId: "" }),
	).toThrow(TypeError);
});

test("rejects an absolute artifact relative path", () => {
	expect(() =>
		createStrictStageRequest({
			...validRequest(),
			artifact: {
				...validRequest().artifact,
				relativePath: "/tmp/evidence.json",
			},
		}),
	).toThrow(TypeError);
});

test("creates an exact deeply frozen artifact-write request", () => {
	const request = createArtifactWriteRequest({
		artifact: {
			acceptingDir: "/tmp/run",
			relativePath: "tasks/task-1/result.json",
		},
		json: { status: "accepted", findings: ["ok"] },
	});

	expect(request).toEqual({
		schemaVersion: 1,
		artifact: {
			acceptingDir: "/tmp/run",
			relativePath: "tasks/task-1/result.json",
		},
		json: { status: "accepted", findings: ["ok"] },
	});
	expect(Object.isFrozen(request)).toBe(true);
	expect(Object.isFrozen(request.artifact)).toBe(true);
	expect(Object.isFrozen(request.json)).toBe(true);
	expect(Object.isFrozen(request.json.findings)).toBe(true);
});

test("rejects a Date artifact payload", () => {
	expect(() =>
		createArtifactWriteRequest({
			artifact: {
				acceptingDir: "/tmp/run",
				relativePath: "tasks/task-1/result.json",
			},
			json: new Date(),
		}),
	).toThrow(TypeError);
});

test("rejects a parent-traversing artifact relative path", () => {
	expect(() =>
		createArtifactWriteRequest({
			artifact: {
				acceptingDir: "/tmp/run",
				relativePath: "tasks/../result.json",
			},
			json: { status: "accepted", findings: ["ok"] },
		}),
	).toThrow(TypeError);
});

test("delegates a valid strict stage through a compatible fake host", async () => {
	const host = createFakeHost({ hostCompatibilityVersion: 1 });

	const result = await runStrictStage(
		host,
		createStrictStageRequest(validRequest()),
	);

	expect(result).toMatchObject({ ok: true, value: { state: "completed" } });
	expect(host.calls()).toEqual(["getConfigSnapshot", "executeStrictStage"]);
});

test("rejects an incompatible fake host before strict-stage execution", async () => {
	const host = createFakeHost({ hostCompatibilityVersion: 2 });

	const result = await runStrictStage(
		host,
		createStrictStageRequest(validRequest()),
	);

	expect(result).toEqual({
		ok: false,
		error: {
			code: "host_incompatible",
			message:
				"Host contract version 2 is incompatible with custom contract version 1",
		},
	});
	expect(host.calls()).toEqual(["getConfigSnapshot"]);
});

test("returns immutable snapshots of fake-host call history", async () => {
	const host = createFakeHost({ hostCompatibilityVersion: 1 });
	const snapshot = host.calls();

	expect(Object.isFrozen(snapshot)).toBe(true);
	expect(() => snapshot.push("executeStrictStage")).toThrow(TypeError);
	await runStrictStage(host, createStrictStageRequest(validRequest()));
	expect(snapshot).toEqual([]);
	expect(host.calls()).toEqual(["getConfigSnapshot", "executeStrictStage"]);
});
