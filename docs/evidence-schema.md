# Evidence Schema — JSONL Format Reference

Compliance task activity is persisted as append-only JSONL (JSON Lines)
records. Each line is a single JSON object representing one event in the
task lifecycle.

---

## File Location

Records are stored in `.omp/evidence/<taskId>.jsonl` under the repository
root. Each task gets its own file, named by its UUID.

---

## Schema Version 1

### Record Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `number` | yes | Schema version (`1`) |
| `timestamp` | `string` (ISO 8601) | yes | When the event occurred |
| `taskId` | `string` (UUID) | yes | Active task ID |
| `contractPath` | `string` | yes | Path to the TDD contract file |
| `contractHash` | `string` (SHA-256 hex) | yes | Hash of the loaded contract |
| `attempt` | `number` | yes | Current attempt number (1-based, increments on remediation resumption) |
| `event` | `string` | yes | Event type (see below) |
| `signalDigest` | `string` (SHA-256 hex) | yes | Digest of signal data for this event (`sha256:` prefix followed by hex digest) |
| `verdictSummary` | `string` | no | Summary text from advisor verdict |
| `worktreeFingerprint` | `string` | no | Fingerprint of worktree state at event time |
| `outputTruncated` | `string` | no | Boolean indicator: `"true"` when tool output was truncated due to length limits, absent otherwise |
| `commandTruncated` | `string` | no | Boolean indicator: `"true"` when command text was truncated due to length limits, absent otherwise |

### Event Types

| Event | Description |
|-------|-------------|
| `active` | Task started |
| `completion_requested` | Agent called `compliance_complete` |
| `remediation_required` | Advisor issued a remediate verdict |
| `completed` | Task passed and is terminal |
| `stopped` | Task stopped by user |
| `resumed` | Task resumed from stalled |
| `protocol_error` | Invalid verdict or protocol violation |

### Example Record

```json
{
  "schemaVersion": 1,
  "timestamp": "2025-06-15T10:30:00.000Z",
  "taskId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "contractPath": "/repo/contracts/my-feature.md",
  "contractHash": "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  "attempt": 2,
  "event": "remediation_required",
|  "signalDigest": "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  "verdictSummary": "Production code was modified but no tests were added",
|  "worktreeFingerprint": "sha256:aabbccddee0011223344556677889900ffeeddccbbaa00998877665544332211"
}
```

---

## Redaction Strategy

Before evidence records are written to disk, sensitive information is
redacted. The redaction module (`redaction.ts`) applies a set of regex
rules that replace matched values with `[REDACTED]` while preserving the
structural context (parameter names, header names, key names).

### What Is Redacted

| Pattern | Example |
|---------|---------|
| Private keys | `-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----` |
| Authorization headers | `Authorization: Bearer sk-...` |
| Bearer tokens | `Bearer eyJ...` |
| API key prefixes | `sk-abc123…`, `pk-abc123…`, `rk-abc123…` |
| `api_key` / `apikey` values | `api_key=my-secret-key` |
| `token` / `access_token` values | `token=eyJhbGci...` |
| Session cookies | `connect.sid=s%3A...` |
| JWT tokens | `eyJ...base64...signature` |
| Passwords / secrets | `password=hunter2`, `secret=my-secret` |

### Truncation

Tool call parameters and results are truncated to prevent unbounded
evidence files. Truncation is field-level:

- **Command text:** Long `bash` commands are truncated to a configurable
  maximum length. The field `commandTruncated` is set when truncation
  occurs.
- **Tool output:** Large output bodies are truncated. The field
  `outputTruncated` is set when truncation occurs.

Truncation preserves the start of the value so the general shape of the
command or output remains visible.

---

## Default: No Run-Directory Submission

By default, evidence files are stored **only on disk** in the repository's
`.omp/evidence/` directory. They are NOT submitted, uploaded, or sent to
any external service.

The evidence store uses a pending buffer for graceful failure handling:
if a disk write fails, records are held in memory and retried later via
`flushPending()`. This ensures no data loss without requiring external
connectivity.

### Crash Recovery

- Writes go to a `.tmp` file first, then atomic `rename` to the final path.
- A crash during write orphans the `.tmp` and leaves the final file intact.
- `readAll()` tolerates a truncated (incomplete JSON) last line so that
  a crash mid-write never loses preceding records.

---

## User-Selectable Submission Strategy

If external delivery is desired, consumers implement **one** of these
patterns:

### Submit on Completion

After a task reaches `completed`, a post-processing script reads the
`.omp/evidence/<taskId>.jsonl` file and sends it to an external audit
store. Example:

```bash
# Opt-in: only runs when the user or CI explicitly invokes it
bun run scripts/submit-evidence.ts <taskId>
```

### Periodic Sync

A cron-like job syncs evidence files to a configured endpoint. Users
opt in by setting environment variables or a config file key.

### Manual Export

The extension may provide a `/compliance export <taskId>` command in a
future version to produce a transport-ready bundle.

**The key invariant:** no evidence leaves the working directory without
explicit configuration or user action. The default policy is local-only.
