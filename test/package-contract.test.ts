import { expect, test } from "bun:test";
import { CONTRACT_VERSION, packageName } from "../src/index.ts";

test("exports the public package identity contract", () => {
	expect(packageName).toBe("@bearmaxdd/omp-custom");
	expect(CONTRACT_VERSION).toBe(1);
});
