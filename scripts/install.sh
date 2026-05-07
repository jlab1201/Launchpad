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

# --- Locate or clone the Dashboard project ---
REPO_URL="${DASHBOARD_REPO_URL:-https://github.com/jlab1201/dashboard.git}"
TARGET_DIR="${DASHBOARD_DIR:-dashboard}"

if [ -f "./package.json" ] && grep -q '"name": "dashboard"' ./package.json 2>/dev/null; then
  : # already inside a Dashboard checkout — nothing to do
elif [ -d "$TARGET_DIR/.git" ] && [ -f "$TARGET_DIR/package.json" ] && grep -q '"name": "dashboard"' "$TARGET_DIR/package.json" 2>/dev/null; then
  echo "Reusing existing checkout at ./$TARGET_DIR"
  cd "$TARGET_DIR"
else
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: git not found. Install git first, or clone the repo manually and re-run." >&2
    exit 1
  fi
  if [ -e "$TARGET_DIR" ]; then
    echo "Error: ./$TARGET_DIR exists but isn't a Dashboard checkout. Move/remove it, or set DASHBOARD_DIR=somewhere-else, then re-run." >&2
    exit 1
  fi
  echo "Cloning $REPO_URL into ./$TARGET_DIR ..."
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
fi

# --- Bootstrap .env.local if no env file exists ---
if [ ! -f ".env.local" ] && [ ! -f ".env" ]; then
  cp .env.example .env.local
  echo "created .env.local from .env.example"
fi

# --- Install Node dependencies (frozen lockfile, but allow native builds) ---
# pnpm.onlyBuiltDependencies in package.json whitelists better-sqlite3, esbuild, sharp
# so their native bindings actually compile.
echo ""
echo "Installing dependencies ..."
pnpm install --frozen-lockfile

# --- Install Playwright Chromium (browser binary only, no sudo / no OS deps) ---
# `--with-deps` would try to apt-install system libraries via sudo, which can't
# prompt for a password under `curl | bash`. End users running locally on a dev
# box already have the libs; CI installs them out-of-band.
echo ""
echo "Installing Playwright Chromium ..."
pnpm exec playwright install chromium

# --- Apply database migrations (creates data/db.sqlite) ---
echo ""
echo "Applying database migrations ..."
pnpm db:migrate

# --- Done ---
echo ""
echo "================================================"
echo "✓ Install complete."
echo ""
echo "  Start dev:   pnpm dev"
echo "  Start prod:  pnpm build && pnpm start"
echo ""
echo "  Then open http://localhost:15123 — your first visit"
echo "  will prompt you to set the master vault passphrase."
echo "================================================"
