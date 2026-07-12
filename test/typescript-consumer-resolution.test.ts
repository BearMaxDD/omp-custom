import { expect, test } from "bun:test";

const packageRoot = `${import.meta.dir}/..`;
const fixtureConfig = `${import.meta.dir}/fixtures/typescript-consumer/tsconfig.json`;
const tsgo = `${packageRoot}/node_modules/.bin/tsgo`;

test("the package type-checks for a strict Bundler consumer without TypeScript-extension opt-in", () => {
	const result = Bun.spawnSync({
		cmd: [tsgo, "-p", fixtureConfig],
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const diagnostics = `${result.stdout.toString()}${result.stderr.toString()}`;

	if (result.exitCode !== 0) {
		console.error(diagnostics);
	}
	expect(result.exitCode).toBe(0);
});
