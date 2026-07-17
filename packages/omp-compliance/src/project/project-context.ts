import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { type ProjectBinding, validateProjectBinding } from "./project-identity";

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

export function createProjectContext(
	binding: Readonly<ProjectBinding>,
	sessionId: string,
	cwd: string,
): Readonly<ProjectContext> {
	let canonicalCwd: string;
	let validatedBinding: Readonly<ProjectBinding>;
	try {
		canonicalCwd = canonicalPath(cwd);
		validatedBinding = validateProjectBinding(binding);
		if (
			!isUuid(sessionId) ||
			canonicalPath(validatedBinding.canonicalRoot) !== validatedBinding.canonicalRoot ||
			!isPathWithin(validatedBinding.canonicalRoot, canonicalCwd)
		) {
			throw new Error(PROJECT_CONTEXT_INVALID_ERROR);
		}
	} catch {
		throw new Error(PROJECT_CONTEXT_INVALID_ERROR);
	}

	return Object.freeze({
		projectId: validatedBinding.projectId,
		root: validatedBinding.canonicalRoot,
		...(validatedBinding.gitRemoteIdentity === undefined ? {} : { remote: validatedBinding.gitRemoteIdentity }),
		...(validatedBinding.codebaseProjectId === undefined
			? {}
			: { codebaseProject: validatedBinding.codebaseProjectId }),
		sessionId,
		cwd: canonicalCwd,
	});
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_V4.test(value);
}

function canonicalPath(value: unknown): string {
	if (typeof value !== "string" || !isAbsolute(value) || normalize(value).split(sep).join("/") !== value) {
		throw new Error(PROJECT_CONTEXT_INVALID_ERROR);
	}
	return normalize(realpathSync(value)).split(sep).join("/");
}

function isPathWithin(root: string, cwd: string): boolean {
	const pathFromRoot = relative(root, cwd);
	return (
		pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}
