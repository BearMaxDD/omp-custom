# Upstream Upgrade Runbook

This document defines the procedure for upgrading the
`@bearmaxdd/omp-compliance` extension to a new upstream
OMP v16.4.x release.

---

## Scope

Every upstream OMP release can change the harness API, tool dispatch
semantics, or the extension loading mechanism. This runbook ensures
the compliance extension remains correct across releases.

---

## Prerequisites

- Two working copies:
  - `omp-custom` — your extension monorepo
  - `oh-my-pi-v16.4.6-compliance` — a clean fork of the target upstream tag
- Bun runtime
- Git

---

## Step-by-Step Procedure

### Step 0: Set Up Upstream Remote

If the `upstream` remote is not yet configured for the upstream fork:

```bash
cd /path/to/oh-my-pi-v16.4.6-compliance

# Add the upstream remote pointing to the official OMP repository
git remote add upstream https://github.com/bearmaxdd/oh-my-pi.git

# Verify the remote
git remote -v
```

The `upstream` remote is used in subsequent steps to fetch release tags.
Set it once per clone; subsequent upgrades only need `git fetch --tags upstream`.

---

### Step 1: Create a Fresh Worktree

From the upstream fork:

```bash
cd /path/to/oh-my-pi-v16.4.6-compliance

# Fetch the new version tag (e.g., v16.4.7)
git fetch --tags upstream v16.4.7

# Create an isolated worktree
git worktree add ../omp-upgrade-checkout v16.4.7
```

This ensures the upgrade check starts from a pristine upstream state
with no local modifications.

### Step 2: Install and Build

```bash
cd ../omp-upgrade-checkout

# Install upstream dependencies
bun install

# Build upstream (verify no build regressions)
bun run build
```

### Step 3: Run Baseline Tests

Run the upstream test suites that cover affected subsystems:

```bash
# Advisor/system-prompt rendering tests
bun test packages/coding-agent/test/advisor/

# Extension loading tests
bun test packages/coding-agent/test/extension-loading/

# Task-tool / subagent tests
bun test packages/coding-agent/test/task/
```

All baseline tests MUST pass. Record any failures — they indicate
upstream regressions that must be resolved before the extension can
be validated.

### Step 4: Run the Compliance Extension Tests

```bash
cd /path/to/omp-custom
bun --cwd=packages/omp-compliance test
bun --cwd=packages/omp-compliance run check
bun --cwd=packages/omp-compliance run build
```

### Step 5: Run Independent Extension Unit Tests

Verify the extension's standalone test suites:

| Test area | Pattern | What it verifies |
|-----------|---------|------------------|
| Behavior fixtures | `test/behavior/*.test.ts` | End-to-end flow scenarios (pass, remediate, stalled) |
| Extension disabled | `test/behavior/extension-disabled.test.ts` | No side effects without activation |
| Advisor protocol | `test/behavior/advisor-protocol.test.ts` | Verdict schema, sink, completion context |
| Signals | `test/signals/*.test.ts` | Codebase-memory, task-delegation, verification, collector |
| Evidence | `test/evidence/*.test.ts` | Store, redaction, fingerprint |
| State machine | `test/state/*.test.ts` | Transitions, stalled detection |
| Contract | `test/contract/*.test.ts` | Load, execution policy, markdown summary |
| Commands | `test/commands/*.test.ts` | Command handler, defaults |
| Runtime | `test/runtime/*.test.ts` | Runtime orchestration, completion gate |
| Tools | `test/tools/*.test.ts` | Compliance complete tool |
| Status | `test/status/*.test.ts` | Status view model, history reader |
| Installation smoke | `test/installation-smoke.test.ts` | Module import and activation |
| Extension loading | `test/extension-loading.test.ts` | Extension export contract |
| Brainstorm | `test/brainstorm/*.test.ts` | Topic lifecycle, advisor hook, fingerprint, decision card |

### Step 6: Verify Extension Disabled Behavior

Confirm that importing the extension module without activating it
produces no side effects:

```bash
# Tests specifically for this contract
bun --cwd=packages/omp-compliance test test/behavior/extension-disabled.test.ts
```

Checklist:
- [ ] `activate()` export is a function, not an auto-executing side-effect
- [ ] No `compliance_complete` tool registers without `activate()`
- [ ] No `/compliance` command registers without `activate()`
- [ ] No tool event handlers fire without `activate()`
- [ ] OMP harness tool list is unchanged without activation

### Step 7: Verify Pass, Remediate, Stalled Semantics

Run the end-to-end flow tests:

