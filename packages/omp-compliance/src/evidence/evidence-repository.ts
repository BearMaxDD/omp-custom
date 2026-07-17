import { lstatSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { EventLog, type EvidenceEvent, EvidencePersistenceError } from "./event-log";
import { SecurePathScope } from "./secure-fs";
import { SnapshotStore } from "./snapshot-store";

export interface EvidenceTaskState {
	status: string;
	attempt: number;
	[key: string]: unknown;
}

export type EvidenceArtifactDirectory = "reviews" | "codebase" | "delegations";

export interface EvidenceTaskPaths {
	root: string;
	state: string;
	contract: string;
	events: string;
	reviews: string;
	codebase: string;
	delegations: string;
}

export interface EvidenceTopicPaths {
	root: string;
	state: string;
	events: string;
	reviews: string;
}

export interface EvidenceRepositoryRecovery {
	taskIds: string[];
	topicIds: string[];
	cleanedTemporarySnapshots: string[];
}

function assertSafeTaskId(taskId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || taskId === "." || taskId === "..") {
		throw new Error("Invalid evidence taskId");
	}
}

function assertSafeTopicId(topicId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(topicId) || topicId === "." || topicId === "..") {
		throw new Error("Invalid evidence topicId");
	}
}

interface RepositoryBoundary {
	trustedRoot: string;
	components: string[];
}

function nearestPlainDirectory(path: string): string {
	let candidate = resolve(path);
	for (;;) {
		try {
			const status = lstatSync(candidate);
			if (status.isDirectory() && !status.isSymbolicLink()) return candidate;
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				(error as { code?: unknown }).code !== "ENOENT"
			) {
				throw error;
			}
		}
		const parent = dirname(candidate);
		if (parent === candidate) throw new Error("No trusted Evidence parent directory exists");
		candidate = parent;
	}
}

function repositoryBoundary(root: string, trustedRoot?: string): RepositoryBoundary {
	const repositoryRoot = resolve(root);
	const standardProjectRoot =
		dirname(repositoryRoot) !== repositoryRoot &&
		basename(dirname(repositoryRoot)) === ".omp" &&
		repositoryRoot === join(dirname(repositoryRoot), "compliance")
			? dirname(dirname(repositoryRoot))
			: undefined;
	const anchor = resolve(trustedRoot ?? standardProjectRoot ?? nearestPlainDirectory(dirname(repositoryRoot)));
	const pathFromAnchor = relative(anchor, repositoryRoot);
	if (
		!pathFromAnchor ||
		pathFromAnchor === ".." ||
		pathFromAnchor.startsWith(`..${sep}`) ||
		pathFromAnchor.startsWith(sep)
	) {
		throw new Error("Evidence repository must be below its trusted root");
	}
	return { trustedRoot: anchor, components: pathFromAnchor.split(sep).filter(Boolean) };
}

export class EvidenceTaskRepository {
	readonly paths: EvidenceTaskPaths;
	readonly state: SnapshotStore;
	readonly contract: SnapshotStore;
	readonly events: EventLog;
	private readonly scope: SecurePathScope;

	constructor(
		root: string,
		readonly taskId: string,
		trustedRoot?: string,
	) {
		assertSafeTaskId(taskId);
		const repositoryRoot = resolve(root);
		const taskRoot = join(repositoryRoot, "tasks", taskId);
		const boundary = repositoryBoundary(repositoryRoot, trustedRoot);
		this.scope = new SecurePathScope(boundary.trustedRoot, [...boundary.components, "tasks", taskId]);
		this.paths = {
			root: taskRoot,
			state: join(taskRoot, "state.json"),
			contract: join(taskRoot, "contract.json"),
			events: join(taskRoot, "events.jsonl"),
			reviews: join(taskRoot, "reviews"),
			codebase: join(taskRoot, "codebase"),
			delegations: join(taskRoot, "delegations"),
		};
		this.state = new SnapshotStore(this.paths.state, this.scope);
		this.contract = new SnapshotStore(this.paths.contract, this.scope);
		this.events = new EventLog<EvidenceEvent>(this.paths.events, this.scope);
	}

	ensureArtifactDirectory(kind: EvidenceArtifactDirectory): string {
		const path = this.paths[kind];
		try {
			this.scope.ensureDirectory(kind);
			return path;
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("ensure_artifact_directory", path, error);
		}
	}
}

