# ClinicMind — Integration Guide

ClinicMind mounts into the **GROW Engine** admin dashboard as a tab, and embeds on
any client's **own website/domain**. Every client gets an isolated, white-labeled
instance. This guide covers both.

---

## A. Provision a client (tenant)

`POST /api/tenants` (SUPER_ADMIN):

```json
{
  "slug": "acme",
  "name": "Acme Family Clinic",
  "ownerEmail": "owner@acme.clinic",
  "branding": { "accent": "#0EA5E9", "productName": "Acme Care AI" },
  "customDomain": "care.acme.com"
}
```

This creates the tenant, its embed config (with a `publicKey`), a default clinic,
and the owner user. The instance is immediately reachable at
`https://acme.<ROOT_DOMAIN>` and embeddable.

---

## B. Embed inside the GROW Engine dashboard (a tab)

The GROW Engine renders ClinicMind as a tab by framing the embed surface:

```html
<iframe
  src="https://app.clinicmind.example/embed/acme"
  allow="microphone; clipboard-write"
  style="width:100%;height:100%;border:0"
></iframe>
```

On load the iframe requests a session token via `postMessage`
(`{ type: "clinicmind:request-token" }`). The GROW Engine backend mints one (step
D) and posts it back (`{ type: "clinicmind:token", token }`). ClinicMind exchanges
it for an httpOnly cookie and renders the tenant-scoped surface.

Add the GROW Engine origin to the tenant's `embed.allowedOrigins`.

---

## C. Embed on the client's own website

Drop the loader on any page — it injects the iframe and handles the token relay
and auto-resize:

```html
<div id="clinicmind-root" style="height:800px"></div>
<script
  src="https://app.clinicmind.example/embed.js"
  data-clinicmind-tenant="acme"
  data-clinicmind-host="https://app.clinicmind.example"
  data-clinicmind-token-endpoint="/api/clinicmind/token"
  defer
></script>
```

`data-clinicmind-token-endpoint` points at **the client's own backend** route,
which performs step D. The ClinicMind embed key never reaches the browser.

---

## D. Mint a session token (server-to-server)

The host backend exchanges its secret embed key for a short-lived session token:

```http
POST https://app.clinicmind.example/api/embed/token
x-clinicmind-embed-key: <tenant.embed.publicKey>   # kept server-side only
Content-Type: application/json

{ "tenantSlug": "acme", "userId": "staff_123", "role": "DOCTOR", "origin": "https://care.acme.com" }
```

→ `{ "token": "<jwt>", "expiresIn": 600 }`

The token is HS256-signed with `EMBED_SIGNING_SECRET`, scoped to the tenant +
user + role, and expires in ≤ 1 hour. `origin` is validated against
`allowedOrigins`.

---

## E. Custom domains

Set `Tenant.customDomain` and point a CNAME at the platform. After DNS + TLS,
mark `customDomainVerified = true`; `lib/tenant.ts` then serves that tenant on the
domain. Branding makes it indistinguishable from the client's own product.

---

## Security checklist for integrators

- Keep the embed **public key** server-side; never ship it to the browser.
- Restrict `embed.allowedOrigins` to exact origins you trust to frame the tool.
- Mint tokens **per logged-in staff member** with their real role — RBAC is
  enforced from the token's role.
- Tokens are short-lived; refresh on expiry rather than issuing long TTLs.
```
