# ClinicMind — Operations Runbook

How to run, deploy, back up, restore and operate ClinicMind. Everything here is
reproducible from the repository; nothing depends on a specific hosting vendor.

## 1. Requirements

| Component | Version | Notes |
|---|---|---|
| Node.js | 22 LTS | `engines` in package.json |
| PostgreSQL | 16 with `pgvector` | `pgvector/pgvector:pg16` image, or `postgresql-16` + the `vector` extension |
| Docker + Compose v2 | any recent | for the container path |
| An AI key | Gemini, OpenAI or Anthropic | optional; without one the offline `echo` provider answers |

## 2. Configuration

Copy `.env.example` to `.env`. Required in production:

- `AUTH_SECRET`, `EMBED_SIGNING_SECRET` — 32+ random characters each (`openssl rand -base64 48`). The app refuses to start with placeholders or development-looking values.
- `DATABASE_URL` — Postgres connection string.
- `APP_URL`, `ROOT_DOMAIN` — public URL and the domain tenant subdomains hang off.
- One of `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` for live AI; model ids and `AI_TIMEOUT_MS` are configurable.
- `SMTP_URL`, `MAIL_FROM` — invitation and password-reset e-mails (otherwise links are printed to the server log).

## 3. Run locally (developer)

```bash
npm install
docker compose up -d db                      # Postgres + pgvector on 127.0.0.1:5432
npm run db:migrate                           # applies prisma/migrations
SEED_DEMO_PASSWORD='Demo-Clinic-2026!' npm run db:seed
npm run dev                                  # http://localhost:3000/login
```

Checks: `npm run typecheck`, `npm run lint`, `npm test` (needs `DATABASE_URL` for the route tests), `npm run build`, and `npm run e2e` against a running server.

## 4. Run the demo stack (one command)

```bash
cp .env.example .env     # set AUTH_SECRET, EMBED_SIGNING_SECRET, optionally an AI key and SEED_DEMO_PASSWORD
docker compose up --build -d
docker compose --profile seed run --rm seed  # prints the demo accounts and password
```

Open http://localhost:3000/login. `docker compose logs -f web` tails the app.

## 5. Deploy to a server (production)

Everything runs from `docker-compose.prod.yml`: Caddy terminates TLS, the app
and Postgres are reachable only on the Compose network, migrations run before
the app starts, a nightly `pg_dump` lands in `./backups`.

1. **Server:** Ubuntu 22.04/24.04, 2 vCPU, 4 GB RAM, 40 GB disk, ports 22/80/443 open.
2. **DNS:** an A record for `DOMAIN` and a wildcard A record `*.ROOT_DOMAIN`
   pointing at the server (tenants are served as `<slug>.ROOT_DOMAIN`). Caddy
   obtains the app certificate at start and tenant and custom-domain
   certificates on first use, gated by the app's `/api/tls/ask` endpoint so
   only active tenants and verified custom domains get one.
3. **Check out and configure:**
   ```bash
   git clone <repository> ~/clinicmind && cd ~/clinicmind
   cp deploy/env.production.example .env   # fill in DOMAIN, ACME_EMAIL, secrets, an AI key, SEED_DEMO_PASSWORD
   ```
   Or let `scripts/server-setup.sh <domain> <acme e-mail>` do steps 3 to 5 on a fresh server: it installs Docker, opens the firewall, writes `.env` with generated secrets, starts the stack and seeds the demo.
4. **Start:** `docker compose -f docker-compose.prod.yml --env-file .env up -d`
   pulls the images published by the *Release image* workflow
   (`ghcr.io/<owner>/clinicmind` and `…/clinicmind-tools`; `docker login ghcr.io`
   first when the repository is private). `up -d --build` builds them on the
   server instead.
5. **Demo data:** `docker compose -f docker-compose.prod.yml --env-file .env --profile seed run --rm seed`
   creates the demo clinic and prints the six accounts; re-running it rebuilds
   the demo tenant.
6. **Platform administrator (real clients):**
   `docker compose -f docker-compose.prod.yml --env-file .env run --rm migrate npx tsx scripts/platform-bootstrap.ts --email you@example.com --name "Your Name"`
   prints an invitation link; the console is at `https://DOMAIN/platform`.
