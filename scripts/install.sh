#!/usr/bin/env bash
set -euo pipefail

# When invoked as a real file (not via `curl | bash`), cd to the project root
# so the script works regardless of which directory the user ran it from.
# Detection: BASH_SOURCE[0] is a regular file AND its parent contains a
# Launchpad package.json. The curl|bash path skips this branch and falls back
# to the existing cwd-based bootstrap below.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$_SCRIPT_DIR/../package.json" ] \
     && grep -q '"name": "launchpad"' "$_SCRIPT_DIR/../package.json" 2>/dev/null; then
    cd "$_SCRIPT_DIR/.."
  fi
fi

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

# --- Rebuild native modules against the runtime Node ABI ---
# Guards against stale better-sqlite3 binaries when the host's Node version,
# glibc, or pnpm store has drifted from what produced the cached .node file.
echo ""
echo "Rebuilding native modules ..."
pnpm rebuild better-sqlite3

# --- Smoke-test the native binding so a broken install fails fast ---
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo "Error: better-sqlite3 native binding failed to load." >&2
  echo "Likely a Node.js version / ABI mismatch — check 'node --version'." >&2
  exit 1
fi
echo "  better-sqlite3 native binding loads OK"

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

INSTALL_DIR="$PWD"
PNPM_BIN="$(command -v pnpm)"
# Resolve the absolute directory of the Node binary in use (e.g. nvm install).
# systemd-user services inherit only a minimal PATH, so without this the
# spawned `node` can fall through to /usr/bin/node and fail with an ABI
# mismatch against native modules built under a different Node version.
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PID_FILE="$INSTALL_DIR/data/launchpad.pid"

# Stop any previously-tracked instance so re-running the installer doesn't
# fight itself for the port.
if [ -f "$PID_FILE" ]; then
  PREV_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PREV_PID" ] && kill -0 "$PREV_PID" 2>/dev/null; then
    echo "Stopping previous Launchpad process (PID $PREV_PID) ..."
    kill "$PREV_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$PREV_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$PREV_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Detect a usable systemd user instance. We accept any state where the user
# manager is responsive (running OR degraded) — `is-system-running --quiet`
# alone is too strict for prod boxes that report "degraded" but happily run
# user services. Probe with a benign command instead.
have_user_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user list-units --type=service --no-legend >/dev/null 2>&1
}

# Stop any previously-managed systemd user service too — it wouldn't have a
# PID file, but it would still hold the port.
if have_user_systemd; then
  systemctl --user stop launchpad.service >/dev/null 2>&1 || true
fi

# Probe forward from $PORT until we find a free TCP port. Caps at +50 to
# avoid runaway scans. Falls back to attempting the requested port directly
# if `ss` isn't installed.
port_in_use() {
  local p="$1"
  ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
}

if command -v ss >/dev/null 2>&1; then
  REQUESTED_PORT="$PORT"
  MAX_PORT=$((PORT + 50))
  while [ "$PORT" -le "$MAX_PORT" ] && port_in_use "$PORT"; do
    PORT=$((PORT + 1))
  done
  if [ "$PORT" -gt "$MAX_PORT" ]; then
    echo "Error: no free port found in range $REQUESTED_PORT–$MAX_PORT." >&2
    exit 1
  fi
  if [ "$PORT" != "$REQUESTED_PORT" ]; then
    echo "Port $REQUESTED_PORT is in use; using port $PORT instead."
  fi
  export PORT
fi

# Persist the resolved port in .env.local so manual `pnpm start` picks the
# same value next time (the systemd unit also embeds it via Environment=).
if [ -f .env.local ]; then
  if grep -q "^PORT=" .env.local; then
    # Portable in-place edit across GNU and BSD sed.
    sed "s/^PORT=.*/PORT=$PORT/" .env.local > .env.local.tmp \
      && mv .env.local.tmp .env.local
  else
    echo "PORT=$PORT" >> .env.local
  fi
fi

# Prefer a systemd user service (survives terminal close AND system reboot).
# Fall back to a nohup-detached process + cron @reboot hook when systemd
# isn't available (e.g. WSL2 without `systemd=true` in /etc/wsl.conf).
USE_SYSTEMD=0
if have_user_systemd; then
  USE_SYSTEMD=1
fi

