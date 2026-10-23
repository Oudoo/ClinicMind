# Platform console (system owner)

The platform console is where the company that runs ClinicMind creates and
manages its clients. Each client is a **tenant**: an isolated clinic group with
its own staff accounts, data, branding, domain and embed credentials. The
console lives inside the application at `/platform` and is reachable only by
platform administrators.

## Who can do what

| Person | Role | Scope |
|---|---|---|
| Platform administrator (you) | `SUPER_ADMIN`, lives in the dedicated `platform` tenant | Every tenant: create, suspend, brand, domain, embedding, owner invitations. Everything a clinic owner can do as well. |
| Clinic owner (your client) | `CLINIC_OWNER` in their tenant | Their tenant only: invite and manage staff, branding, embed secret, clinical work. Cannot see other tenants or the console. |
| Clinic staff | `DOCTOR`, `NURSE`, `RECEPTIONIST`, `ASSISTANT` | Clinical and front-desk work inside their tenant. |

Platform administrators never belong to a client tenant. They sign in at the
normal `/login` page and land on `/platform`; the "Platform" entry also appears
at the top of their navigation.

## Getting a platform administrator

- **Demo clinic:** the seed creates `platform@demo.clinic` (same password as the
  other demo accounts).
- **Production:** run the bootstrap once per administrator. It creates the
  `platform` tenant when missing and prints a single-use invitation link
  (valid 7 days) to choose a password:

  ```bash
  npm run platform:bootstrap -- --email admin@example.com --name "Full Name" --platform-name "GrowCDX Platform"
  ```

  Re-running it for an active administrator does nothing except promote the
  role if needed; password resets go through `/forgot-password`.

## Creating a client

1. Open `/platform` and click **New tenant**.
2. Fill in the clinic name (the slug is derived, editable), the owner's e-mail
   and name, the white-label settings (product name, accent colour, logo URL),
   the clinic's time zone, and optionally the custom domain and the website
   origins allowed to embed ClinicMind.
3. **Hand over what the dialog shows once:**
   - the sign-in address (`https://<slug>.<root domain>/login`, or the custom
     domain once verified);
   - the owner's invitation link (also e-mailed when `SMTP_URL` is set);
   - the embed secret, which is stored hashed and never shown again. The client's
     web developer keeps it server-side to mint embed tokens
     (see [`INTEGRATION.md`](INTEGRATION.md)).

The owner opens the link, chooses a password and from then on runs the tenant:
*Settings → Team* to invite doctors, nurses and reception; *Settings →
Branding* to adjust the look; *Settings → Embed* to rotate the secret.

## Managing a client

The tenant page (`/platform/tenants/<id>`) shows usage (staff, patients,
appointments, signed visits), the staff list, and these controls:

| Control | Effect |
|---|---|
| **Suspend / Activate** | Suspension ends every session of the tenant immediately, refuses sign-in and embed tokens, and keeps all data. Activation restores access. Both are audited. |
| **White-label** | Product name shown in the app header and on the sign-in page, accent colour (applied to buttons, links and highlights), logo URL. The clinic owner can change the same settings from their Settings page. |
| **Domain & embedding** | Custom domain and its verified flag, the embedding switch, and the exact origins allowed to frame the embed surface and request tokens. |
| **Owner invitation** | Invite a (second) clinic owner, or re-send the invitation of one who has not set a password yet. |

**Custom domains.** The tenant's subdomain always works. For a custom domain,
the client points a CNAME at the platform host; the platform must terminate
TLS for that hostname (Caddy on-demand TLS or a certificate per domain, see
[`RUNBOOK.md`](RUNBOOK.md)); then the administrator ticks *verified*. Changing
the domain resets the flag.

## API

All platform endpoints require a signed-in `SUPER_ADMIN` session
(`platform:manage`); mutations are same-origin only. Every change writes an
audit row in the affected tenant (`tenant.provision`, `tenant.update`,
`tenant.status`, `tenant.owner.invite`, `tenant.owner.reinvite`,
`tenant.branding`).

