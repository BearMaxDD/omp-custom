import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { BaseProducer } from "./base";

export interface FileWatchOptions {
	directory: string;
	debounceMs?: number;
	patterns?: string[];
}

/**
 * File-system watcher producer.
 *
 * Uses fs.watch with recursive=true and a configurable debounce window
 * (default 300 ms) to batch rapid change events into a single produce.
 */
export class FileWatchProducer extends BaseProducer {
	readonly trigger = "file_change";
	readonly label = "File Watch";
	private watcher: FSWatcher | null = null;
	private readonly directory: string;
	private readonly debounceMs: number;
	private readonly patterns: string[];
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly pendingPaths = new Set<string>();
	private started = false;

	constructor(options: FileWatchOptions, enabled = true) {
		super(enabled);
		this.directory = options.directory;
		this.debounceMs = options.debounceMs ?? 300;
		this.patterns = options.patterns ?? [];
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		this.watcher = watch(this.directory, { recursive: true }, (eventType, filename) => {
			if (!filename) return;
			const raw = filename.toString();
			const filePath = isAbsolute(raw) ? relative(this.directory, raw) : raw;
			if (this.patterns.length > 0 && !this.patterns.some((p) => {
				const regex = new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$");
				return regex.test(filePath);
			})) {
				return;
			}
			this.pendingPaths.add(filePath);
			this.scheduleFlush();
		});
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.pendingPaths.clear();
	}

	private scheduleFlush(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
	}

	private flush(): void {
		this.debounceTimer = null;
		if (this.pendingPaths.size === 0) return;
		const paths = [...this.pendingPaths].sort();
		this.pendingPaths.clear();
		this.emitEvent(
			{ directory: this.directory, changed: paths },
			`file_change-${paths.join(",")}`,
		);
	}
}
