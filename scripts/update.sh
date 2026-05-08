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

# --- Snapshot data/ as a rollback point ---
# Nothing in this script *should* clobber data/ (gitignored, git pull skips it,
# tar -xz only writes archive paths, migrations are additive). But "should" is
# not "guaranteed", and a single bad migration or wrong cwd would silently
# nuke a user's vault. Take a single rolling snapshot at data.bak/ so we can
# detect and reverse damage without depending on that chain holding.
DATA_DIR="data"
DATA_BAK="data.bak"
PRE_WEBAPP_COUNT=""
if [ -d "$DATA_DIR" ]; then
  echo "Snapshotting $DATA_DIR/ → $DATA_BAK/ (rollback point) ..."
  rm -rf "$DATA_BAK"
  # cp -a preserves perms, mtimes, symlinks. better-sqlite3 in WAL mode keeps
  # the live DB consistent on disk, so a plain copy is safe even if the app
  # is currently running — the WAL/-shm files travel with the .sqlite file.
  cp -a "$DATA_DIR" "$DATA_BAK"

  # Capture the pre-update webapps row count via Node so we can diff after
  # install.sh runs. Uses `--print` over a temp file to keep this stateless.
  if [ -f "$DATA_DIR/db.sqlite" ] && command -v node >/dev/null 2>&1; then
    PRE_WEBAPP_COUNT="$(node -e "
      try {
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1], { readonly: true });
        const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='webapps'\").all();
        if (tables.length === 0) { console.log(''); process.exit(0); }
        console.log(db.prepare('SELECT COUNT(*) AS c FROM webapps').get().c);
      } catch (e) { console.log(''); }
    " "$DATA_DIR/db.sqlite" 2>/dev/null || true)"
  fi
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

# --- Verify data/ survived the update ---
# Two checks: (1) db.sqlite still exists and is non-empty, (2) the webapps row
# count didn't shrink. If either fails, we restore from data.bak/ and abort
# loudly — better to roll back automatically than ship a "successful" update
# the user discovers an hour later in the empty UI.
if [ -d "$DATA_BAK" ]; then
  echo ""
  echo "Verifying data/ integrity ..."

  if [ ! -f "$DATA_DIR/db.sqlite" ] || [ ! -s "$DATA_DIR/db.sqlite" ]; then
    echo "  ✗ $DATA_DIR/db.sqlite is missing or empty after update — rolling back." >&2
    rm -rf "$DATA_DIR"
    mv "$DATA_BAK" "$DATA_DIR"
    echo "    Restored from snapshot. Investigate before re-running update.sh." >&2
    exit 1
  fi

  if [ -n "$PRE_WEBAPP_COUNT" ] && command -v node >/dev/null 2>&1; then
    POST_WEBAPP_COUNT="$(node -e "
      try {
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1], { readonly: true });
        const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='webapps'\").all();
        if (tables.length === 0) { console.log(''); process.exit(0); }
        console.log(db.prepare('SELECT COUNT(*) AS c FROM webapps').get().c);
      } catch (e) { console.log(''); }
    " "$DATA_DIR/db.sqlite" 2>/dev/null || true)"

    if [ -n "$POST_WEBAPP_COUNT" ] && [ "$POST_WEBAPP_COUNT" -lt "$PRE_WEBAPP_COUNT" ]; then
      echo "  ✗ webapps row count shrank: $PRE_WEBAPP_COUNT → $POST_WEBAPP_COUNT — rolling back." >&2
      rm -rf "$DATA_DIR"
      mv "$DATA_BAK" "$DATA_DIR"
      echo "    Restored from snapshot. Investigate before re-running update.sh." >&2
      exit 1
    fi
    echo "  ✓ webapps preserved ($POST_WEBAPP_COUNT row(s)); db.sqlite intact."
  else
    echo "  ✓ db.sqlite intact (row-count diff skipped — node or pre-count unavailable)."
  fi

  # Snapshot stays at data.bak/ as a one-step rollback for the user. The next
  # update.sh run will overwrite it, so it never accumulates.
  echo "  Snapshot retained at $DATA_BAK/ — delete it manually once you're confident."
fi

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
