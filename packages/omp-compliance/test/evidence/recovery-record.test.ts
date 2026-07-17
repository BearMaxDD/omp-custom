import { describe, expect, it } from "bun:test";
import {
	createRecoveryTruncatedTailEvent,
	createRecoveryTruncatedTailEventFromDigest,
	createRecoveryTruncatedTailHasher,
	isRecoveryTruncatedTailForDigest,
} from "../../src/evidence/recovery-record";

describe("RecoveryTruncatedTailEvent", () => {
	it("预计算原始字节 digest 与小日志 Buffer API 生成完全相同的磁盘事件", () => {
		const content = Buffer.concat([
			Buffer.from('{"eventId":"550e8400-e29b-41d4-a716-446655440000","type":"valid"}\n'),
			Buffer.from([0xe2]),
		]);
		const tail = Buffer.from([0xe2]);
		const timestamp = "2026-07-18T00:00:00.000Z";
		const digest = createRecoveryTruncatedTailHasher().update(content).digest();
		const fromBuffer = createRecoveryTruncatedTailEvent(content, tail, timestamp);
		const fromDigest = createRecoveryTruncatedTailEventFromDigest(digest, tail.byteLength, timestamp);

		expect(fromDigest).toEqual(fromBuffer);
		expect(isRecoveryTruncatedTailForDigest(fromDigest, digest, tail.byteLength)).toBeTrue();
	});
});
