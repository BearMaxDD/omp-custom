# Local Installation

## Prerequisites

- Oh My Pi v16.4.x
- Bun runtime
- This repository cloned

## Option 1: As a local package in `.omp/extensions`

```bash
# From the omp-custom repository root
bun install
bun --cwd=packages/omp-compliance run build

# Symlink or copy into the OMP extensions directory
ln -s $(pwd)/packages/omp-compliance ~/.oh-my-pi/extensions/omp-compliance
```

## Option 2: Via OMP Settings

1. Build the package: `bun --cwd=packages/omp-compliance run build`
2. In OMP settings, add the extension path:
   - Path: `/path/to/omp-custom/packages/omp-compliance/dist/extension.js`

## Verification

```bash
bun --cwd=packages/omp-compliance test
```

All tests should pass.
