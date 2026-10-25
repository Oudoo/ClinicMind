#!/usr/bin/env bash
# ClinicMind: run the whole demo on this machine with one command.
#
#   scripts/demo-local.sh              first run builds the application (about 5 minutes), later runs reuse it
#   scripts/demo-local.sh --reseed     rebuild the demo clinic so the schedule is centred on today, then start
#   scripts/demo-local.sh --rebuild    build the application again (after pulling new code)
#   scripts/demo-local.sh --dev        development server with hot reload instead of the production build
#
# It starts PostgreSQL in Docker when nothing answers at DATABASE_URL, applies
# the migrations, seeds the demo clinic once (password Demo-Clinic-2026!), then
# serves the application on http://localhost:3000 and the click-through
# prototype on http://localhost:8787, and prints the accounts. Ctrl+C stops both.
# Keys never go on the command line: put GEMINI_API_KEY (or OPENAI_API_KEY) in .env.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=start; RESEED=0; REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --dev) MODE=dev ;;
    --reseed) RESEED=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1; }; }
need node "Install Node 22 from https://nodejs.org"
need npm "npm comes with Node"
case "$(node -v)" in v2[2-9].*|v[3-9][0-9].*) ;; *) echo "Node 22 or newer is required (found $(node -v))."; exit 1 ;; esac

# 1. Configuration: .env with real secrets and the demo password.
if [ ! -f .env ]; then
  say "Creating .env from .env.example with fresh secrets"
  cp .env.example .env
  node -e '
    const fs = require("fs"); const c = require("crypto");
    let s = fs.readFileSync(".env", "utf8");
    const set = (k, v) => { s = s.replace(new RegExp("^" + k + "=.*$", "m"), k + "=" + v); };
    set("AUTH_SECRET", c.randomBytes(48).toString("base64"));
    set("EMBED_SIGNING_SECRET", c.randomBytes(48).toString("base64"));
    set("SEED_DEMO_PASSWORD", "Demo-Clinic-2026!");
    fs.writeFileSync(".env", s);'
  echo "   Add GEMINI_API_KEY=<your key> to .env for live AI (extraction, assistant reasoning, dictation)."
fi
set -a; . ./.env; set +a
export SEED_DEMO_PASSWORD="${SEED_DEMO_PASSWORD:-Demo-Clinic-2026!}"
# .env may say NODE_ENV=development for `npm run dev`; the production build and server need production.
unset NODE_ENV

# 2. Database: reuse what answers at DATABASE_URL, otherwise start Postgres in Docker.
db_ok() { echo 'SELECT 1' | npx --no-install prisma db execute --stdin --url "$DATABASE_URL" >/dev/null 2>&1; }
[ -d node_modules ] || { say "Installing dependencies"; npm ci; }
if ! db_ok; then
  if command -v docker >/dev/null 2>&1; then
    say "Starting PostgreSQL (Docker)"
    docker compose up -d db
    for _ in $(seq 1 30); do db_ok && break; sleep 2; done
  fi
  db_ok || { echo "PostgreSQL does not answer at DATABASE_URL and Docker is not available. Start a database and try again."; exit 1; }
fi

# 3. Schema and the demo clinic.
say "Applying migrations"
npm run --silent db:migrate
if [ "$RESEED" = 1 ] || [ ! -f .demo-seeded ]; then
  say "Building the demo clinic (62 patients, weeks of appointments around today, indexed for the assistant)"
  npm run --silent db:seed
  date > .demo-seeded
else
  echo "Demo clinic already seeded on $(cat .demo-seeded | head -c 24); use --reseed to centre the schedule on today."
fi

# 4. The two builds.
cleanup() { kill "${PROTO_PID:-}" "${APP_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
node scripts/static-server.mjs demo 8787 >/dev/null 2>&1 &
PROTO_PID=$!
if [ "$MODE" = dev ]; then
  say "Starting the application (development server)"
  npm run --silent dev >/dev/null 2>&1 &
else
  if [ "$REBUILD" = 1 ] || [ ! -f .next/BUILD_ID ]; then
    say "Building the application (a few minutes the first time)"
    NODE_ENV=production npm run --silent build
  fi
  say "Starting the application"
  NODE_ENV=production npm run --silent start >/dev/null 2>&1 &
fi
APP_PID=$!
HEALTH=""
for _ in $(seq 1 60); do
  HEALTH="$(curl -fsS --max-time 3 http://localhost:3000/api/health 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 2
done
[ -n "$HEALTH" ] || { echo "The application did not answer on http://localhost:3000; see the terminal above."; exit 1; }
AI="$(node -e 'const h=JSON.parse(process.argv[1]); const a=h.ai||{}; const f=(x)=>x&&x.configured?`${x.provider} (${x.model})`:"not configured (offline echo mode)"; console.log(`chat ${f(a.chat)} · embeddings ${f(a.embeddings)} · transcription ${f(a.transcription)}`)' "$HEALTH" 2>/dev/null || echo "unknown")"

cat <<EOF

────────────────────────────────────────────────────────────────────────
  ClinicMind demo is running

  Application (live backend)   http://localhost:3000/login
  Platform console             http://localhost:3000/platform
  Prototype (click-through)    http://localhost:8787/
  Health                       http://localhost:3000/api/health

  AI: $AI

  Accounts (both builds), password: $SEED_DEMO_PASSWORD
    ai@demo.clinic          Nadia Youssef     Clinic AI lead (the spec, module by module: prototype)
    owner@demo.clinic       Dr. Layla Hassan  Clinic owner
    doctor@demo.clinic      Dr. Omar Fahmy    Doctor
    mariam@demo.clinic      Dr. Mariam Tarek  Doctor
    nurse@demo.clinic       Heba Mostafa      Nurse
    reception@demo.clinic   Youssef Hany      Receptionist
    platform@demo.clinic    Platform Admin    Platform console

  Use Chrome; allow the microphone for localhost once. Ctrl+C stops everything.
────────────────────────────────────────────────────────────────────────
EOF
wait
