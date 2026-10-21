/* ClinicMind demo SPA — hash router + views. Pure client-side. */
(function () {
  const D = window.CM_DATA, C = window.CM_CHARTS;
  const $ = (s, r = document) => r.querySelector(s);

  const ic = {
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87',
    cal: 'M3 4h18v18H3zM3 10h18M8 2v4M16 2v4',
    steth: 'M6 3v6a4 4 0 0 0 8 0V3M10 13v3a5 5 0 0 0 10 0v-1M20 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
    spark: 'M5 3v16h16M8 13l3-4 3 3 4-6',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    report: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
    bolt: 'M13 2 3 14h7l-1 8 10-12h-7z',
  };
  const svg = (p, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${p}"/></svg>`;

  const NAV = [
    { id: "overview", label: "Overview", icon: "grid" },
    { id: "patients", label: "Patients", icon: "users" },
    { id: "appointments", label: "Appointments", icon: "cal" },
    { id: "consultation", label: "Consultation", icon: "steth" },
    { id: "assistant", label: "AI Assistant", icon: "spark", badge: "RAG" },
    { id: "conversations", label: "Conversations", icon: "chat" },
    { id: "report", label: "Production Report", icon: "report", badge: "DOC" },
  ];

  const statusTone = {
    CONFIRMED: "accent", CHECKED_IN: "accent", IN_PROGRESS: "accent",
    COMPLETED: "success", SCHEDULED: "", WAITLISTED: "warning", NO_SHOW: "danger",
  };
  const riskTone = { high: "danger", moderate: "warning", low: "success" };
  const initials = (n) => n.split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  const money = (n) => "EGP " + n.toLocaleString("en-US");

  // ---- Views -------------------------------------------------------------
  const views = {
    overview() {
      const m = D.metrics;
      return `
      <div class="stack">
        <div class="section-head"><div><h2>Clinic Intelligence</h2><div class="desc">Real-time operating metrics across appointments, patients and AI activity.</div></div><span class="badge accent">7-day window</span></div>
        <div class="bento">
          ${metric("Total Patients", m.patients.toLocaleString(), "accent")}
          ${metric("Appointments Today", m.appointmentsToday)}
          ${metric("Upcoming", m.upcoming)}
          ${metric("No-show Rate", Math.round(m.noShowRate * 100) + "%", m.noShowRate > 0.15 ? "warn" : "")}
        </div>
        <div class="bento">
          <div class="card col-2"><div class="section-head"><div><h3>Appointment Volume</h3><div class="desc">Daily booked appointments</div></div></div>${C.spark(D.appointmentTrend)}</div>
          <div class="card"><div class="data-label">AI activity (7d)</div><div class="metric accent" style="margin:6px 0">${m.aiInteractions}</div><div class="data-label" style="margin-top:10px">Active consultations</div><div class="metric" style="font-size:22px">${m.activeConsultations}</div></div>
          <div class="card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">${C.donut(m.retention, "retention")}<div class="data-label">${money(m.revenueMonth)} / mo</div></div>
        </div>
        <div class="card"><div class="section-head"><div><h3>Diagnoses Distribution</h3><div class="desc">Most frequent diagnoses across the population</div></div></div>${C.bars(D.diagnoses)}</div>
      </div>`;
    },

    patients() {
      const rows = D.patients.map((p) => `
        <tr>
          <td><div class="row" style="align-items:center;gap:10px"><span class="avatar">${initials(p.name)}</span><b>${p.name}</b></div></td>
          <td class="mono" style="color:var(--muted)">${p.age}</td>
          <td class="mono" style="color:var(--muted);font-size:12px">${p.phone}</td>
          <td><div class="pill-list">${(p.conditions.length ? p.conditions : ["—"]).map((c) => `<span class="badge">${c}</span>`).join("")}</div></td>
          <td><span class="badge ${riskTone[p.risk]}">${p.risk}</span></td>
          <td class="mono" style="text-align:right;color:var(--muted);font-size:12px">${p.appts} appts · ${p.visits} visits</td>
        </tr>`).join("");
      return `<div class="stack">
        <div class="section-head"><div><h2>Patient CRM</h2><div class="desc">Unified patient registry with clinical context.</div></div><span class="badge accent">${D.metrics.patients.toLocaleString()} records</span></div>
        <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Patient</th><th>Age</th><th>Contact</th><th>Conditions</th><th>Risk</th><th style="text-align:right">Activity</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    },

    appointments() {
      const days = ["Today", "Tomorrow", "Wed", "Thu"];
      const cols = days.map((label, d) => {
        const list = D.appointments.filter((a) => a.day === d);
        const items = list.length ? list.map((a) => `
          <div class="card tight" style="margin-bottom:8px">
            <div class="row" style="justify-content:space-between;align-items:center"><span class="mono">${a.time}</span><span class="badge ${statusTone[a.status]}">${a.status}</span></div>
            <div style="font-weight:600;margin-top:4px">${a.patient}</div><div style="color:var(--muted);font-size:12px">${a.reason}</div>
          </div>`).join("") : '<div style="color:var(--muted);text-align:center;padding:18px">—</div>';
        return `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:10px"><span class="data-label">${label}</span><span class="mono" style="color:var(--muted)">${list.length}</span></div>${items}</div>`;
      }).join("");
      return `<div class="stack">
        <div class="section-head"><div><h2>Appointments</h2><div class="desc">Week schedule with conflict detection &amp; waitlist.</div></div><span class="badge accent">${D.appointments.length} this week</span></div>
        <div class="week-grid">${cols}</div>
      </div>`;
    },

    consultation() {
      const c = D.consultation;
      return `<div class="stack">
        <div class="section-head"><div><h2>Consultation Intelligence</h2><div class="desc">Record → transcribe → extract → review → sign. Decisions are never auto-saved.</div></div><span class="badge">${c.patient}</span></div>
        <div class="grid-2">
          <div class="card stack">
            <div class="section-head"><div><h3>Transcript</h3></div><span class="badge danger">● live transcription</span></div>
            <div class="mono" style="white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:var(--muted-bg);border-radius:8px;padding:14px;max-height:340px;overflow:auto">${c.transcript}</div>
            <button class="btn" id="extractBtn">${svg(ic.bolt, 16)} Extract clinical data</button>
          </div>
          <div class="card stack" id="reviewPane">
            <div class="section-head"><div><h3>Review &amp; Sign</h3><div class="desc">AI-extracted. Edit before signing — nothing saved automatically.</div></div></div>
            <div id="extractionOut" style="color:var(--muted);text-align:center;padding:36px 0">Run extraction to review the structured output.</div>
          </div>
        </div>
      </div>`;
    },

    assistant() {
      const sugg = ["Show me patients who missed follow-ups", "Summarize today's appointments", "Find high-risk diabetic patients", "Compare Ahmed and Mohamed's hypertension progress"];
      return `<div class="stack">
        <div class="section-head"><div><h2>Doctor AI Assistant</h2><div class="desc">Retrieval-grounded clinical chat over your tenant's records — answers with citations.</div></div><span class="badge accent">RAG · grounded</span></div>
        <div class="card chat">
          <div class="chat-scroll" id="chatScroll">
            <div style="text-align:center;color:var(--muted);margin:auto;max-width:480px">
              <div style="font-weight:600;color:var(--fg);margin-bottom:6px">Ask in natural language</div>
              <div style="margin-bottom:16px">Every answer is grounded in the clinic's records via retrieval — never an ungrounded guess.</div>
              <div class="suggest">${sugg.map((s) => `<button onclick="window.__ask('${s.replace(/'/g, "\\'")}')">${s}</button>`).join("")}</div>
            </div>
          </div>
          <div class="chat-input"><input id="chatInput" placeholder="Ask about patients, appointments, trends…" onkeydown="if(event.key==='Enter')window.__ask(this.value)"><button class="btn" onclick="window.__ask(document.getElementById('chatInput').value)">Send</button></div>
        </div>
      </div>`;
    },

    conversations() {
      const cards = D.conversations.map((c) => `
        <div class="card stack" style="gap:8px">
          <div class="row" style="justify-content:space-between"><span class="badge ${c.channel === "WHATSAPP" ? "success" : "accent"}">${c.channel}</span><span class="mono" style="color:var(--muted)">${c.locale}</span></div>
          <div style="font-weight:600">${c.patient}</div>
          <div style="color:var(--muted);font-size:13px">${c.summary}</div>
          <div class="mono" style="color:var(--muted);font-size:10px">${c.msgs} messages</div>
        </div>`).join("");
      return `<div class="stack">
        <div class="section-head"><div><h2>Conversations</h2><div class="desc">AI receptionist (WhatsApp) &amp; voice agent — Arabic, Egyptian Arabic &amp; English.</div></div><span class="badge accent">${D.conversations.length} threads</span></div>
        <div class="grid-2">${cards}</div>
      </div>`;
    },

    report() { return window.CM_REPORT(); },
  };

  function metric(label, value, tone = "") {
    return `<div class="card"><div class="data-label">${label}</div><div class="metric ${tone}" style="margin-top:6px">${value}</div></div>`;
  }

  // ---- Assistant behavior ----------------------------------------------
  window.__ask = function (text) {
    text = (text || "").trim(); if (!text) return;
    const scroll = $("#chatScroll"); if (!scroll) return;
    if (scroll.querySelector(".suggest")) scroll.innerHTML = "";
    scroll.insertAdjacentHTML("beforeend", `<div class="bubble user">${esc(text)}</div>`);
    const input = $("#chatInput"); if (input) input.value = "";
    scroll.scrollTop = scroll.scrollHeight;

    const typing = document.createElement("div");
    typing.className = "bubble ai"; typing.innerHTML = '<span class="data-label">retrieving + reasoning…</span>';
    scroll.appendChild(typing); scroll.scrollTop = scroll.scrollHeight;

    setTimeout(() => {
      const hit = matchAnswer(text);
      const cites = hit.citations ? `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${hit.citations.map((c, i) => `<div class="cite"><span class="n">[${i + 1}]</span><span><b class="mono" style="text-transform:uppercase;font-size:10px">${c.source}</b> — ${esc(c.snippet)}</span></div>`).join("")}</div>` : "";
      const meta = `<div class="row" style="gap:6px;margin-top:8px"><span class="badge">gemini</span><span class="badge ${hit.confidence > 0.6 ? "success" : "warning"}">${Math.round(hit.confidence * 100)}% conf</span></div>`;
      typing.innerHTML = `<div style="white-space:pre-wrap">${esc(hit.answer)}</div>${cites}${meta}`;
      scroll.scrollTop = scroll.scrollHeight;
    }, 650);
  };

  function matchAnswer(text) {
    const t = text.toLowerCase();
    for (const a of D.assistant) if (a.match.every((m) => t.includes(m)) || a.match.some((m) => t.includes(m)) && a.match.filter((m) => t.includes(m)).length >= Math.min(2, a.match.length)) return a;
    for (const a of D.assistant) if (a.match.some((m) => t.includes(m))) return a;
    return { answer: "I couldn't retrieve records matching that query in the demo dataset. Try one of the suggested questions — in production I search the full tenant knowledge base via RAG.", citations: null, confidence: 0.2 };
  }

  // ---- Consultation behavior -------------------------------------------
  function wireConsultation() {
    const btn = $("#extractBtn"); if (!btn) return;
    btn.addEventListener("click", () => {
      const out = $("#extractionOut"); const e = D.consultation.extraction;
      out.innerHTML = '<span class="data-label">extracting…</span>';
      setTimeout(() => {
        const field = (l, items) => `<div><div class="data-label" style="margin-bottom:4px">${l}</div><div class="pill-list">${items.length ? items.map((i) => `<span class="badge accent">${i}</span>`).join("") : "—"}</div></div>`;
        out.style.padding = "0"; out.style.textAlign = "left"; out.style.color = "var(--fg)";
        out.innerHTML = `<div class="stack" style="gap:12px">
          ${field("Symptoms", e.symptoms)}
          ${field("Diagnoses", e.diagnoses)}
          ${field("Medications", e.medications.map((m) => `${m.name} · ${m.dosage} · ${m.frequency}`))}
          ${field("Tests", e.tests)}
          ${field("Follow-ups", e.followUps)}
          <div><div class="data-label" style="margin-bottom:4px">Visit summary</div><div style="background:var(--muted-bg);border-radius:8px;padding:12px;line-height:1.55">${D.consultation.summary}</div></div>
          <button class="btn" id="signBtn">✓ Review complete — sign</button>
        </div>`;
        $("#signBtn").addEventListener("click", function () {
          this.outerHTML = '<span class="badge success" style="padding:8px 12px">✓ Signed &amp; saved to patient record</span>';
        });
      }, 600);
    });
  }

  // ---- Router -----------------------------------------------------------
  function route() {
    const id = (location.hash.replace("#", "") || "overview");
    const view = views[id] ? id : "overview";
    $("#content").innerHTML = views[view]();
    $("#crumb").textContent = NAV.find((n) => n.id === view).label;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.id === view));
    if (view === "consultation") wireConsultation();
    $(".content").scrollTop = 0; window.scrollTo(0, 0);
  }

  function renderShell() {
    const nav = NAV.map((n) => `<a data-id="${n.id}" href="#${n.id}"><span style="display:flex;align-items:center;gap:10px"><span class="ic">${svg(ic[n.icon])}</span>${n.label}</span>${n.badge ? `<span class="badge accent">${n.badge}</span>` : ""}</a>`).join("");
    document.body.innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand"><img class="logo-img" src="assets/logo.svg" alt="ClinicMind" width="30" height="30" /><div><div class="name">ClinicMind</div><div class="sub">medical ai os</div></div></div>
          <nav class="nav">${nav}</nav>
          <div class="foot"><div class="tenant-pill"><div class="l">tenant</div><div class="v">${D.tenant.name}</div></div></div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="crumbs"><span class="mono t">${D.tenant.name}</span><span class="t">/</span><span id="crumb" style="font-weight:600">Overview</span></div>
            <div class="row" style="gap:8px;align-items:center">
              <button class="btn ghost sm" id="themeBtn" title="Toggle theme">${svg(ic.moon, 16)}</button>
              <span class="badge success">live</span>
            </div>
          </header>
          <main class="content" id="content"></main>
        </div>
      </div>`;
    $("#themeBtn").addEventListener("click", () => document.documentElement.classList.toggle("dark"));
    window.addEventListener("hashchange", route);
    route();
  }

  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  document.addEventListener("DOMContentLoaded", renderShell);
})();