if [ "$USE_SYSTEMD" = "1" ]; then
  SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SERVICE_FILE="$SYSTEMD_DIR/launchpad.service"
  mkdir -p "$SYSTEMD_DIR"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Launchpad
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
Environment=PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$PNPM_BIN start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable launchpad.service >/dev/null
  systemctl --user restart launchpad.service

  # Linger is what makes the user service start at *boot* (rather than only
  # after the user logs in). Without it, "autostart" silently means "starts
  # next time the user opens a shell." We try to enable it and report the
  # truthful outcome — no silent failures.
  LINGER_OK=0
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$USER" >/dev/null 2>&1; then
      LINGER_OK=1
    elif loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
      LINGER_OK=1
    fi
  fi

  if [ "$LINGER_OK" = "1" ]; then
    AUTOSTART_LINE="Autostart: enabled — runs at boot (systemd user + linger)."
  else
    AUTOSTART_LINE="Autostart: PARTIAL — service is enabled but linger could not be set.
             It will start the next time '$USER' logs in, NOT at boot.
             Fix:  sudo loginctl enable-linger $USER"
  fi

  cat <<EOF

================================================
✓ Launchpad started as a systemd user service.
  URL:    http://localhost:${PORT}
  $AUTOSTART_LINE
  Status: systemctl --user status launchpad
  Logs:   journalctl --user -u launchpad -f
  Stop:   systemctl --user stop launchpad

  Your first visit will prompt you to set the master vault passphrase.
================================================
EOF
else
  LOG_FILE="$INSTALL_DIR/launchpad.log"
  nohup "$PNPM_BIN" start > "$LOG_FILE" 2>&1 < /dev/null &
  APP_PID=$!
  disown "$APP_PID" 2>/dev/null || true
  echo "$APP_PID" > "$PID_FILE"
  # Fail fast on common errors (port-in-use, missing build, etc.).
  sleep 2
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Error: Launchpad failed to start. Last 20 log lines:" >&2
    tail -20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi

  # Register a cron @reboot hook so the app starts on system boot even
  # without systemd. The hook calls a small wrapper that re-launches via
  # nohup with the same env, so prod boxes that survive a reboot come back
  # up unattended. We write the wrapper to scripts/ so it stays version-
  # controlled and updates land on every `update.sh`.
  AUTOSTART_WRAPPER="$INSTALL_DIR/scripts/autostart.sh"
  cat > "$AUTOSTART_WRAPPER" <<EOF
#!/usr/bin/env bash
# Auto-generated by install.sh — invoked by 'crontab @reboot'.
# Starts Launchpad detached and writes a PID file so update.sh can stop it cleanly.
set -eu
cd "$INSTALL_DIR"
export PATH="$(dirname "$PNPM_BIN"):\$PATH"
export PORT="$PORT"
LOG_FILE="$INSTALL_DIR/launchpad.log"
PID_FILE="$INSTALL_DIR/data/launchpad.pid"
# If a previous instance is still alive (e.g. the user already started it
# manually after boot), do nothing — don't fight for the port.
if [ -f "\$PID_FILE" ] && kill -0 "\$(cat "\$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi
nohup "$PNPM_BIN" start > "\$LOG_FILE" 2>&1 < /dev/null &
echo "\$!" > "\$PID_FILE"
EOF
  chmod +x "$AUTOSTART_WRAPPER"

  AUTOSTART_LINE="Autostart: NOT configured (no cron available)."
  if command -v crontab >/dev/null 2>&1; then
    # Replace any prior Launchpad @reboot line so re-running the installer
    # (or update.sh) doesn't accumulate duplicates. The marker comment makes
    # the entry recognizable and removable without touching unrelated cron jobs.
    CRON_MARKER="# launchpad-autostart"
    CRON_LINE="@reboot $AUTOSTART_WRAPPER $CRON_MARKER"
    NEW_CRONTAB="$( (crontab -l 2>/dev/null || true) | grep -vF "$CRON_MARKER" ; echo "$CRON_LINE" )"
    if echo "$NEW_CRONTAB" | crontab - 2>/dev/null; then
      AUTOSTART_LINE="Autostart: enabled via cron @reboot ($AUTOSTART_WRAPPER)."
    else
      AUTOSTART_LINE="Autostart: FAILED to register cron @reboot. Check 'crontab -l' permissions."
    fi
  fi

  cat <<EOF

================================================
✓ Launchpad running in the background (PID $APP_PID).
  URL:    http://localhost:${PORT}
  $AUTOSTART_LINE
  Logs:   tail -f $LOG_FILE
  Stop:   kill \$(cat $PID_FILE)

  systemd isn't available. For a more robust prod setup on WSL2:
    1. Add 'systemd=true' under [boot] in /etc/wsl.conf
    2. Run 'wsl --shutdown' from Windows, then re-run this installer.

  Your first visit will prompt you to set the master vault passphrase.
================================================
EOF
fi
