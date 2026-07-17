import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	EventLog,
	type EvidenceEvent,
	EvidencePersistenceError,
	type EvidenceWriteBoundary,
	type EvidenceWriteLease,
} from "./event-log";
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

interface DirectoryIdentity {
	path: string;
	device: bigint;
	inode: bigint;
}

interface TaskWriteLease extends EvidenceWriteLease {
	directories: DirectoryIdentity[];
}

function isMissingPath(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function isWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !pathFromRoot.startsWith(sep))
	);
}

class TaskEvidenceWriteBoundary implements EvidenceWriteBoundary {
	constructor(
		private readonly repositoryRoot: string,
		private readonly taskRoot: string,
	) {}

	prepareFileWrite(path: string): EvidenceWriteLease {
		return this.wrap(path, () => {
			this.assertTaskPath(path);
			const directories = this.ensureDirectoryChain(dirname(path));
			this.assertSafeFileTarget(path);
			return { path, directories } satisfies TaskWriteLease;
		});
	}

	verifyFileWrite(lease: EvidenceWriteLease): void {
		this.wrap(lease.path, () => {
			const taskLease = lease as TaskWriteLease;
			this.assertTaskPath(taskLease.path);
			for (const identity of taskLease.directories) {
				const status = lstatSync(identity.path, { bigint: true });
				if (
					status.isSymbolicLink() ||
					!status.isDirectory() ||
					status.dev !== identity.device ||
					status.ino !== identity.inode
				) {
					throw new Error("Evidence directory identity changed");
				}
			}
			this.assertResolvedWithinBoundary(dirname(taskLease.path));
		});
	}

	ensureDirectory(path: string): void {
		this.wrap(path, () => {
			this.assertTaskPath(path);
			const directories = this.ensureDirectoryChain(path);
			const lease: TaskWriteLease = { path, directories };
			this.verifyFileWrite(lease);
		});
	}

	private ensureDirectoryChain(target: string): DirectoryIdentity[] {
		if (!isWithin(this.repositoryRoot, target)) {
			throw new Error("Evidence path escaped repository root");
		}

		this.ensurePlainDirectory(this.repositoryRoot, true);
		const pathFromRoot = relative(this.repositoryRoot, target);
		let current = this.repositoryRoot;
		const directories = [this.captureDirectory(current)];
		for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
			current = join(current, segment);
			this.ensurePlainDirectory(current, false);
			directories.push(this.captureDirectory(current));
		}
		this.assertResolvedWithinBoundary(target);
		return directories;
	}

	private ensurePlainDirectory(path: string, recursive: boolean): void {
		try {
			const status = lstatSync(path);
			if (status.isSymbolicLink() || !status.isDirectory()) {
				throw new Error("Evidence path component is not a plain directory");
			}
			return;
		} catch (error) {
			if (!isMissingPath(error)) {
				throw error;
			}
		}

		mkdirSync(path, { recursive });
		const created = lstatSync(path);
		if (created.isSymbolicLink() || !created.isDirectory()) {
			throw new Error("Evidence path component changed during creation");
		}
	}

	private captureDirectory(path: string): DirectoryIdentity {
		const status = lstatSync(path, { bigint: true });
		if (status.isSymbolicLink() || !status.isDirectory()) {
			throw new Error("Evidence path component is not a plain directory");
		}
		return { path, device: status.dev, inode: status.ino };
	}

	private assertTaskPath(path: string): void {
		if (!isWithin(this.taskRoot, path)) {
			throw new Error("Evidence path escaped task root");
		}
	}

	private assertSafeFileTarget(path: string): void {
		try {
			const status = lstatSync(path);
			if (status.isSymbolicLink() || !status.isFile()) {
				throw new Error("Evidence file target is not a plain file");
			}
		} catch (error) {
			if (!isMissingPath(error)) {
				throw error;
			}
		}
	}

	private assertResolvedWithinBoundary(path: string): void {
		const resolvedRoot = realpathSync(this.repositoryRoot);
		const resolvedPath = realpathSync(path);
		if (!isWithin(resolvedRoot, resolvedPath)) {
			throw new Error("Evidence path resolved outside repository root");
		}
	}

	private wrap<T>(path: string, operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			if (error instanceof EvidencePersistenceError) {
				throw error;
			}
			throw new EvidencePersistenceError("validate_evidence_path", path, error);
		}
	}
}

export class EvidenceTaskRepository {
	readonly paths: EvidenceTaskPaths;
	readonly state: SnapshotStore;
	readonly contract: SnapshotStore;
	readonly events: EventLog;
	readonly overrides: EventLog;
	private readonly writeBoundary: TaskEvidenceWriteBoundary;

	constructor(
		root: string,
		readonly taskId: string,
	) {
		assertSafeTaskId(taskId);
		const repositoryRoot = resolve(root);
		const taskRoot = join(repositoryRoot, "tasks", taskId);
		this.writeBoundary = new TaskEvidenceWriteBoundary(repositoryRoot, taskRoot);
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
		this.state = new SnapshotStore(this.paths.state, this.writeBoundary);
		this.contract = new SnapshotStore(this.paths.contract, this.writeBoundary);
		this.events = new EventLog<EvidenceEvent>(this.paths.events, this.writeBoundary);
		this.overrides = new EventLog<EvidenceEvent>(this.paths.overrides, this.writeBoundary);
	}

	ensureArtifactDirectory(kind: EvidenceArtifactDirectory): string {
		const path = this.paths[kind];
		this.writeBoundary.ensureDirectory(path);
		return path;
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
