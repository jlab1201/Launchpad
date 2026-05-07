#!/usr/bin/env bash
set -euo pipefail

command -v pnpm >/dev/null || { echo "pnpm missing — install from https://pnpm.io/installation"; exit 1; }
command -v node >/dev/null || { echo "node missing — install Node.js 20 LTS from https://nodejs.org"; exit 1; }

pnpm install --frozen-lockfile
pnpm playwright install chromium --with-deps || true
pnpm db:migrate
pnpm lint
pnpm test
pnpm build

echo "Install verified."
