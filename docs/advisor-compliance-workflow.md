# Advisor Compliance Extension — Workflow Guide

This document describes how to install, activate, and use the `@bearmaxdd/omp-compliance`
extension in your Oh My Pi (OMP) v16.4.x environment.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Daily Workflow](#daily-workflow)
- [Semantics: Pass, Remediate, Stalled](#semantics-pass-remediate-stalled)
- [Extension Disabled Behavior](#extension-disabled-behavior)
- [Architecture Notes](#architecture-notes)
- [Reference](#reference)

---

## Installation

### Option 1: Local Development (monorepo checkout)

```bash
git clone <your-omp-custom-repo>
cd omp-custom
bun install
bun --cwd=packages/omp-compliance run build
```

The extension registers itself via the `omp.extensions` field in
`packages/omp-compliance/package.json`.

### Option 2: bun pack (distributable tarball)

```bash
cd omp-custom
bun --cwd=packages/omp-compliance run build
bun pack --cwd=packages/omp-compliance
# Produces bearmaxdd-omp-compliance-0.1.0.tgz
```

Install in your target OMP workspace:

```bash
bun install /path/to/bearmaxdd-omp-compliance-0.1.0.tgz
```

### Option 3: Project-level `.omp/extensions`

Symlink or copy the built extension into your OMP extensions directory:

```bash
ln -s $(pwd)/packages/omp-compliance ~/.oh-my-pi/extensions/omp-compliance
```

Or add the path in OMP settings: `path/to/omp-compliance/dist/extension.js`.

---

## Quick Start

1. Install the extension (see above).
2. Create a TDD markdown file (see [Contract Format](#reference)).
3. In an OMP session, run:

```
/compliance start path/to/tdd.md
```

The extension loads the contract and begins tracking the task.

---

## Daily Workflow

### 1. Bind a TDD Contract

Start a compliance task:

```
/compliance start contracts/my-feature.md
```

This:
- Reads the TDD contract (goal, scope, files, tests, verification steps)
- Generates a unique `taskId`
- Records an `active` evidence event
- Sends a managed prompt to the main agent

**Non-managed sessions:** In a plain (unmanaged) OMP session the extension
does nothing — commands are ignored and the `compliance_complete` tool is
unavailable. The completion gate only activates inside a managed session
started by `/compliance start`.

### 2. Work on the Task

The agent works normally. The extension passively collects evidence:
- Codebase-memory tool calls (via `codebase-memory` module)
- Task sub-agent delegations (via `task-delegation` module)
- Verification command results (exit codes from `bash` calls)
- Tool call/result events

### 3. Request Completion

When the agent believes the task is done:

```
compliance_complete(summary: "...", claimed_verification: ["bun test", ...])
```

This builds a completion snapshot and transitions the task state to
`advisor_reviewing`. Verification commands are validated by the
completion gate.

### 4. Receive Verdict

The Advisor reviews the snapshot and issues a verdict —
see [Pass / Remediate / Stalled](#semantics-pass-remediate-stalled).

### 5. Remediation Loop

If the verdict is `remediate`:

- The runtime transitions to `remediation_required`.
- A structured `compliance_remediation` message is injected with
  specific `requiredFix` items.
- Apply the fixes, then call `compliance_complete` again to re-request
  review.

To resume after applying fixes (if the tool did not auto-resume):

```
/compliance resume <task_id>
```

### 6. Pass

When all evidence is present and the Advisor issues `pass`:

- Task transitions to `completed` (terminal).
- No remediation message is injected.
- Evidence records are finalized.
- The session continues — `/compliance start` with a new TDD begins
  a new task.

### 7. Check Status and History

Read-only commands — no side effects:

```
/compliance status
```

Shows: task ID, current status, attempt count, contract info, and
whether the task has stalled.

```
/compliance history
```

Shows a chronological list of all events (start, completion requests,
verdicts, remediations) for the current task.

### 8. Stop a Task

```
/compliance stop
```

Clears the active task without completing it. Records a `stopped`
evidence event.

---

## Semantics: Pass, Remediate, Stalled

### Pass

The Advisor found no issues. All evidence requirements are satisfied:
- Codebase-memory tools were used to understand the code.
- Task delegation (subagents) were used where appropriate.
- Verification commands passed (exit code 0).
- Changes are within the TDD scope.

Outcome: task status → `completed` (terminal).

### Remediate

The Advisor found issues that must be fixed before completion.
Each finding includes a `requiredFix` string. Common categories:
- Production code was modified but tests were not added or updated.
- Tests failed during completion verification.
- Changes fell outside the TDD contract scope.
- Codebase-memory tools were not used to verify context.
- Task subagents were not delegated when appropriate.
- Subagents produced code without codebase references.

Outcome: task status → `remediation_required`. A remediation message
is injected. The agent SHOULD apply the fixes and re-request completion.

### Stalled

Three consecutive identical remediation fingerprints with **no progress
between them** trigger the stalled state. The fingerprint is computed from:

```
sha256(worktree_diff + normalized_findings + verification_results + contract_hash)
```

Same inputs → same fingerprint. Different worktree state → different
fingerprint. The runtime tracks `consecutiveStalledFingerprints` and
transitions to `stalled` at threshold 3.

**Stalled is NOT a quality verdict.** It protects against infinite loops
where the agent makes no effective change.

When stalled:
- No new remediation message is injected (the prior message suffices).
- `/compliance resume <task_id>` transitions back to `active`, assigning
  a fresh fingerprint.
- Real progress (fingerprint change) prevents stall even on the third
  remediation.

---

## Extension Disabled Behavior

When the extension is not activated:

- The `compliance_complete` tool is NOT registered in the OMP tool list.
- The `/compliance` command is NOT registered.
- No tool event handlers fire.
- No evidence is collected.
- No completion gate side effects exist.
- The harness OMP behavior is unchanged.

The extension exports an `activate(api)` function that must be explicitly
called with an `ExtensionAPI` instance. Importing the module alone does
nothing — tests verify this contract.

---

## Architecture Notes

### Strict Routing

The compliance extension uses OMP's routing system to direct
compliance-related signals to the correct subsystems. Managed
prompts and remediation messages use the `compliance_managed` and
`compliance_remediation` message types, routed through the extension
API's `sendMessage` method. These types are not processed by the
general-purpose agent — they go through the compliance runtime.

### PlanRun Compatibility

The extension works alongside OMP's `/plan` system (PlanRun). When a
plan is active, compliance tracking continues independently. The
extension does not intercept or modify plan execution — it monitors
the tool stream and state machine separately.

### Batch Role Assignment

Batch role assignments (e.g., multi-agent configurations where roles
are assigned in bulk) do not migrate to the compliance extension's
managed task model. Each compliance task is a single sequential flow
with one active task at a time. Future versions may support parallel
batch evaluation, but the current v1 model does not migrate batch
role assignments.

### Runtime Architecture

```
┌─────────────────────────────────────────────────────┐
│  ComplianceRuntime                                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │  Command  │  │   Tool       │  │   Verdict     │ │
│  │  Handler  │──│   Registry   │──│   Sink        │ │
│  └────┬─────┘  └──────┬───────┘  └──────┬────────┘ │
│       │               │                 │           │
│  ┌────▼───────────────▼─────────────────▼────────┐  │
│  │  State Machine (task-state-machine.ts)        │  │
│  │  inactive → active → ... → completed|stalled  │  │
│  └───────────────────────────────────────────────┘  │
│       │                                             │
│  ┌────▼────────────────────────────────────────┐    │
│  │  EvidenceStore + CollectorRuntime           │    │
│  │  (JSONL append-only, passive events)        │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Evidence Collection Flow

```
OMP Tool Stream
     │
     ▼
CollectorRuntime (passive listeners)
     │
     ├── tool_call   → ToolEventCollector.recordCall()
     ├── tool_result → ToolEventCollector.recordResult()
     ├── turn_end    → (no-op placeholder)
     └── agent_end   → refreshPresentation()
           │
           ▼
     EvidenceSnapshot (on demand via snapshot())
           │
           ▼
     buildCompletionSnapshot() → CompletionSnapshot
           │
           ▼
     compliance_complete → ComplianceRuntime.requestCompletion()
```

---

## Reference

### Command Reference

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/compliance start <tdd.md>` | TDD file path | Start a new compliance task |
| `/compliance stop` | — | Stop the current task |
| `/compliance resume <task_id>` | Task UUID | Resume a stalled task |
| `/compliance status` | — | Show current task state (read-only) |
| `/compliance history` | — | Show event history (read-only) |

### Tool Reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `compliance_complete` | `summary: string`, `claimed_verification?: string[]` | Signal task completion |

### Evidence Files

Evidence is stored as append-only JSONL files in `.omp/evidence/` under
the repo root. See [`evidence-schema.md`](./evidence-schema.md) for the
full schema reference.
