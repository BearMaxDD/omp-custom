import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventLog, type EvidenceEvent, EvidencePersistenceError } from "./event-log";
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

	constructor(
		root: string,
		readonly taskId: string,
	) {
		const taskRoot = join(root, "tasks", taskId);
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
		this.state = new SnapshotStore(this.paths.state);
		this.contract = new SnapshotStore(this.paths.contract);
		this.events = new EventLog<EvidenceEvent>(this.paths.events);
		this.overrides = new EventLog<EvidenceEvent>(this.paths.overrides);
	}

	ensureArtifactDirectory(kind: EvidenceArtifactDirectory): string {
		const path = this.paths[kind];
		try {
			mkdirSync(path, { recursive: true });
			return path;
		} catch (error) {
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
