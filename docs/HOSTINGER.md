# ClinicMind on Hostinger's Node.js hosting

This puts the ClinicMind demo on a Hostinger **Business or Cloud** web hosting plan, as a
Node.js website, for testing before go-live. For going live, use a server of your own
(docs/RUNBOOK.md §5): this hosting has no PostgreSQL, stops every request after 120 seconds and
runs no background workers besides the app itself.

## What it needs

1. **A free Node.js website slot** on a Business or Cloud plan.
2. **A PostgreSQL database outside Hostinger.** Hostinger's web hosting only offers MySQL. A free
   [Neon](https://neon.tech) project is enough for the demo: create one in the region nearest the
   hosting (Frankfurt for Europe), then in **Connect** turn **Connection pooling off** and copy
   the connection string. Its host must not contain `-pooler`, because each clinic's connections
   carry their clinic as a startup option, and a pooler drops it.

## Option A: GitHub deploys it (recommended)

The **Hostinger** workflow (`.github/workflows/hostinger.yml`) does everything through
Hostinger's API: it creates the website if needed, sets its environment variables, uploads the
app, follows the build and checks the site. When the app Hostinger starts at the end of a build
does not answer, it restarts it (up to twice), and then runs the end-to-end suite against the
live site: every account's pages, signing in and out, a patient's account, the phone layout.

1. Add these repository secrets (GitHub → Settings → Secrets and variables → Actions):
   - `HOSTINGER_API_TOKEN`: hPanel → Account → API.
   - `DEMO_DATABASE_URL`: the Neon connection string.
   - `GEMINI_API_KEY` (optional): live AI. Without it the assistant answers in offline mode.
2. Set `deploy/hostinger/request.json` to `{ "action": "deploy", "domain": "cm.growcdx.com" }`
   and push it to `main`. The workflow's log shows the build and the result.

The workflow derives the app's database password and its secrets from `DEMO_DATABASE_URL`, so
they stay the same from one deploy to the next, and it uses the direct host when given a pooled
one. `{ "action": "status", "domain": "cm.growcdx.com" }` in `deploy/hostinger/status.json`
(the **Hostinger status** workflow) shows the last build, the app's log and its errors, its
environment variable names, the SSL and CDN settings and its health check, without changing
anything; with `"restart": true` it restarts the app first. A deploy with `"reseed": true`
rebuilds the demo clinic around today; the running app's background jobs are off until the new
app runs, so none of them works on a clinic half built.

## Option B: upload the zip in hPanel

1. Make the zip: `bash scripts/hostinger-package.sh` writes `.hostinger/clinicmind-hostinger.zip`.
2. hPanel → **Websites** → **Add website** → **Node.js Apps** → **Upload your website files**,
   and choose the zip.
3. Build settings: framework **Next.js**, Node.js **22**, build command `npm run build`, output
   directory `.next`. These are the detected defaults.
4. Environment variables:

   | Name | Value |
   | --- | --- |
   | `SYSTEM_DATABASE_URL` | the Neon connection string, with `&connection_limit=5` added at the end |
   | `DATABASE_URL` | the same string, with the user and password before `@` replaced by `clinicmind_app:` and a new password of 32 letters and digits, and `&connection_limit=10` at the end |
   | `AUTH_SECRET` | 48 random letters and digits |
   | `EMBED_SIGNING_SECRET` | 48 other random letters and digits |
   | `APP_URL` | the website's address, e.g. `https://cm.growcdx.com` |
   | `SEED_DEMO_PASSWORD` | the demo accounts' password, e.g. `Demo-Clinic-2026!` |
   | `TOKIO_WORKER_THREADS` | `2` |
   | `GEMINI_API_KEY` | optional, for live AI |

5. **Deploy**. The first build takes 5 to 15 minutes, because it also creates the demo clinic,
   about 28,000 queries over the network to the database. Later builds take a few minutes.

## What the build does

`npm run build` in the bundle runs `scripts/hostinger-build.mjs`:

1. applies the database migrations, as the database's owner (`SYSTEM_DATABASE_URL`);
2. gives the app's own role, `clinicmind_app`, the password in `DATABASE_URL`, and checks that a
   connection as it is bound by the clinic isolation rules;
3. creates the demo clinic if it is not there yet (with `SEED_DEMO_PASSWORD`);
4. builds the app with few workers and threads (the hosting counts every thread against a limit).

Later deploys keep the demo clinic and its data. To rebuild it around today's date, add
`RESEED_DEMO` = `yes`, deploy once, then remove the variable.

## Signing in

Open `APP_URL/login`. Every demo account uses `SEED_DEMO_PASSWORD`:

| Account | Role |
| --- | --- |
| `owner@demo.clinic` | Clinic owner |
| `doctor@demo.clinic` | Doctor |
| `nurse@demo.clinic` | Nurse |
| `reception@demo.clinic` | Reception |
| `ai@demo.clinic` | The Clinic AI module |
| `platform@demo.clinic` | Platform administrator (`/platform`) |

## Limits of this hosting

- Reminders and other scheduled jobs run inside the app, so only while Hostinger keeps the app
  running. Hostinger runs two copies of it; each job still runs once, because every run is
  claimed in the database first.
- If the site stops answering (the page keeps loading, the app's log shows nothing new),
  restart the app: push `deploy/hostinger/status.json` with `"restart": true`, or use the
  restart button on the website's Node.js page in hPanel.
- A request that takes longer than 120 seconds is stopped. Long AI calls time out at 30 seconds
  first (`AI_TIMEOUT_MS`).
- Files sent to the app (lab reports, receipt photos) are kept in the database, so a redeploy
  does not lose them.
