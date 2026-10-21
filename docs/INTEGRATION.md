# ClinicMind — Integration Guide

ClinicMind mounts into the **GROW Engine** admin dashboard as a tab, and embeds on
any client's **own website/domain**. Every client gets an isolated, white-labeled
instance. This guide covers both.

Two credentials are involved — keep them apart:

| Credential | Who holds it | Where it lives | Purpose |
|---|---|---|---|
| **Embed secret** (`cmembed_…`) | the client's backend | server-side secret store | proves to `POST /api/embed/token` that the caller may mint sessions for that tenant |
| **Embed token** (JWT, ≤ 1 h) | the browser, briefly | httpOnly cookie inside the iframe | identifies one staff member's session: tenant, user, capped role, framing origin |

The embed secret is never sent to a browser, never placed in a `data-*`
attribute, and never shown by ClinicMind again after the moment it is generated
(only its SHA-256 hash is stored).

---

## A. Provision a client (tenant)

`POST /api/tenants` requires the `platform:manage` permission, which only
`SUPER_ADMIN` holds. A clinic owner's `tenant:manage` covers their **own**
tenant's settings, never the platform.

```json
{
  "slug": "acme",
  "name": "Acme Family Clinic",
  "ownerEmail": "owner@acme.clinic",
  "branding": { "accent": "#0EA5E9", "productName": "Acme Care AI" },
  "customDomain": "care.acme.com"
}
```

Response `201`:

```json
{
  "tenant": { "id": "…", "slug": "acme" },
  "owner": { "id": "…", "email": "owner@acme.clinic" },
  "inviteUrl": "https://app.clinicmind.example/invite/…",
  "inviteExpiresAt": "…",
  "embedSecret": "cmembed_…"
}
```

This creates the tenant, its embed config, a default clinic and the owner user
(`INVITED`). The owner is e-mailed a single-use invitation link to choose a
password, and the link is also returned in the response (`inviteUrl`, valid 7
days) so you can hand it over directly. Once the owner has signed in at `/login`
they invite the rest of the staff from *Settings → Team*.

`embedSecret` is returned **once**: hand it to the client's backend. If it is
lost, rotate it (section E) — the old one stops working immediately.

Before tokens can be minted, add the exact origins that will frame the tool to
the tenant's `embed.allowedOrigins` (e.g. `https://care.acme.com`). An empty
list refuses every token request.

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

Add the GROW Engine origin to the tenant's `embed.allowedOrigins` and pass it as
`origin` when minting.

---

## C. Embed on the client's own website

Drop the loader on any page — it injects the iframe and handles the token relay
and auto-resize. This is the same snippet the dashboard shows under
**Settings → Embed on your website**:

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

`data-clinicmind-token-endpoint` points at **the client's own backend** route.
`embed.js` POSTs `{ "tenant": "acme" }` to it with the visitor's cookies; the
route must authenticate the staff member, perform step D, and answer
`{ "token": "<jwt>" }`. The embed secret never reaches the browser.

---

## D. Mint a session token (server-to-server)

The host backend exchanges the embed secret for a short-lived session token:

```http
POST https://app.clinicmind.example/api/embed/token
x-clinicmind-embed-secret: cmembed_…        # server-side only
Content-Type: application/json

{
  "tenantSlug": "acme",
  "userId": "<the staff member's ClinicMind user id>",
  "origin": "https://care.acme.com",
  "role": "DOCTOR",
  "ttlSeconds": 600
}
```

→ `{ "token": "<jwt>", "expiresIn": 600, "role": "DOCTOR" }`

Checks performed, in order:

1. The tenant is `ACTIVE`, embedding is enabled, and the secret matches the
   stored hash (constant-time comparison).
2. `origin` is required and must exactly match an entry of `allowedOrigins`
   (scheme + host + port).
3. `userId` must be an **active** user of that tenant — a session always acts as
   a real ClinicMind user.
4. `role` is optional. When given it must be a tenant role (`CLINIC_OWNER`,
   `DOCTOR`, `NURSE`, `RECEPTIONIST`, `ASSISTANT`) that grants no more than the
   user's stored role; omit it to use the stored role. `SUPER_ADMIN` can never be
   minted through this endpoint, whatever the secret.

| Status | `error` | Meaning |
|---|---|---|
| 401 | `missing_embed_secret` | no `x-clinicmind-embed-secret` header |
| 403 | `invalid_tenant_or_secret` | unknown/inactive tenant, embedding off, or wrong secret |
| 403 | `origin_not_allowed` | `origin` is not on the allow-list |
| 403 | `user_not_in_tenant` | `userId` is not an active user of this tenant |
| 403 | `role_not_permitted` | requested role exceeds the user's own role |
| 422 | `validation_error` | malformed body (e.g. `role: "SUPER_ADMIN"`, missing `origin`) |

The token is HS256-signed with `EMBED_SIGNING_SECRET` and expires in ≤ 1 hour.
When ClinicMind resolves a session from it, it re-checks that the user is still
active in that tenant and that the token's role is within their stored role;
otherwise the session is refused.

---

## E. Rotate the embed secret

**Settings → Embed on your website → Rotate secret** (requires `embed:manage`:
`CLINIC_OWNER` or `SUPER_ADMIN`), or from an authenticated dashboard session:

```http
POST /api/embed/secret
```

→ `{ "secret": "cmembed_…", "prefix": "cmembed_ab12cd", "rotatedAt": "…" }`

The new secret is shown once. The previous secret is invalid immediately; tokens
already minted stay valid until they expire. The dashboard only ever displays
the prefix of the live secret.

---

## F. Custom domains

Set `Tenant.customDomain` and point a CNAME at the platform. After DNS + TLS,
mark `customDomainVerified = true`; `lib/tenant.ts` then serves that tenant on the
domain. Branding makes it indistinguishable from the client's own product.

---

## Security checklist for integrators

- Keep the embed **secret** server-side; never ship it to the browser — not in
  `embed.js` attributes, not in client-side JavaScript.
- Restrict `embed.allowedOrigins` to the exact origins you trust to frame the
  tool, and pass the real framing origin when minting.
- Mint tokens **per logged-in staff member** with their ClinicMind user id.
  Request a narrower role when the host page needs less (e.g. `ASSISTANT` for
  read-only views); you cannot request a wider one.
- Tokens are short-lived; refresh on expiry rather than issuing long TTLs.
- Rotate the secret when staff with access to it leave, or on any suspected leak.
