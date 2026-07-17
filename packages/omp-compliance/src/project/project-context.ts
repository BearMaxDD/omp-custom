import { isAbsolute, normalize, sep } from "node:path";

export interface ProjectContext {
	readonly projectId: string;
	readonly root: string;
	readonly remote?: string;
	readonly codebaseProject?: string;
	readonly sessionId: string;
	readonly cwd: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_CONTEXT_INVALID_ERROR = "OMP project context is invalid";

export function createProjectContext(context: ProjectContext): Readonly<ProjectContext> {
	if (
		!isRecord(context) ||
		!isUuid(context.projectId) ||
		!isValidPath(context.root) ||
		(context.remote !== undefined && !isNonEmptyString(context.remote)) ||
		(context.codebaseProject !== undefined && !isNonEmptyString(context.codebaseProject)) ||
		!isUuid(context.sessionId) ||
		!isValidPath(context.cwd)
	) {
		throw new Error(PROJECT_CONTEXT_INVALID_ERROR);
	}

	return Object.freeze({
		projectId: context.projectId,
		root: context.root,
		...(context.remote === undefined ? {} : { remote: context.remote }),
		...(context.codebaseProject === undefined ? {} : { codebaseProject: context.codebaseProject }),
		sessionId: context.sessionId,
		cwd: context.cwd,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_V4.test(value);
}

function isValidPath(value: unknown): value is string {
	return isNonEmptyString(value) && isAbsolute(value) && normalize(value).split(sep).join("/") === value;
}
