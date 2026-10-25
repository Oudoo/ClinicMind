/* Reporting schema for the CEO dashboard (Module 6 of the Clinic AI
   Implementation Spec): the nightly copies of the operational tables plus the
   ads, payments, check-in and review imports, 26 weeks deep so every period on
   the dashboard has a comparison period. Deterministic; called from data.js
   after the operational seed and the module seed, with the same random stream. */
window.CM_SEED_REPORTING = (function () {
  const DAYS_BACK = 181; // 26 weeks including today

  const TREATMENTS = [
    { key: "transplant", name: "Hair transplant", short: "Transplant", doctor: "hair", consultFee: 500, price: [45000, 90000], deposit: 5000, procRate: 0.3, bookRate: 0.34, weight: 0.22, checkins: [1, 3, 7, 14, 30, 90, 180], satAt: 30 },
    { key: "hairloss", name: "Hair loss / PRP", short: "Hair loss", doctor: "hair", consultFee: 600, price: [7500, 9000], deposit: 500, procRate: 0.46, bookRate: 0.4, weight: 0.18, checkins: [2, 7, 14, 28], satAt: 14 },
    { key: "acne", name: "Acne", short: "Acne", doctor: "derm", consultFee: 600, price: [1500, 2200], deposit: 0, procRate: 0.36, bookRate: 0.44, weight: 0.2, checkins: [2, 7, 14], satAt: 14 },
    { key: "pigmentation", name: "Pigmentation / melasma", short: "Pigmentation", doctor: "derm", consultFee: 600, price: [3000, 3500], deposit: 500, procRate: 0.41, bookRate: 0.38, weight: 0.13, checkins: [2, 7, 14], satAt: 14 },
    { key: "laser", name: "Laser hair removal", short: "Laser", doctor: "derm", consultFee: 0, price: [1200, 7200], deposit: 0, procRate: 0.62, bookRate: 0.47, weight: 0.17, checkins: [2, 7, 14], satAt: 14 },
    { key: "general", name: "General dermatology", short: "General", doctor: "derm", consultFee: 600, price: [800, 2000], deposit: 0, procRate: 0.16, bookRate: 0.52, weight: 0.1, checkins: [7, 14], satAt: 14 },
  ];
  const SOURCES = [
    { key: "wa-ad", name: "Click-to-WhatsApp ad", channel: "WHATSAPP", book: 0.9, noShow: 1.3 },
    { key: "ig-organic", name: "Instagram organic", channel: "INSTAGRAM", book: 0.85, noShow: 1.1 },
    { key: "website", name: "Website", channel: "WEB", book: 1.0, noShow: 1.0 },
    { key: "referral", name: "Referral", channel: "WHATSAPP", book: 1.35, noShow: 0.55 },
    { key: "walk-in", name: "Walk-in", channel: "PHONE", book: 1.3, noShow: 0.7 },
    { key: "phone", name: "Phone", channel: "PHONE", book: 1.1, noShow: 0.95 },
  ];
  const SOURCE_W = { transplant: [0.44, 0.24, 0.12, 0.09, 0.03, 0.08], hairloss: [0.3, 0.22, 0.16, 0.14, 0.06, 0.12], acne: [0.28, 0.26, 0.16, 0.12, 0.08, 0.1], pigmentation: [0.22, 0.24, 0.22, 0.14, 0.08, 0.1], laser: [0.34, 0.22, 0.14, 0.1, 0.1, 0.1], general: [0.1, 0.14, 0.22, 0.24, 0.16, 0.14] };
  const CAMPAIGNS = [
    { id: "cmp-meta-transplant", name: "Meta · Hair transplant (click-to-WhatsApp)", platform: "Meta", treatment: "transplant", source: "wa-ad", weeklySpend: 4600, from: -DAYS_BACK, to: 0, creatives: ["Video · 12-month result", "Carousel · graft count explained", "Static · candidacy consultation"] },
    { id: "cmp-meta-acne", name: "Meta · Adult acne", platform: "Meta", treatment: "acne", source: "wa-ad", weeklySpend: 1500, from: -DAYS_BACK, to: 0, creatives: ["Reel · skincare routine", "Static · consultation EGP 600"] },
    { id: "cmp-meta-laser", name: "Meta · Laser summer offer", platform: "Meta", treatment: "laser", source: "wa-ad", weeklySpend: 1900, from: -70, to: 0, creatives: ["Static · 6-session bundle", "Reel · patch test"], broken: true },
    { id: "cmp-meta-other", name: "Meta · Always-on (other treatments)", platform: "Meta", treatment: null, source: "wa-ad", weeklySpend: 900, from: -DAYS_BACK, to: 0, creatives: ["Static · clinic tour", "Reel · doctor introductions"] },
    { id: "cmp-google-brand", name: "Google · Brand search", platform: "Google", treatment: null, source: "website", weeklySpend: 800, from: -DAYS_BACK, to: 0, creatives: ["Brand exact", "Brand + Maadi"] },
    { id: "cmp-google-melasma", name: "Google · Melasma treatment Cairo", platform: "Google", treatment: "pigmentation", source: "website", weeklySpend: 1100, from: -120, to: 0, creatives: ["Melasma laser", "Pigmentation clinic Cairo"] },
  ];
  const LOST_REASONS = ["No response", "Price", "Timing", "Chose competitor", "Distance", "Not a fit", "Other"];
  const LOST_W = [0.38, 0.22, 0.12, 0.09, 0.08, 0.07, 0.04];
  const OBJECTIONS = ["Price", "Timing", "Downtime", "Pain", "Results doubt", "Trust"];
  const OBJECTION_W = [0.4, 0.18, 0.14, 0.1, 0.1, 0.08];
  const CHANNELS = ["WHATSAPP", "INSTAGRAM", "WEB", "PHONE"];

  // The spec's success-metrics table: baseline in week 1, 90-day target, the screen that reports it.
  const TARGETS = [
    { key: "frtMedian", module: 1, metric: "Median first-response time, all channels, all hours", baseline: "4 min 10 s (WhatsApp export)", target: "under 1 minute", targetValue: 60, dir: "down", unit: "s", screen: "today" },
    { key: "leadToConsult", module: 1, metric: "Lead to consultation conversion", baseline: "28% (booking records)", target: "up 25% relative: 35%", targetValue: 35, dir: "up", unit: "%", screen: "funnel" },
    { key: "aiHandled", module: 1, metric: "Share of enquiries handled without a human", baseline: "0", target: "60% or more, handover under 20%", targetValue: 60, dir: "up", unit: "%", screen: "ai" },
    { key: "recovered", module: 1, metric: "Leads recovered by follow-up sequences", baseline: "0", target: "10% of silent leads book", targetValue: 10, dir: "up", unit: "%", screen: "funnel" },
    { key: "phoneAnswered", module: 1, metric: "Phone calls answered", baseline: "71% within 3 rings (call logs)", target: "100% within 3 rings, 24 hours", targetValue: 100, dir: "up", unit: "%", screen: "today" },
    { key: "intakeBefore", module: 2, metric: "Intake completed before arrival", baseline: "0", target: "80%", targetValue: 80, dir: "up", unit: "%", screen: "patients" },
    { key: "briefUseful", module: 2, metric: "Doctor-rated brief usefulness", baseline: "none", target: "4 of 5 or better", targetValue: 4, dir: "up", unit: "/5", screen: "ai" },
    { key: "docMinutes", module: 3, metric: "Documentation time per consultation", baseline: "about 12 minutes (timed sample)", target: "under 4 minutes", targetValue: 4, dir: "down", unit: "min", screen: "doctors" },
    { key: "notesFewEdits", module: 3, metric: "Notes signed with 3 or fewer edits", baseline: "none", target: "90%", targetValue: 90, dir: "up", unit: "%", screen: "ai" },
    { key: "photoSets", module: 4, metric: "Complete photo sets at baseline and months 1, 3, 6, 12", baseline: "41% (current folders)", target: "90% of transplant patients", targetValue: 90, dir: "up", unit: "%", screen: "patients" },
    { key: "checkinResponse", module: 5, metric: "Check-in response rate", baseline: "none", target: "90%", targetValue: 90, dir: "up", unit: "%", screen: "patients" },
    { key: "highRiskAck", module: 5, metric: "High-risk replies acknowledged within target", baseline: "none", target: "100%", targetValue: 100, dir: "up", unit: "%", screen: "today" },
    { key: "satisfaction", module: 5, metric: "Patient satisfaction at month 1 (transplant) and day 14 (other)", baseline: "none", target: "4.5 of 5 average", targetValue: 4.5, dir: "up", unit: "/5", screen: "patients" },
    { key: "reviewsMonthly", module: 5, metric: "Review volume on Google", baseline: "11 a month (current count)", target: "2x the monthly rate: 22", targetValue: 22, dir: "up", unit: "/month", screen: "patients" },
    { key: "reconciliation", module: 6, metric: "Dashboard numbers reconciled to manual counts", baseline: "none", target: "within 2%", targetValue: 2, dir: "down", unit: "%", screen: "ai" },
    { key: "spendAttributed", module: 6, metric: "Campaigns with measured cost per procedure", baseline: "0", target: "90% of spend attributed", targetValue: 90, dir: "up", unit: "%", screen: "marketing" },
    { key: "aiCost", module: "All", metric: "AI variable cost per enquiry, consultation and procedure", baseline: "none", target: "within the cost model's ranges", targetValue: null, dir: "down", unit: "", screen: "ai" },
    { key: "clinicalStatements", module: "All", metric: "Clinical statements by the AI found in audits", baseline: "none", target: "0", targetValue: 0, dir: "down", unit: "", screen: "ai" },
  ];

  function generate(ctx) {
    const { rand, pick, chance, between, id, at, today, dayKey, STAFF } = ctx;
    const now = new Date();
    const gauss = () => { const u = Math.max(rand(), 1e-9), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const weighted = (xs, ws) => { let r = rand() * ws.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { r -= ws[i]; if (r <= 0) return xs[i]; } return xs[xs.length - 1]; };
    const logn = (median, sigma) => Math.round(Math.exp(Math.log(median) + gauss() * sigma));
    const hair = STAFF.find((s) => s.id === "u-omar"), layla = STAFF.find((s) => s.id === "u-owner"), mariam = STAFF.find((s) => s.id === "u-mariam");
    const nurse = STAFF.find((s) => s.id === "u-nurse"), reception = STAFF.find((s) => s.id === "u-reception");
    const DOCTOR_F = { "u-omar": 1.1, "u-owner": 1.0, "u-mariam": 0.9 };
    const NOSHOW_DOC = { "u-omar": 0.95, "u-owner": 0.9, "u-mariam": 1.2 };
    const progressOf = (d) => (d + DAYS_BACK) / DAYS_BACK; // 0 at the start of the window, 1 today
    const campaignFor = (t, source, d) => {
      const active = CAMPAIGNS.filter((c) => c.source === source && d >= c.from && d <= c.to);
      if (!active.length) return null;
      const exact = active.find((c) => c.treatment === t.key);
      if (exact) return exact;
      if (source === "website") return chance(0.55) ? active.find((c) => c.id === "cmp-google-brand") || null : null; // the rest is organic search
      return active.find((c) => !c.treatment) || null;
    };

    // ── Leads: the funnel from enquiry to signed procedure ─────────────────
    const leads = [];
    for (let d = -DAYS_BACK; d <= 0; d++) {
      const day = at(d, 0, 0), dow = day.getDay(), progress = progressOf(d);
      const base = dow === 5 ? 2.4 : 7.4;
      const trend = 1 + 0.28 * progress;
      const burst = d > -21 ? 1.25 : 1; // the October transplant push
      const count = Math.max(1, Math.round(base * trend * burst * (0.7 + rand() * 0.6)));
      const extra = d >= -70 && dow !== 5 ? between(1, 3) : 0; // the laser offer: cheap clicks, price shoppers
      for (let i = 0; i < count + extra; i++) {
        const offer = i >= count;
        const t = offer ? TREATMENTS.find((x) => x.key === "laser") : weighted(TREATMENTS, TREATMENTS.map((x) => x.weight * (x.key === "transplant" && d > -21 ? 1.5 : 1)));
        const src = offer ? SOURCES[0] : weighted(SOURCES, SOURCE_W[t.key]);
        const attributed = offer || !chance(0.07);
        const campaign = offer ? CAMPAIGNS.find((c) => c.id === "cmp-meta-laser") : attributed ? campaignFor(t, src.key, d) : null;
        const hour = weighted([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], [2, 5, 8, 9, 8, 6, 5, 5, 6, 7, 8, 8, 7, 4, 2]);
        const createdAt = at(d, hour, between(0, 59));
        if (createdAt > now) continue;
        const channel = src.channel;
        // First response: AI share grows as the front desk moves from shadow to assist to auto.
        let pAi = 0.35 + 0.37 * progress; if (channel === "PHONE") pAi *= 0.55;
        const by = chance(pAi) ? "ai" : "human";
        let sec = by === "ai" ? logn(38, 0.5) : logn(330, 0.9);
        if (by === "human" && (hour >= 20 || hour < 10)) sec = Math.round(sec * 2.2);
        if (by === "human" && channel === "INSTAGRAM") sec = Math.round(sec * 1.6);
        if (channel === "INSTAGRAM" && hour >= 20 && d > -14) sec = Math.round(sec * 5); // the Instagram token expired after 20:00; shadow mode
        const aiHandled = by === "ai" && chance(0.82);
        const handover = by === "ai" && !aiHandled;
        const objections = []; if (chance(t.key === "transplant" ? 0.55 : 0.35)) objections.push(weighted(OBJECTIONS, OBJECTION_W)); if (chance(0.15)) { const o = weighted(OBJECTIONS, OBJECTION_W); if (!objections.includes(o)) objections.push(o); }
        const respF = sec < 60 ? 1.15 : sec < 600 ? 1 : 0.75;
        const broken = !!(campaign && campaign.broken);
        const pBook = broken ? 0 : Math.min(0.92, t.bookRate * src.book * respF * (objections.includes("Price") ? 0.85 : 1) * (1 + 0.12 * progress));
        const lead = { id: id("rl"), createdAt: createdAt.toISOString(), day: d, hour, dow, treatment: t.key, source: attributed ? src.key : "unknown", channel, campaignId: campaign ? campaign.id : null, attributed, responseBy: by, responseSec: sec, aiHandled, handover, objections, booked: false, consultationAt: null, attended: false, noShow: false, doctorId: null, deposit: false, intakeBefore: false, docMinutes: null, docEdits: null, procedure: null, lost: null, followUp: null, recovered: false, checkins: [] };
        if (chance(pBook)) {
          const silentFirst = chance(0.14); // booked only after a follow-up step
          const consultAt = new Date(createdAt.getTime() + between(2, 18) * 86400000); consultAt.setHours(weighted([10, 11, 12, 13, 14, 15, 16, 17, 18, 19], [1, 2, 2, 2, 2, 2, 2, 2, 2, 1]), pick([0, 15, 30, 45]), 0, 0);
          if (consultAt.getDay() === 5) consultAt.setDate(consultAt.getDate() + 1);
          lead.booked = true; lead.recovered = silentFirst; lead.consultationAt = consultAt.toISOString();
          lead.doctorId = t.doctor === "hair" ? hair.id : chance(0.55) ? layla.id : mariam.id;
          lead.deposit = chance(0.35);
          if (consultAt <= now) {
            let pNo = 0.1 * src.noShow * (lead.deposit ? 0.3 : 1.05) * (consultAt.getDay() === 4 ? 1.45 : consultAt.getDay() === 6 ? 1.15 : 1) * NOSHOW_DOC[lead.doctorId];
            lead.noShow = chance(Math.min(0.5, pNo)); lead.attended = !lead.noShow;
            if (lead.attended) {
              lead.intakeBefore = chance(0.55 + 0.3 * progress);
              const adopt = Math.max(0, Math.min(1, (progress - 0.3) / 0.45)); // the copilot arrives a third of the way in
              lead.docMinutes = Math.max(2.5, Math.round((12 - 7.6 * adopt + gauss() * 1.6) * 10) / 10);
              lead.docEdits = Math.max(0, Math.round((3.4 - 1.9 * adopt) + gauss() * 1.4));
              const pProc = t.procRate * DOCTOR_F[lead.doctorId] * (objections.includes("Price") ? 0.8 : 1);
              if (chance(pProc)) {
                const signedAt = new Date(consultAt.getTime() + between(0, 40) * 86400000);
                if (signedAt <= now) {
                  const procNoShow = chance(0.025);
                  const performedAt = new Date(signedAt.getTime() + (between(2, 21) + (procNoShow ? 10 : 0)) * 86400000);
                  const revenue = t.key === "laser" ? pick([1200, 6400, 7200, 7200]) : between(t.price[0], t.price[1]);
                  lead.procedure = { signedAt: signedAt.toISOString(), performedAt: performedAt.toISOString(), performed: performedAt <= now, noShow: procNoShow, doctorId: lead.doctorId, treatment: t.key, revenue, deposit: t.deposit, refund: chance(0.03) ? t.deposit : 0 };
                  // Concierge check-ins after the procedure, with satisfaction at month 1 (transplant) or day 14.
                  if (performedAt <= now) {
                    for (const off of t.checkins) {
                      const sentAt = new Date(performedAt.getTime() + off * 86400000); if (sentAt > now) break;
                      const answered = chance(0.84 + 0.09 * progress); const within24 = answered && chance(0.88); const high = answered && chance(0.05);
                      const c = { offset: off, sentAt: sentAt.toISOString(), answered, within24, high, escalated: high, acked: high ? chance(0.96) : null, ownerId: high ? (chance(0.7) ? nurse.id : hair.id) : null, satisfaction: null };
                      if (answered && off === t.satAt) c.satisfaction = weighted([5, 4, 3, 2, 1], t.key === "transplant" ? [0.66, 0.26, 0.05, 0.02, 0.01] : t.key === "laser" ? [0.52, 0.34, 0.1, 0.03, 0.01] : [0.56, 0.32, 0.08, 0.03, 0.01]);
                      lead.checkins.push(c);
                    }
                  }
                }
              }
            }
          }
        }
        if (!lead.booked) {
          const ageDays = -d;
          if (ageDays > 14) lead.lost = { reason: broken ? weighted(["No response", "Price", "Timing"], [0.7, 0.2, 0.1]) : weighted(LOST_REASONS, LOST_W), stage: weighted(["First reply", "Qualifying", "Quoted", "Booked, no-show"], [0.42, 0.3, 0.2, 0.08]), at: new Date(createdAt.getTime() + 14 * 86400000).toISOString() };
          else { const step = ageDays < 1 ? 1 : ageDays < 3 ? 1 : ageDays < 7 ? 2 : 3; const dueAt = new Date(createdAt.getTime() + [0, 1, 3, 7][step] * 86400000 + 10 * 3600000); const human = chance(0.3); lead.followUp = { step, dueAt: dueAt.toISOString(), ownerId: human ? (chance(0.6) ? reception.id : nurse.id) : "ai", done: dueAt < now ? chance(human ? 0.55 : 0.97) : false }; }
        } else if (lead.noShow && chance(0.6)) lead.lost = { reason: weighted(LOST_REASONS, LOST_W), stage: "Booked, no-show", at: new Date(new Date(lead.consultationAt).getTime() + 7 * 86400000).toISOString() };
        leads.push(lead);
      }
    }

    // ── Repeat patients: first paid visits over two years, second visit within 12 months ──
    const patients = [];
    const REPEAT = { transplant: 0.2, hairloss: 0.55, acne: 0.45, pigmentation: 0.5, laser: 0.72, general: 0.3 };
    for (let i = 0; i < 520; i++) {
      const t = weighted(TREATMENTS, TREATMENTS.map((x) => x.weight));
      const first = at(-between(190, 730), 11, 0);
      const second = chance(REPEAT[t.key] * (0.9 + 0.2 * rand())) ? new Date(first.getTime() + between(20, 365) * 86400000) : null;
      patients.push({ id: id("rp"), firstTreatment: t.key, firstVisitAt: first.toISOString(), secondPaidVisitAt: second && second <= now ? second.toISOString() : null });
    }

    // ── Weekly imports: Google reviews, marketing opt-outs, phone calls ────
    const weeks = [];
    for (let w = 25; w >= 0; w--) {
      const start = at(-w * 7 - today.getDay(), 0, 0); const progress = 1 - w / 25;
      weeks.push({ weekStart: dayKey(start), reviews: Math.max(0, Math.round(2.4 + 3.6 * progress + gauss() * 0.9)), rating: Math.min(4.95, Math.round((4.52 + 0.32 * progress + gauss() * 0.08) * 100) / 100), optOuts: between(0, 2), consented: 180 + Math.round(progress * 160) });
    }
    const phone = [];
    for (let d = -DAYS_BACK; d <= 0; d++) { const progress = progressOf(d); const calls = at(d, 0, 0).getDay() === 5 ? between(2, 6) : between(9, 24); const missed = progress < 0.3 ? between(1, 4) : chance(0.85) ? 0 : 1; const afterHours = between(1, 5); phone.push({ day: dayKey(at(d, 0, 0)), calls, answeredIn3: Math.max(0, calls - missed), afterHours, afterHoursAnswered: progress < 0.3 ? 0 : afterHours }); }

    // ── AI operations per day and module: calls, cost, errors, refusals, acceptance ──
    const MODULES = [
      { key: "frontDesk", name: "1 · AI front desk", perLead: 3.2, cost: 0.012, errRate: 0.004, refuseRate: 0.01, acceptance: [0.78, 0.9] },
      { key: "preparation", name: "2 · Consultation prep", perLead: 0, perConsult: 1.1, cost: 0.05, errRate: 0.003, refuseRate: 0, acceptance: [0.86, 0.93] },
      { key: "copilot", name: "3 · Documentation copilot", perAttended: 1.4, cost: 0.09, errRate: 0.003, refuseRate: 0.002, acceptance: [0.8, 0.92] },
      { key: "photos", name: "4 · Photography", fixed: [2, 8], cost: 0.004, errRate: 0.01, refuseRate: 0, acceptance: [0.9, 0.96] },
      { key: "concierge", name: "5 · Concierge", perCheckin: 1, cost: 0.006, errRate: 0.002, refuseRate: 0.004, acceptance: [0.88, 0.95] },
      { key: "management", name: "6 · Management layer", fixed: [1, 4], cost: 0.6, errRate: 0.01, refuseRate: 0.02, acceptance: [0.9, 0.97] },
    ];
    const aiOps = [];
    const byDay = {}; leads.forEach((l) => { (byDay[l.day] = byDay[l.day] || { leads: 0, consults: 0, attended: 0, checkins: 0 }).leads++; });
    leads.forEach((l) => { if (l.consultationAt) { const dd = Math.round((new Date(l.consultationAt) - today) / 86400000); if (byDay[dd]) { byDay[dd].consults++; if (l.attended) byDay[dd].attended++; } } l.checkins.forEach((c) => { const dd = Math.round((new Date(c.sentAt) - today) / 86400000); if (byDay[dd]) byDay[dd].checkins++; }); });
    for (let d = -DAYS_BACK; d <= 0; d++) {
      const v = byDay[d] || { leads: 0, consults: 0, attended: 0, checkins: 0 }; const progress = progressOf(d);
      for (const m of MODULES) {
        const live = m.key === "frontDesk" || m.key === "preparation" ? true : m.key === "copilot" || m.key === "photos" ? progress > 0.3 : progress > 0.5;
        if (!live) continue;
        const calls = Math.round((m.perLead || 0) * v.leads + (m.perConsult || 0) * v.consults + (m.perAttended || 0) * v.attended + (m.perCheckin || 0) * v.checkins + (m.fixed ? between(m.fixed[0], m.fixed[1]) : 0));
        if (!calls) continue;
        const errors = Math.round(calls * m.errRate * (0.5 + rand())), refusals = Math.round(calls * m.refuseRate * (0.5 + rand()));
        aiOps.push({ day: d, module: m.key, calls, costUsd: Math.round(calls * m.cost * (0.85 + rand() * 0.3) * 1000) / 1000, errors, refusals, acceptance: Math.round((m.acceptance[0] + (m.acceptance[1] - m.acceptance[0]) * progress + gauss() * 0.02) * 1000) / 10 });
      }
    }

    // ── Prompt versions and their evaluation scores (release gates) ───────
    const evalHistory = [
      ["front-desk.reply", 13, 94.0, 95], ["front-desk.reply", 14, 96.5, 95], ["front-desk.reply", 15, 97.2, 95],
      ["front-desk.qualify", 8, 93.1, 90], ["front-desk.qualify", 9, 95.4, 90],
      ["intake.brief", 5, 90.0, 90], ["intake.brief", 6, 92.5, 90],
      ["copilot.note", 10, 91.7, 90], ["copilot.note", 11, 93.3, 90],
      ["copilot.plan", 3, 88.3, 90], ["copilot.plan", 4, 91.7, 90],
      ["photos.quality", 3, 95.0, 90],
      ["concierge.triage", 6, 96.3, 95], ["concierge.triage", 7, 97.5, 95],
      ["management.brief", 4, 91.7, 90], ["management.brief", 5, 100, 90],
      ["management.nl-sql", 2, 92.0, 90], ["management.nl-sql", 3, 88.0, 90],
    ].map(([prompt, version, score, threshold], i) => ({ prompt, version, score, threshold, runAt: at(-between(1, 60), 11, 0).toISOString(), pass: score >= threshold, index: i }));

    // ── Reconciliation of the last two-week sample against manual counts ──
    const models = {
      leads: { name: "Leads", diffPct: 1.1, status: "ok" }, appointments: { name: "Appointments", diffPct: 0.4, status: "ok" }, procedures: { name: "Procedures", diffPct: 1.8, status: "ok" },
      revenue: { name: "Revenue by doctor and treatment", diffPct: 2.6, status: "failed", reason: "Last night's payments import from the point of sale is missing two days (deposits booked in cash were not exported). The model's test failed, so the metric is hidden rather than shown wrong.", lastRun: at(0, 2, 10).toISOString() },
      responses: { name: "First-response time", diffPct: 0.2, status: "ok" }, checkins: { name: "Check-ins", diffPct: 0.9, status: "ok" },
    };

    const spend = CAMPAIGNS.map((c) => ({ id: c.id, name: c.name, platform: c.platform, treatment: c.treatment, source: c.source, weeklySpend: c.weeklySpend, from: c.from, to: c.to, creatives: c.creatives, broken: !!c.broken }));
    const reporting = { generatedAt: now.toISOString(), nightlyAt: at(0, 2, 0).toISOString(), liveAt: new Date(now.getTime() - 9 * 60000).toISOString(), daysBack: DAYS_BACK, treatments: TREATMENTS.map(({ key, name, short, doctor, consultFee, deposit }) => ({ key, name, short, doctor, consultFee, deposit })), sources: SOURCES.map(({ key, name, channel }) => ({ key, name, channel })), channels: CHANNELS, lostReasons: LOST_REASONS, objections: OBJECTIONS, campaigns: spend, leads, patients, weeks, phone, aiOps, modules: MODULES.map(({ key, name }) => ({ key, name })), evalHistory, models, auditClinicalStatements: 0, briefRatings: [1, 1, 1, 1] };
    return { reporting, targets: TARGETS, targetEdits: {}, alertAcks: {}, thresholds: { noShowPct: 8, firstResponseSec: 60, campaignLeads: 100, escalationMinutes: 15 }, ceo: { p: 28, cmp: true } };
  }
  return { generate, TARGETS };
})();