| Method and path | Purpose |
|---|---|
| `GET /api/tenants` | List client tenants with owner, status, counts and embed summary. |
| `POST /api/tenants` | Provision: `slug`, `name`, `ownerEmail`, `ownerFullName?`, `timezone?`, `branding?`, `customDomain?`, `allowedOrigins?`. Returns the owner invitation and the embed secret once. |
| `GET /api/tenants/{id}` | Tenant detail: clinics, users, counts, embed settings. |
| `PATCH /api/tenants/{id}` | `name`, `status` (`ACTIVE` or `SUSPENDED`), `branding`, `customDomain`, `customDomainVerified`, `allowedOrigins`, `embedEnabled`. |
| `POST /api/tenants/{id}/owner` | Invite or re-invite a clinic owner: `email`, `fullName?`. |
| `PATCH /api/tenant/branding` | A clinic owner (`tenant:manage`) updates their own tenant's branding. |

Branding fields are merged: a request names only the keys it changes, and an
empty string clears a key. Slugs that would collide with platform hostnames
(`platform`, `www`, `api`, `app`, `admin`, …) are refused.

## The growcdx.com developer page

The goal is one place on growcdx.com to manage every product and every client.
The practical path:

1. **Now.** The developer page links to each product's own console with the
   administrator's own sign-in: ClinicMind at `https://<clinicmind host>/platform`.
   Nothing to build in the website beyond the links.
2. **Next.** A machine credential for the platform API (a platform API key or an
   OAuth client for growcdx.com), so the developer page can list and create
   clients across products without a browser session. ClinicMind needs three
   additions for that: API-key authentication on the `/api/tenants*` routes,
   a CORS allow-list entry for the growcdx.com origin, and webhooks for tenant
   events (`tenant.created`, `tenant.suspended`) so the page stays current.
3. **Later.** Single sign-on from a growcdx.com account into every product's
   console, and a small cross-product registry on the website (product, client,
   owner, status, plan) fed by those webhooks.

The same shape applies to every product under growcdx.com: each product owns
its tenants and exposes the same four operations (list, create, update,
invite owner), and the website composes them.

## Omni Grow, the all-in-one inbox: integrate, do not merge

Omni Grow stays its own product and its own deployment. ClinicMind integrates
with it over the contract in [`SPEC_ANALYSIS.md`](SPEC_ANALYSIS.md#5-the-all-in-one-inbox-integration-plan):
Omni Grow owns the channels (WhatsApp, Instagram, website chat, voice
transcripts), the unified thread, assignment and the inbox UI; ClinicMind owns
the patient record, scheduling, clinical data, retrieval and the tools the
front-desk AI calls. The two talk through signed webhooks and per-tenant API
keys.

Reasons:

- Omni Grow is used on its own for other clients; merging it into ClinicMind
  would tie its releases, scaling and incidents to a clinical product.
- Clinical data stays inside ClinicMind's security boundary; the inbox holds
  conversations and receives only the patient fields the contract allows.
- Each product keeps one codebase and one team, and the growcdx.com developer
  page manages both the same way.

What this means in practice: a ClinicMind tenant gets an "Omni Grow connection"
(endpoint, API key, webhook secret) in its settings; Omni Grow gets a
"ClinicMind connection" per workspace. If a clinic wants the inbox inside the
ClinicMind screen, it can be framed with the same embed-token pattern
ClinicMind already uses for its own surface, without moving any code.

## AI providers per tenant

Each client can run on the AI vendor it prefers. On the tenant page the **AI
providers** card sets which provider answers chat, extraction and the
assistant (Gemini, OpenAI/ChatGPT or Anthropic/Claude), which one transcribes
dictation (Gemini or OpenAI; Claude takes no audio), optional model overrides,
and the client's own API keys. Anything left on *inherit* uses the
environment's configuration.

API: `PATCH /api/tenants/[id]` with

```json
{ "ai": { "chatProvider": "openai", "transcriptionProvider": "gemini",
          "models": { "openaiChat": "gpt-4.1" },
          "keys": { "openai": "sk-…" } } }
```

`inherit` or an empty string clears a field; an omitted field keeps its value.
Keys are stored under `Tenant.settings.ai` encrypted with AES-256-GCM
(`DATA_ENCRYPTION_KEY`, else a key derived from `AUTH_SECRET`), never returned
by any endpoint (`GET /api/tenants/[id]` reports `set` and the last four
characters), and used only for that tenant's calls. The audit log records the
public shape of the change, never a key. Embeddings are not per tenant: the
vector store has one dimension and one model.

