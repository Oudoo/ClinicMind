/* ClinicMind click-through prototype — core: storage, auth, router, shell and
   UI primitives. Views live in views.js. Everything runs in the browser. */
window.CM = (function () {
  const STORAGE = "cm-proto-v5";
  const SESSION = "cm-proto-session";
  const THEME = "cm-proto-theme";
  const $ = (s, r = document) => r.querySelector(s);

  // ── Permissions (mirrors src/lib/auth/rbac.ts) ──────────────────────────
  const PERMS = {
    SUPER_ADMIN: ["platform:manage", "tenant:manage", "users:manage", "patients:read", "patients:write", "appointments:read", "appointments:write", "consultations:read", "consultations:sign", "ai:assistant", "conversations:read", "analytics:read", "embed:manage"],
    CLINIC_OWNER: ["tenant:manage", "users:manage", "patients:read", "patients:write", "appointments:read", "appointments:write", "consultations:read", "consultations:sign", "ai:assistant", "conversations:read", "analytics:read", "embed:manage"],
    DOCTOR: ["patients:read", "patients:write", "appointments:read", "appointments:write", "consultations:read", "consultations:sign", "ai:assistant", "conversations:read", "analytics:read"],
    NURSE: ["patients:read", "patients:write", "appointments:read", "appointments:write", "consultations:read", "conversations:read"],
    RECEPTIONIST: ["patients:read", "patients:write", "appointments:read", "appointments:write", "conversations:read"],
    ASSISTANT: ["patients:read", "appointments:read", "conversations:read"],
  };
  const can = (role, perm) => (PERMS[role] || []).includes(perm);
  const ROLE_LABEL = { SUPER_ADMIN: "Super admin", CLINIC_OWNER: "Clinic owner", DOCTOR: "Doctor", NURSE: "Nurse", RECEPTIONIST: "Receptionist", ASSISTANT: "Assistant" };

  // ── State ───────────────────────────────────────────────────────────────
  let S = null;
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) { S = JSON.parse(raw); if (S && S.version === 2) return S; }
    } catch (e) { /* storage unavailable: regenerate every load */ }
    S = window.CM_SEED.generate(new Date());
    save();
    return S;
  }
  function save() { try { localStorage.setItem(STORAGE, JSON.stringify(S)); } catch (e) { /* ignore */ } }
  function reset() { try { localStorage.removeItem(STORAGE); } catch (e) { /* ignore */ } S = null; load(); }
  let idCounter = 1000;
  const newId = (p) => `${p}-${Date.now().toString(36)}${(idCounter++).toString(36)}`;
  const audit = [];
  function logAudit(action, entity, entityId, extra) {
    audit.unshift({ at: new Date().toISOString(), actor: session() ? session().email : "system", action, entity, entityId, ...(extra || {}) });
    if (audit.length > 200) audit.length = 200;
  }

  // ── Session ─────────────────────────────────────────────────────────────
  let failures = {};
  function session() { try { return JSON.parse(sessionStorage.getItem(SESSION) || localStorage.getItem(SESSION) || "null"); } catch (e) { return null; } }
  function setSession(v) { try { if (v) localStorage.setItem(SESSION, JSON.stringify(v)); else localStorage.removeItem(SESSION); } catch (e) { /* ignore */ } }
  function currentUser() { const s = session(); if (!s) return null; const t = tenantById(s.tenantId); if (!t || t.status !== "ACTIVE") return null; return S.users.find((u) => u.id === s.userId && u.status === "ACTIVE") || null; }
  function currentTenant() { const u = currentUser(); if (!u) return null; return tenantById(u.tenantId); }
  function tenantById(id) { if (id === "ten-platform") return { ...S.platformTenant, status: "ACTIVE", branding: { productName: "ClinicMind", accent: "#4F46E5", logoUrl: "" } }; return S.tenants.find((t) => t.id === id) || null; }
  function tenantBySlug(slug) { if (slug === "platform") return tenantById("ten-platform"); return S.tenants.find((t) => t.slug === slug) || null; }

  function login(email, password, tenantSlug) {
    email = (email || "").trim().toLowerCase();
    const key = email || "unknown";
    const f = failures[key] || { count: 0, until: 0 };
    if (f.until > Date.now()) return { ok: false, reason: "locked", retryAfter: Math.ceil((f.until - Date.now()) / 60000) };
    let candidates = S.users.filter((u) => u.email.toLowerCase() === email && u.status === "ACTIVE");
    if (tenantSlug) candidates = candidates.filter((u) => { const t = tenantById(u.tenantId); return t && t.slug === tenantSlug; });
    candidates = candidates.filter((u) => { const t = tenantById(u.tenantId); return t && t.status === "ACTIVE"; });
    const user = candidates[0];
    if (!user || password !== (user.password || S.password)) {
      f.count += 1; if (f.count >= 10) { f.until = Date.now() + 15 * 60000; f.count = 0; }
      failures[key] = f;
      return { ok: false, reason: "invalid_credentials" };
    }
    if (candidates.length > 1) return { ok: false, reason: "ambiguous_tenant" };
    failures[key] = { count: 0, until: 0 };
    setSession({ userId: user.id, tenantId: user.tenantId, email: user.email, since: new Date().toISOString() });
    logAudit("auth.login", "User", user.id);
    return { ok: true, user };
  }
  function logout() { const u = currentUser(); if (u) logAudit("auth.logout", "User", u.id); setSession(null); }

  // ── Scoping helpers ─────────────────────────────────────────────────────
  const tid = () => (session() ? session().tenantId : null);
  const scoped = (list) => list.filter((x) => (x.tenantId || "ten-demo") === tid());
  const patients = () => scoped(S.patients);
  const appointments = () => scoped(S.appointments);
  const visits = () => scoped(S.visits);
  const consultations = () => scoped(S.consultations);
  const conversations = () => scoped(S.conversations);
  const medications = () => scoped(S.medications);
  const timeline = () => scoped(S.timeline);
  const staff = () => S.users.filter((u) => u.tenantId === tid() && u.status !== "DELETED");
  const patient = (id) => S.patients.find((p) => p.id === id) || null;
  const user = (id) => S.users.find((u) => u.id === id) || null;
  const doctors = () => staff().filter((u) => ["DOCTOR", "NURSE", "CLINIC_OWNER"].includes(u.role) && u.status === "ACTIVE");

  // ── Formatting ──────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n) => String(n).padStart(2, "0");
  const toDate = (v) => (v instanceof Date ? v : new Date(v));
  const fmtDate = (v) => { const d = toDate(v); return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtLongDate = (v) => { const d = toDate(v); return `${DAYS[d.getDay()]}, ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtTime = (v) => { const d = toDate(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dayKey = (v) => { const d = toDate(v); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const parseDay = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(toDate(d)); x.setDate(x.getDate() + n); return x; };
  const age = (dob) => { const d = toDate(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  const initials = (n) => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  const n = (x) => Number(x).toLocaleString("en-US");
  const todayKey = () => dayKey(new Date());

  // ── Theme and white-label ───────────────────────────────────────────────
  function hexToHsl(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  function applyBranding(branding) {
    const root = document.documentElement;
    const hsl = hexToHsl(branding && branding.accent);
    if (hsl) {
      root.style.setProperty("--accent", `${hsl.h} ${hsl.s}% ${hsl.l}%`);
      root.style.setProperty("--ring", `${hsl.h} ${hsl.s}% ${hsl.l}%`);
      root.style.setProperty("--accent-muted", `${hsl.h} ${Math.max(30, hsl.s)}% ${root.classList.contains("dark") ? 22 : 96}%`);
    } else { root.style.removeProperty("--accent"); root.style.removeProperty("--ring"); root.style.removeProperty("--accent-muted"); }
  }
  function theme() { try { return localStorage.getItem(THEME) || "light"; } catch (e) { return "light"; } }
  function setTheme(t) { try { localStorage.setItem(THEME, t); } catch (e) { /* ignore */ } document.documentElement.classList.toggle("dark", t === "dark"); }

  // ── Icons (Lucide paths, stroke) ────────────────────────────────────────
  const ICONS = {
    layout: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
    users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    stethoscope: "M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4M20 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    sparkles: "M9.9 2.1 11.4 6.6l4.5 1.5-4.5 1.5-1.5 4.5-1.5-4.5-4.5-1.5 4.5-1.5zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9zM5 15l.6 1.9 1.9.6-1.9.6L5 20l-.6-1.9-1.9-.6 1.9-.6z",
    messages: "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
    settings: "M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    building: "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18zM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4",
    menu: "M4 6h16M4 12h16M4 18h16",
    x: "M18 6 6 18M6 6l12 12",
    moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z",
    sun: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
    plus: "M5 12h14M12 5v14",
    search: "M21 21l-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    copy: "M8 8h12v12H8zM16 8V4H4v12h4",
    check: "M20 6 9 17l-5-5",
    trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
    pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
    archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
    more: "M12 12h.01M19 12h.01M5 12h.01",
    "chevron-left": "m15 18-6-6 6-6",
    "chevron-right": "m9 18 6-6-6-6",
    "chevron-down": "m6 9 6 6 6-6",
    "arrow-left": "M19 12H5M12 19l-7-7 7-7",
    "arrow-right": "M5 12h14M12 5l7 7-7 7",
    external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    key: "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15 8m0 0 3 3m-3-3 2-2",
    link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
    mail: "M4 4h16v16H4zM4 7l8 6 8-6",
    pause: "M6 4h4v16H6zM14 4h4v16h-4z",
    play: "M6 4l14 8-14 8z",
    save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8",
    alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
    phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
    chat: "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l2-5.3A8.4 8.4 0 1 1 21 11.5z",
    send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
    mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
    clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
    refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
    quote: "M3 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6c0 1 1 2 2 2h4M15 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v6c0 1 1 2 2 2h4",
    user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "message-square": "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    chart: "M3 3v18h18M7 14l4-4 4 4 5-6",
    "trend-up": "M3 17l6-6 4 4 8-8M14 7h7v7",
    "trend-down": "M3 7l6 6 4-4 8 8M14 17h7v-7",
    target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
    filter: "M22 3H2l8 9.5V19l4 2v-8.5z",
    info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
    wallet: "M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4z",
  };
  const icon = (name, cls = "h-4 w-4") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ""}"/></svg>`;

  // ── UI primitives ───────────────────────────────────────────────────────
  const badge = (text, tone = "default", extra = "") => `<span class="badge badge-${tone} ${extra}">${esc(text)}</span>`;
  const card = (inner, cls = "") => `<div class="bento ${cls}">${inner}</div>`;
  const sectionTitle = (title, description, action) => `<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 class="font-display text-xl font-semibold tracking-tight">${esc(title)}</h2>${description ? `<p class="mt-1 text-sm text-muted-foreground">${description}</p>` : ""}</div>${action ? `<div class="flex shrink-0 items-center gap-2">${action}</div>` : ""}</div>`;
  /** Tabs as one scrollable row (no wrapping on phones). items: [key, label]; base: href prefix the key is appended to. */
  const tabStrip = (items, active, base) => `<div class="tab-strip" role="tablist">${items.map(([k, l]) => `<a role="tab" aria-selected="${k === active}" href="${base}${k}" class="tab ${k === active ? "tab-active" : ""}">${esc(l)}</a>`).join("")}</div>`;
  const metric = (label, value, hint, tone) => `<div class="bento flex flex-col gap-2"><span class="data-label">${esc(label)}</span><span class="metric-value ${tone === "accent" ? "text-accent" : tone === "warning" ? "text-warning" : ""}">${value}</span>${hint ? `<span class="text-xs text-muted-foreground">${esc(hint)}</span>` : ""}</div>`;
  const emptyState = (title, hint) => `<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-10 text-center"><p class="text-sm font-medium">${esc(title)}</p>${hint ? `<p class="mt-1 text-xs text-muted-foreground">${esc(hint)}</p>` : ""}</div>`;
  const field = (label, control, hint, id) => `<div class="space-y-1.5"><label ${id ? `for="${id}"` : ""} class="data-label block">${esc(label)}</label>${control}${hint ? `<p class="text-xs text-muted-foreground">${hint}</p>` : ""}</div>`;
  const alert = (text, tone = "danger") => `<div role="${tone === "danger" ? "alert" : "status"}" class="rounded-lg border px-3 py-2 text-sm ${tone === "danger" ? "border-danger/30 bg-danger/5 text-danger" : tone === "success" ? "border-success/30 bg-success/5 text-success" : "border-border bg-muted text-muted-foreground"}">${text}</div>`;
  const avatar = (name, size = "h-10 w-10 text-sm") => `<span class="flex ${size} shrink-0 items-center justify-center rounded-md bg-accent-muted font-mono font-medium text-accent">${esc(initials(name))}</span>`;

  let toastTimer = 0;
  function toast({ title, description, tone = "success" }) {
    const host = $("#toasts");
    const el = document.createElement("div");
    const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-accent";
    el.className = "toast";
    el.innerHTML = `${icon(tone === "danger" ? "alert" : tone === "info" ? "alert" : "check", `mt-0.5 h-4 w-4 shrink-0 ${color}`)}<div class="min-w-0 flex-1"><p class="text-sm font-medium">${esc(title)}</p>${description ? `<p class="mt-0.5 text-xs text-muted-foreground">${esc(description)}</p>` : ""}</div><button class="text-muted-foreground hover:text-foreground" data-action="dismiss-toast" aria-label="Dismiss">${icon("x")}</button>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  let dialogState = null;
  function openDialog({ title, description, body, footer, size = "max-w-lg", onMount }) {
    closeDialog();
    const wrap = document.createElement("div");
    wrap.id = "dialog"; wrap.className = "fixed inset-0 z-50";
    wrap.innerHTML = `<div class="dialog-overlay" data-action="close-dialog"></div><div role="dialog" aria-modal="true" aria-labelledby="dialog-title" class="dialog ${size}"><div class="mb-4 flex items-start justify-between gap-4"><div><h2 id="dialog-title" class="font-display text-lg font-semibold tracking-tight">${esc(title)}</h2>${description ? `<p class="mt-0.5 text-sm text-muted-foreground">${description}</p>` : ""}</div><button class="btn btn-ghost btn-icon" data-action="close-dialog" aria-label="Close">${icon("x")}</button></div><div id="dialog-body">${body}</div>${footer ? `<div class="mt-6 flex items-center justify-end gap-2" id="dialog-footer">${footer}</div>` : ""}</div>`;
    document.body.appendChild(wrap);
    enhanceMics(wrap);
    dialogState = { onMount };
    const first = wrap.querySelector("input, textarea, select, button:not([data-action=close-dialog])");
    if (first) first.focus();
    if (onMount) onMount(wrap);
  }
  function closeDialog() { const d = $("#dialog"); if (d) d.remove(); dialogState = null; }
  function confirmDialog({ title, description, confirmLabel = "Confirm", tone = "primary" }) {
    return new Promise((resolve) => {
      openDialog({
        title, description, body: "",
        footer: `<button class="btn btn-outline" type="button" data-action="confirm-no">Cancel</button><button class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" type="button" data-action="confirm-yes">${esc(confirmLabel)}</button>`,
      });
      confirmResolver = resolve;
    });
  }
  let confirmResolver = null;

  // ── Microphone in free-text fields (simulated speech-to-text) ──────────
  // The application records the field's audio and sends it to the clinic's
  // speech-to-text provider; the prototype listens for two seconds and types
  // a phrase that fits the field, inserted at the caret like the real one.
  const MIC_PHRASES = [
    [/transcript/, "Doctor: Patient reports less shedding since starting minoxidil. On examination, mild thinning at the crown, no scalp inflammation. Plan: continue minoxidil 5% twice daily, ferritin and TSH, review in three months with photos."],
    [/summary/, "Acne follow-up. Clear improvement on adapalene; continue nightly, sunscreen every morning, review in six weeks."],
    [/cancel/, "Patient asked to cancel by phone; travelling next week."],
    [/reason/, "Hair loss follow-up"],
    [/notes?\b/, "Patient prefers afternoon appointments and speaks Arabic; call before the visit."],
    [/\b(body|reply|message)\b/, "Thanks for your message! The next free consultation is Thursday at 11:00. Shall I book it for you?"],
    [/\bmq\b/, "no-show rate by doctor"],
    [/\b(ask|q|question)\b/, "Which patients are on isotretinoin?"],
    [/concern/, "Thinning at the crown for about a year"],
    [/expectations/, "Stop the shedding and regrow the crown"],
    [/prior/, "Minoxidil 5% for two months, then stopped"],
    [/\ba\b/, "Yes, we see children from the age of two."],
  ];
  const micPhrase = (el) => { const key = `${el.name || ""} ${el.id || ""}`.toLowerCase(); const hit = MIC_PHRASES.find(([re]) => re.test(key)); return hit ? hit[1] : "Patient is well and will return for review."; };
  const micWanted = (el) => {
    if (el.dataset.noMic != null || el.readOnly || el.disabled || /font-mono/.test(el.className) || el.closest("[data-mic-wrap]")) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.type && el.type !== "text") return false;
    return el.name === "reason" || el.name === "concern" || (el.name === "q" && el.id !== "q");
  };
  function enhanceMics(root) {
    root.querySelectorAll("textarea, input").forEach((el) => {
      if (!micWanted(el)) return;
      const area = el.tagName === "TEXTAREA";
      const wrap = document.createElement("div");
      wrap.setAttribute("data-mic-wrap", "");
      wrap.className = ["relative", /\bflex-1\b/.test(el.className) ? "flex-1" : "", /\bmin-w-0\b/.test(el.className) ? "min-w-0" : "", /\bw-full\b/.test(el.className) || area ? "w-full" : ""].filter(Boolean).join(" ");
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
      el.classList.add("pr-10");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mic-btn ${area ? "top-1.5" : "top-1/2 -translate-y-1/2"}`;
      btn.dataset.action = "mic";
      btn.dataset.state = "idle";
      btn.setAttribute("aria-label", "Dictate into this field");
      btn.title = "Dictate into this field (Arabic, English or a mix)";
      btn.innerHTML = icon("mic");
      wrap.appendChild(btn);
    });
  }
  const micTimers = new WeakMap();
  function micAction(btn) {
    const wrap = btn.closest("[data-mic-wrap]"); const el = wrap && wrap.querySelector("textarea, input"); if (!el) return;
    const state = btn.dataset.state || "idle";
    const clear = () => { const t = micTimers.get(btn); if (t) { clearInterval(t.tick); clearTimeout(t.stop); micTimers.delete(btn); } };
    const finish = () => {
      clear();
      btn.dataset.state = "busy"; btn.setAttribute("aria-label", "Transcribing"); btn.innerHTML = icon("refresh", "h-4 w-4 animate-spin");
      setTimeout(() => {
        const text = micPhrase(el);
        const start = el.selectionStart == null ? el.value.length : el.selectionStart, end = el.selectionEnd == null ? start : el.selectionEnd;
        const before = el.value.slice(0, start), after = el.value.slice(end);
        const sepB = before && !/\s$/.test(before) ? " " : "", sepA = after && !/^\s/.test(after) ? " " : "";
        el.value = before + sepB + text + sepA + after;
        const caret = (before + sepB + text).length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) { /* not every input has a selection */ }
        btn.dataset.state = "idle"; btn.setAttribute("aria-label", "Dictate into this field"); btn.innerHTML = icon("mic");
        toast({ title: "Dictated into the field", description: "Simulated speech-to-text. The application sends the audio to the clinic's provider; Arabic, English or a mix.", tone: "info" });
      }, 700);
    };
    if (state === "listening") { finish(); return; }
    if (state === "busy") return;
    btn.dataset.state = "listening"; btn.setAttribute("aria-label", "Stop dictating");
    btn.innerHTML = `${icon("mic")}<span class="font-mono text-[10px] tabular-nums">00:0<span data-t>0</span></span>`;
    let t = 0;
    const tick = setInterval(() => { t++; const s = btn.querySelector("[data-t]"); if (s) s.textContent = String(Math.min(9, t)); }, 1000);
    micTimers.set(btn, { tick, stop: setTimeout(finish, 2400) });
  }

  // ── Router ──────────────────────────────────────────────────────────────
  function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = hash.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs || ""));
    return { path, query, parts: path.split("/").filter(Boolean) };
  }
  function go(hash) { if (location.hash === "#" + hash) render(); else location.hash = hash; }
  const views = {};
  const actions = {};
  actions.mic = micAction;
  const forms = {};

  const NAV = [
    { href: "/dashboard", label: "Overview", icon: "layout" },
    { href: "/dashboard/patients", label: "Patients", icon: "users" },
    { href: "/dashboard/appointments", label: "Appointments", icon: "calendar" },
    { href: "/dashboard/consultations", label: "Consultations", icon: "stethoscope" },
    { href: "/dashboard/assistant", label: "AI Assistant", icon: "sparkles", badge: "RAG" },
    { href: "/dashboard/conversations", label: "Conversations", icon: "messages" },
    { href: "/dashboard/settings", label: "Settings", icon: "settings" },
  ];
  const PLATFORM_NAV = { href: "/platform", label: "Platform", icon: "building" };
  // The Clinic AI module: the Clinic AI Implementation Spec as a workspace, one entry per spec module.
  const AI_NAV = [
    { href: "/ai", label: "Clinic AI", icon: "sparkles" },
    { href: "/ai/front-desk", label: "1 · AI front desk", icon: "messages" },
    { href: "/ai/preparation", label: "2 · Consultation prep", icon: "file" },
    { href: "/ai/copilot", label: "3 · Documentation copilot", icon: "mic" },
    { href: "/ai/photos", label: "4 · Photography", icon: "eye" },
    { href: "/ai/concierge", label: "5 · Concierge", icon: "shield" },
    { href: "/ai/management", label: "6 · CEO dashboard", icon: "chart" },
    { href: "/ai/rules", label: "AI rules", icon: "key" },
  ];
  const AI_ENTRY = { href: "/ai", label: "Clinic AI", icon: "sparkles", badge: "module" };
  const aiModuleOn = (t) => !!(t && t.modules && t.modules.clinicAi && t.modules.clinicAi.enabled);
  const isActive = (path, href) => path === href || (href !== "/dashboard" && href !== "/ai" && path.startsWith(href));

  function shell(content, r) {
    const u = currentUser(), t = currentTenant();
    const aiProfile = u.profile === "clinic-ai";
    let items = aiProfile ? (aiModuleOn(t) ? AI_NAV : [AI_NAV[0]]) : aiModuleOn(t) ? [...NAV.slice(0, 6), AI_ENTRY, NAV[6]] : NAV.slice();
    if (can(u.role, "platform:manage")) items = [PLATFORM_NAV, ...items];
    const current = items.find((i) => isActive(r.path, i.href));
    const productName = (t.branding && t.branding.productName) || "ClinicMind";
    const logo = t.branding && t.branding.logoUrl ? `<img src="${esc(t.branding.logoUrl)}" alt="" class="h-7 w-7 rounded-md object-contain">` : `<img src="assets/logo.svg" alt="" class="h-7 w-7 rounded-md">`;
    const nav = `<nav class="flex-1 space-y-0.5 p-3" aria-label="Main">${items.map((i) => `<a href="#${i.href}" class="nav-link" ${isActive(r.path, i.href) ? 'aria-current="page"' : ""} data-action="close-drawer"><span class="flex items-center gap-2.5">${icon(i.icon)}${esc(i.label)}</span>${i.badge ? badge(i.badge, "accent") : ""}</a>`).join("")}</nav>`;
    const brand = `<div class="flex h-14 items-center gap-2 border-b border-border px-5">${logo}<div class="flex flex-col leading-none"><span class="font-display text-sm font-semibold tracking-tight">${esc(productName)}</span><span class="font-mono text-[10px] text-muted-foreground">${aiProfile ? "clinic ai module" : "clinic operating system"}</span></div></div>`;
    const tenantCard = `<div class="border-t border-border p-3"><div class="rounded-md bg-muted px-3 py-2"><p class="data-label">${t.id === "ten-platform" ? "platform" : "clinic"}</p><p class="truncate text-sm font-medium">${esc(t.name)}</p></div></div>`;
    const dark = document.documentElement.classList.contains("dark");
    return `<div class="flex min-h-screen bg-background">
      <aside class="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">${brand}${nav}${tenantCard}</aside>
      <div id="drawer" class="hidden"><div class="fixed inset-0 z-40 bg-charcoal-slate/40 lg:hidden" data-action="close-drawer"></div><div class="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-card shadow-xl lg:hidden"><div class="flex items-center justify-between pr-2">${brand}<button class="rounded-md p-2 text-muted-foreground hover:bg-muted" data-action="close-drawer" aria-label="Close navigation">${icon("x")}</button></div>${nav}${tenantCard}</div></div>
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card/70 px-4 backdrop-blur-glass sm:px-6">
          <div class="flex min-w-0 items-center gap-2"><button class="rounded-md p-2 text-muted-foreground hover:bg-muted lg:hidden" data-action="open-drawer" aria-label="Open navigation">${icon("menu", "h-5 w-5")}</button><span class="hidden truncate font-mono text-xs text-muted-foreground sm:inline">${esc(t.name)}</span><span class="hidden text-muted-foreground sm:inline">/</span><span class="truncate text-sm font-medium">${esc(current ? current.label : "Overview")}</span></div>
          <div class="flex items-center gap-1 sm:gap-2">
            <button class="btn btn-ghost btn-icon" data-action="toggle-theme" aria-label="Switch to ${dark ? "light" : "dark"} mode">${icon(dark ? "sun" : "moon")}</button>
            <div class="relative"><button class="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted" data-action="toggle-menu" aria-label="Account menu" aria-haspopup="menu">${avatar(u.fullName || u.email, "h-8 w-8 text-xs")}<span class="hidden text-left sm:block"><span class="block text-sm font-medium leading-tight">${esc(u.fullName || u.email)}</span><span class="block font-mono text-[10px] uppercase text-muted-foreground">${esc(u.title || ROLE_LABEL[u.role] || u.role)}</span></span>${icon("chevron-down", "h-4 w-4 text-muted-foreground")}</button>
              <div id="account-menu" class="hidden absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-border bg-card p-1 shadow-xl" role="menu"><div class="px-3 py-2"><p class="text-sm font-medium">${esc(u.fullName || "")}</p><p class="font-mono text-xs text-muted-foreground">${esc(u.email)}</p></div><div class="my-1 h-px bg-border"></div><button class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted" role="menuitem" data-action="reset-data">${icon("refresh")} Reset demo data</button><button class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted" role="menuitem" data-action="sign-out">${icon("logout")} Sign out</button></div></div>
          </div>
        </header>
        <main class="flex-1 overflow-y-auto p-4 sm:p-6">${content}</main>
      </div></div>`;
  }

  function render() {
    if (!S) load();
    const r = route();
    const app = $("#app");
    closeDialog();
    const u = currentUser();
    // Theme + branding
    document.documentElement.classList.toggle("dark", theme() === "dark");
    const protectedPath = r.path.startsWith("/dashboard") || r.path.startsWith("/platform") || r.path === "/ai" || r.path.startsWith("/ai/");
    if (protectedPath && !u) { setSession(null); location.hash = `/login?next=${encodeURIComponent(r.path)}`; return; }
    if (r.path.startsWith("/platform") && u && !can(u.role, "platform:manage")) { location.hash = "/dashboard"; return; }
    if (protectedPath) applyBranding(currentTenant().branding);
    else if (r.path === "/login" && r.query.tenant) { const t = tenantBySlug(r.query.tenant); applyBranding(t && t.branding); }
    else applyBranding(null);

    let html = "";
    try {
      if (r.path === "/" ) html = views.landing(r);
      else if (r.path === "/login") html = views.login(r);
      else if (r.path === "/forgot-password") html = views.forgot(r);
      else if (r.parts[0] === "invite") html = views.invite(r);
      else if (r.parts[0] === "embed") html = views.embed(r);
      else if (r.parts[0] === "intake") html = views.intakeForm(r);
      else if (r.parts[0] === "ai") html = shell(views.ai(r), r);
      else if (r.path === "/dashboard") html = shell(views.overview(r), r);
      else if (r.parts[1] === "patients" && r.parts[2]) html = shell(views.patient(r, r.parts[2]), r);
      else if (r.parts[1] === "patients") html = shell(views.patients(r), r);
      else if (r.parts[1] === "appointments") html = shell(views.appointments(r), r);
      else if (r.parts[1] === "consultations") html = shell(views.consultations(r), r);
      else if (r.parts[1] === "assistant") html = shell(views.assistant(r), r);
      else if (r.parts[1] === "conversations") html = shell(views.conversations(r), r);
      else if (r.parts[1] === "settings") html = shell(views.settings(r), r);
      else if (r.path === "/platform") html = shell(views.platform(r), r);
      else if (r.parts[0] === "platform" && r.parts[1] === "tenants" && r.parts[2]) html = shell(views.tenant(r, r.parts[2]), r);
      else html = views.notFound(r);
    } catch (err) {
      console.error(err);
      html = `<div class="p-10">${alert(`Something went wrong rendering this page: ${esc(err.message)}`)}</div>`;
    }
    app.innerHTML = html;
    enhanceMics(app);
    window.scrollTo(0, 0);
    document.title = `${(currentTenant() && currentTenant().branding && currentTenant().branding.productName) || "ClinicMind"} — ${r.path === "/" ? "Clinic operating system" : r.parts.slice(-1)[0].replace(/-/g, " ")}`;
    if (views.afterRender) views.afterRender(r);
  }

  // ── Global event delegation ─────────────────────────────────────────────
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) { const m = $("#account-menu"); if (m && !ev.target.closest("[data-action=toggle-menu]")) m.classList.add("hidden"); return; }
    const name = el.dataset.action;
    if (name === "close-dialog") { closeDialog(); if (confirmResolver) { confirmResolver(false); confirmResolver = null; } return; }
    if (name === "confirm-yes") { closeDialog(); if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(true); } return; }
    if (name === "confirm-no") { closeDialog(); if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(false); } return; }
    if (name === "dismiss-toast") { el.closest(".toast").remove(); return; }
    if (name === "open-drawer") { $("#drawer").classList.remove("hidden"); return; }
    if (name === "close-drawer") { const d = $("#drawer"); if (d) d.classList.add("hidden"); return; }
    if (name === "toggle-theme") { setTheme(theme() === "dark" ? "light" : "dark"); render(); return; }
    if (name === "toggle-menu") { $("#account-menu").classList.toggle("hidden"); return; }
    if (name === "sign-out") { logout(); location.hash = "/login"; return; }
    if (name === "reset-data") { confirmDialog({ title: "Reset the demo data?", description: "Rebuilds the clinic as seeded, centred on today. Everything you created or changed in this browser is removed.", confirmLabel: "Reset demo data", tone: "danger" }).then((ok) => { if (ok) { reset(); toast({ title: "Demo data rebuilt" }); render(); } }); return; }
    if (actions[name]) { ev.preventDefault(); actions[name](el, ev); }
  });
  document.addEventListener("submit", (ev) => {
    const form = ev.target.closest("form[data-form]");
    if (!form) return;
    ev.preventDefault();
    const name = form.dataset.form;
    const data = Object.fromEntries(new FormData(form).entries());
    if (forms[name]) forms[name](data, form);
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeDialog(); if (confirmResolver) { confirmResolver(false); confirmResolver = null; } const d = $("#drawer"); if (d) d.classList.add("hidden"); } });
  window.addEventListener("hashchange", render);

  return {
    get S() { return S; }, load, save, reset, newId, logAudit, audit,
    session, currentUser, currentTenant, tenantById, tenantBySlug, login, logout, can, ROLE_LABEL,
    tid, scoped, patients, appointments, visits, consultations, conversations, medications, timeline, staff, doctors, patient, user,
    esc, fmtDate, fmtLongDate, fmtTime, dayKey, parseDay, addDays, age, initials, n, todayKey, pad, MONTHS, DAYS,
    icon, badge, card, sectionTitle, tabStrip, metric, emptyState, field, alert, avatar, toast, openDialog, closeDialog, confirmDialog,
    route, go, render, views, actions, forms, applyBranding, hexToHsl, theme, setTheme, NAV, AI_NAV, aiModuleOn,
  };
})();
