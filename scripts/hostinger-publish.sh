#!/usr/bin/env bash
# Publish ClinicMind on a Hostinger KVM VPS in one run, through the Hostinger API:
#   1. picks the VPS: a purchased one still awaiting setup (state "initial"), or VM_ID;
#   2. stores a post-install script that clones this repository and runs scripts/server-setup.sh;
#   3. installs Ubuntu 24.04 on the VPS with that script ("setup" mode; "recreate" reinstalls an
#      existing VPS and destroys everything on it);
#   4. waits for the VPS to run, then points DOMAIN and *.DOMAIN at it in the Hostinger DNS zone;
#   5. waits for https://DOMAIN/api/health.
#
# Needs curl, jq, openssl and HOSTINGER_API_TOKEN (hPanel → Account → API). Run it from the
# "Provision Hostinger" GitHub workflow, where the secrets stay in GitHub, or locally:
#   HOSTINGER_API_TOKEN=… ACME_EMAIL=you@example.com bash scripts/hostinger-publish.sh
#
# Environment:
#   DOMAIN              app domain (default cm.growcdx.com); tenants live under *.DOMAIN
#   ACME_EMAIL          contact e-mail for the TLS certificates (required)
#   ZONE                DNS zone at Hostinger (default: the last two labels of DOMAIN)
#   MODE                setup (default; only touches a VPS in state "initial") | recreate (destructive)
#   VM_ID               Hostinger virtual machine id (default: the first VPS awaiting setup)
#   DATA_CENTER_ID      data center id (default: the VPS's own, else a European one)
#   TEMPLATE_MATCH      OS template name pattern (default "Ubuntu 24.04")
#   SSH_PUBLIC_KEY      optional public key installed for root
#   GEMINI_API_KEY      optional; enables live AI. It travels inside the post-install script, which
#                       is deleted from Hostinger once the VPS runs.
#   SEED_DEMO_PASSWORD  optional demo password (otherwise generated on the server; see its .env)
#   SKIP_DNS            "true" leaves DNS alone
#   REPO_URL, REPO_REF  code to deploy (default https://github.com/Oudoo/ClinicMind, main)
set -euo pipefail

