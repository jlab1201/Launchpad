# Dashboard

A self-hosted launchpad for the internal webapps you build, with a credential vault and auto-screenshot thumbnails.

---

> Screenshots coming soon.

---

## Features

- Launchpad grid for all your registered internal webapps — thumbnail, name, and live status badge per tile.
- Encrypted credential vault using Argon2id key derivation and libsodium XChaCha20-Poly1305 secretbox; no plaintext ever touches disk.
- Per-app status checks with green / yellow / red badges updated automatically.
- Auto-screenshot thumbnails captured via headless Chromium (Playwright).
- Single-process, self-hosted — one `pnpm start` is all it takes.
- SQLite-backed — no external database to run or maintain.

---

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/jlab1201/dashboard/main/scripts/install.sh | bash
```

Inspect the script first: https://github.com/jlab1201/dashboard/blob/main/scripts/install.sh

Requires Node.js 20 LTS and pnpm (via `corepack enable`).

---

## Manual install

```bash
git clone https://github.com/jlab1201/dashboard.git
cd dashboard
pnpm install
pnpm playwright install chromium
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. The app runs on port 3000 by default.

---

## First run / vault setup

The first time you open the dashboard you will be prompted for a master passphrase. This passphrase derives the encryption key for your credential vault via Argon2id. It is never written to disk — if you lose it, stored credentials are unrecoverable (the apps themselves and their thumbnails are not affected). The vault is locked by default after every server restart, so you will re-enter the passphrase each session.

---

## Configuration

Set these environment variables (copy `.env.example` to `.env.local`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port the Next.js server listens on |
| `VAULT_IDLE_TIMEOUT_MS` | `1800000` | Milliseconds of inactivity before the vault auto-locks (default 30 min) |

---

## Development

Available scripts (from `package.json`):

- `dev` — start the Next.js development server with HMR.
- `build` — compile a production build.
- `start` — serve the production build.
- `lint` — run Biome static analysis across the project.
- `format` — auto-format all files with Biome.
- `test` — run the Vitest unit test suite once.
- `test:watch` — run Vitest in watch mode.
- `test:e2e` — run Playwright end-to-end tests.
- `test:all` — run unit tests then e2e tests in sequence.
- `db:generate` — generate Drizzle migration files from the schema.
- `db:migrate` — apply pending migrations to `data/db.sqlite`.

---

## Production deployment

### pm2

```bash
pnpm build
pnpm add -g pm2
pm2 start "node .next/standalone/server.js" --name dashboard
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

### systemd (user-level, no root required)

Create `~/.config/systemd/user/dashboard.service`:

```ini
[Unit]
Description=Dashboard launchpad
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/Dashboard
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dashboard
```

Replace `/path/to/Dashboard` with the absolute path to this repository.

### Docker

```bash
docker compose up -d
```

The compose file mounts `./data` into the container so the vault, database, and thumbnails persist across restarts. The image exposes port 3000.

To build and run without compose:

```bash
docker build -t dashboard .
docker run -d -p 3000:3000 -v "$(pwd)/data:/app/data" dashboard
```

### TLS and HSTS

When terminating TLS at a reverse proxy (nginx, Caddy, Traefik), enable HSTS at the proxy layer:

```
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

The Next.js process intentionally does not set HSTS — sending it from a non-TLS deployment can lock browsers out of the dashboard.

---

## Security notes

- The master passphrase exists only in memory for the duration of your session. It is never written to disk or logged.
- Credentials are encrypted with XChaCha20-Poly1305 (libsodium secretbox). Each record has its own random nonce. The encrypted blob is the only thing stored in SQLite — running `sqlite3 data/db.sqlite "select * from credentials"` will show ciphertext.
- The derived key is zeroed from RAM when you click Lock and after 30 minutes of inactivity (configurable via `VAULT_IDLE_TIMEOUT_MS`).
- The vault is locked by default on every server restart. The UI shows a clear Vault locked / Vault unlocked indicator.

For the full threat model (at-rest, stolen-disk, RAM-dump, malicious extension, phishing), see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

### Security headers

The app sets the following HTTP security headers on all routes via `next.config.ts`:

- `X-Frame-Options: DENY` — blocks clickjacking.
- `X-Content-Type-Options: nosniff` — prevents MIME-type sniffing.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` — disables sensitive browser APIs not used by the dashboard.
- `Cross-Origin-Opener-Policy: same-origin` — isolates the dashboard from cross-origin window references.
- `Content-Security-Policy` — production builds only (omitted in dev to keep Next.js HMR working).

---

## Backup & restore

Copy `data/db.sqlite` to back up all registered apps, encrypted credentials, and the per-install vault salt (stored in the `vault_meta` table). Restoring on another machine still requires the original master passphrase.

Thumbnails are stored in `data/screenshots/` and can be backed up separately; the app will re-capture them if missing.

---

## Troubleshooting

**`better-sqlite3` native build fails after `pnpm install`**
Try `pnpm rebuild better-sqlite3`. If that does not resolve it, run `node-gyp rebuild` from inside `node_modules/better-sqlite3`. You need `python3`, `make`, and a C++ compiler (on Debian/Ubuntu: `sudo apt install build-essential`).

**Playwright cannot find Chromium**
Run `pnpm playwright install chromium` from the project root. This downloads the browser binary that Playwright uses for thumbnail capture and e2e tests.

**Port 3000 is already in use**
Start on a different port:
```bash
PORT=3001 pnpm dev
```

---

## Contributing

Issues and PRs welcome at https://github.com/jlab1201/dashboard. For security disclosures, please open a private security advisory on GitHub rather than a public issue.

---

## License

MIT — see [LICENSE](LICENSE).
