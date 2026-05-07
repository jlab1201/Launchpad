#!/usr/bin/env bash
set -euo pipefail

echo "================================================"
echo " Launchpad — installer"
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

# --- Locate or download the Launchpad project ---
# Defaults aim at the public GitHub release. Tarball download is anonymous
# and bypasses git credential helpers (which can prompt for a password
# even on public repos if the user has one configured for github.com).
REPO_OWNER="${LAUNCHPAD_REPO_OWNER:-jlab1201}"
REPO_NAME="${LAUNCHPAD_REPO_NAME:-Launchpad}"
REPO_REF="${LAUNCHPAD_REPO_REF:-main}"
TARGET_DIR="${LAUNCHPAD_DIR:-launchpad}"
TARBALL_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${REPO_REF}"

if [ -f "./package.json" ] && grep -q '"name": "launchpad"' ./package.json 2>/dev/null; then
  : # already inside a Launchpad checkout — nothing to do
elif [ -f "$TARGET_DIR/package.json" ] && grep -q '"name": "launchpad"' "$TARGET_DIR/package.json" 2>/dev/null; then
  echo "Reusing existing checkout at ./$TARGET_DIR"
  cd "$TARGET_DIR"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl not found. Install curl, or download the repo manually and re-run this script from inside it." >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "Error: tar not found. Install tar, or download the repo manually and re-run this script from inside it." >&2
    exit 1
  fi
  if [ -e "$TARGET_DIR" ]; then
    echo "Error: ./$TARGET_DIR exists but isn't a Launchpad checkout. Move/remove it, or set LAUNCHPAD_DIR=somewhere-else, then re-run." >&2
    exit 1
  fi

  echo "Downloading Launchpad ($REPO_OWNER/$REPO_NAME @ $REPO_REF) ..."
  mkdir -p "$TARGET_DIR"
  # `--strip-components=1` flattens the GitHub-generated `<repo>-<ref>/` prefix.
  # Pipe straight from curl to tar — no temp file, no auth path.
  curl -fsSL "$TARBALL_URL" | tar -xz -C "$TARGET_DIR" --strip-components=1
  cd "$TARGET_DIR"
fi

# --- Bootstrap .env.local if no env file exists ---
if [ ! -f ".env.local" ] && [ ! -f ".env" ]; then
  cp .env.example .env.local
  echo "created .env.local from .env.example"
fi

# --- Install Node dependencies (frozen lockfile, allow whitelisted native builds) ---
echo ""
echo "Installing dependencies ..."
pnpm install --frozen-lockfile

# --- Install Playwright Chromium (browser binary only — no sudo / no OS deps) ---
echo ""
echo "Installing Playwright Chromium ..."
pnpm exec playwright install chromium

# --- Apply database migrations (creates data/db.sqlite) ---
echo ""
echo "Applying database migrations ..."
pnpm db:migrate

# --- Build the production bundle so we can autostart cleanly ---
echo ""
echo "Building production bundle ..."
pnpm build

# --- Autostart unless the caller opted out ---
PORT="${PORT:-15123}"
export PORT

if [ "${LAUNCHPAD_NO_START:-0}" = "1" ]; then
  echo ""
  echo "================================================"
  echo "✓ Install complete (autostart skipped)."
  echo ""
  echo "  Start when ready:  cd $(basename "$PWD") && pnpm start"
  echo "  URL:               http://localhost:${PORT}"
  echo "================================================"
  exit 0
fi

echo ""
echo "================================================"
echo "✓ Install complete. Starting Launchpad ..."
echo ""
echo "  URL:    http://localhost:${PORT}"
echo "  Stop:   Ctrl+C"
echo ""
echo "  Your first visit will prompt you to set the master vault passphrase."
echo "  To skip autostart on future installs, set LAUNCHPAD_NO_START=1."
echo "================================================"
echo ""

# `exec` so Ctrl+C goes straight to Next.js with no shell sitting in the middle.
exec pnpm start
