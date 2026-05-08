#!/usr/bin/env bash
#
# Launchpad — updater.
#
# Pulls the latest source for the current install and re-runs the installer,
# which handles deps, migrations, build, a clean restart of the running
# service (systemd or nohup-tracked PID file), AND refreshes the boot-time
# autostart hook (systemd user service + linger, or `cron @reboot` fallback).
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

# Resolve our own location and cd to the project root, so the script works
# whether you run it as `./scripts/update.sh` from the install dir or as
# `./update.sh` from inside the scripts/ directory itself.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

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
./scripts/install.sh

# --- Verify boot-time autostart is actually configured ---
# The installer prints its own banner, but on prod boxes the user often
# scripts `update.sh` non-interactively and only checks the exit code. A
# missing autostart hook would otherwise be invisible until the next reboot.
echo ""
echo "Verifying boot-time autostart ..."
AUTOSTART_OK=0
if command -v systemctl >/dev/null 2>&1 \
   && systemctl --user is-enabled launchpad.service >/dev/null 2>&1; then
  if command -v loginctl >/dev/null 2>&1 \
     && loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    echo "  ✓ systemd user service enabled + linger on — starts at boot."
    AUTOSTART_OK=1
  else
    echo "  ! systemd user service enabled, but linger is OFF."
    echo "    The app will only start when '$USER' logs in, NOT at boot."
    echo "    Fix: sudo loginctl enable-linger $USER"
  fi
elif command -v crontab >/dev/null 2>&1 \
     && crontab -l 2>/dev/null | grep -q '# launchpad-autostart'; then
  echo "  ✓ cron @reboot hook registered — starts at boot (no systemd)."
  AUTOSTART_OK=1
else
  echo "  ! No autostart hook detected. The app will NOT come back after reboot."
  echo "    Re-run install.sh on a host with systemd or cron available."
fi

[ "$AUTOSTART_OK" = "1" ] || exit 1
