#!/usr/bin/env bash
set -euo pipefail

echo "================================================"
echo " Dashboard — installer"
echo "================================================"
echo ""

# --- Pre-flight: Node.js >= 20 ---
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found. Install Node.js 20 LTS from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20 or higher is required. Found: $(node --version)" >&2
  echo "Install Node.js 20 LTS from https://nodejs.org" >&2
  exit 1
fi

# --- Pre-flight: pnpm ---
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm not found. Run \`corepack enable\` then re-run this installer." >&2
  exit 1
fi

# --- Confirm we are inside a cloned Dashboard project ---
if [ ! -f "./package.json" ] || ! grep -q '"name": "dashboard"' ./package.json 2>/dev/null; then
  echo "Error: This directory does not appear to be the Dashboard project." >&2
  echo "Please clone the repository first and cd into it, then run this script again." >&2
  exit 1
fi

# --- Bootstrap .env.local if no env file exists ---
if [ ! -f ".env.local" ] && [ ! -f ".env" ]; then
  cp .env.example .env.local
  echo "created .env.local from .env.example"
fi

# --- Delegate all heavy lifting to verify-install.sh ---
echo ""
echo "Running verify-install.sh ..."
echo ""
bash scripts/verify-install.sh

# --- Done ---
echo ""
echo "✓ Install complete. Run \`pnpm dev\` (development) or \`pnpm start\` (production)."
echo "  Open http://localhost:3000 — your first visit will prompt you to set the master vault passphrase."
