# ClinicMind — SaaS / Subscription Model Blueprint

> "Can I make this a SaaS that clients pay for monthly/annually? How, and what
> does it need?"

**Yes — and you're most of the way there.** ClinicMind is already **multi-tenant**
(each client = one isolated `Tenant`), which is the hard part of SaaS. Charging
subscriptions is a **billing layer** added on top. This document is the complete
"what you need to know" — not an implementation.

---

## 1. The model in one picture

```
Client signs up  ─▶  Tenant created (PROVISIONING)
                         │
                    Stripe Checkout (pick plan: monthly / annual)
                         │
                  Stripe subscription = active
                         │
            Webhook ─▶ Tenant.status = ACTIVE + plan entitlements
                         │
        ┌────────────────┼─────────────────────────────┐
   Renews monthly   Payment fails ─▶ SUSPENDED     Cancels ─▶ ARCHIVED
```

One **Tenant** maps to one **subscription**. The plan controls feature flags and
usage limits (already represented in `Tenant.settings`).

---

## 2. What you need (the checklist)

### a. A billing provider — pick one
| Option | Best when | Trade-off |
|---|---|---|
| **Stripe Billing** | You want maximum control, lowest fees | You are the merchant of record → you handle VAT/tax registration |
| **Paddle / Lemon Squeezy** | You want them to handle global tax/VAT as merchant-of-record | Slightly higher fees, less control |

Recommendation for a solo/small team selling across countries: **Paddle** (no tax
headaches). For maximum control/margins: **Stripe**.

> **Cost:** no fixed monthly fee to adopt. Stripe ≈ 2.9% + small fixed fee per
> charge; Paddle ≈ 5% + fee. You only pay when you get paid.

### b. Plans & pricing (define 2–4 tiers)
Example:
| Plan | Monthly | Annual | Limits |
|---|---|---|---|
| Starter | $X | 2 months free | 1 clinic, 2 staff, echo/Gemini AI, no voice |
| Pro | $Y | 2 months free | 3 clinics, 15 staff, premium AI, WhatsApp |
| Clinic+ | $Z | 2 months free | Unlimited staff, voice agent, custom domain, SLA |

Map each plan to feature flags you already have hooks for (channels, AI provider,
custom domain, seat limits).

### c. Data you must add (small)
- `Subscription` record per tenant: provider IDs, plan, status, current period end.
- `plan` + `entitlements` on the tenant (extend `Tenant.settings`).
- (Optional) usage counters for metered add-ons — **already captured**: `AiRun`
  rows = AI usage, `Conversation`/`Message` = messaging volume.

### d. Flows to build
1. **Checkout:** "Subscribe" → Stripe/Paddle Checkout → success → activate tenant.
2. **Webhooks:** listen for `subscription.created/updated/deleted`,
   `invoice.paid`, `invoice.payment_failed` → update tenant status & entitlements.
3. **Customer portal:** let clients change plan / card / cancel (Stripe & Paddle
   both provide a hosted portal — minimal code).
4. **Entitlement enforcement:** a `requirePlan()` / `withinLimit()` guard alongside
   the existing `assertCan()` RBAC check, gating premium features and seat counts.
5. **Dunning:** on `payment_failed`, suspend after a grace period
   (`Tenant.status = SUSPENDED`); restore on recovery.

### e. Legal / operational (don't skip for healthcare)
- **Terms of Service + Privacy Policy + DPA** (data processing agreement) — clinics
  will ask, especially with patient data.
- **Tax/VAT:** handled for you with Paddle/Lemon Squeezy; your responsibility with
  Stripe.
- **Healthcare compliance:** depending on country/region (e.g. HIPAA-equivalent),
  ensure BAAs with subprocessors (your DB host, AI provider). ClinicMind's audit
  log, RLS, soft delete and RBAC are built to support these requirements.

---

## 3. Pricing strategy notes
- **AI cost pass-through:** premium AI (OpenAI/Anthropic) is pay-per-token. Either
  bundle a usage cap per plan, or charge AI as a metered add-on using the `AiRun`
  logs. Free Gemini tier / `echo` keeps your COGS near zero on lower plans.
- **Annual = cash up front + lower churn:** offer "2 months free" annually.
- **Per-clinic or per-seat** are the two natural axes; the schema supports both
  (clinics and users are already per-tenant).

---

## 4. Effort estimate
Because multi-tenancy, provisioning, feature flags, and usage logging already
exist, adding subscriptions is a **focused, well-scoped slice**:
- Billing provider integration + webhooks
- `Subscription` model + entitlement guard
- Checkout + customer portal wiring
- Plan→feature mapping + dunning/suspension

This is the natural **next milestone after the demo is approved and the
production deployment is live.** Nothing in the current architecture needs to
change to support it — it's additive.