BASE=${HOSTINGER_API_BASE:-https://developers.hostinger.com}
DOMAIN=${DOMAIN:-cm.growcdx.com}
ACME_EMAIL=${ACME_EMAIL:?ACME_EMAIL is required (contact e-mail for the TLS certificates)}
MODE=${MODE:-setup}
TEMPLATE_MATCH=${TEMPLATE_MATCH:-Ubuntu 24.04}
REPO_URL=${REPO_URL:-https://github.com/Oudoo/ClinicMind}
REPO_REF=${REPO_REF:-main}
ZONE=${ZONE:-$(printf '%s' "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')}
VM_WAIT=${VM_WAIT:-80}        # polls of 15 s while the OS installs
HEALTH_WAIT=${HEALTH_WAIT:-80} # polls of 15 s for /api/health
POLL=${POLL_SECONDS:-15}
: "${HOSTINGER_API_TOKEN:?HOSTINGER_API_TOKEN is not set (hPanel → Account → API)}"
for t in curl jq openssl; do command -v "$t" >/dev/null || { echo "$t is required" >&2; exit 1; }; done
case "$MODE" in setup|recreate) ;; *) echo "MODE must be setup or recreate" >&2; exit 1 ;; esac

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mask() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1"; fi; }
mask "$HOSTINGER_API_TOKEN"

# api METHOD PATH [JSON] → response body on stdout; honours 429 Retry-After.
api() {
  local method=$1 path=$2 body=${3:-} attempt=0 code wait
  local -a extra=()
  if [ -n "$body" ]; then extra=(-H "Content-Type: application/json" --data "$body"); fi
  while :; do
    attempt=$((attempt + 1))
    code=$(curl -sS -o "$TMP/resp" -D "$TMP/hdr" -w '%{http_code}' -X "$method" "$BASE$path" \
      -H "Authorization: Bearer $HOSTINGER_API_TOKEN" -H "Accept: application/json" \
      ${extra[@]+"${extra[@]}"}) || code=000
    if [ "$code" = 429 ] && [ "$attempt" -lt 6 ]; then
      wait=$(grep -i '^retry-after:' "$TMP/hdr" | tr -dc '0-9' || true); sleep "${wait:-15}"; continue
    fi
    if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then cat "$TMP/resp"; return 0; fi
    echo "✗ $method $path → HTTP $code $(head -c 400 "$TMP/resp" 2>/dev/null)" >&2; return 1
  done
}
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; } # single-quote for the remote shell

echo "▶ Hostinger virtual machines"
VMS=$(api GET /api/vps/v1/virtual-machines)
echo "$VMS" | jq -r '.[] | "  VM \(.id)  \(.plan // "?")  state=\(.state)  hostname=\(.hostname // "-")  ip=\(.ipv4[0].address // "-")"'
if [ -n "${VM_ID:-}" ]; then
  [[ $VM_ID =~ ^[0-9]+$ ]] || { echo "VM_ID must be a number" >&2; exit 1; }
  VM=$(echo "$VMS" | jq --argjson id "$VM_ID" '.[] | select(.id == $id)')
  [ -n "$VM" ] || { echo "No virtual machine with id $VM_ID in this account" >&2; exit 1; }
elif [ "$MODE" = setup ]; then
  VM=$(echo "$VMS" | jq 'map(select(.state == "initial")) | first // empty')
  [ -n "$VM" ] || { echo "No VPS is awaiting setup (state \"initial\"). Buy a KVM plan in hPanel and leave it un-set-up, or pass VM_ID with MODE=recreate to reinstall an existing one (destroys its data)." >&2; exit 1; }
else
  echo "MODE=recreate needs VM_ID (the VPS to reinstall)" >&2; exit 1
fi
VM_ID=$(echo "$VM" | jq -r .id); STATE=$(echo "$VM" | jq -r .state)
if [ "$MODE" = setup ] && [ "$STATE" != initial ]; then
  echo "VM $VM_ID is \"$STATE\", not \"initial\". Use MODE=recreate to reinstall it (destroys everything on it)." >&2; exit 1
fi
echo "  using VM $VM_ID (state $STATE, mode $MODE)"

echo "▶ OS template and data center"
TEMPLATES=$(api GET /api/vps/v1/templates)
TEMPLATE_ID=$(echo "$TEMPLATES" | jq -r --arg m "$TEMPLATE_MATCH" \
  '([.[] | select(.name | test("^" + $m; "i"))] + [.[] | select(.name | test($m; "i"))]) | sort_by(.name | length) | first | .id // empty')
if [ -z "$TEMPLATE_ID" ]; then
  echo "No OS template matches \"$TEMPLATE_MATCH\". Available:" >&2; echo "$TEMPLATES" | jq -r '.[] | "  \(.id)  \(.name)"' >&2; exit 1
fi
TEMPLATE_NAME=$(echo "$TEMPLATES" | jq -r --argjson id "$TEMPLATE_ID" '.[] | select(.id == $id) | .name')
echo "  template: $TEMPLATE_NAME (id $TEMPLATE_ID)"
DC_ID=${DATA_CENTER_ID:-$(echo "$VM" | jq -r '.data_center_id // empty')}
if [ -z "$DC_ID" ]; then
  DCS=$(api GET /api/vps/v1/data-centers)
  DC_ID=$(echo "$DCS" | jq -r '[.[] | select(((.location // "") | ascii_downcase) as $l | ["de","fr","gb","lt","nl"] | index($l) != null)] | sort_by(.location) | first | .id // empty')
  [ -n "$DC_ID" ] || DC_ID=$(echo "$DCS" | jq -r 'first | .id // empty')
  [ -n "$DC_ID" ] || { echo "No data center available; pass DATA_CENTER_ID" >&2; exit 1; }
  DC_LABEL=$(echo "$DCS" | jq -r --argjson id "$DC_ID" '.[] | select(.id == $id) | ((.city // "?") + ", " + (.location // "?"))')
  echo "  data center: $DC_LABEL (id $DC_ID)"
else
  echo "  data center id: $DC_ID"
fi

echo "▶ Post-install script"
cat > "$TMP/post_install.sh" <<SCRIPT
#!/bin/bash
# ClinicMind first boot — generated by scripts/hostinger-publish.sh on $(date -u +%FT%TZ)
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
for i in \$(seq 1 30); do apt-get update -y && break; sleep 10; done
apt-get install -y git ca-certificates curl
[ -d /opt/clinicmind/.git ] || git clone --depth 1 --branch $(q "$REPO_REF") $(q "$REPO_URL") /opt/clinicmind
cd /opt/clinicmind
${GEMINI_API_KEY:+export GEMINI_API_KEY=$(q "${GEMINI_API_KEY:-}")}
${SEED_DEMO_PASSWORD:+export SEED_DEMO_PASSWORD=$(q "${SEED_DEMO_PASSWORD:-}")}
bash scripts/server-setup.sh $(q "$DOMAIN") $(q "$ACME_EMAIL") $(q "$DOMAIN")
echo "clinicmind-setup: exit \$?"
SCRIPT
POST_INSTALL=$(cat "$TMP/post_install.sh")
PIS_NAME="clinicmind-${DOMAIN}-$(date -u +%Y%m%d-%H%M%S)"
PIS_ID=$(api POST /api/vps/v1/post-install-scripts "$(jq -n --arg n "$PIS_NAME" --arg c "$POST_INSTALL" '{name: $n, content: $c}')" | jq -r .id)
echo "  stored as \"$PIS_NAME\" (id $PIS_ID)"

echo "▶ Installing the operating system ($MODE)"
ROOT_PASSWORD="$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 20)aZ9"
mask "$ROOT_PASSWORD"
if [ "$MODE" = setup ]; then
  BODY=$(jq -n --argjson t "$TEMPLATE_ID" --argjson d "$DC_ID" --argjson p "$PIS_ID" --arg pw "$ROOT_PASSWORD" --arg h "$DOMAIN" --arg key "${SSH_PUBLIC_KEY:-}" \
    '{template_id: $t, data_center_id: $d, post_install_script_id: $p, password: $pw, hostname: $h}
     + (if $key != "" then {public_key: {name: "clinicmind", key: $key}} else {} end)')
  api POST "/api/vps/v1/virtual-machines/$VM_ID/setup" "$BODY" >/dev/null
else
  BODY=$(jq -n --argjson t "$TEMPLATE_ID" --argjson p "$PIS_ID" --arg pw "$ROOT_PASSWORD" '{template_id: $t, post_install_script_id: $p, password: $pw}')
  ACTION_ID=$(api POST "/api/vps/v1/virtual-machines/$VM_ID/recreate" "$BODY" | jq -r '.id // empty')
  if [ -n "$ACTION_ID" ]; then
    for _ in $(seq 1 "$VM_WAIT"); do
      A=$(api GET "/api/vps/v1/virtual-machines/$VM_ID/actions/$ACTION_ID" || true)
      case "$(echo "$A" | jq -r '.state // "?"')" in success) break ;; error) echo "Recreate failed: $A" >&2; exit 1 ;; esac
      sleep "$POLL"
    done
  fi