export class EvidenceTopicRepository {
	readonly paths: EvidenceTopicPaths;
	readonly state: SnapshotStore;
	readonly events: EventLog;
	private readonly scope: SecurePathScope;

	constructor(
		root: string,
		readonly topicId: string,
		trustedRoot?: string,
	) {
		assertSafeTopicId(topicId);
		const repositoryRoot = resolve(root);
		const topicRoot = join(repositoryRoot, "topics", topicId);
		const boundary = repositoryBoundary(repositoryRoot, trustedRoot);
		this.scope = new SecurePathScope(boundary.trustedRoot, [...boundary.components, "topics", topicId]);
		this.paths = {
			root: topicRoot,
			state: join(topicRoot, "state.json"),
			events: join(topicRoot, "events.jsonl"),
			reviews: join(topicRoot, "reviews"),
		};
		this.state = new SnapshotStore(this.paths.state, this.scope);
		this.events = new EventLog<EvidenceEvent>(this.paths.events, this.scope);
	}

	ensureReviewsDirectory(): string {
		try {
			this.scope.ensureDirectory("reviews");
			return this.paths.reviews;
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("ensure_artifact_directory", this.paths.reviews, error);
		}
	}

	recover(): string[] {
		return this.state.recover();
	}
}

export class EvidenceRepository {
	readonly root: string;
	readonly overrides: EventLog;
	private readonly trustedRoot?: string;
	private readonly boundary: RepositoryBoundary;
	private readonly tasksScope: SecurePathScope;
	private readonly topicsScope: SecurePathScope;
	private readonly rootSnapshots: SnapshotStore[];
	private readonly taskRepositories = new Map<string, EvidenceTaskRepository>();
	private readonly topicRepositories = new Map<string, EvidenceTopicRepository>();

	constructor(root: string, trustedRoot?: string) {
		this.root = resolve(root);
		this.trustedRoot = trustedRoot === undefined ? undefined : resolve(trustedRoot);
		this.boundary = repositoryBoundary(this.root, this.trustedRoot);
		this.tasksScope = new SecurePathScope(this.boundary.trustedRoot, [...this.boundary.components, "tasks"]);
		this.topicsScope = new SecurePathScope(this.boundary.trustedRoot, [...this.boundary.components, "topics"]);
		const rootScope = new SecurePathScope(this.boundary.trustedRoot, this.boundary.components);
		this.overrides = new EventLog<EvidenceEvent>(join(this.root, "overrides.jsonl"), rootScope);
		this.rootSnapshots = [
			new SnapshotStore(join(this.root, "project.json"), rootScope),
			new SnapshotStore(join(this.root, "scheduler.json"), rootScope),
		];
	}

	task(taskId: string): EvidenceTaskRepository {
		assertSafeTaskId(taskId);
		const existing = this.taskRepositories.get(taskId);
		if (existing) return existing;
		const repository = new EvidenceTaskRepository(this.root, taskId, this.trustedRoot);
		this.taskRepositories.set(taskId, repository);
		return repository;
	}

	topic(topicId: string): EvidenceTopicRepository {
		assertSafeTopicId(topicId);
		const existing = this.topicRepositories.get(topicId);
		if (existing) return existing;
		const repository = new EvidenceTopicRepository(this.root, topicId, this.trustedRoot);
		this.topicRepositories.set(topicId, repository);
		return repository;
	}

	recover(): EvidenceRepositoryRecovery {
		try {
			const taskIds = this.tasksScope
				.listDirectories()
				.filter((taskId) => {
					try {
						assertSafeTaskId(taskId);
						return true;
					} catch {
						return false;
					}
				})
				.sort();
			const topicIds = this.topicsScope
				.listDirectories()
				.filter((topicId) => {
					try {
						assertSafeTopicId(topicId);
						return true;
					} catch {
						return false;
					}
				})
				.sort();
			const cleanedTemporarySnapshots = this.rootSnapshots.flatMap((snapshot) => snapshot.recover());
			cleanedTemporarySnapshots.push(
				...taskIds.flatMap((taskId) => {
					const task = this.task(taskId);
					return [...task.state.recover(), ...task.contract.recover()];
				}),
			);
			cleanedTemporarySnapshots.push(...topicIds.flatMap((topicId) => this.topic(topicId).recover()));
			return { taskIds, topicIds, cleanedTemporarySnapshots };
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("recover_repository", this.root, error);
		}
	}
}
