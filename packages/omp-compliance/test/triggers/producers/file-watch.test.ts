import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatchProducer } from "../../../src/triggers/producers/file-watch";
import type { TriggerEvent } from "../../../src/triggers/types";

describe("FileWatchProducer", () => {
	it("debounces 3 rapid changes into 1 produce event", async () => {
		const dir = join(tmpdir(), `fwd-${Date.now()}`);

		// Pre-create directory so watcher doesn't see dir-rename events
		mkdirSync(dir, { recursive: true });

		const received: string[][] = [];
		const producer = new FileWatchProducer({ directory: dir, debounceMs: 300 });

		producer.on("produce", (event: unknown) => {
			const e = event as TriggerEvent;
			received.push((e.body.changed as string[]).sort());
		});

		await producer.start();

		// Let fsevents settle before writing
		await Bun.sleep(400);

		// Write files one at a time with small gaps
		// (Bun/macOS fsevents coalesces same-tick writes)
		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			writeFileSync(join(dir, name), name);
			await Bun.sleep(50);
		}

		// Wait for debounce window (300ms from last write + margin)
		await Bun.sleep(500);

		await producer.stop();

		expect(received.length).toBe(1);
		expect(received[0]).toEqual(["a.ts", "b.ts", "c.ts"]);

		rmSync(dir, { recursive: true, force: true });
	});
});
