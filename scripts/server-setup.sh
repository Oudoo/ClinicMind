#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 server for ClinicMind, as root.
#
#   git clone <repository> /opt/clinicmind      # with your GitHub credentials
#   cd /opt/clinicmind
#   bash scripts/server-setup.sh cm.growcdx.com you@example.com
#
# Installs Docker, opens ports 22/80/443, writes .env with fresh secrets (when
# none exists), starts the production stack (pulling the published images, or
# building when they cannot be pulled), seeds the demo clinic and prints the
# demo password. Re-running it is safe: it keeps an existing .env. Optional
# environment: GEMINI_API_KEY (live AI), SEED_DEMO_PASSWORD (demo password).
set -euo pipefail

DOMAIN=${1:?usage: server-setup.sh <domain> <acme e-mail> [root domain]}
ACME_EMAIL=${2:?usage: server-setup.sh <domain> <acme e-mail> [root domain]}
ROOT_DOMAIN=${3:-$DOMAIN}
cd "$(dirname "$0")/.."

echo "▶ Packages and Docker"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends ca-certificates curl git ufw openssl >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

echo "▶ Firewall (22, 80, 443)"
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

if [ ! -f .env ]; then
  echo "▶ Writing .env with fresh secrets"
  SEED_PASSWORD=${SEED_DEMO_PASSWORD:-"Demo-$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)!"}
  cat > .env <<EOF
DOMAIN=$DOMAIN
ROOT_DOMAIN=$ROOT_DOMAIN
ACME_EMAIL=$ACME_EMAIL
POSTGRES_PASSWORD=$(openssl rand -hex 32)
APP_DB_PASSWORD=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -base64 48)
EMBED_SIGNING_SECRET=$(openssl rand -base64 48)
GEMINI_API_KEY=${GEMINI_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
AI_DEFAULT_PROVIDER=auto
AI_EMBEDDING_PROVIDER=auto
SMTP_URL=${SMTP_URL:-}
MAIL_FROM="ClinicMind <no-reply@$DOMAIN>"
SEED_DEMO_PASSWORD=$SEED_PASSWORD
BACKUP_RETENTION_DAYS=30
LOG_LEVEL=info
EOF
  chmod 600 .env
else
  echo "▶ Keeping the existing .env"
  # Added with row-level security: the app's own database role needs a password.
  if ! grep -q '^APP_DB_PASSWORD=.' .env; then
    echo "APP_DB_PASSWORD=$(openssl rand -hex 32)" >> .env
    echo "  (added APP_DB_PASSWORD)"
  fi
fi

echo "▶ Starting the stack"
compose="docker compose -f docker-compose.prod.yml --env-file .env"
if $compose pull --quiet web migrate 2>/dev/null; then
  $compose up -d --remove-orphans
else
  echo "  (published images not reachable; building locally, a few minutes)"
  $compose up -d --build --remove-orphans
fi

echo "▶ Seeding the demo clinic"
$compose --profile seed run --rm seed

echo "▶ Waiting for https://$DOMAIN"
for i in $(seq 1 60); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    echo "✅ Healthy: https://$DOMAIN/login  (platform console: https://$DOMAIN/platform)"
    exit 0
  fi
  sleep 5
done
echo "The app did not answer yet. Check DNS for $DOMAIN and *.$ROOT_DOMAIN, then: $compose logs -f caddy web"
exit 1
