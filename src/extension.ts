export interface ExtensionCommandContribution {
	readonly kind: "slash-command";
	readonly name: "plan-run" | "superpowers";
	readonly description: string;
}

export interface ExtensionContribution {
	readonly commands: readonly ExtensionCommandContribution[];
}

const CONTRIBUTIONS: ExtensionContribution = Object.freeze({
	commands: Object.freeze([
		Object.freeze({
			kind: "slash-command" as const,
			name: "plan-run" as const,
			description: "Run a verified execution book",
		}),
		Object.freeze({
			kind: "slash-command" as const,
			name: "superpowers" as const,
			description: "Inspect Superpowers capabilities",
		}),
	]),
});

export function getExtensionContributions(): ExtensionContribution {
	return CONTRIBUTIONS;
}
