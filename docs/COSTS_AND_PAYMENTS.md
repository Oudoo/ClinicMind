# ClinicMind — Costs & Payments

**Short answer:** the software is 100% free and open-source. The *only* things
that ever cost money are (1) infrastructure you choose to host on, and (2)
third-party APIs you choose to switch on. ClinicMind can run **end-to-end at $0
of per-use fees** using the offline `echo` AI provider with channels disabled.

## What is always free

| Component | Notes |
|---|---|
| Next.js, React, TypeScript, Tailwind, Radix | MIT/OSS — free forever |
| Prisma ORM | Apache-2.0 — free |
| PostgreSQL + `pgvector` + `pg_trgm` | OSS — free (you only pay for the server it runs on) |
| Redis | OSS — free (only the server) |
| The entire ClinicMind codebase | Yours |
| The static demo on **GitHub Pages** | Free for public repos |

## What can cost money (all optional / swappable)

| Service | Powers | Pricing shape | How to avoid cost |
|---|---|---|---|
| **Hostinger Next.js plan** | Production hosting | Your existing plan | Already chosen |
| **Managed Postgres** (with pgvector) | Production database | Monthly, by size | Self-host Postgres on a VPS/the same box |
| **Managed Redis** | Background job queues | Monthly | Self-host Redis; or defer queues until you need WhatsApp/voice |
| **S3-compatible storage** | Audio, documents, images | Per-GB + requests | Use cheap providers (Cloudflare R2 has no egress fees); or local disk early on |
| **OpenAI / Anthropic API** | Live AI answers, summaries | Pay-per-token | Use **Gemini free tier**, or the `echo` provider ($0) |
| **Google Gemini API** | Live AI (now supported) | **Has a free tier**; paid above quota | Stay within free tier; or `echo` |
| **WhatsApp Cloud API** | AI receptionist messaging | Per-conversation (Meta) | Off by default — only if you enable WhatsApp |
| **Voice / telephony** (e.g. Twilio) | AI call agent | Per-minute | Off by default — only if you enable voice |
| **Custom domains / TLS** | White-label client domains | Domain registrar fee | Use subdomains of your own domain (free) |

## Recommended "no surprise bills" setup

1. **AI:** start with `AI_DEFAULT_PROVIDER=gemini` on the **free tier** (or `echo`
   for true $0). Only move to OpenAI/Anthropic when a client pays for premium AI.
2. **DB/Redis/Storage:** co-locate Postgres + Redis on your Hostinger box or a
   single small VPS instead of managed services; use Cloudflare R2 for files.
3. **Channels off** until a client specifically buys WhatsApp/voice; those are
   the only genuinely per-use external costs and they're feature-flagged per tenant.

## Why the AI cost is fully under your control

The AI layer is a **provider abstraction**. The app calls one interface; the
adapter behind it is chosen by config:

- `echo` — deterministic, offline, **$0**, still enforces the retrieval guardrail.
- `gemini` — Google, **free tier available**.
- `openai` / `anthropic` — pay-per-token, opt-in.

You can run the whole product, demo it, and onboard early clients without paying
a cent for AI, then turn on paid models per tenant when it's economically worth it.
