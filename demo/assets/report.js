/* Interactive production report rendered inside the demo's "Report" tab. */
window.CM_REPORT = function () {
  const acc = (title, badge, body, open) => `
    <div class="acc accordion${open ? " open" : ""}">
      <div class="acc-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="t">${title} ${badge ? `<span class="badge ${badge.tone}">${badge.text}</span>` : ""}</span>
        <span class="chev">▶</span>
      </div>
      <div class="acc-body">${body}</div>
    </div>`;

  const node = (t) => `<span class="node">${t}</span>`;
  const arrow = '<span class="arrow">→</span>';

  return `
  <div class="report stack">
    <div>
      <h2>ClinicMind — Production Architecture &amp; Security Report</h2>
      <p class="lead">AI-first, multi-tenant Medical OS. This report documents the production-ready design behind the demo you are viewing.</p>
    </div>

    <div class="bento">
      <div class="card tight"><div class="data-label">Architecture</div><div class="metric" style="font-size:22px">Modular monolith</div><div style="color:var(--muted);font-size:12px">Next.js + Postgres</div></div>
      <div class="card tight"><div class="data-label">Isolation</div><div class="metric" style="font-size:22px">Per-tenant</div><div style="color:var(--muted);font-size:12px">Domain + RLS</div></div>
      <div class="card tight"><div class="data-label">AI</div><div class="metric" style="font-size:22px">4 providers</div><div style="color:var(--muted);font-size:12px">OpenAI · Claude · Gemini · echo</div></div>
      <div class="card tight"><div class="data-label">Compliance posture</div><div class="metric" style="font-size:22px">Audit + RBAC</div><div style="color:var(--muted);font-size:12px">Append-only</div></div>
    </div>

    ${acc("System architecture", { tone: "accent", text: "modular monolith" }, `
      <p style="color:var(--muted)">A single Next.js 14 deployment with clear domain seams, ready to split into services as scale demands. Each domain is independently extensible.</p>
      <div class="grid-3">
        <div class="layer"><div class="lh">Presentation</div>App Router · React Server Components · Tailwind · Radix · institutional-tech design system</div>
        <div class="layer"><div class="lh">Application</div>API routes · server actions · RBAC guard · Zod validation · audit middleware</div>
        <div class="layer"><div class="lh">Domain</div>patients · appointments · consultations · conversations · analytics · ai · billing · embed</div>
      </div>
      <div style="margin-top:12px" class="kv">
        <div class="k">Frontend</div><div>Next.js (App Router, RSC, Server Actions), TypeScript, Tailwind, Radix, React Hook Form, Zod</div>
        <div class="k">Data</div><div>PostgreSQL + pgvector via Prisma — soft delete, full-text/trigram search, append-only audit</div>
        <div class="k">AI service</div><div>Provider-agnostic adapter layer (synchronous) + Redis-queued background jobs for heavy work</div>
        <div class="k">Storage</div><div>S3-compatible object storage (audio, documents, medical images)</div>
      </div>`, true)}

    ${acc("Multi-tenancy &amp; white-labeling", { tone: "accent", text: "isolated per client" }, `
      <p style="color:var(--muted)">Every client gets a fully isolated, white-labeled instance — on a subdomain, their own custom domain, or embedded in a host dashboard.</p>
      <div class="flow">${node("Custom domain")}${arrow}${node("Subdomain")}${arrow}${node("Embed token")}${arrow}${node("Tenant context")}${arrow}${node("Row-scoped data + RLS")}</div>
      <ul class="tight">
        <li><b>Resolution:</b> request → tenant via custom domain → subdomain → signed embed token.</li>
        <li><b>Isolation:</b> every row carries <span class="mono">tenantId</span>; queries filter by it; Postgres <b>Row-Level Security</b> is the database-enforced backstop.</li>
        <li><b>Branding:</b> per-tenant accent, logo and product name applied via runtime CSS variables — no rebuild per client.</li>
        <li><b>Provisioning:</b> one API call creates the tenant, embed config, default clinic and owner.</li>
      </ul>`)}

    ${acc("AI &amp; RAG pipeline", { tone: "accent", text: "grounded, cited" }, `
      <p style="color:var(--muted)">The assistant never answers without retrieval. Every answer is grounded in the tenant's own records and returns citations.</p>
      <div class="flow">${node("Embed query")}${arrow}${node("pgvector retrieve")}${arrow}${node("Rank")}${arrow}${node("Re-rank")}${arrow}${node("Generate + cite")}</div>
      <div class="note" style="margin-top:12px"><b>Provider abstraction:</b> OpenAI (GPT-4o), Anthropic (Claude), Google (Gemini) and an offline deterministic <span class="mono">echo</span> fallback all implement one interface. Switching providers is config, not code. Every AI call is recorded immutably (prompt, context, output, confidence, latency).</div>
      <ul class="tight">
        <li><b>Consultation intelligence:</b> audio → transcript → structured extraction → <b>clinician review → sign</b>. Clinical decisions are never auto-saved.</li>
        <li><b>Extraction:</b> transcript → strict JSON (symptoms, diagnoses, medications, tests, follow-ups), stored separately from free text.</li>
      </ul>`)}

    ${acc("Security measures", { tone: "success", text: "defense in depth" }, `
      <div class="grid-2">
        <div class="layer"><div class="lh">Access control</div>RBAC across 6 roles, enforced at every API edge. Clinical sign-off gated to clinicians only.</div>
        <div class="layer"><div class="lh">Tenant isolation</div>Query-level scoping + Postgres Row-Level Security policies as the database backstop.</div>
        <div class="layer"><div class="lh">Audit</div>Append-only audit log (actor, time, device, IP, before/after); UPDATE/DELETE blocked at DB.</div>
        <div class="lh"></div>
        <div class="layer"><div class="lh">Sessions</div>Short-lived signed embed tokens (JWT/HS256), httpOnly cookies, device + login history.</div>
        <div class="layer"><div class="lh">Input &amp; transport</div>Zod validation on all input, TLS in transit, encryption at rest, strict per-route framing/CSP.</div>
        <div class="layer"><div class="lh">Uploads</div>Secure file uploads with malware-scan + safe flags before clinical exposure.</div>
        <div class="layer"><div class="lh">Data lifecycle</div>Soft delete (no hard loss), history never overwritten, MFA-ready auth model.</div>
      </div>`)}

    ${acc("Data model highlights", null, `
      <ul class="tight">
        <li><b>Append-only history:</b> AiRun, Visit, Consultation, TimelineEvent never overwritten; diagnoses/medications appended on sign.</li>
        <li><b>Unified timeline:</b> appointments, calls, messages, diagnoses, prescriptions, audio, documents and AI notes in one chronological feed.</li>
        <li><b>RAG store:</b> pgvector embeddings with an ivfflat cosine index, tenant-scoped.</li>
        <li><b>Search:</b> trigram (pg_trgm) indexes for fast fuzzy patient lookup.</li>
      </ul>`)}

    ${acc("Performance targets", null, `
      <div class="kv">
        <div class="k">Dashboard load</div><div>&lt; 2s (RSC + indexed aggregates)</div>
        <div class="k">Search</div><div>&lt; 1s (trigram indexes)</div>
        <div class="k">Chat response</div><div>&lt; 5s (top-k retrieval + streaming-ready)</div>
        <div class="k">Summary generation</div><div>&lt; 15s</div>
        <div class="k">Voice transcription</div><div>near real-time (Whisper-class via adapter)</div>
      </div>`)}

    ${acc("Deployment (Hostinger Next.js plan)", { tone: "accent", text: "production" }, `
      <ul class="tight">
        <li>Next.js app runs as a Node process on the Hostinger Next.js hosting plan (<span class="mono">npm run build</span> → <span class="mono">npm run start</span>).</li>
        <li><b>External services:</b> a managed PostgreSQL with the <span class="mono">pgvector</span> extension, a Redis instance for queues, and S3-compatible object storage. Hostinger app hosting does not bundle Postgres+pgvector/Redis/S3, so these are provisioned alongside (managed DB + storage).</li>
        <li>Health checks at <span class="mono">/api/health</span>; CI builds, typechecks, tests and runs migrations.</li>
        <li>Docker + Compose provided for portability and parity if you later move to a VPS.</li>
      </ul>
      <div class="note" style="margin-top:10px">The static demo you are viewing runs with zero backend on GitHub Pages — it is the pitch/sales build and is independent of the production deployment.</div>`)}

    ${acc("Cost &amp; payments — what could incur fees", { tone: "warning", text: "read this" }, `
      <p style="color:var(--muted)">The application code and frameworks are free and open-source. Costs come only from infrastructure and third-party APIs you choose to switch on.</p>
      <table>
        <thead><tr><th>Service</th><th>Needed for</th><th>Cost</th><th>Free / avoidable?</th></tr></thead>
        <tbody>
          <tr><td>Next.js, Prisma, Postgres, pgvector, Redis, Tailwind, Radix</td><td>The whole app</td><td><span class="badge success">Free</span></td><td>Open-source, always free</td></tr>
          <tr><td>Hostinger Next.js plan</td><td>Hosting production</td><td>Paid (your plan)</td><td>Already chosen</td></tr>
          <tr><td>Managed Postgres + Redis + S3 storage</td><td>Production data/queues/files</td><td>Paid if managed</td><td>Self-host on a VPS to avoid extra fees</td></tr>
          <tr><td>OpenAI / Anthropic / <b>Gemini</b> API</td><td>Live AI answers, summaries</td><td>Pay-per-token</td><td><b>Gemini has a free tier</b>; or run the offline <span class="mono">echo</span> provider at $0</td></tr>
          <tr><td>WhatsApp Cloud API</td><td>AI receptionist messaging</td><td>Per-conversation</td><td>Optional — off by default</td></tr>
          <tr><td>Voice (telephony) provider</td><td>AI call agent</td><td>Per-minute</td><td>Optional — off by default</td></tr>
          <tr><td>GitHub Pages (this demo)</td><td>Hosting the demo</td><td><span class="badge success">Free</span></td><td>Free for public repos</td></tr>
        </tbody>
      </table>
      <div class="note" style="margin-top:10px"><b>Zero-cost mode:</b> the app runs end-to-end with the <span class="mono">echo</span> AI provider and channels disabled — no per-use API fees at all. Turn on Gemini's free tier when you want real AI without committing to paid usage.</div>`)}

    ${acc("SaaS readiness — subscriptions", { tone: "accent", text: "supported" }, `
      <p style="color:var(--muted)">The multi-tenant foundation is exactly what a subscription SaaS needs. To charge clients monthly/annually you add a billing layer:</p>
      <div class="flow">${node("Stripe Billing")}${arrow}${node("Plans &amp; prices")}${arrow}${node("Subscription per tenant")}${arrow}${node("Webhooks → entitlements")}${arrow}${node("Feature gating")}</div>
      <ul class="tight">
        <li><b>Provider:</b> Stripe Billing (or Paddle as merchant-of-record for global tax/VAT handling).</li>
        <li><b>Model:</b> each Tenant = one subscription. Plans (Starter/Pro/Clinic) map to feature flags &amp; usage limits already in the tenant settings.</li>
        <li><b>Metering:</b> AI usage and message volume are already logged (AiRun, conversations) — usable for usage-based add-ons.</li>
        <li><b>Lifecycle:</b> Stripe webhooks drive provisioning, suspension on non-payment (Tenant.status), and cancellation.</li>
      </ul>
      <div class="note" style="margin-top:10px">Stripe charges ~2.9% + fixed fee per transaction; there is no fixed monthly cost to adopt it. See <span class="mono">docs/SAAS_MODEL.md</span> for the full blueprint.</div>`)}
  </div>`;
};
