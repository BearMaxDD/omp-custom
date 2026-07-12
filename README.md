# omp-custom

Custom Oh My Pi extensions monorepo.

## Packages

| Package | Description |
|---------|-------------|
| `@bearmaxdd/omp-compliance` | Compliance checking and task completion tracking |

## Getting Started

```bash
bun install
bun --cwd=packages/omp-compliance test
bun --cwd=packages/omp-compliance run build
```

## Extension Loading

The `@bearmaxdd/omp-compliance` extension is discoverable by OMP through the `omp.extensions` field in its `package.json`.