7. **Verify:** `curl -s https://DOMAIN/api/health` → `{"status":"ok","database":"up",…,"devSecrets":false}`,
   then open `https://DOMAIN/login` and `https://demo.ROOT_DOMAIN/login`.

### Publishing the demo at cm.growcdx.com

| Item | Value |
|---|---|
| App domain (`DOMAIN`) | `cm.growcdx.com` → landing page, sign-in, platform console |
| Tenants (`ROOT_DOMAIN`) | `cm.growcdx.com` → `demo.cm.growcdx.com`, `nour-clinics.cm.growcdx.com`, … |
| DNS records | `A cm.growcdx.com → <server IP>` and `A *.cm.growcdx.com → <server IP>` |
| First run | `bash scripts/server-setup.sh cm.growcdx.com <your e-mail>` on the server, with `GEMINI_API_KEY=<key>` exported first for live AI |
| Demo accounts | printed by the seed; the password is `SEED_DEMO_PASSWORD` in `.env` |
| Health | `https://cm.growcdx.com/api/health` |
| Later deploys | GitHub → Actions → *Deploy* → *Run workflow* (tag `latest` or a commit sha), after adding the `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` repository secrets; or `git pull` and `up -d` on the server |

### Upgrading

Run the *Deploy* workflow, or on the server:

```bash
cd ~/clinicmind && git pull
docker compose -f docker-compose.prod.yml --env-file .env pull && docker compose -f docker-compose.prod.yml --env-file .env up -d
```
Migrations run before the new app version starts. Roll back by deploying the previous image tag; migrations are forward-only, so restore a backup if a migration must be undone.

## 6. Backups and restore

- Nightly dumps land in `./backups/clinicmind-<timestamp>.dump` (custom format, compressed). Copy them off the host (object storage, another machine) — a backup on the same disk is not a backup.
- Restore drill (do this quarterly): `PGHOST=... PGPASSWORD=... ./scripts/restore.sh backups/<file>.dump`, then `npx prisma migrate deploy`, then sign in and spot-check a patient.
- The audit log is append-only at the database level; deleting a tenant (offboarding, erasure request) requires `SET LOCAL app.allow_audit_delete = 'on'` inside the same transaction, which only the application's tenant-removal path and the seed do.

## 7. Secrets and access

- Rotate `AUTH_SECRET` to invalidate every staff session at once (users sign in again). Rotate `EMBED_SIGNING_SECRET` to invalidate every embed token.
- Each tenant's embed secret is stored hashed; rotate it from **Settings → Embed**; the old one stops working immediately.
- Staff offboarding: set the user to `DISABLED` (Settings → Team); their sessions stop resolving on the next request.
- Rate limits: sign-in 30/IP and 10/e-mail per 15 min, account lockout after 10 failures; API 600 requests / 5 min per client address, AI endpoints 40, token minting 60. Behind a reverse proxy the client address is the first `X-Forwarded-For` hop, so the proxy must set it (Caddy does).

## 8. Monitoring

- `GET /api/health` — 200 when the database answers; includes DB latency and uptime. Point an uptime monitor at it.
- Logs go to stdout (`docker compose logs`); Caddy logs requests as JSON. Ship both to your log system.
- Error tracking: not bundled; a Sentry-compatible DSN can be added to the Next.js app in one step when you choose a vendor.

## 9. Data protection notes

- Patient data stays in Postgres and the AI provider calls; nothing is sent to third parties except the configured AI provider. Transcripts and retrieved context are stored in `ai_runs` for traceability — set a retention period that matches your policy and purge with a scheduled `DELETE` (a retention job is on the roadmap).
- Sending clinical text to a cloud AI provider is a cross-border transfer under Egypt's PDPL; keep the provider's data-processing terms and the patient consent wording with your records.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| App exits at start with "Invalid environment configuration" | missing/short secrets or bad URL | fix `.env`, restart |
| "AUTH_SECRET / EMBED_SIGNING_SECRET are development values" | placeholder secrets | generate real ones |
| 429 on sign-in | rate limit or lockout | wait for the window (15 min) or restart `web` to clear in-memory buckets |
| Assistant says no records were found | embeddings not built | run `npm run ai:reindex demo` (or `--all`) after seeding or importing data |
| `relation ... does not exist` | migrations not applied | `npm run db:migrate` |
| Embed surface shows "not available" | embedding disabled or no allowed origins | enable in Settings → Embed and add the exact origin |
