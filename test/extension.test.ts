import { expect, test } from "bun:test";
import { getExtensionContributions } from "../src/index.ts";

test("exposes the declarative slash commands in public order", () => {
	const contributions = getExtensionContributions();

	expect(contributions.commands.map(({ name }) => name)).toEqual([
		"plan-run",
		"superpowers",
	]);
	expect(contributions.commands.map(({ kind }) => kind)).toEqual([
		"slash-command",
		"slash-command",
	]);
});

test("gives every public command a human-readable description", () => {
	const contributions = getExtensionContributions();

	for (const command of contributions.commands) {
		expect(typeof command.description).toBe("string");
		expect(command.description.trim().length).toBeGreaterThan(0);
	}
});

test("returns immutable contributions without a host registration step", () => {
	const contributions = getExtensionContributions();

	expect(Object.isFrozen(contributions)).toBe(true);
	expect(Object.isFrozen(contributions.commands)).toBe(true);
});
