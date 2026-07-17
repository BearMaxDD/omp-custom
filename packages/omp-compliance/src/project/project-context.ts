import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, sep } from "node:path";
import {
	type ProjectIdentityResult,
	ProjectIdentityStore,
	isBoundProjectIdentityResult,
	validateProjectBinding,
} from "./project-identity";

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
	...args: [
		identity: ProjectIdentityResult,
		sessionId: string,
		cwd: string,
		currentCodebaseProjectId: string | undefined,
	]
): Readonly<ProjectContext> {
	const hasCurrentCodebaseObservation = args.length >= 4;
	const [identity, sessionId, cwd, currentCodebaseProjectId] = args;
	let canonicalCwd: string;
	let validatedBinding: ReturnType<typeof validateProjectBinding>;
	try {
		if (!hasCurrentCodebaseObservation || !isBoundProjectIdentityResult(identity)) {
			throw new Error(PROJECT_CONTEXT_INVALID_ERROR);
		}
		canonicalCwd = canonicalPath(cwd);
		validatedBinding = validateProjectBinding(identity.binding);
		if (
			!isUuid(sessionId) ||
			canonicalPath(validatedBinding.canonicalRoot) !== validatedBinding.canonicalRoot ||
			!isPathWithin(validatedBinding.canonicalRoot, canonicalCwd)
		) {
			throw new Error(PROJECT_CONTEXT_INVALID_ERROR);
		}
		const freshIdentity = ProjectIdentityStore.open(canonicalCwd, { codebaseProjectId: currentCodebaseProjectId });
		if (
			freshIdentity.status !== "bound" ||
			freshIdentity.binding.projectId !== validatedBinding.projectId ||
			freshIdentity.observedRoot !== validatedBinding.canonicalRoot ||
			freshIdentity.observedRemote !== validatedBinding.gitRemoteIdentity ||
			freshIdentity.binding.codebaseProjectId !== validatedBinding.codebaseProjectId
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
	if (typeof value !== "string" || !isAbsolute(value)) {
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
