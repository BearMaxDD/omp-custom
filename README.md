# omp-custom

Custom Oh My Pi extensions monorepo.

## Packages

| Package | Description |
|---------|-------------|
| `@bearmaxdd/omp-compliance` | Advisor Compliance Extension — provides compliance checking, task completion tracking, and repository standard enforcement for OMP v16.4.x projects |

## Quick Start

```bash
bun install
bun --cwd=packages/omp-compliance run build
bun --cwd=packages/omp-compliance test
```

## Extension Loading

The `@bearmaxdd/omp-compliance` extension is discoverable by OMP through the `omp.extensions` field in its `package.json`:

```json
{
  "name": "@bearmaxdd/omp-compliance",
  "omp": {
    "extensions": ["./dist/extension.js"]
  }
}
```

The extension is NOT auto-loading on import — it exports an `activate(api: ExtensionAPI)` function that must be explicitly called to register commands and tools. This ensures importing the module alone has no side effects.

## Installation Options

See [docs/install-local.md](docs/install-local.md) for three installation methods:

1. **Local development** — symlink or copy into `.omp/extensions`
2. **bun pack** — distribute as a tarball
3. **OMP Settings** — add the built extension path directly

## Documentation

| Document | Description |
|----------|-------------|
| [docs/install-local.md](docs/install-local.md) | Local installation instructions |
| [docs/advisor-compliance-workflow.md](docs/advisor-compliance-workflow.md) | Daily usage guide with command reference |
| [docs/evidence-schema.md](docs/evidence-schema.md) | Evidence JSONL schema and redaction strategy |
| [docs/upstream-upgrade-runbook.md](docs/upstream-upgrade-runbook.md) | Procedure for upgrading to new upstream releases |

## Quality Gates

```bash
# Run all tests
bun --cwd=packages/omp-compliance test

# Run code quality checks (biome)
bun --cwd=packages/omp-compliance run check

# Build the extension
bun --cwd=packages/omp-compliance run build
```

## Project Structure

```
omp-custom/
  packages/
    omp-compliance/
      src/       — extension source code
      test/      — test suite (behavior, signals, evidence, runtime, etc.)
      dist/      — compiled output
  docs/          — project documentation
```
