export interface ProjectContext {
	readonly projectId: string;
	readonly root: string;
	readonly remote?: string;
	readonly codebaseProject?: string;
	readonly sessionId: string;
	readonly cwd: string;
}

export function createProjectContext(context: ProjectContext): Readonly<ProjectContext> {
	return Object.freeze({
		projectId: context.projectId,
		root: context.root,
		...(context.remote === undefined ? {} : { remote: context.remote }),
		...(context.codebaseProject === undefined ? {} : { codebaseProject: context.codebaseProject }),
		sessionId: context.sessionId,
		cwd: context.cwd,
	});
}
