import type { ContextInjector } from "./types";
export function createContextInjector(): ContextInjector {
  return {
    inject(trigger: string): string[] {
      switch (trigger) {
        case "git_pre_push": return ["Focus on changed files only. Pre-push check."];
        case "scheduled": return ["Scheduled routine review. Priority: low."];
        case "file_change": return ["Triggered by file changes. Review affected module."];
        default: return [];
      }
    },
  };
}
