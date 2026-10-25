/* ClinicMind click-through prototype — deterministic demo data, generated in
   the browser. Mirrors prisma/seed.ts: the same clinic, staff, conditions,
   medications and schedule shape, centred on the day the data is generated. */
window.CM_SEED = (function () {
  const PASSWORD = "Demo-Clinic-2026!";
  const TZ_LABEL = "Africa/Cairo";

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIRST_M = ["Ahmed", "Mohamed", "Omar", "Youssef", "Khaled", "Mahmoud", "Karim", "Tarek", "Hassan", "Amr", "Mostafa", "Ali", "Ziad", "Sherif", "Hany", "Adel", "Ibrahim", "Sameh"];
  const FIRST_F = ["Sara", "Nour", "Fatma", "Mariam", "Heba", "Dina", "Yasmin", "Salma", "Rana", "Aya", "Menna", "Hala", "Laila", "Nadine", "Mona", "Reem", "Farida", "Nesma"];
  const LAST = ["Mahmoud", "Saleh", "Ibrahim", "El-Din", "Adel", "Mansour", "Tarek", "Hany", "Fathy", "Abdel Rahman", "Samir", "Kamel", "Shaaban", "Gamal", "Zaki", "Fouad", "Nabil", "Ezzat", "Hamdy", "Lotfy"];

  const CONDITIONS = [
    { key: "aga", tag: "hair-loss", chronic: ["Androgenetic alopecia"], diagnosis: "Androgenetic alopecia (Norwood III vertex)", meds: [{ name: "Minoxidil 5% solution", dosage: "1 ml", frequency: "Twice daily" }, { name: "Finasteride", dosage: "1 mg", frequency: "Once daily" }], reasons: ["Hair loss consultation", "Hair loss follow-up", "PRP session", "Hair transplant consultation"], symptoms: ["progressive thinning at the crown", "increased shedding over 8 months", "family history on father's side"], tests: ["Trichoscopy", "Ferritin and TSH"], followUps: ["Review in 3 months with photos", "Discuss transplant candidacy"], doctor: "hair" },
    { key: "fue", tag: "hair-transplant", chronic: ["Androgenetic alopecia"], diagnosis: "Post FUE hair transplant, day 7 review", meds: [{ name: "Cephalexin", dosage: "500 mg", frequency: "Twice daily for 5 days" }, { name: "Saline spray", dosage: "As directed", frequency: "Every 2 hours while awake" }], reasons: ["Post-op day 7 review", "Post-op day 14 review", "Month 1 review", "Month 3 review"], symptoms: ["mild crusting in recipient area", "no bleeding", "donor area healing well"], tests: [], followUps: ["Crust removal guidance", "Photo set at month 1"], doctor: "hair" },
    { key: "acne", tag: "acne", chronic: [], diagnosis: "Acne vulgaris, moderate inflammatory", meds: [{ name: "Adapalene 0.1% gel", dosage: "Thin layer", frequency: "Nightly" }, { name: "Doxycycline", dosage: "100 mg", frequency: "Once daily for 8 weeks" }], reasons: ["Acne consultation", "Acne follow-up", "Chemical peel session"], symptoms: ["inflammatory papules on cheeks and jawline", "post-inflammatory marks", "flares before menstruation"], tests: [], followUps: ["Review in 6 weeks", "Sunscreen counselling"], doctor: "derm" },
    { key: "melasma", tag: "pigmentation", chronic: ["Melasma"], diagnosis: "Melasma, mixed epidermal-dermal", meds: [{ name: "Tranexamic acid", dosage: "250 mg", frequency: "Twice daily" }, { name: "Hydroquinone 4% cream", dosage: "Thin layer", frequency: "Nightly" }, { name: "Broad-spectrum sunscreen SPF 50", dosage: "Generous", frequency: "Every 3 hours outdoors" }], reasons: ["Pigmentation consultation", "Melasma follow-up", "Laser session"], symptoms: ["symmetrical brown patches on cheeks", "worse after summer", "no new medications"], tests: ["Wood's lamp examination"], followUps: ["Review in 8 weeks with photos"], doctor: "derm" },
    { key: "eczema", tag: "eczema", chronic: ["Atopic dermatitis"], diagnosis: "Atopic dermatitis flare, flexural", meds: [{ name: "Emollient cream", dosage: "Liberal", frequency: "Twice daily" }, { name: "Mometasone 0.1% cream", dosage: "Thin layer", frequency: "Once daily for 7 days" }], reasons: ["Eczema flare", "Eczema review"], symptoms: ["itchy patches in elbow folds", "sleep disturbed by itching", "dry skin"], tests: [], followUps: ["Review in 2 weeks", "Written skincare plan"], doctor: "derm" },
    { key: "psoriasis", tag: "psoriasis", chronic: ["Plaque psoriasis"], diagnosis: "Plaque psoriasis, limited, elbows and scalp", meds: [{ name: "Calcipotriol/betamethasone gel", dosage: "Thin layer", frequency: "Once daily" }, { name: "Coal tar shampoo", dosage: "As directed", frequency: "Three times weekly" }], reasons: ["Psoriasis review", "Psoriasis consultation"], symptoms: ["well-demarcated scaly plaques on elbows", "scalp scaling", "no joint pain"], tests: [], followUps: ["Review in 6 weeks"], doctor: "derm" },
    { key: "rosacea", tag: "rosacea", chronic: ["Rosacea"], diagnosis: "Papulopustular rosacea", meds: [{ name: "Metronidazole 0.75% gel", dosage: "Thin layer", frequency: "Twice daily" }, { name: "Ivermectin 1% cream", dosage: "Thin layer", frequency: "Nightly" }], reasons: ["Rosacea consultation", "Rosacea follow-up"], symptoms: ["persistent central facial redness", "flushing with heat and spicy food", "papules on nose"], tests: [], followUps: ["Trigger diary", "Review in 8 weeks"], doctor: "derm" },
    { key: "alopecia-areata", tag: "hair-loss", chronic: ["Alopecia areata"], diagnosis: "Alopecia areata, single patch, scalp", meds: [{ name: "Intralesional triamcinolone", dosage: "5 mg/ml", frequency: "Every 4 weeks" }], reasons: ["Alopecia areata injection", "Alopecia areata review"], symptoms: ["round patch of hair loss 3 cm", "noticed 6 weeks ago", "no nail changes"], tests: ["Thyroid function"], followUps: ["Injection in 4 weeks"], doctor: "hair" },
    { key: "laser-hr", tag: "laser", chronic: [], diagnosis: "Hirsutism, cosmetic laser hair removal course", meds: [], reasons: ["Laser hair removal session", "Laser hair removal consultation"], symptoms: ["unwanted facial hair", "previous waxing", "no hormonal symptoms"], tests: ["Hormonal profile if cycles irregular"], followUps: ["Next session in 6 weeks"], doctor: "derm" },
    { key: "warts", tag: "minor-procedure", chronic: [], diagnosis: "Plantar warts", meds: [{ name: "Salicylic acid 40% plaster", dosage: "Apply", frequency: "Daily" }], reasons: ["Wart cryotherapy", "Wart review"], symptoms: ["painful lesions on sole", "present for 4 months"], tests: [], followUps: ["Cryotherapy repeat in 3 weeks"], doctor: "derm" },
  ];
  const ALLERGIES = [[], [], [], ["Penicillin"], ["Sulfa drugs"], ["NSAIDs"], ["Latex"]];
  const COMORBID = [[], [], [], ["Hypertension"], ["Type 2 diabetes"], ["Hypothyroidism"], ["PCOS"], ["Iron deficiency anaemia"]];
  const ROOMS = ["Room 1", "Room 2", "Laser suite", "Procedure room"];
  const CANCEL_REASONS = ["Patient travelling", "Rescheduled by patient", "Doctor unavailable", "Patient unwell"];

  const STAFF = [
    { id: "u-owner", email: "owner@demo.clinic", fullName: "Dr. Layla Hassan", role: "CLINIC_OWNER", kind: "derm" },
    { id: "u-omar", email: "doctor@demo.clinic", fullName: "Dr. Omar Fahmy", role: "DOCTOR", kind: "hair" },
    { id: "u-mariam", email: "mariam@demo.clinic", fullName: "Dr. Mariam Tarek", role: "DOCTOR", kind: "derm" },
    { id: "u-nurse", email: "nurse@demo.clinic", fullName: "Heba Mostafa", role: "NURSE", kind: null },
    { id: "u-reception", email: "reception@demo.clinic", fullName: "Youssef Hany", role: "RECEPTIONIST", kind: null },
    // The AI profile: an owner-level account whose workspace is the Clinic AI module (the spec, module by module).
    { id: "u-ai", email: "ai@demo.clinic", fullName: "Nadia Youssef", role: "CLINIC_OWNER", kind: null, profile: "clinic-ai", title: "Clinic AI lead", demoOrder: 2 },
  ];
  STAFF[0].demoOrder = 1;
  const PLATFORM_ADMIN = { id: "u-platform", email: "platform@demo.clinic", fullName: "Platform Admin", role: "SUPER_ADMIN", kind: null, demoOrder: 3 };
  const AI_MODULE_DEFAULT = () => ({ enabled: true, killSwitch: false, modes: { frontDesk: "assist", preparation: "auto", copilot: "assist", photos: "assist", concierge: "assist", management: "auto" } });

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function generate(now) {
    const rand = mulberry32(20261022);
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const chance = (p) => rand() < p;
    const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
    let ids = 0;
    const id = (p) => `${p}-${(++ids).toString(36).padStart(4, "0")}`;

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const at = (dayOffset, h, m) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, h, m);

    const doctors = STAFF.filter((s) => s.kind);
    const patients = [];
    const appointments = [];
    const visits = [];
    const consultations = [];
    const conversations = [];
    const medications = [];
    const timeline = [];
    const usedNames = new Set();

    // The first patient is fixed so the demo script and the tester guide can name him.
    usedNames.add("Ali Adel");
    patients.push({
      id: id("pat"), fullName: "Ali Adel", gender: "Male", dob: "1964-03-27", phone: "+201033448079", whatsapp: true, email: null,
      language: "English", tags: ["hair-loss"], notes: "", emergencyContact: null, address: null,
      createdAt: at(-26, 10, 0).toISOString(), archivedAt: null,
      history: { chronicConditions: ["Alopecia areata", "Hypothyroidism"], allergies: ["Penicillin"], diagnoses: [], surgeries: [] },
      conditionKeys: ["alopecia-areata"],
    });
    for (let i = 1; i < 62; i++) {
      const female = chance(0.5);
      let fullName;
      do { fullName = `${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)}`; } while (usedNames.has(fullName));
      usedNames.add(fullName);
      const primary = pick(CONDITIONS);
      const secondary = chance(0.25) ? pick(CONDITIONS.filter((c) => c.key !== primary.key)) : null;
      const age = between(18, 68);
      const dob = new Date(today.getFullYear() - age, between(0, 11), between(1, 28));
      const tags = [primary.tag];
      if (chance(0.15)) tags.push("vip");
      if (chance(0.15)) tags.push("new-patient");
      const comorbid = pick(COMORBID);
      const p = {
        id: id("pat"), fullName, gender: female ? "Female" : "Male", dob: dayKey(dob),
        phone: `+2010${between(10000000, 99999999)}`, whatsapp: true,
        email: chance(0.45) ? `${fullName.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@example.com` : null,
        language: chance(0.6) ? "Arabic" : "English", tags, notes: "", emergencyContact: null, address: null,
        createdAt: at(-(i % 6 === 0 ? between(1, 27) : between(40, 400)), 10, 0).toISOString(), archivedAt: null, // a few new patients each month
        history: {
          chronicConditions: [...primary.chronic, ...(secondary ? secondary.chronic : []), ...comorbid],
          allergies: pick(ALLERGIES),
          diagnoses: [],
          surgeries: primary.key === "fue" ? ["FUE hair transplant"] : [],
        },
        conditionKeys: [primary.key, ...(secondary ? [secondary.key] : [])],
      };
      patients.push(p);
    }

    // Appointments: five weeks back, ten days ahead, clinic hours 10:00–20:00.
    const slotTaken = new Set();
    for (const p of patients) {
      const n = between(3, 14);
      const cond = CONDITIONS.find((c) => c.key === p.conditionKeys[0]);
      const doctor = cond.doctor === "hair" ? STAFF[1] : pick([STAFF[0], STAFF[2]]);
      const days = new Set();
      while (days.size < n) days.add(between(-35, 10));
      for (const d of [...days].sort((a, b) => a - b)) {
        let h = between(10, 19), m = pick([0, 15, 30, 45]);
        const dur = pick([20, 30, 30, 45, 60]);
        let key = `${doctor.id}|${d}|${h}:${m}`;
        let tries = 0;
        while (slotTaken.has(key) && tries++ < 10) { h = between(10, 19); m = pick([0, 15, 30, 45]); key = `${doctor.id}|${d}|${h}:${m}`; }
        if (slotTaken.has(key)) continue;
        slotTaken.add(key);
        const start = at(d, h, m), end = new Date(start.getTime() + dur * 60000);
        let status, cancelReason = null;
        if (d < 0) status = chance(0.85) ? "COMPLETED" : chance(0.5) ? "NO_SHOW" : "CANCELLED";
        else if (d === 0) status = start < now ? (chance(0.8) ? "COMPLETED" : "CHECKED_IN") : chance(0.6) ? "CONFIRMED" : "SCHEDULED";
        else status = chance(0.55) ? "CONFIRMED" : "SCHEDULED";
        if (status === "CANCELLED") cancelReason = pick(CANCEL_REASONS);
        const a = {
          id: id("apt"), patientId: p.id, doctorId: doctor.id, room: pick(ROOMS),
          startsAt: start.toISOString(), endsAt: end.toISOString(), status, reason: pick(cond.reasons), notes: "", cancelReason,
          createdAt: at(d - between(1, 14), 9, 0).toISOString(),
        };
        appointments.push(a);
        timeline.push({ id: id("tl"), patientId: p.id, kind: "APPOINTMENT", at: a.startsAt, title: `Appointment — ${a.reason}`, body: cancelReason ? `Cancelled: ${cancelReason}` : "" });
        if (status === "COMPLETED") {
          const visitAt = new Date(start.getTime() + between(20, 50) * 60000);
          const meds = cond.meds;
          const summary = `${a.reason}. ${cond.diagnosis}. Plan: ${meds.map((x) => `${x.name} ${x.dosage} ${x.frequency.toLowerCase()}`).join("; ")}${meds.length ? ". " : ""}${pick(cond.followUps)}.`;
          const v = { id: id("vis"), patientId: p.id, doctorId: doctor.id, appointmentId: a.id, at: visitAt.toISOString(), summary, diagnoses: [cond.diagnosis], symptoms: cond.symptoms, tests: cond.tests, followUps: [pick(cond.followUps)], medications: meds.map((x) => ({ ...x })) };
          visits.push(v);
          consultations.push({ id: id("con"), patientId: p.id, doctorId: doctor.id, status: "SIGNED", createdAt: visitAt.toISOString(), reviewedAt: visitAt.toISOString(), reviewedById: doctor.id, visitId: v.id, transcript: transcriptFor(p, cond, doctor), draft: draftFor(cond), summary, editedByClinician: chance(0.4) });
          timeline.push({ id: id("tl"), patientId: p.id, kind: "VISIT", at: v.at, title: "Consultation signed", body: summary });
          if (!p.history.diagnoses.includes(cond.diagnosis)) p.history.diagnoses.push(cond.diagnosis);
          timeline.push({ id: id("tl"), patientId: p.id, kind: "DIAGNOSIS", at: v.at, title: cond.diagnosis, body: "" });
          if (meds.length) timeline.push({ id: id("tl"), patientId: p.id, kind: "PRESCRIPTION", at: v.at, title: meds.map((x) => x.name).join(", "), body: "" });
        }
      }
      // Active medications = the primary condition's plan, started at the first signed visit.
      const firstVisit = visits.filter((v) => v.patientId === p.id).sort((x, y) => x.at.localeCompare(y.at))[0];
      if (firstVisit) for (const m of cond.meds) medications.push({ id: id("med"), patientId: p.id, name: m.name, dosage: m.dosage, frequency: m.frequency, startedAt: firstVisit.at, stoppedAt: null, visitId: firstVisit.id });
    }

    // Ten drafts awaiting review on recent completed appointments without a signed visit of their own.
    const recentDone = appointments.filter((a) => a.status === "COMPLETED" && new Date(a.startsAt) > at(-4, 0, 0)).slice(0, 10);
    for (const a of recentDone) {
      const p = patients.find((x) => x.id === a.patientId);
      const cond = CONDITIONS.find((c) => c.key === p.conditionKeys[0]);
      const doctor = STAFF.find((s) => s.id === a.doctorId);
      consultations.push({ id: id("con"), patientId: p.id, doctorId: doctor.id, status: "PENDING_REVIEW", createdAt: new Date(new Date(a.startsAt).getTime() + 15 * 60000).toISOString(), reviewedAt: null, reviewedById: null, visitId: null, transcript: transcriptFor(p, cond, doctor), draft: draftFor(cond), summary: `${a.reason}. ${cond.diagnosis}. Plan: ${cond.meds.map((x) => `${x.name} ${x.dosage} ${x.frequency.toLowerCase()}`).join("; ")}. ${cond.followUps[0]}.`, editedByClinician: false, appointmentId: a.id });
    }

    // WhatsApp conversations.
    const templates = [
      ["Hello, I would like to book a consultation for hair loss.", "Thank you for contacting {clinic}. Dr. Omar Fahmy has availability this week. Would 11:30 on Thursday work?", "Thursday works, thank you.", "Booked. You will receive a confirmation and preparation instructions shortly."],
      ["Is the laser session painful?", "Most patients describe it as a warm snap; a cooling gel is used. Dr. Mariam Tarek can discuss it at your consultation.", "Okay, please book me for next week."],
      ["I have redness after the peel, is this normal?", "Mild redness for 24 to 48 hours is expected. If you notice blistering, severe pain or fever, please call us immediately. Would you like a nurse to call you?", "Yes please."],
      ["Can I reschedule tomorrow's appointment to the afternoon?", "Yes. Dr. Layla Hassan has 15:30 and 17:00 free tomorrow. Which do you prefer?", "17:00 please.", "Done. See you tomorrow at 17:00."],
      ["What is the price of PRP?", "PRP sessions start from EGP 2,500; the exact plan is confirmed at consultation. Shall I book a consultation?"],
    ];
    for (let i = 0; i < 26; i++) {
      const p = pick(patients);
      const t = pick(templates);
      const startAt = at(-between(0, 20), between(9, 21), between(0, 59));
      const msgs = t.map((body, j) => ({ id: id("msg"), direction: j % 2 === 0 ? "INBOUND" : "OUTBOUND", body: body.replace("{clinic}", "Aura Derma & Hair Clinic"), at: new Date(startAt.getTime() + j * between(2, 9) * 60000).toISOString(), handledBy: j % 2 === 0 ? null : chance(0.6) ? "ai" : "staff" }));
      conversations.push({ id: id("cnv"), patientId: p.id, channel: "WHATSAPP", status: chance(0.7) ? "OPEN" : "CLOSED", messages: msgs, lastAt: msgs[msgs.length - 1].at });
    }

    const tenants = [
      { id: "ten-demo", slug: "demo", name: "Aura Derma & Hair Clinic", status: "ACTIVE", modules: { clinicAi: AI_MODULE_DEFAULT() }, branding: { productName: "ClinicMind", accent: "#4F46E5", logoUrl: "" }, customDomain: null, customDomainVerified: false, embed: { enabled: true, allowedOrigins: ["https://www.auraclinic.example"], secretPrefix: "cmembed_mc4Gfi", rotatedAt: today.toISOString() }, timezone: TZ_LABEL, clinicName: "Aura Clinic — Zamalek", createdAt: at(-120, 9, 0).toISOString() },
    ];
    const users = [...STAFF.map((s) => ({ ...s, tenantId: "ten-demo", status: "ACTIVE", createdAt: at(-120, 9, 0).toISOString() })), { ...PLATFORM_ADMIN, tenantId: "ten-platform", status: "ACTIVE", createdAt: at(-120, 9, 0).toISOString() }];

    const ai = window.CM_SEED_AI ? window.CM_SEED_AI.generate({ rand, pick, chance, between, id, at, today, dayKey, patients, appointments, visits, consultations, conversations, STAFF }) : {};
    const reporting = window.CM_SEED_REPORTING ? window.CM_SEED_REPORTING.generate({ rand, pick, chance, between, id, at, today, dayKey, STAFF, ai }) : {};
    return {
      version: 2, generatedAt: now.toISOString(), today: dayKey(today), password: PASSWORD,
      tenants, users, patients, appointments, visits, consultations, conversations, medications, timeline,
      aiRuns: between(18, 34), platformTenant: { id: "ten-platform", slug: "platform", name: "GrowCDX Platform" },
      ...ai,
      ...reporting,
    };
  }

  function transcriptFor(p, cond, doctor) {
    const first = p.fullName.split(" ")[0];
    return `Doctor: Good morning ${first}. What brings you in today?\nPatient: ${cond.symptoms[0]}${cond.symptoms[1] ? ", and " + cond.symptoms[1] : ""}.\nDoctor: Any allergies or new medicines?\nPatient: ${p.history.allergies.length ? "I am allergic to " + p.history.allergies.join(" and ") : "No allergies"}; ${cond.symptoms[2] ?? "nothing new"}.\nDoctor: On examination this is consistent with ${cond.diagnosis.toLowerCase()}. We will ${cond.meds.length ? "start " + cond.meds.map((m) => `${m.name} ${m.dosage} ${m.frequency.toLowerCase()}`).join(" and ") : "proceed with the session as planned"}.${cond.tests.length ? " I would like " + cond.tests.join(" and ") + " before the next visit." : ""} ${cond.followUps[0]}.`;
  }
  function draftFor(cond) {
    return { symptoms: [...cond.symptoms], diagnoses: [cond.diagnosis], tests: [...cond.tests], followUps: [cond.followUps[0]], medications: cond.meds.map((m) => ({ ...m })) };
  }

  return { generate, CONDITIONS, STAFF, PLATFORM_ADMIN, PASSWORD, ROOMS, CANCEL_REASONS, AI_MODULE_DEFAULT };
})();
