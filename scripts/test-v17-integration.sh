#!/usr/bin/env bash
set -euo pipefail

: "${OMP_V17_HOST:?set OMP_V17_HOST to the v17 host worktree}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bun test --preload ./packages/omp-compliance/test/setup.ts packages/omp-compliance/test/contract/real-v17-host.test.ts
bun test --preload ./packages/omp-compliance/test/setup.ts packages/omp-compliance/test/e2e/advisor-compliance-flow.test.ts
bun --cwd=packages/omp-compliance run build