fi
echo "  root password: set (not printed). Reset it in hPanel if you need SSH without a key."

echo "▶ Waiting for VM $VM_ID to run (usually 2–5 minutes)"
IP=""
for _ in $(seq 1 "$VM_WAIT"); do
  VM=$(api GET "/api/vps/v1/virtual-machines/$VM_ID" || true)
  STATE=$(echo "$VM" | jq -r '.state // "?"'); IP=$(echo "$VM" | jq -r '.ipv4[0].address // empty')
  if [ "$STATE" = running ] && [ -n "$IP" ]; then break; fi
  if [ "$STATE" = error ]; then echo "VM $VM_ID entered state \"error\"" >&2; exit 1; fi
  sleep "$POLL"
done
{ [ "$STATE" = running ] && [ -n "$IP" ]; } || { echo "VM $VM_ID is still \"$STATE\" after $((VM_WAIT * POLL / 60)) minutes" >&2; exit 1; }
echo "  running at $IP"
if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${SEED_DEMO_PASSWORD:-}" ]; then
  sleep $((POLL * 4)) # the installer has copied the script to the VPS by now
  api DELETE "/api/vps/v1/post-install-scripts/$PIS_ID" >/dev/null && echo "  post-install script deleted from Hostinger (it carried secrets)"
fi

if [ "${SKIP_DNS:-false}" != true ]; then
  echo "▶ DNS: $DOMAIN and *.$DOMAIN → $IP (zone $ZONE)"
  if [ "$DOMAIN" = "$ZONE" ]; then NAME="@"; WILD="*"; else NAME=${DOMAIN%."$ZONE"}; WILD="*.$NAME"; fi
  DNS_BODY=$(jq -n --arg n "$NAME" --arg w "$WILD" --arg ip "$IP" \
    '{overwrite: true, zone: [{name: $n, type: "A", ttl: 300, records: [{content: $ip}]}, {name: $w, type: "A", ttl: 300, records: [{content: $ip}]}]}')
  if api POST "/api/dns/v1/zones/$ZONE/validate" "$DNS_BODY" >/dev/null && api PUT "/api/dns/v1/zones/$ZONE" "$DNS_BODY" >/dev/null; then
    echo "  records written"
  else
    echo "  could not write the records (is the $ZONE zone managed at Hostinger?). Create them yourself: A $DOMAIN → $IP and A *.$DOMAIN → $IP"
  fi
fi

echo "▶ Waiting for https://$DOMAIN/api/health (first boot installs Docker and starts the stack: 5–15 minutes)"
for _ in $(seq 1 "$HEALTH_WAIT"); do
  if curl -fsS --max-time 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    echo "✅ ClinicMind is up: https://$DOMAIN/login  ·  platform console: https://$DOMAIN/platform"
    if [ -z "${SEED_DEMO_PASSWORD:-}" ]; then echo "   Demo password: SEED_DEMO_PASSWORD in /opt/clinicmind/.env on the server (hPanel → VPS → Browser terminal)."; fi
    exit 0
  fi
  sleep "$POLL"
done
echo "Not answering yet. The VPS keeps installing on its own; check /post_install.log on the server (hPanel → VPS → Browser terminal) and the DNS records for $DOMAIN and *.$DOMAIN."
exit 1