```bash
bun --cwd=packages/omp-compliance test test/behavior/compliance-flow.test.ts
```

Verify:
- [ ] Scenario 1: only prod code changed, no tests → remediate + fix
- [ ] Scenario 2: tests fail during completion → remediate + evidence
- [ ] Scenario 3: changes outside TDD scope → remediate + contract refs
- [ ] Scenario 4: no codebase-memory calls → remediate + evidence
- [ ] Scenario 5: no task delegation → remediate + delegation
- [ ] Scenario 6: subagent without codebase refs → remediate + traceability
- [ ] Scenario 7: full evidence + passing verification → pass only
- [ ] Scenario 8: consecutive remediation then pass → attempts, history
- [ ] Scenario 9: repeated identical remediation → stalled, no injection

### Step 8: Bridge Patch Audit

If the extension repo carries **bridge patches** (copies of upstream
code that bridge a missing API), do the following:

1. **List all bridge patches:**

```bash
grep -rn "TODO.*bridge\|FIXME.*bridge\|upstream.*copy\|paste.*from.*upstream" packages/omp-compliance/src/
```

2. **For each patch, diff against upstream:**

```bash
# Compare ComplianceVerdictTool with upstream's version (if any)
git diff v16.4.6..v16.4.7 -- packages/coding-agent/src/tools/compliance-verdict*

# Compare buildAdvisorRuntime with the upstream version
git diff v16.4.6..v16.4.7 -- packages/coding-agent/src/advisor/buildAdvisorRuntime*
```

3. **Minimum diff rule:** Only accept patches whose diff is strictly
   limited to `ComplianceVerdictTool` and `buildAdvisorRuntime`. Any
   patch touching other subsystems requires re-review.

4. **If upstream now natively provides the API** that the bridge was
   filling:

   a. Write a regression test that exercises the new API.
   b. Verify the regression test passes against the new upstream.
   c. Delete the bridge patch.
   d. Re-point the extension to the upstream API.

### Step 9: Clean Up

```bash
cd /path/to/oh-my-pi-v16.4.6-compliance
git worktree remove ../omp-upgrade-checkout
```

---

## Verification Checklist (Full)

- [ ] Fresh worktree from upstream tag
- [ ] Baseline upstream tests pass (Advisor, Extension, TaskTool)
- [ ] Extension unit tests pass (behavior fixtures)
- [ ] Extension disabled behavior verified
- [ ] Pass, remediate, stalled semantics verified
- [ ] Brainstorm tests pass (topic lifecycle, advisor hook, fingerprint, decision card)
- [ ] Bridge patches audited (ComplianceVerdictTool, buildAdvisorRuntime only)
- [ ] Superseded bridge patches deleted with regression tests
- [ ] Branch rebased or merged
- [ ] Full CI run on the upgrade branch


---

## Rollback

If the upgrade introduces regressions, revert to the previous known-good
state:

1. **Remove the upgrade worktree:**

```bash
cd /path/to/oh-my-pi-v16.4.6-compliance
git worktree remove ../omp-upgrade-checkout 2>/dev/null || true
```

2. **Reset the extension branch:**

```bash
cd /path/to/omp-custom
git checkout main
git reset --hard origin/main
```

3. **Restore upstream fork to previous tag:**

```bash
cd /path/to/oh-my-pi-v16.4.6-compliance
git checkout v16.4.6
```

4. **Reinstall dependencies for the previous version:**

```bash
bun install
bun run build
```

5. **Re-run the compliance extension tests to confirm stability:**

```bash
cd /path/to/omp-custom
bun --cwd=packages/omp-compliance test
```

---

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| `fatal: 'upstream' does not appear to be a git repository` | Upstream remote not configured | Run `git remote add upstream <repo-url>` (see Step 0) |
| `fatal: tag 'v16.4.7' not found` | Tag not fetched yet | Run `git fetch --tags upstream` |
| `A git directory for '..' is found` | Stale worktree from a previous attempt | Run `git worktree prune` or manually remove the directory |
| Baseline tests fail on the upstream fork | Upstream regression | Investigate the failing test; file an issue with the OMP team before proceeding |
| Extension tests fail after upgrade | API incompatibility in a bridge patch | Review bridge patches (Step 8); update the extension code to match the new upstream API |
| `bun install` fails with version mismatch | Bun version incompatible with upstream | Check `package.json` engines; install the required Bun version via `bun upgrade` or `bun install` |
| `worktreeFingerprint` mismatch in evidence records | Worktree state changed between events | Ensure the compliance task runs in a stable worktree; re-run the task from a clean state |