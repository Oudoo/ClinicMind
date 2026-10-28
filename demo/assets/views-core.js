/* Views: landing, sign-in, invitation, overview, patients. */
(function () {
  const C = window.CM;
  const { esc, icon, badge, card, sectionTitle, metric, emptyState, field, alert, avatar, fmtDate, fmtTime, age, n } = C;

  // ── Landing ─────────────────────────────────────────────────────────────
  C.views.landing = () => `
    <div class="min-h-screen bg-background">
      <header class="mx-auto flex max-w-6xl items-center justify-between px-6 py-5"><a href="#/" class="flex items-center gap-2"><img src="assets/logo.svg" alt="" class="h-8 w-8 rounded-md"><span class="font-display text-lg font-semibold tracking-tight">ClinicMind</span></a><a href="#/login" class="btn btn-outline btn-sm">Sign in ${icon("arrow-right")}</a></header>
      <main class="mx-auto max-w-6xl px-6 pb-16">
        <section class="mesh relative overflow-hidden rounded-lg border border-border px-6 py-16 text-center sm:py-24">
          <span class="badge badge-accent">clinic operating system · ai-first</span>
          <h1 class="mx-auto mt-6 max-w-3xl font-display text-4xl font-semibold tracking-tightest sm:text-5xl">One record of truth for the clinic, with AI that only speaks from it.</h1>
          <p class="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">Patients, appointments and consultations in one place. Every AI answer is grounded in your own records and cited; every clinical decision is reviewed and signed by a clinician.</p>
          <a href="#/login" class="btn btn-primary mt-8">Sign in to your clinic ${icon("arrow-right")}</a>
          <p class="mt-6 font-mono text-xs text-muted-foreground">Click-through prototype · data lives in your browser · password Demo-Clinic-2026!</p>
        </section>
        <section class="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          ${[["users", "Patients and timeline", "A complete patient record: history, allergies, medications, visits and every interaction on one chronological timeline."], ["calendar", "Scheduling that holds", "Booking with conflict detection, waitlists and a full lifecycle from confirmation to check-in, completion or no-show."], ["stethoscope", "Consultation intelligence", "Transcripts become structured notes. The clinician edits, reconciles medications and signs; nothing is saved by the AI alone."], ["sparkles", "Grounded assistant", "Ask about your patients in plain language and get answers with citations into the record, or a clear “no records found”."], ["shield", "Built for accountability", "Roles for every staff member, an append-only audit log enforced in the database, and review-before-sign everywhere."], ["building", "Isolated per clinic", "Each clinic runs its own white-labeled instance on its own domain, with data scoped and checked at every query."]].map(([i, t, d]) => `<div class="bento"><span class="flex h-10 w-10 items-center justify-center rounded-md bg-accent-muted text-accent">${icon(i, "h-5 w-5")}</span><h3 class="mt-4 font-display text-base font-semibold">${t}</h3><p class="mt-2 text-sm text-muted-foreground">${d}</p></div>`).join("")}
        </section>
        <footer class="mt-16 text-center font-mono text-xs text-muted-foreground">ClinicMind</footer>
      </main>
    </div>`;

  // ── Auth card ───────────────────────────────────────────────────────────
  function authCard({ title, description, body, footer, brand }) {
    const name = (brand && brand.name) || "ClinicMind";
    const logo = brand && brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(name)}" class="h-8 w-8 rounded-md object-contain">` : `<img src="assets/logo.svg" alt="${esc(name)}" class="h-8 w-8 rounded-md">`;
    return `<div class="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10"><a href="#/" class="mb-6 flex items-center gap-2">${logo}<span class="font-display text-lg font-semibold tracking-tight">${esc(name)}</span></a><div class="bento w-full max-w-md space-y-6"><div><h1 class="font-display text-xl font-semibold tracking-tight">${esc(title)}</h1>${description ? `<div class="mt-1 text-sm text-muted-foreground">${description}</div>` : ""}</div>${body}</div>${footer ? `<div class="mt-6 max-w-md text-center text-xs text-muted-foreground">${footer}</div>` : ""}</div>`;
  }

  C.views.login = (r) => {
    const t = r.query.tenant ? C.tenantBySlug(r.query.tenant) : null;
    const accounts = C.S.users.filter((u) => u.status === "ACTIVE" && !u.password).sort((a, b) => (a.demoOrder || 9) - (b.demoOrder || 9));
    const body = `
      <form data-form="login" class="space-y-4" novalidate>
        <input type="hidden" name="next" value="${esc(r.query.next || "")}">
        <div id="login-error"></div>
        ${field("E-mail", `<input id="email" name="email" type="email" class="input" autocomplete="username" required>`, null, "email")}
        ${field("Password", `<input id="password" name="password" type="password" class="input" autocomplete="current-password" required>`, null, "password")}
        <div id="tenant-field" class="${t ? "" : "hidden"}">${field("Clinic ID", `<input id="tenant" name="tenant" class="input font-mono" value="${esc(t ? t.slug : "")}">`, "The short name of your clinic in ClinicMind, e.g. the subdomain you normally use.", "tenant")}</div>
        <button type="submit" class="btn btn-primary w-full">${icon("logout")} Sign in</button>
        <p class="text-center text-sm"><a href="#/forgot-password" class="text-muted-foreground hover:text-foreground">Forgot your password?</a></p>
      </form>
      ${t ? "" : `<div class="rounded-lg border border-border bg-muted/40 p-3"><p class="data-label mb-2">Demo accounts · password Demo-Clinic-2026!</p><ul class="space-y-1">${accounts.map((u) => `<li class="flex items-center justify-between gap-2 text-xs"><span class="min-w-0 truncate"><span class="font-mono">${esc(u.email)}</span> <span class="text-muted-foreground">· ${esc(u.title || C.ROLE_LABEL[u.role])}</span></span><button type="button" class="btn btn-ghost btn-sm h-7 px-2 text-xs" data-action="use-account" data-email="${esc(u.email)}">Use</button></li>`).join("")}</ul></div>`}`;
    return authCard({ title: t ? `Sign in to ${t.name}` : "Sign in", description: "Use the e-mail address and password of your clinic account.", body, footer: "Access is restricted to invited staff. Contact your clinic administrator for an invitation.", brand: t ? { name: (t.branding && t.branding.productName) || t.name, logoUrl: t.branding && t.branding.logoUrl } : null });
  };
  C.actions["use-account"] = (el) => { document.querySelector("#email").value = el.dataset.email; document.querySelector("#password").value = C.S.password; document.querySelector("#password").focus(); };
  C.forms.login = (d) => {
    const res = C.login(d.email, d.password, d.tenant);
    const errBox = document.querySelector("#login-error");
    if (res.ok) { C.go(d.next || (res.user.role === "SUPER_ADMIN" ? "/platform" : res.user.profile === "clinic-ai" ? "/ai" : "/dashboard")); return; }
    if (res.reason === "locked") errBox.innerHTML = alert(`Too many failed attempts. This account is locked for ${res.retryAfter} more minute${res.retryAfter === 1 ? "" : "s"}.`);
    else if (res.reason === "ambiguous_tenant") { document.querySelector("#tenant-field").classList.remove("hidden"); errBox.innerHTML = alert("This e-mail exists in more than one clinic. Enter your clinic ID.", "info"); }
    else errBox.innerHTML = alert("The e-mail address or password is incorrect. Repeated failures lock the account for 15 minutes.");
  };

  C.views.forgot = () => authCard({
    title: "Forgot your password?", description: "Enter your e-mail address and we will send a single-use link, valid for one hour.",
    body: `<form data-form="forgot" class="space-y-4" novalidate><div id="forgot-result"></div>${field("E-mail", `<input id="email" name="email" type="email" class="input" required>`, null, "email")}<button type="submit" class="btn btn-primary w-full">${icon("mail")} Send reset link</button><p class="text-center text-sm"><a href="#/login" class="text-muted-foreground hover:text-foreground">Back to sign in</a></p></form>`,
  });
  C.forms.forgot = (d) => {
    const u = C.S.users.find((x) => x.email.toLowerCase() === (d.email || "").trim().toLowerCase());
    const box = document.querySelector("#forgot-result");
    let extra = "";
    if (u) { const token = C.newId("tok"); C.S.invites = C.S.invites || {}; C.S.invites[token] = { userId: u.id, kind: "reset", expiresAt: Date.now() + 3600e3 }; C.save(); extra = `<p class="mt-2 text-xs">Prototype shortcut (the link is e-mailed in production): <a class="font-mono text-accent underline" href="#/invite/${token}">open the reset link</a></p>`; }
    box.innerHTML = alert(`If an account exists for that address, a reset link has been sent. It expires in one hour.${extra}`, "success");
  };

  C.views.invite = (r) => {
    const token = r.parts[1];
    const inv = (C.S.invites || {})[token];
    const u = inv && C.user(inv.userId);
    if (!inv || !u || inv.expiresAt < Date.now()) return authCard({ title: "This link is not valid", description: "It may have expired or already been used. Ask your administrator for a new invitation.", body: `<a href="#/login" class="btn btn-outline w-full">Back to sign in</a>` });
    const t = C.tenantById(u.tenantId);
    return authCard({
      title: inv.kind === "reset" ? "Choose a new password" : `Welcome to ${t.name}`,
      descriptionHtml: `${inv.kind === "reset" ? "Set a new password for" : "Choose a password for"} <span class="font-mono">${esc(u.email)}</span>. At least 12 characters.`,
      body: `<form data-form="set-password" class="space-y-4" novalidate><input type="hidden" name="token" value="${esc(token)}"><div id="pw-error"></div>${field("Password", `<input id="password" name="password" type="password" class="input" autocomplete="new-password" required>`, null, "password")}${field("Confirm password", `<input id="confirm" name="confirm" type="password" class="input" autocomplete="new-password" required>`, null, "confirm")}<button type="submit" class="btn btn-primary w-full">${icon("check")} ${inv.kind === "reset" ? "Set password" : "Activate my account"}</button></form>`,
      brand: t && t.id !== "ten-platform" ? { name: (t.branding && t.branding.productName) || t.name, logoUrl: t.branding && t.branding.logoUrl } : null,
    });
  };
  C.forms["set-password"] = (d) => {
    const box = document.querySelector("#pw-error");
    if ((d.password || "").length < 12) { box.innerHTML = alert("Use at least 12 characters."); return; }
    if (d.password !== d.confirm) { box.innerHTML = alert("The two passwords do not match."); return; }
    const inv = C.S.invites[d.token]; const u = C.user(inv.userId);
    u.password = d.password; u.status = "ACTIVE"; delete C.S.invites[d.token]; C.save();
    C.logAudit(inv.kind === "reset" ? "auth.password.reset" : "user.invite.accept", "User", u.id);
    C.login(u.email, d.password, C.tenantById(u.tenantId).slug);
    C.toast({ title: inv.kind === "reset" ? "Password updated" : "Account activated", description: "You are signed in." });
    C.go(u.role === "SUPER_ADMIN" ? "/platform" : "/dashboard");
  };

  C.views.embed = (r) => {
    const t = C.tenantBySlug(r.parts[1]);
    return `<div class="flex min-h-screen items-center justify-center bg-background p-6"><div class="bento max-w-lg space-y-3"><h1 class="font-display text-lg font-semibold">${t ? esc((t.branding && t.branding.productName) || t.name) : "ClinicMind"} embed surface</h1><p class="text-sm text-muted-foreground">${t ? "This page is framed by the clinic's own website. The website's backend exchanges its embed secret for a short-lived token, and the surface loads for the signed-in staff member only." : "Unknown clinic."}</p><a href="#/" class="btn btn-outline btn-sm">Back</a></div></div>`;
  };
  C.views.notFound = () => `<div class="flex min-h-screen items-center justify-center p-6"><div class="bento text-center"><p class="font-display text-lg font-semibold">Page not found</p><a href="#/dashboard" class="btn btn-outline btn-sm mt-4">Go to the dashboard</a></div></div>`;

  // ── Overview ────────────────────────────────────────────────────────────
  function sparkline(days) {
    const w = 560, h = 170, pad = 10;
    const max = Math.max(1, ...days.map((d) => d.count));
    const stepX = (w - pad * 2) / Math.max(1, days.length - 1);
    const pts = days.map((d, i) => [pad + i * stepX, h - pad - (d.count / max) * (h - pad * 2 - 16)]);
    const line = pts.map((p, i) => `${i ? "L" : "M"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const area = `${line} L ${pts[pts.length - 1][0]} ${h - pad} L ${pts[0][0]} ${h - pad} Z`;
    return `<div class="mesh rounded-md p-1"><svg viewBox="0 0 ${w} ${h}" class="h-44 w-full" preserveAspectRatio="none" role="img" aria-label="Daily booked appointments"><defs><linearGradient id="cmfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="hsl(var(--accent))" stop-opacity="0.28"/><stop offset="100%" stop-color="hsl(var(--accent))" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#cmfill)"/><path d="${line}" fill="none" stroke="hsl(var(--accent))" stroke-width="1.6"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="hsl(var(--accent))"/>`).join("")}${days.map((d, i) => `<text x="${pad + i * stepX}" y="${h - 2}" font-size="9" fill="hsl(var(--muted-foreground))" text-anchor="middle" font-family="JetBrains Mono">${d.label}</text>`).join("")}</svg></div>`;
  }
  C.views.overview = () => {
    const pts = C.patients().filter((p) => !p.archivedAt), apts = C.appointments(), today = C.todayKey(), now = new Date();
    const K = window.CM_CEO && window.CM_CEO.kit; const dk = (d) => C.dayKey(d);
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const inRange = (iso, from, to) => { const t = new Date(iso); return t >= from && t < to; };
    const live = (a) => !["CANCELLED", "NO_SHOW"].includes(a.status);
    const todayApts = apts.filter((a) => dk(a.startsAt) === today && live(a));
    const lastWeekSameDay = apts.filter((a) => dk(a.startsAt) === dk(C.addDays(day0, -7)) && live(a));
    const upcoming = apts.filter((a) => new Date(a.startsAt) > now && ["SCHEDULED", "CONFIRMED"].includes(a.status));
    const upcoming7 = upcoming.filter((a) => new Date(a.startsAt) < C.addDays(day0, 7));
    const noShowRate = (from, to) => { const xs = apts.filter((a) => inRange(a.startsAt, from, to) && ["COMPLETED", "NO_SHOW"].includes(a.status)); return xs.length ? Math.round((xs.filter((a) => a.status === "NO_SHOW").length / xs.length) * 1000) / 10 : 0; };
    const ns30 = noShowRate(C.addDays(day0, -14), now), nsPrev = noShowRate(C.addDays(day0, -28), C.addDays(day0, -14));
    const newPts = (from, to) => pts.filter((p) => inRange(p.createdAt, from, to)).length;
    const new7 = newPts(C.addDays(day0, -7), now), newPrev7 = newPts(C.addDays(day0, -14), C.addDays(day0, -7));
    const days = [...Array(14)].map((_, i) => { const d = C.addDays(day0, i - 13); const k = dk(d); return { label: C.DAYS[d.getDay()], count: apts.filter((a) => dk(a.startsAt) === k && a.status !== "CANCELLED").length, noShow: apts.filter((a) => dk(a.startsAt) === k && a.status === "NO_SHOW").length, signed: C.visits().filter((v) => dk(v.at) === k).length }; });
    const thisWeek = days.slice(7), lastWeek = days.slice(0, 7);
    const diag = {}; pts.forEach((p) => p.history.diagnoses.forEach((d) => { diag[d] = (diag[d] || 0) + 1; }));
    const top = Object.entries(diag).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const pending = C.consultations().filter((c) => c.status === "PENDING_REVIEW").length;
    const openConv = C.conversations().filter((c) => c.status === "OPEN").length;
    const signed30 = C.visits().filter((v) => inRange(v.at, C.addDays(day0, -14), now)).length, signedPrev30 = C.visits().filter((v) => inRange(v.at, C.addDays(day0, -28), C.addDays(day0, -14))).length;
    const ai = C.aiModuleOn(C.currentTenant()) && window.CM_CEO && C.tid() === "ten-demo" ? (() => { const w = window.CM_CEO.windows(28); return { cur: window.CM_CEO.compute(w.from, w.to), prev: window.CM_CEO.compute(w.prevFrom, w.prevTo), hidden: window.CM_CEO.revenueHidden() }; })() : null;
    const tile = (o) => (K ? K.kpi(o) : metric(o.label, o.value, o.hint, o.tone));
    const delta = (a, b, dir, fmt) => (K ? K.deltaChip(a, b, dir, fmt) : "");
    const kpis = `<div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      ${tile({ label: "Total patients", value: n(pts.length), delta: delta(new7, newPrev7, "up"), hint: `${new7} new this week`, tone: "accent", sparkValues: [...Array(8)].map((_, i) => newPts(C.addDays(day0, (i - 8) * 7), C.addDays(day0, (i - 7) * 7))) })}
      ${tile({ label: "Appointments today", value: n(todayApts.length), delta: delta(todayApts.length, lastWeekSameDay.length, "up"), hint: `${todayApts.filter((a) => a.status === "COMPLETED").length} done · ${todayApts.filter((a) => ["CONFIRMED", "SCHEDULED", "CHECKED_IN"].includes(a.status)).length} to come`, sparkValues: days.map((d) => d.count) })}
      ${tile({ label: "Upcoming 7 days", value: n(upcoming7.length), hint: `${n(upcoming.length)} booked in total`, sparkValues: [...Array(7)].map((_, i) => upcoming.filter((a) => dk(a.startsAt) === dk(C.addDays(day0, i + 1))).length) })}
      ${tile({ label: "No-show rate · 14 d", value: `${ns30}%`, delta: delta(ns30, nsPrev, "down", (v) => `${v}%`), target: { ok: ns30 <= 8, text: "target ≤ 8%" }, tone: ns30 > 8 ? "warning" : "", sparkValues: days.map((d) => d.noShow) })}
      ${tile({ label: "Drafts to sign", value: n(pending), hint: "consultations awaiting a clinician", tone: pending ? "warning" : "", href: "#/dashboard/consultations" })}
      ${tile({ label: "Open conversations", value: n(openConv), hint: "WhatsApp, through Omni Grow", href: "#/dashboard/conversations" })}
      ${tile({ label: "Signed visits · 14 d", value: n(signed30), delta: delta(signed30, signedPrev30, "up"), sparkValues: days.map((d) => d.signed) })}
      ${ai ? (ai.hidden ? `<div class="kpi border-dashed"><span class="data-label">Procedure revenue · 28 d <span class="font-mono text-[10px] text-accent">M4</span></span><span class="kpi-value text-muted-foreground">hidden</span><span class="text-xs text-muted-foreground">model test failed; see the <a class="underline" href="#/ai/management">CEO dashboard</a></span></div>` : tile({ label: "Procedure revenue · 28 d", value: K.egpShort(ai.cur.revenue), delta: delta(ai.cur.revenue, ai.prev.revenue, "up", K.egpShort), hint: `${n(ai.cur.procedures)} procedures · M4`, tone: "accent", sparkValues: ai.cur.daily.map((d) => d.revenue) })) : tile({ label: "AI interactions", value: n((C.S.aiRuns || 0) + (C.S.aiAsked || 0)), hint: "grounded answers and extractions" })}
    </div>`;
    const volume = K ? K.columns(thisWeek.map((d, i) => ({ label: d.label, value: d.count, value2: lastWeek[i].count })), { height: "h-44", second: "Solid: this week. Grey: the same weekday last week." }) : sparkline(thisWeek);
    const dx = K ? K.hbars(top.map(([label, count]) => ({ label, value: count })), { labelW: "w-36 sm:w-56" }) : "";
    const aiCard = ai ? `<div class="bento space-y-4"><div class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="card-title">Clinic AI · CEO dashboard</h3><p class="mt-0.5 text-xs text-muted-foreground">Last 28 days against the previous 28; the full picture, the weekly brief and the alerts live in the module.</p></div><a href="#/ai/management" class="btn btn-outline btn-sm">${icon("chart")} Open</a></div><div class="grid grid-cols-3 gap-3">${[["First response", K.secs(ai.cur.frt.median), delta(ai.cur.frt.median, ai.prev.frt.median, "down", K.secs), "M5"], ["Lead → consultation", `${ai.cur.leadToConsult}%`, delta(ai.cur.leadToConsult, ai.prev.leadToConsult, "up"), "M2"], ["No-show rate", `${ai.cur.noShow.rate}%`, delta(ai.cur.noShow.rate, ai.prev.noShow.rate, "down"), "M6"]].map(([l, v, d, id]) => `<div class="min-w-0"><p class="data-label truncate">${l} <span class="text-accent">${id}</span></p><p class="mt-1 flex flex-wrap items-baseline gap-1.5"><span class="font-display text-xl font-semibold tracking-tight">${v}</span>${d}</p></div>`).join("")}</div>${window.CM_CEO.computeAlerts().filter((a) => !a.acknowledged).length ? `<p class="text-xs text-warning">${icon("alert", "mr-1 inline h-3.5 w-3.5")}${window.CM_CEO.computeAlerts().filter((a) => !a.acknowledged).length} alert(s) waiting for an acknowledgement.</p>` : `<p class="text-xs text-success">${icon("check", "mr-1 inline h-3.5 w-3.5")}No open alerts.</p>`}</div>` : "";
    return `<div class="space-y-6">${sectionTitle("Clinic Intelligence", "Operating metrics across appointments, patients and AI activity, with the change against the previous period.", badge("live", "accent"))}
      ${kpis}
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div class="bento lg:col-span-2"><h3 class="card-title">Appointment volume</h3><p class="mb-4 mt-0.5 text-xs text-muted-foreground">Booked appointments per day, this week against last week.</p>${volume}</div>
        ${aiCard || `<div class="bento"><h3 class="card-title">AI activity</h3><div class="mt-6 space-y-5"><div class="flex items-center justify-between"><span class="data-label">interactions</span><span class="metric-value text-accent">${n((C.S.aiRuns || 0) + (C.S.aiAsked || 0))}</span></div><div class="flex items-center justify-between"><span class="data-label">active consultations</span><span class="metric-value">${n(pending)}</span></div></div></div>`}
      </div>
      <div class="bento"><h3 class="card-title">Diagnoses distribution</h3><p class="mb-4 mt-0.5 text-xs text-muted-foreground">Most frequent diagnoses across the patient population.</p>${top.length ? dx || `<div class="space-y-2.5">${top.map(([label, count]) => `<div class="flex items-center gap-3"><span class="w-40 truncate text-sm sm:w-56" title="${esc(label)}">${esc(label)}</span><span class="h-2 flex-1 rounded-full bg-muted"><span class="block h-2 rounded-full bg-accent" style="width:${Math.round((count / Math.max(1, top[0][1])) * 100)}%"></span></span><span class="w-8 text-right font-mono text-xs tabular-nums">${count}</span></div>`).join("")}</div>` : emptyState("No diagnosis data yet", "Diagnoses populate as consultations are signed.")}</div>
    </div>`;
  };

  // ── Patients ────────────────────────────────────────────────────────────
  const tone = (s) => ({ ACTIVE: "success", INVITED: "warning", DISABLED: "danger" }[s] || "default");
  C.tone = tone;
  function matches(p, q) { if (!q) return true; q = q.toLowerCase(); return p.fullName.toLowerCase().includes(q) || p.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")) || (p.email || "").toLowerCase().includes(q); }
  C.views.patients = (r) => {
    const q = r.query.q || "", page = Math.max(1, Number(r.query.page || 1)), archived = r.query.archived === "1";
    const all = C.patients().filter((p) => (archived ? Boolean(p.archivedAt) : !p.archivedAt) && matches(p, q));
    const size = 25, total = all.length, pages = Math.max(1, Math.ceil(total / size)), slice = all.slice((page - 1) * size, page * size);
    const apts = C.appointments(), vis = C.visits();
    const write = C.can(C.currentUser().role, "patients:write");
    const link = (over) => `#/dashboard/patients?${new URLSearchParams({ q, page: String(page), archived: archived ? "1" : "0", ...over }).toString()}`;
    return `<div class="space-y-6">${sectionTitle("Patients", "Unified patient registry with clinical context.", `${badge(`${n(total)} records`, "accent")}${write ? `<button class="btn btn-primary" data-action="new-patient">${icon("plus")} Add patient</button>` : ""}`)}
      <div class="bento space-y-4 p-0"><form class="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-end sm:justify-between" data-form="patient-search"><div class="flex flex-1 flex-col gap-1.5 sm:flex-row sm:items-end"><div class="w-full sm:max-w-xs"><label class="data-label block mb-1.5" for="q">Search</label><input id="q" name="q" class="input" value="${esc(q)}" placeholder="Name, phone or e-mail"></div><button class="btn btn-outline" type="submit">${icon("search")} Search</button></div><a class="text-xs text-muted-foreground hover:text-foreground" href="${link({ archived: archived ? "0" : "1", page: "1" })}">${archived ? "Show active" : "Show archived"}</a></form>
      ${slice.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="border-b border-border"><tr><th class="th">Patient</th><th class="th">Age</th><th class="th">Contact</th><th class="th col-md">Tags</th><th class="th col-md">Conditions</th><th class="th col-lg text-right">Activity</th></tr></thead><tbody>${slice.map((p) => { const ac = apts.filter((a) => a.patientId === p.id).length, vc = vis.filter((v) => v.patientId === p.id).length; return `<tr class="tr"><td class="td"><a href="#/dashboard/patients/${p.id}" class="flex items-center gap-3 hover:underline">${avatar(p.fullName)}<span><span class="block font-medium">${esc(p.fullName)}</span><span class="block text-xs text-muted-foreground">${esc(p.gender)}</span></span></a></td><td class="td font-mono text-xs">${age(p.dob)}</td><td class="td font-mono text-xs"><span class="block">${esc(p.phone)}</span>${p.email ? `<span class="block text-muted-foreground">${esc(p.email)}</span>` : ""}</td><td class="td col-md"><span class="flex flex-wrap gap-1">${p.tags.map((t) => badge(t)).join("")}</span></td><td class="td col-md"><span class="flex flex-wrap gap-1">${p.history.chronicConditions.slice(0, 2).map((c) => badge(c, "warning")).join("")}</span></td><td class="td col-lg text-right font-mono text-xs text-muted-foreground">${ac} appts · ${vc} visits</td></tr>`; }).join("")}</tbody></table></div>
      <div class="flex items-center justify-between border-t border-border px-4 py-3 font-mono text-xs text-muted-foreground"><span>${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}</span><span class="flex items-center gap-2"><a class="btn btn-outline btn-icon h-8 w-8 ${page <= 1 ? "pointer-events-none opacity-50" : ""}" href="${link({ page: String(page - 1) })}" aria-label="Previous page">${icon("chevron-left")}</a><span>${page} / ${pages}</span><a class="btn btn-outline btn-icon h-8 w-8 ${page >= pages ? "pointer-events-none opacity-50" : ""}" href="${link({ page: String(page + 1) })}" aria-label="Next page">${icon("chevron-right")}</a></span></div>` : `<div class="p-4">${emptyState(archived ? "No archived patients" : "No patients match", "Try another name, phone number or e-mail, or clear the filters.")}</div>`}
      </div></div>`;
  };
  C.forms["patient-search"] = (d) => C.go(`/dashboard/patients?q=${encodeURIComponent(d.q || "")}`);

  function patientForm(p) {
    return `<form data-form="save-patient" class="space-y-4" novalidate><input type="hidden" name="id" value="${p ? p.id : ""}"><div id="patient-error"></div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">${field("Full name", `<input id="pf-name" name="fullName" class="input" required value="${esc(p ? p.fullName : "")}">`, null, "pf-name")}${field("Gender", `<select id="pf-gender" name="gender" class="input">${["Female", "Male"].map((g) => `<option ${p && p.gender === g ? "selected" : ""}>${g}</option>`).join("")}</select>`, null, "pf-gender")}${field("Date of birth", `<input id="pf-dob" name="dob" type="date" class="input" value="${esc(p ? p.dob : "")}">`, null, "pf-dob")}${field("Phone", `<input id="pf-phone" name="phone" class="input font-mono" required value="${esc(p ? p.phone : "+2010")}">`, null, "pf-phone")}${field("E-mail", `<input id="pf-email" name="email" type="email" class="input" value="${esc(p ? p.email || "" : "")}">`, null, "pf-email")}${field("Language", `<select id="pf-lang" name="language" class="input">${["Arabic", "English"].map((g) => `<option ${p && p.language === g ? "selected" : ""}>${g}</option>`).join("")}</select>`, null, "pf-lang")}</div>
      ${field("Tags", `<input id="pf-tags" name="tags" class="input font-mono" value="${esc(p ? p.tags.join(", ") : "")}" placeholder="acne, vip">`, "Comma separated", "pf-tags")}${field("Notes", `<textarea id="pf-notes" name="notes" class="input min-h-[5rem]">${esc(p ? p.notes : "")}</textarea>`, null, "pf-notes")}
      <div class="flex items-center justify-end gap-2"><button type="button" class="btn btn-outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn btn-primary">${icon("save")} ${p ? "Save changes" : "Add patient"}</button></div></form>`;
  }
  C.actions["new-patient"] = () => C.openDialog({ title: "Add patient", description: "A new record in this clinic.", body: patientForm(null) });
  C.actions["edit-patient"] = (el) => C.openDialog({ title: "Edit patient", body: patientForm(C.patient(el.dataset.id)) });
  C.forms["save-patient"] = (d) => {
    const box = document.querySelector("#patient-error");
    if (!d.fullName.trim() || d.fullName.trim().length < 2) { box.innerHTML = alert("Enter the patient's full name."); return; }
    if (!/^\+?[0-9 ]{8,16}$/.test(d.phone.trim())) { box.innerHTML = alert("Enter a phone number with 8 to 15 digits."); return; }
    if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) { box.innerHTML = alert("Enter a valid e-mail address."); return; }
    const tags = d.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    let p = d.id ? C.patient(d.id) : null;
    if (p) { Object.assign(p, { fullName: d.fullName.trim(), gender: d.gender, dob: d.dob || p.dob, phone: d.phone.trim(), email: d.email.trim() || null, language: d.language, tags, notes: d.notes }); C.logAudit("patient.update", "Patient", p.id); C.save(); C.closeDialog(); C.toast({ title: "Patient updated" }); C.render(); return; }
    p = { id: C.newId("pat"), tenantId: C.tid(), fullName: d.fullName.trim(), gender: d.gender, dob: d.dob || "1990-01-01", phone: d.phone.trim(), whatsapp: true, email: d.email.trim() || null, language: d.language, tags, notes: d.notes, emergencyContact: null, address: null, createdAt: new Date().toISOString(), archivedAt: null, history: { chronicConditions: [], allergies: [], diagnoses: [], surgeries: [] }, conditionKeys: [] };
    C.S.patients.push(p); C.logAudit("patient.create", "Patient", p.id); C.save(); C.closeDialog(); C.toast({ title: "Patient added", description: p.fullName }); C.go(`/dashboard/patients/${p.id}`);
  };
  C.actions["archive-patient"] = async (el) => { const p = C.patient(el.dataset.id); const ok = await C.confirmDialog({ title: `Archive ${p.fullName}?`, description: "The record is hidden from lists and the assistant, and can be restored at any time. Nothing is deleted.", confirmLabel: "Archive patient", tone: "danger" }); if (!ok) return; p.archivedAt = new Date().toISOString(); C.logAudit("patient.archive", "Patient", p.id); C.save(); C.toast({ title: "Patient archived" }); C.render(); };
  C.actions["restore-patient"] = (el) => { const p = C.patient(el.dataset.id); p.archivedAt = null; C.logAudit("patient.restore", "Patient", p.id); C.save(); C.toast({ title: "Patient restored" }); C.render(); };

  const KIND_TONE = { VISIT: "success", DIAGNOSIS: "warning", PRESCRIPTION: "accent", APPOINTMENT: "accent", CONVERSATION: "default", NOTE: "default" };
  C.views.patient = (r, id) => {
    const p = C.patient(id);
    if (!p || (p.tenantId || "ten-demo") !== C.tid()) return `<div class="space-y-4"><a href="#/dashboard/patients" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">${icon("arrow-left")} Patients</a>${emptyState("Patient not found", "This record does not exist in your clinic.")}</div>`;
    const tab = r.query.tab || "overview", now = new Date();
    const apts = C.appointments().filter((a) => a.patientId === p.id).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const upcoming = apts.filter((a) => new Date(a.startsAt) > now && !["CANCELLED", "NO_SHOW", "COMPLETED"].includes(a.status));
    const vis = C.visits().filter((v) => v.patientId === p.id).sort((a, b) => b.at.localeCompare(a.at));
    const meds = C.medications().filter((m) => m.patientId === p.id && !m.stoppedAt);
    const tl = C.timeline().filter((t) => t.patientId === p.id).sort((a, b) => b.at.localeCompare(a.at));
    const write = C.can(C.currentUser().role, "patients:write"), archived = Boolean(p.archivedAt);
    const tabs = [["overview", "Overview"], ["timeline", "Timeline"], ["visits", "Visits & consultations"], ["documents", "Documents"]];
    const h = p.history;
    const list = (label, items, tn) => `<div class="rounded-lg border border-border p-4"><div class="mb-2 flex items-center justify-between"><span class="data-label">${label}</span><span class="font-mono text-xs text-muted-foreground">${items.length}</span></div>${items.length ? `<div class="flex flex-wrap gap-1.5">${items.map((i) => badge(i, tn, "normal-case tracking-normal font-sans text-xs")).join("")}</div>` : `<p class="text-sm text-muted-foreground">None recorded.</p>`}</div>`;
    let body = "";
    if (tab === "overview") body = `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3"><div class="min-w-0 space-y-4 lg:col-span-2">
        <div class="bento space-y-4">${sectionTitle("Medical history", "Chronic conditions, allergies, diagnoses and surgeries.", write && !archived ? `<button class="btn btn-outline btn-sm" data-action="edit-history" data-id="${p.id}">${icon("pencil")} Edit history</button>` : "")}<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">${list("Chronic conditions", h.chronicConditions, "warning")}${list("Allergies", h.allergies, "danger")}${list("Diagnoses", h.diagnoses, "accent")}${list("Surgeries", h.surgeries, "default")}</div></div>
        <div class="bento overflow-hidden p-0"><div class="border-b border-border px-6 py-4">${sectionTitle("Medications", "Prescribed when consultations are signed; read-only here.", badge(`${meds.length} active`, "accent"))}</div>${meds.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="border-b border-border"><tr><th class="th">Medication</th><th class="th">Dosage</th><th class="th">Frequency</th><th class="th">Since</th></tr></thead><tbody>${meds.map((m) => `<tr class="tr"><td class="td font-medium">${esc(m.name)}</td><td class="td text-muted-foreground">${esc(m.dosage || "—")}</td><td class="td text-muted-foreground">${esc(m.frequency || "—")}</td><td class="td font-mono text-xs">${fmtDate(m.startedAt)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="p-6">${emptyState("No active medications", "Medications are added when a consultation is signed.")}</div>`}</div></div>
        <div class="min-w-0 space-y-4"><div class="bento space-y-3">${sectionTitle("Upcoming appointments", null, write && !archived ? `<button class="btn btn-outline btn-sm" data-action="new-appointment" data-patient="${p.id}">${icon("calendar")} Book</button>` : "")}${upcoming.length ? `<ul class="space-y-2">${upcoming.slice(0, 5).map((a) => `<li class="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"><span><span class="block font-mono text-xs">${fmtDate(a.startsAt)} ${fmtTime(a.startsAt)}</span><span class="block text-muted-foreground">${esc(a.reason)} · ${esc((C.user(a.doctorId) || {}).fullName || "")}</span></span>${badge(a.status.replace("_", " "), C.aptTone(a.status))}</li>`).join("")}</ul>` : emptyState("Nothing scheduled", "Upcoming bookings appear here.")}</div>
        <div class="bento space-y-3"><h3 class="font-display text-lg font-semibold">Contact & emergency</h3>${[["Emergency contact", p.emergencyContact || "—"], ["Address", p.address || "—"], ["Language", p.language], ["Registered", fmtDate(p.createdAt)]].map(([k, v]) => `<div class="flex items-center justify-between gap-4"><span class="data-label">${k}</span><span class="text-sm font-medium">${esc(v)}</span></div>`).join("")}</div>
        <div class="bento space-y-2"><h3 class="font-display text-lg font-semibold">Notes</h3><p class="text-sm ${p.notes ? "" : "text-muted-foreground"}">${esc(p.notes || "No notes on this patient.")}</p></div></div></div>`;
    else if (tab === "timeline") body = `<div class="bento">${tl.length ? `<ol class="relative space-y-5 border-l border-border pl-5">${tl.map((e) => `<li class="relative"><span class="absolute -left-[1.45rem] top-1.5 h-2 w-2 rounded-full bg-accent"></span><div class="flex flex-wrap items-center gap-2">${badge(e.kind, KIND_TONE[e.kind] || "default")}<span class="font-mono text-xs text-muted-foreground">${fmtDate(e.at)} · ${fmtTime(e.at)}</span></div><p class="mt-1 text-sm font-medium">${esc(e.title)}</p>${e.body ? `<p class="text-sm text-muted-foreground">${esc(e.body)}</p>` : ""}</li>`).join("")}</ol>` : emptyState("No events yet", "Appointments, visits, diagnoses and prescriptions appear here.")}</div>`;
    else if (tab === "visits") body = `<div class="bento overflow-hidden p-0">${vis.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="border-b border-border"><tr><th class="th">Date</th><th class="th col-md">Doctor</th><th class="th">Summary</th><th class="th text-right">Status</th></tr></thead><tbody>${vis.map((v) => { const c = C.consultations().find((x) => x.visitId === v.id); return `<tr class="tr"><td class="td whitespace-nowrap font-mono text-xs">${fmtDate(v.at)} <span class="text-muted-foreground">${fmtTime(v.at)}</span></td><td class="td col-md">${esc((C.user(v.doctorId) || {}).fullName || "")}</td><td class="td max-w-md text-muted-foreground"><a href="#/dashboard/consultations?open=${c ? c.id : ""}" class="line-clamp-2 hover:underline">${esc(v.summary)}</a></td><td class="td text-right">${badge("signed", "success")}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="p-6">${emptyState("No visits yet", "Signed consultations appear here.")}</div>`}</div>`;
    else body = C.aiModuleOn(C.currentTenant()) ? `<div class="bento space-y-4">${emptyState("Photos and documents live in the Clinic AI module", "Module 4 holds the photo timeline and comparisons; Module 3 holds the signed documents.")}<div class="flex flex-wrap justify-center gap-2"><a class="btn btn-outline btn-sm" href="#/ai/photos?patient=${p.id}">${icon("eye")} Open photos</a><a class="btn btn-outline btn-sm" href="#/ai/copilot?tab=documents&patient=${p.id}">${icon("file")} Open documents</a><a class="btn btn-outline btn-sm" href="#/ai/preparation?tab=consents">${icon("shield")} Consents</a></div></div>` : `<div class="bento">${emptyState("No documents yet", "Photos, consent forms and reports arrive with Module 4 (photography and documents). Not built yet.")}</div>`;
    return `<div class="space-y-6"><a href="#/dashboard/patients" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">${icon("arrow-left")} Patients</a>
      ${archived ? alert(`This patient is archived. ${write ? `<button class="underline" data-action="restore-patient" data-id="${p.id}">Restore</button>` : ""}`, "info") : ""}
      <div class="bento flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div class="flex min-w-0 gap-4">${avatar(p.fullName, "h-14 w-14 text-lg")}<div class="min-w-0"><h1 class="font-display text-2xl font-semibold tracking-tight">${esc(p.fullName)}</h1><p class="text-sm text-muted-foreground">${age(p.dob)} years · ${esc(p.gender)} · born ${fmtDate(p.dob)}</p><p class="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs"><span class="inline-flex items-center gap-1">${icon("phone", "h-3.5 w-3.5")} ${esc(p.phone)}</span>${p.whatsapp ? `<span class="inline-flex items-center gap-1">${icon("chat", "h-3.5 w-3.5")} ${esc(p.phone)}</span>` : ""}${p.email ? `<span class="inline-flex items-center gap-1">${icon("mail", "h-3.5 w-3.5")} ${esc(p.email)}</span>` : ""}</p><p class="mt-2 flex flex-wrap gap-1">${badge(p.language, "accent")}${p.tags.map((t) => badge(t)).join("")}</p></div></div>
        ${write ? `<div class="flex shrink-0 items-center gap-2">${archived ? `<button class="btn btn-outline btn-sm" data-action="restore-patient" data-id="${p.id}">${icon("refresh")} Restore</button>` : `<button class="btn btn-outline btn-sm" data-action="edit-patient" data-id="${p.id}">${icon("pencil")} Edit</button><button class="btn btn-ghost btn-sm text-danger" data-action="archive-patient" data-id="${p.id}">${icon("archive")} Archive</button>`}</div>` : ""}</div>
      <div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">${metric("Upcoming appointments", upcoming.length, null, upcoming.length ? "accent" : null)}${metric("Visits", vis.length, vis.length ? `Last on ${fmtDate(vis[0].at)}` : null)}${metric("Active medications", meds.length)}${metric("Timeline events", tl.length)}</div>
      <div class="inline-flex h-auto flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist">${tabs.map(([k, l]) => `<a role="tab" aria-selected="${tab === k}" href="#/dashboard/patients/${p.id}?tab=${k}" class="rounded-md px-3 py-1.5 text-sm ${tab === k ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}">${l}</a>`).join("")}</div>
      ${body}</div>`;
  };
  C.actions["edit-history"] = (el) => {
    const p = C.patient(el.dataset.id), h = p.history;
    const ta = (name, label, v) => field(label, `<textarea name="${name}" class="input min-h-[4rem] font-mono text-xs">${esc(v.join("\n"))}</textarea>`, "One item per line");
    C.openDialog({ title: "Edit medical history", description: `${esc(p.fullName)} · diagnoses are written by signed consultations and can be corrected here.`, body: `<form data-form="save-history" class="space-y-3" novalidate><input type="hidden" name="id" value="${p.id}"><div class="grid grid-cols-1 gap-3 sm:grid-cols-2">${ta("chronicConditions", "Chronic conditions", h.chronicConditions)}${ta("allergies", "Allergies", h.allergies)}${ta("diagnoses", "Diagnoses", h.diagnoses)}${ta("surgeries", "Surgeries", h.surgeries)}</div><div class="flex justify-end gap-2"><button type="button" class="btn btn-outline" data-action="close-dialog">Cancel</button><button class="btn btn-primary" type="submit">${icon("save")} Save history</button></div></form>` });
  };
  C.forms["save-history"] = (d) => { const p = C.patient(d.id); const split = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean); p.history = { chronicConditions: split(d.chronicConditions), allergies: split(d.allergies), diagnoses: split(d.diagnoses), surgeries: split(d.surgeries) }; C.logAudit("patient.history.update", "Patient", p.id); C.save(); C.closeDialog(); C.toast({ title: "Medical history saved" }); C.render(); };
})();
