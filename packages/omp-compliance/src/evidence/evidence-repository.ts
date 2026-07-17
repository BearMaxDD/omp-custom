import { join, resolve } from "node:path";
import { EventLog, type EvidenceEvent, EvidencePersistenceError } from "./event-log";
import { SecurePathScope } from "./secure-fs";
import { SnapshotStore } from "./snapshot-store";

export interface EvidenceTaskState {
	status: string;
	attempt: number;
	[key: string]: unknown;
}

export type EvidenceArtifactDirectory = "reviews" | "codebase" | "delegations" | "topics";

export interface EvidenceTaskPaths {
	root: string;
	state: string;
	contract: string;
	events: string;
	reviews: string;
	codebase: string;
	delegations: string;
	topics: string;
	overrides: string;
}

function assertSafeTaskId(taskId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || taskId === "." || taskId === "..") {
		throw new Error("Invalid evidence taskId");
	}
}

export class EvidenceTaskRepository {
	readonly paths: EvidenceTaskPaths;
	readonly state: SnapshotStore;
	readonly contract: SnapshotStore;
	readonly events: EventLog;
	readonly overrides: EventLog;
	private readonly scope: SecurePathScope;

	constructor(
		root: string,
		readonly taskId: string,
	) {
		assertSafeTaskId(taskId);
		const repositoryRoot = resolve(root);
		const taskRoot = join(repositoryRoot, "tasks", taskId);
		this.scope = new SecurePathScope(repositoryRoot, ["tasks", taskId]);
		this.paths = {
			root: taskRoot,
			state: join(taskRoot, "state.json"),
			contract: join(taskRoot, "contract.json"),
			events: join(taskRoot, "events.jsonl"),
			reviews: join(taskRoot, "reviews"),
			codebase: join(taskRoot, "codebase"),
			delegations: join(taskRoot, "delegations"),
			topics: join(taskRoot, "topics"),
			overrides: join(taskRoot, "overrides.jsonl"),
		};
		this.state = new SnapshotStore(this.paths.state, this.scope);
		this.contract = new SnapshotStore(this.paths.contract, this.scope);
		this.events = new EventLog<EvidenceEvent>(this.paths.events, this.scope);
		this.overrides = new EventLog<EvidenceEvent>(this.paths.overrides, this.scope);
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

export class EvidenceRepository {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	task(taskId: string): EvidenceTaskRepository {
		assertSafeTaskId(taskId);
		return new EvidenceTaskRepository(this.root, taskId);
	}
}
