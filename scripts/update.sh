#!/usr/bin/env bash
#
# Launchpad — updater.
#
# Pulls the latest source for the current install and re-runs the installer,
# which handles deps, migrations, build, and a clean restart of the running
# service (systemd or nohup-tracked PID file).
#
# Run from inside your Launchpad install directory:
#   cd ~/launchpad && ./scripts/update.sh
#
# Environment overrides (rarely needed):
#   LAUNCHPAD_REPO_OWNER   GitHub org/user (default: jlab1201)
#   LAUNCHPAD_REPO_NAME    Repo name        (default: Launchpad)
#   LAUNCHPAD_REPO_REF     Branch/tag/SHA   (default: main)
#   LAUNCHPAD_NO_START=1   Skip auto-restart (just pull + build)
#
set -euo pipefail

echo "================================================"
echo " Launchpad — updater"
echo "================================================"
echo ""

# --- Sanity check: must be in a Launchpad checkout ---
if [ ! -f "./package.json" ] || ! grep -q '"name": "launchpad"' ./package.json 2>/dev/null; then
  echo "Error: not inside a Launchpad checkout (./package.json with name=launchpad missing)." >&2
  echo "       cd into your install directory and re-run this script." >&2
  exit 1
fi

if [ ! -x "./scripts/install.sh" ]; then
  echo "Error: ./scripts/install.sh missing or not executable. Was the install incomplete?" >&2
  exit 1
fi

# --- Pull latest source ---
REPO_OWNER="${LAUNCHPAD_REPO_OWNER:-jlab1201}"
REPO_NAME="${LAUNCHPAD_REPO_NAME:-Launchpad}"
REPO_REF="${LAUNCHPAD_REPO_REF:-main}"

if [ -d .git ]; then
  echo "Pulling latest changes via git (origin/$REPO_REF) ..."
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: .git directory present but git is not installed." >&2
    exit 1
  fi
  # --ff-only refuses to merge — protects local edits from being silently
  # clobbered. The user will see a clear error if they have divergent commits.
  git pull --ff-only origin "$REPO_REF"
else
  # Anonymous tarball, same pattern as install.sh — bypasses git auth prompts.
  if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl not found." >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "Error: tar not found." >&2
    exit 1
  fi
  TARBALL_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${REPO_REF}"
  echo "Downloading latest tarball ($REPO_OWNER/$REPO_NAME @ $REPO_REF) ..."
  # --strip-components=1 flattens the GitHub-generated <repo>-<ref>/ prefix.
  # Files in data/, .env*, launchpad.log are not in the tarball, so they're preserved.
  curl -fsSL "$TARBALL_URL" | tar -xz --strip-components=1
fi

# --- Re-run installer to refresh deps, rebuild, and restart the service ---
echo ""
echo "Re-running installer to apply updates ..."
echo ""
exec ./scripts/install.sh
