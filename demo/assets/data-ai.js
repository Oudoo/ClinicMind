/* Seed data for the Clinic AI module (the Clinic AI Implementation Spec as a module):
   leads and the front-desk inbox, knowledge base, intake templates and briefs,
   consents, generated documents, photo sets, protocols and enrolments, metric
   definitions, alerts, red lines, prompt registry, evaluation sets and the LLM
   call log. Called from data.js generate(); everything is deterministic. */
window.CM_SEED_AI = (function () {
  const LEAD_NAMES = ["Karim Nabil", "Salma Adel", "Mostafa Reda", "Nourhan Saeed", "Hassan Lotfy", "Dina Magdy", "Omar Khaled", "Yasmin Fathy", "Ahmed Sobhy", "Mariam Gamal", "Tamer Hosny", "Rania Wael", "Sherif Anwar", "Laila Mounir", "Mahmoud Essam", "Hana Tarek", "Ziad Samy", "Nadine Fouad"];
  const CONCERNS = [
    { concern: "Hair transplant", interest: "FUE hair transplant", doctor: "hair", budget: true, ask: ["Hi, how much is a hair transplant and when can I come?", "عايز أعرف سعر زراعة الشعر وإمكانية الحجز"], draft: "Thanks {first}! The first step is a 20-minute candidacy consultation with Dr. Omar Fahmy (EGP 500, deducted from the procedure). Could you send a photo of the top of your head and tell me since when you noticed the thinning? Prices depend on the number of grafts; the consultation gives you an exact plan. I can offer {slots}." },
    { concern: "Hair loss", interest: "Hair loss consultation", doctor: "hair", budget: false, ask: ["I'm losing a lot of hair since 3 months, what do you recommend?", "شعري بيقع كتير من ٣ شهور، في علاج؟"], draft: "Sorry to hear that {first}. Shedding over three months is worth a proper look; our hair clinic starts with a trichoscopy and blood tests so the treatment matches the cause. A consultation with Dr. Omar Fahmy is EGP 600. Would {slots} suit you?" },
    { concern: "Acne", interest: "Acne consultation", doctor: "derm", budget: false, ask: ["Do you treat adult acne? I'm 29 and it's getting worse before my period.", "I tried everything for my acne. What's the cost of a consultation?"], draft: "Yes {first}, adult acne is one of the most common reasons people visit us. Dr. Layla Hassan builds a plan around your skin and cycle; the consultation is EGP 600 and includes a skincare plan. Could you come on {slots}?" },
    { concern: "Pigmentation", interest: "Melasma treatment", doctor: "derm", budget: false, ask: ["I have dark patches on my cheeks since summer. Can laser remove them?", "Is melasma treatable permanently?"], draft: "Thanks {first}. Patches that darken after summer are usually melasma; it is controllable rather than removed once, and the plan starts with a Wood's lamp assessment, not laser straight away. A pigmentation consultation with Dr. Mariam Tarek is EGP 600. Free slots: {slots}." },
    { concern: "Laser hair removal", interest: "Laser hair removal course", doctor: "derm", budget: false, ask: ["Price for full legs laser? And is it safe for dark skin?", "How many laser sessions do I need?"], draft: "Hi {first}! A full-legs session is EGP 1,200 and most people need 6 to 8 sessions four weeks apart. Our device is set for darker skin tones; a patch test is done at the first visit. Shall I book your patch test on {slots}?" },
    { concern: "Eczema", interest: "Dermatology consultation", doctor: "derm", budget: false, ask: ["My daughter's eczema flared up badly, can we come today?", "Do you see children for eczema?"], draft: "Of course {first}. We see children from age two. For a flare the earliest options are {slots}; if the skin is weeping or she has a fever please tell me and I will ask the nurse to call you now." },
  ];
  const SOURCES = ["Instagram ad · Hair transplant October", "Google search", "Facebook ad · Acne", "Referral from a patient", "Website chat", "Walk-in phone call", "Instagram profile"];
  const LOST = ["Price too high", "Chose another clinic", "Stopped replying", "Out of area"];

  function generate(ctx) {
    const { rand, pick, chance, between, id, at, today, dayKey, patients, appointments, visits, consultations, STAFF } = ctx;
    const minutesAgo = (m) => new Date(today.getTime() + (new Date().getTime() - today.getTime()) - m * 60000).toISOString();
    const hair = STAFF.find((s) => s.id === "u-omar"), derm = STAFF.find((s) => s.id === "u-owner"), derm2 = STAFF.find((s) => s.id === "u-mariam"), nurse = STAFF.find((s) => s.id === "u-nurse");

    // ── Module 1: leads and the cross-channel inbox ───────────────────────
    const leads = [];
    const STAGES = ["NEW", "NEW", "NEW", "NEW", "QUALIFYING", "QUALIFYING", "QUALIFYING", "QUALIFYING", "QUALIFIED", "QUALIFIED", "QUALIFIED", "BOOKED", "BOOKED", "BOOKED", "QUIET", "QUIET", "QUIET", "LOST"];
    LEAD_NAMES.forEach((name, i) => {
      const c = pick(CONCERNS), stage = STAGES[i], channel = i % 9 === 7 ? "INSTAGRAM" : i % 9 === 8 ? "WEB" : i % 9 === 4 ? "PHONE" : "WHATSAPP";
      const ar = chance(0.55), first = name.split(" ")[0];
      const ago = stage === "NEW" ? between(2, 40) : stage === "QUALIFYING" ? between(30, 300) : stage === "QUIET" ? between(3 * 1440, 9 * 1440) : stage === "LOST" ? between(12 * 1440, 20 * 1440) : between(600, 4000);
      const inAt = minutesAgo(ago);
      const msgs = [{ id: id("lm"), direction: "INBOUND", by: "patient", body: c.ask[ar ? 1 : 0], at: inAt }];
      const draft = c.draft.replace("{first}", first).replace("{slots}", "{slots}");
      const answered = between(18, 85);
      if (stage !== "NEW") {
        msgs.push({ id: id("lm"), direction: "OUTBOUND", by: "ai", body: draft.replace("{slots}", "Thursday 11:00, Saturday 13:30 or Sunday 16:00"), at: new Date(new Date(inAt).getTime() + answered * 1000).toISOString() });
        if (["QUALIFIED", "BOOKED", "QUIET", "LOST"].includes(stage)) msgs.push({ id: id("lm"), direction: "INBOUND", by: "patient", body: stage === "QUIET" || stage === "LOST" ? "Ok thanks, I will think about it." : c.budget ? "Since about 2 years. Budget is around 40 to 50 thousand. Saturday is fine." : "Saturday 13:30 works for me.", at: new Date(new Date(inAt).getTime() + (answered + between(120, 900)) * 1000).toISOString() });
        if (stage === "BOOKED") msgs.push({ id: id("lm"), direction: "OUTBOUND", by: "ai", body: `Booked: Saturday 13:30 with ${c.doctor === "hair" ? hair.fullName : derm.fullName}. You will get a confirmation and a short intake form to fill before the visit.`, at: new Date(new Date(inAt).getTime() + (answered + 960) * 1000).toISOString() });
      }
      const red = i === 5; // one medical question that hits a red line
      if (red) { msgs[0].body = "I started isotretinoin from a pharmacy, can I double the dose to finish faster?"; }
      leads.push({
        id: id("lead"), name, phone: `+2011${between(10000000, 99999999)}`, channel, language: ar ? "Arabic" : "English", stage, concern: c.concern, interest: c.interest, doctorKind: c.doctor,
        source: pick(SOURCES), score: stage === "BOOKED" ? between(80, 95) : stage === "QUALIFIED" ? between(65, 85) : stage === "QUALIFYING" ? between(40, 70) : stage === "NEW" ? between(25, 55) : between(10, 35),
        createdAt: inAt, lastInboundAt: msgs.filter((m) => m.direction === "INBOUND").slice(-1)[0].at, firstResponseSec: stage === "NEW" ? null : answered,
        messages: msgs, aiDraft: stage === "NEW" && !red ? draft : null, intent: red ? "medical-advice" : stage === "NEW" ? "enquiry" : "booking",
        qualification: { since: stage === "NEW" ? "" : c.budget ? "About 2 years" : "3 months", budget: c.budget && stage !== "NEW" ? "EGP 40,000–50,000" : "", preferredTime: stage === "NEW" ? "" : "Saturday afternoon", photos: stage === "QUALIFIED" || stage === "BOOKED" ? 1 : 0 },
        handledBy: red ? "nurse" : stage === "NEW" ? null : "ai", redLine: red ? "Medication dosing question — routed to the nurse, no AI reply" : null,
        followUp: stage === "QUIET" ? { step: between(1, 2), nextAt: at(between(0, 1), 10, 0).toISOString() } : null, lostReason: stage === "LOST" ? pick(LOST) : null,
        appointmentId: null,
      });
    });

    const knowledgeBase = {
      treatments: [
        { id: "kb-1", name: "FUE hair transplant", from: 45000, to: 90000, unit: "per procedure", duration: "6–8 hours", deposit: 5000, notes: "Price depends on graft count; the candidacy consultation gives an exact plan." },
        { id: "kb-2", name: "Hair loss consultation (trichoscopy)", from: 600, to: 600, unit: "per visit", duration: "30 min", deposit: 0, notes: "Includes trichoscopy; blood tests billed by the lab." },
        { id: "kb-3", name: "PRP scalp session", from: 2500, to: 3000, unit: "per session", duration: "45 min", deposit: 500, notes: "Courses of 3 sessions, four weeks apart." },
        { id: "kb-4", name: "Dermatology consultation", from: 600, to: 600, unit: "per visit", duration: "20 min", deposit: 0, notes: "" },
        { id: "kb-5", name: "Laser hair removal, full legs", from: 1200, to: 1200, unit: "per session", duration: "40 min", deposit: 0, notes: "Patch test at the first visit; 6–8 sessions." },
        { id: "kb-6", name: "Chemical peel", from: 1500, to: 2200, unit: "per session", duration: "30 min", deposit: 0, notes: "" },
        { id: "kb-7", name: "Melasma laser session", from: 3000, to: 3500, unit: "per session", duration: "30 min", deposit: 500, notes: "Only after the consultation plan." },
        { id: "kb-8", name: "Acne follow-up", from: 400, to: 400, unit: "per visit", duration: "15 min", deposit: 0, notes: "" },
      ],
      faq: [
        { id: "faq-1", q: "Where are you and what are your hours?", a: "Aura Derma & Hair Clinic, 14 Road 9, Maadi, Cairo. Saturday to Thursday 10:00–20:00; closed Friday. Parking at the building." },
        { id: "faq-2", q: "Do I need to pay a deposit?", a: "Only for procedures (PRP, laser courses, hair transplant). Consultations are paid at the visit." },
        { id: "faq-3", q: "What is the cancellation policy?", a: "Free up to 24 hours before; later cancellations lose the deposit." },
        { id: "faq-4", q: "Do you speak English?", a: "Yes. The team speaks Arabic and English; documents can be in either." },
        { id: "faq-5", q: "What should I bring to a hair transplant consultation?", a: "Any previous blood tests, a list of medications, and come with unwashed hair if possible." },
        { id: "faq-6", q: "Can I send photos before booking?", a: "Yes, for hair loss and acne a photo helps the doctor prepare. One-line consent is requested first." },
      ],
      neverSay: ["Graft counts or final prices for a transplant before the consultation", "Whether a treatment will 'definitely' work", "Any diagnosis of a skin or hair condition", "Medication doses or whether to stop a medicine", "Comparisons with other clinics"],
      sequences: [
        { step: 1, after: "1 day", body: "Hi {first}, this is Aura Clinic. Still thinking about the {interest}? Happy to answer any question or hold a slot for you." },
        { step: 2, after: "3 days", body: "{first}, a quick note: the doctor's next free consultations are on {slots}. Shall I keep one for you?" },
        { step: 3, after: "7 days", body: "Last message from us {first}: whenever you are ready, reply here and we will take care of the rest." },
      ],
    };

    // ── Module 2: intake templates, intakes, briefs, consents ─────────────
    const intakeTemplates = [
      { key: "general", name: "General dermatology", version: 3, questions: 14, photos: 2, minutes: 5 },
      { key: "acne", name: "Acne", version: 4, questions: 18, photos: 3, minutes: 6 },
      { key: "pigmentation", name: "Pigmentation", version: 2, questions: 16, photos: 3, minutes: 6 },
      { key: "hair-loss", name: "Hair loss", version: 3, questions: 20, photos: 4, minutes: 7 },
      { key: "hair-transplant", name: "Hair transplant candidacy", version: 5, questions: 26, photos: 5, minutes: 10 },
      { key: "follow-up", name: "Follow-up (short)", version: 2, questions: 7, photos: 1, minutes: 2 },
    ];
    const templateFor = (reason) => /transplant|post-op|month \d/i.test(reason) ? "hair-transplant" : /hair loss|prp/i.test(reason) ? "hair-loss" : /acne|peel/i.test(reason) ? "acne" : /pigment|melasma/i.test(reason) ? "pigmentation" : /follow-up|review/i.test(reason) ? "follow-up" : "general";
    const intakes = [];
    const consents = [];
    const upcoming = appointments.filter((a) => new Date(a.startsAt) >= today && ["SCHEDULED", "CONFIRMED"].includes(a.status)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 16);
    upcoming.forEach((a, i) => {
      const p = patients.find((x) => x.id === a.patientId);
      const key = templateFor(a.reason);
      const status = i % 10 < 5 ? "COMPLETED" : i % 10 < 7 ? "OPENED" : "SENT";
      const sentAt = new Date(new Date(a.createdAt).getTime() + 5 * 60000).toISOString();
      const completedAt = status === "COMPLETED" ? new Date(new Date(sentAt).getTime() + between(30, 900) * 60000).toISOString() : null;
      const mismatch = status === "COMPLETED" && p.history.allergies.length && i % 5 === 0;
      const answers = status === "COMPLETED" ? {
        concern: a.reason, since: pick(["3 months", "6 months", "about a year", "2 years"]),
        priorTreatments: pick(/hair/.test(key) ? [["Minoxidil 5%, stopped after 2 months"], ["Biotin and a hair serum"], [], ["PRP elsewhere, 2 sessions"]] : key === "acne" ? [["Over-the-counter creams"], ["A course of antibiotics last year"], []] : key === "pigmentation" ? [["Lightening creams from the pharmacy"], ["Two peels elsewhere"], []] : [["Over-the-counter creams"], []]),
        medications: pick(p.gender === "Female" ? [["Thyroid tablets"], [], ["Oral contraceptive"], ["Vitamin D"]] : [["Thyroid tablets"], [], ["Vitamin D"], ["Blood pressure tablets"]]), allergies: mismatch ? [] : p.history.allergies.slice(), pregnant: p.gender === "Female" ? pick(["No", "No", "Not sure"]) : "n/a",
        expectations: pick(["Stop the shedding and regrow the crown", "Clear skin before my wedding in March", "Even skin tone", "Natural-looking hairline"]), budget: key === "hair-transplant" ? "EGP 40,000–60,000" : null, sunExposure: pick(["Daily, outdoors work", "Weekends", "Low"]),
      } : null;
      const flags = [];
      if (answers) {
        if (mismatch) flags.push({ level: "warning", text: `Intake says no allergies; the record lists ${p.history.allergies.join(", ")} — patient reported`, evidence: "Allergies: none" });
        if (answers.medications.includes("Thyroid tablets")) flags.push({ level: "info", text: "On thyroid medication — relevant for hair-loss work-up — patient reported", evidence: "Medications: Thyroid tablets" });
        if (answers.pregnant === "Not sure") flags.push({ level: "warning", text: "Pregnancy status unsure — no oral retinoid, no laser until confirmed — patient reported", evidence: "Pregnant or breastfeeding: Not sure" });
        if (answers.priorTreatments[0] && /PRP elsewhere/.test(answers.priorTreatments[0])) flags.push({ level: "info", text: "Previous PRP elsewhere; ask for dates and response — patient reported", evidence: answers.priorTreatments[0] });
        if (key === "hair-transplant" && p.history.chronicConditions.some((c) => /diabetes/i.test(c))) flags.push({ level: "warning", text: "Type 2 diabetes on record — healing and candidacy", evidence: "Record: chronic conditions" });
      }
      intakes.push({ id: id("int"), appointmentId: a.id, patientId: p.id, templateKey: key, status, sentAt, openedAt: status !== "SENT" ? new Date(new Date(sentAt).getTime() + between(5, 120) * 60000).toISOString() : null, completedAt, completion: status === "COMPLETED" ? 100 : status === "OPENED" ? between(20, 70) : 0, photos: status === "COMPLETED" ? between(1, 4) : 0, answers, flags, briefVersion: status === "COMPLETED" ? 1 : 0, briefReadAt: status === "COMPLETED" && i % 3 === 0 ? completedAt : null, token: `tok-int-${i + 1}` });
      if (status === "COMPLETED") {
        consents.push({ id: id("cns"), patientId: p.id, kind: "processing", version: "v2 (2026-06)", at: completedAt, by: "patient (intake form)", withdrawnAt: null });
        consents.push({ id: id("cns"), patientId: p.id, kind: "photos", version: "v2 (2026-06)", at: completedAt, by: "patient (intake form)", withdrawnAt: null });
        if (i % 2 === 0) consents.push({ id: id("cns"), patientId: p.id, kind: "marketing", version: "v1 (2026-02)", at: completedAt, by: "patient (intake form)", withdrawnAt: i % 4 === 0 ? at(-2, 11, 0).toISOString() : null });
      }
    });

    // ── Module 3: documents generated from signed encounters ──────────────
    const documents = [];
    const recentVisits = visits.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
    recentVisits.forEach((v, i) => {
      const mk = (type, status, body) => documents.push({ id: id("doc"), visitId: v.id, patientId: v.patientId, type, status, createdAt: v.at, signedAt: status !== "DRAFT" ? v.at : null, sentAt: status === "SENT" ? new Date(new Date(v.at).getTime() + 30 * 60000).toISOString() : null, body });
      mk("note", "SIGNED", v.summary);
      mk("plan", i % 3 === 0 ? "DRAFT" : "SIGNED", `Treatment plan: ${v.medications.map((m) => `${m.name} ${m.dosage} ${m.frequency.toLowerCase()}`).join("; ") || "no medication"}. Follow-up: ${v.followUps.join("; ")}.`);
      mk("instructions", i % 2 === 0 ? "SENT" : "SIGNED", `Patient instructions: ${v.medications.length ? `take ${v.medications[0].name} ${v.medications[0].dosage} ${v.medications[0].frequency.toLowerCase()}. ` : ""}Avoid direct sun; use sunscreen SPF 50 every morning. Contact the clinic on WhatsApp for bleeding, fever or swelling.`);
      if (/transplant|laser|peel|prp/i.test(v.summary)) mk("consent", i % 4 === 0 ? "DRAFT" : "SIGNED", "Consent for the procedure: purpose, alternatives, expected course, risks (infection, swelling, uneven result), photos for clinical use. Signed on the clinic tablet.");
      if (i % 5 === 4) mk("referral", "DRAFT", "Referral to endocrinology: thyroid function and ferritin abnormal on screening; please assess before continuing hair-loss treatment.");
    });

    // ── Module 4: photo sets ───────────────────────────────────────────────
    const photos = [];
    const photoPatients = patients.filter((p) => ["fue", "aga", "acne", "melasma", "laser-hr", "alopecia-areata"].includes(p.conditionKeys[0])).slice(0, 14);
    const STAGES_FOR = { fue: ["Before", "Day 7", "Month 1", "Month 3", "Month 6"], aga: ["Before", "Month 3", "Month 6"], "alopecia-areata": ["Before", "Week 6", "Week 12"], acne: ["Before", "Week 6", "Week 12"], melasma: ["Before", "Week 8", "Week 16"], "laser-hr": ["Before", "Session 3", "Session 6"] };
    const VIEWS_FOR = { fue: ["Front", "Top", "Left", "Right", "Donor"], aga: ["Front", "Top", "Left", "Right"], "alopecia-areata": ["Top", "Patch close-up"], acne: ["Front", "Left", "Right"], melasma: ["Front", "Left", "Right"], "laser-hr": ["Area"] };
    photoPatients.forEach((p, i) => {
      const key = p.conditionKeys[0], stages = STAGES_FOR[key], views = VIEWS_FOR[key];
      // Photo history predates the seeded appointment window so later stages exist.
      const start = at(-between(60, 220), 11, 0);
      const captured = Math.min(stages.length, 2 + (i % stages.length));
      stages.slice(0, captured).forEach((stage, s) => {
        const offset = { "Before": 0, "Day 7": 7, "Week 6": 42, "Week 8": 56, "Week 12": 84, "Week 16": 112, "Month 1": 30, "Month 3": 90, "Month 6": 180, "Session 3": 56, "Session 6": 140 }[stage] || 0;
        const atDate = new Date(start.getTime() + offset * 86400000);
        if (atDate > new Date()) return;
        views.forEach((view, vi) => {
          const missing = s > 0 && i % 4 === 1 && vi === views.length - 1;
          if (missing) return;
          const quality = s > 0 && i % 3 === 2 && vi === 0 ? "blur" : s > 0 && i % 5 === 3 && vi === 1 ? "lighting" : "ok";
          photos.push({ id: id("ph"), patientId: p.id, stage, view, capturedAt: atDate.toISOString(), source: s === 0 ? "clinic" : i % 2 ? "patient" : "clinic", quality, flag: quality !== "ok" ? `${quality === "blur" ? "Blurred" : "Poor lighting"} — ask for a retake` : null, hue: (i * 47 + s * 23) % 360 });
        });
      });
    });

    // ── Module 5: protocols, enrolments, escalations, roster ──────────────
    const protocols = [
      { id: "pro-fue", name: "Hair transplant aftercare", version: 3, approvedBy: hair.fullName, approvedAt: at(-40, 9, 0).toISOString(), language: ["Arabic", "English"], quietHours: "22:00–08:00", steps: [
        { offset: 0, kind: "message", title: "Post-op instructions", body: "Sleep with the head raised for 3 nights; no washing for 48 hours; the nurse will call tomorrow." },
        { offset: 1, kind: "checkin", title: "Day 1 check-in", questions: [{ q: "Any bleeding from the donor or recipient area?", options: ["None", "Spots on the pillow", "Bleeding that will not stop"] }, { q: "Pain level?", options: ["Mild", "Moderate", "Severe"] }], escalate: ["Bleeding that will not stop", "Severe"] },
        { offset: 3, kind: "photo", title: "Day 3 photos", body: "Please send a photo of the top and the back of the head in daylight." },
        { offset: 7, kind: "checkin", title: "Day 7 check-in", questions: [{ q: "How is the crusting?", options: ["Lifting with washing", "Still thick", "Oozing or smelly"] }, { q: "Fever?", options: ["No", "Above 38.5"] }], escalate: ["Oozing or smelly", "Above 38.5"] },
        { offset: 10, kind: "message", title: "Washing guidance", body: "From today you can wash normally with gentle pressure; crusts should be gone by day 14." },
        { offset: 14, kind: "photo", title: "Day 14 photos", body: "Day 14 photo set: front, top, left, right." },
        { offset: 30, kind: "checkin", title: "Month 1 check-in", questions: [{ q: "Shedding of the transplanted hair?", options: ["Yes, started", "Not yet", "Worried"] }], escalate: [] },
        { offset: 90, kind: "photo", title: "Month 3 photos", body: "Month 3 photo set; growth is just starting, this is normal." },
        { offset: 180, kind: "photo", title: "Month 6 photos and review", body: "Month 6 photos and a review visit with the doctor." },
        { offset: 365, kind: "photo", title: "Final result photos", body: "Final photo set at 12 months." },
      ] },
      { id: "pro-laser", name: "Laser session aftercare", version: 2, approvedBy: derm2.fullName, approvedAt: at(-70, 9, 0).toISOString(), language: ["Arabic", "English"], quietHours: "22:00–08:00", steps: [
        { offset: 0, kind: "message", title: "After your session", body: "Cool the area, no sun, no hot showers for 24 hours." },
        { offset: 2, kind: "checkin", title: "Day 2 check-in", questions: [{ q: "Redness or blisters?", options: ["Mild redness", "Gone", "Blisters or burns"] }], escalate: ["Blisters or burns"] },
        { offset: 7, kind: "message", title: "Week 1", body: "Shedding of treated hair is expected over the next two weeks." },
        { offset: 28, kind: "reminder", title: "Next session", body: "Time to book the next session; reply with a day that suits you." },
      ] },
      { id: "pro-peel", name: "Chemical peel aftercare", version: 1, approvedBy: derm.fullName, approvedAt: at(-90, 9, 0).toISOString(), language: ["Arabic", "English"], quietHours: "22:00–08:00", steps: [
        { offset: 0, kind: "message", title: "After the peel", body: "Expect tightness and mild redness for 48 hours; moisturise, no picking, sunscreen." },
        { offset: 2, kind: "checkin", title: "Day 2 check-in", questions: [{ q: "How does the skin feel?", options: ["Tight and dry", "Fine", "Blistering or severe pain"] }], escalate: ["Blistering or severe pain"] },
        { offset: 7, kind: "photo", title: "Day 7 photo", body: "A daylight photo of the treated area, please." },
      ] },
      { id: "pro-acne", name: "Oral acne course monitoring", version: 1, approvedBy: derm.fullName, approvedAt: at(-55, 9, 0).toISOString(), language: ["Arabic", "English"], quietHours: "22:00–08:00", steps: [
        { offset: 0, kind: "message", title: "Starting the course", body: "Take the tablet with food; expect dryness; sunscreen every morning." },
        { offset: 14, kind: "checkin", title: "Week 2 check-in", questions: [{ q: "Side effects?", options: ["Dry lips only", "Stomach upset", "Low mood or severe headache"] }], escalate: ["Low mood or severe headache"] },
        { offset: 30, kind: "reminder", title: "Blood tests", body: "Time for the month-1 blood tests; the lab form is attached." },
        { offset: 42, kind: "photo", title: "Week 6 photos", body: "Week 6 photo set: front, left, right." },
      ] },
    ];
    const enrolments = [];
    const triggerVisits = visits.filter((v) => /transplant|laser|peel|acne vulgaris/i.test(v.summary) && new Date(v.at) > at(-45, 0, 0)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
    triggerVisits.forEach((v, i) => {
      const proto = /transplant/i.test(v.summary) ? protocols[0] : /laser/i.test(v.summary) ? protocols[1] : /peel/i.test(v.summary) ? protocols[2] : protocols[3];
      const startedAt = new Date(v.at);
      const steps = proto.steps.map((s, si) => {
        const dueAt = new Date(startedAt.getTime() + s.offset * 86400000);
        const past = dueAt < new Date();
        let status = past ? (s.kind === "checkin" || s.kind === "photo" ? "ANSWERED" : "SENT") : "SCHEDULED";
        let answer = null, risk = null;
        if (past && s.kind === "checkin") {
          const esc = i % 6 === 1 && si === 1;
          answer = esc ? s.escalate[0] : s.questions[0].options[0]; risk = esc ? "HIGH" : "LOW";
          if (esc) status = "ESCALATED";
        }
        if (past && s.kind === "photo" && i % 4 === 2) status = "AWAITING";
        if (dayKey(dueAt) === dayKey(today) && !past) status = "DUE";
        return { ...s, dueAt: dueAt.toISOString(), status, answer, risk };
      });
      const escalated = steps.find((s) => s.status === "ESCALATED");
      enrolments.push({ id: id("enr"), patientId: v.patientId, protocolId: proto.id, protocolVersion: proto.version, visitId: v.id, startedAt: v.at, status: escalated ? "ESCALATED" : steps.every((s) => s.status !== "SCHEDULED" && s.status !== "DUE") ? "COMPLETED" : "ACTIVE", ownerId: nurse.id, steps,
        escalation: escalated ? { level: 2, openedAt: new Date(new Date(escalated.dueAt).getTime() + 20 * 60000).toISOString(), assignedTo: proto.approvedBy, reason: `${escalated.title}: "${escalated.answer}"`, resolvedAt: null } : null });
    });
    // The board always has one open escalation to show the ladder, whatever today's date is.
    if (!enrolments.some((e) => e.status === "ESCALATED")) {
      const target = enrolments.find((e) => e.steps.some((s) => s.kind === "checkin" && new Date(s.dueAt) < new Date()));
      if (target) {
        const s = target.steps.find((x) => x.kind === "checkin" && new Date(x.dueAt) < new Date());
        const proto = protocols.find((p) => p.id === target.protocolId);
        s.answer = s.escalate[0] || s.questions[0].options[s.questions[0].options.length - 1]; s.risk = "HIGH"; s.status = "ESCALATED";
        target.status = "ESCALATED";
        target.escalation = { level: 2, openedAt: new Date(new Date(s.dueAt).getTime() + 20 * 60000).toISOString(), assignedTo: proto.approvedBy, reason: `${s.title}: "${s.answer}"`, resolvedAt: null };
      }
    }
    const roster = { date: dayKey(today), level1: { name: nurse.fullName, role: "Nurse", hours: "08:00–20:00", minutes: 15 }, level2: { name: hair.fullName, role: "Doctor on call", hours: "08:00–22:00", minutes: 60 }, level3: { name: derm.fullName, role: "Clinic owner", hours: "any time", minutes: 120 }, emergency: "Bleeding that will not stop, fever above 38.5, swelling of the face or chest pain: the AI stops and the on-call doctor is called immediately." };

    // ── Module 6: metric definitions (the spec's table; every number on the dashboard has one, owned by one table) ──
    const metricDefinitions = [
      { id: "M1", name: "Enquiries by treatment", definition: "New leads per period grouped by treatment interest; a lead with two interests counts once per interest with a note.", source: "Lead", breakdowns: "treatment, source, campaign, channel", target: "" },
      { id: "M2", name: "Lead to consultation conversion", definition: "Leads created in the period that have an attended consultation within 30 days, divided by leads created.", source: "Lead, Appointment", breakdowns: "treatment, source, campaign", target: "> 35% (baseline 28%)" },
      { id: "M3", name: "Consultation to procedure conversion", definition: "Attended consultations with a signed procedure within 60 days, divided by attended consultations; by doctor and treatment.", source: "Appointment, Procedure", breakdowns: "doctor, treatment", target: "" },
      { id: "M4", name: "Revenue by doctor and treatment", definition: "Signed procedure revenue by procedure date; deposits and refunds shown separately; consultation fees as their own line.", source: "Procedure, Payments (manual entry or POS import)", breakdowns: "doctor, treatment", target: "" },
      { id: "M5", name: "Average first-response time", definition: "Median and 90th percentile seconds from an inbound message to the first reply, split AI and human, by channel and hour of day.", source: "Message", breakdowns: "AI/human, channel, hour of day", target: "median < 60 s" },
      { id: "M6", name: "No-show rate", definition: "Appointments with status no-show divided by booked, by doctor, type, weekday, lead source, and whether a deposit was paid.", source: "Appointment", breakdowns: "doctor, type, weekday, lead source, deposit", target: "< 8%" },
      { id: "M7", name: "Lost leads and reasons", definition: "Leads marked lost with the reason (no response, price, distance, chose competitor, not a fit, timing, other) and the lost-at stage.", source: "Lead", breakdowns: "reason, stage", target: "" },
      { id: "M8", name: "Most common objections", definition: "Objection tags set by the AI on each conversation (price, pain, downtime, results doubt, trust, timing) and confirmed by staff when they close a lead.", source: "Conversation", breakdowns: "objection, treatment", target: "" },
      { id: "M9", name: "Hair-transplant enquiries by source", definition: "Leads with transplant interest by first-touch source and campaign (click-to-WhatsApp ad, Instagram organic, website, referral, walk-in, phone).", source: "Lead", breakdowns: "source, campaign", target: "" },
      { id: "M10", name: "Repeat-patient rate", definition: "Patients with a second paid visit within 12 months of the first, by first treatment.", source: "Patient, Procedure", breakdowns: "first treatment", target: "" },
      { id: "M11", name: "Patient satisfaction", definition: "Check-in satisfaction scores (1 to 5) at month 1 and month 12 for transplant and at day 14 for other treatments; public review count and rating pulled weekly.", source: "Check-in, Google Business Profile", breakdowns: "treatment, doctor, week", target: "≥ 4.5 of 5" },
      { id: "M12", name: "Follow-ups overdue", definition: "Open lead follow-ups and concierge escalations past their target time, by owner.", source: "Lead, Check-in", breakdowns: "owner, kind", target: "0" },
      { id: "M13", name: "Campaign to procedure", definition: "For each campaign id: leads, consultations, procedures, revenue, cost from the ads platform, cost per procedure.", source: "Lead, Procedure, Meta and Google Ads", breakdowns: "campaign, creative", target: "90% of spend attributed" },
    ];

    // ── AI rules: red lines, prompt registry, evaluation sets, call log ───
    const redLines = [
      { id: "rl-1", text: "Never diagnose or name a condition for a patient; describe what the doctor will assess.", enabled: true },
      { id: "rl-2", text: "Never promise outcomes, graft counts or 'guaranteed' results.", enabled: true },
      { id: "rl-3", text: "Never quote a final price for surgery; ranges from the price table only, the consultation decides.", enabled: true },
      { id: "rl-4", text: "Never give medication dosing advice to patients; route to the nurse.", enabled: true },
      { id: "rl-5", text: "Emergency words (bleeding that will not stop, fever above 38.5, swelling of the face, chest pain): stop the AI and call the on-call doctor.", enabled: true },
      { id: "rl-6", text: "No outbound messages between 22:00 and 08:00 unless the patient wrote first.", enabled: true },
      { id: "rl-7", text: "Never contact a patient who withdrew consent; never send marketing without marketing consent.", enabled: true },
      { id: "rl-8", text: "Never message anyone under 18 without a guardian on the thread.", enabled: true },
      { id: "rl-9", text: "Answer only from the clinic's records and knowledge base; say 'I do not know' otherwise.", enabled: true },
    ];
    const prompts = [
      { id: "front-desk.reply", module: "M1", version: 14, status: "active", updatedAt: at(-6, 15, 0).toISOString(), evalSet: "front-desk-200" },
      { id: "front-desk.reply", module: "M1", version: 15, status: "candidate", updatedAt: at(-1, 17, 0).toISOString(), evalSet: "front-desk-200" },
      { id: "front-desk.qualify", module: "M1", version: 9, status: "active", updatedAt: at(-12, 10, 0).toISOString(), evalSet: "front-desk-200" },
      { id: "intake.brief", module: "M2", version: 6, status: "active", updatedAt: at(-9, 10, 0).toISOString(), evalSet: "intake-brief-40" },
      { id: "copilot.note", module: "M3", version: 11, status: "active", updatedAt: at(-4, 10, 0).toISOString(), evalSet: "copilot-notes-60" },
      { id: "copilot.plan", module: "M3", version: 4, status: "active", updatedAt: at(-20, 10, 0).toISOString(), evalSet: "copilot-notes-60" },
      { id: "photos.quality", module: "M4", version: 3, status: "active", updatedAt: at(-30, 10, 0).toISOString(), evalSet: "photos-quality-100" },
      { id: "concierge.triage", module: "M5", version: 7, status: "active", updatedAt: at(-8, 10, 0).toISOString(), evalSet: "triage-80" },
      { id: "management.brief", module: "M6", version: 5, status: "active", updatedAt: at(-3, 10, 0).toISOString(), evalSet: "brief-12" },
      { id: "management.nl-sql", module: "M6", version: 2, status: "active", updatedAt: at(-15, 10, 0).toISOString(), evalSet: "nl-sql-50" },
      { id: "management.nl-sql", module: "M6", version: 3, status: "candidate", updatedAt: at(0, 9, 0).toISOString(), evalSet: "nl-sql-50" },
    ];
    const evalSets = [
      { id: "front-desk-200", name: "Front-desk conversations", module: "M1", cases: 200, passRate: 96.5, threshold: 95, lastRun: at(-1, 17, 20).toISOString(), gate: "pass" },
      { id: "red-lines-adversarial", name: "Red-line adversarial set", module: "all", cases: 120, passRate: 100, threshold: 100, lastRun: at(-1, 17, 25).toISOString(), gate: "pass" },
      { id: "intake-brief-40", name: "Intake briefs", module: "M2", cases: 40, passRate: 92.5, threshold: 90, lastRun: at(-9, 11, 0).toISOString(), gate: "pass" },
      { id: "copilot-notes-60", name: "Documentation notes", module: "M3", cases: 60, passRate: 93.3, threshold: 90, lastRun: at(-4, 11, 0).toISOString(), gate: "pass" },
      { id: "photos-quality-100", name: "Photo quality labels", module: "M4", cases: 100, passRate: 95, threshold: 90, lastRun: at(-30, 11, 0).toISOString(), gate: "pass" },
      { id: "triage-80", name: "Check-in triage", module: "M5", cases: 80, passRate: 97.5, threshold: 95, lastRun: at(-8, 11, 0).toISOString(), gate: "pass" },
      { id: "brief-12", name: "Weekly briefs", module: "M6", cases: 12, passRate: 100, threshold: 90, lastRun: at(-3, 11, 0).toISOString(), gate: "pass" },
      { id: "nl-sql-50", name: "Natural-language questions", module: "M6", cases: 50, passRate: 88, threshold: 90, lastRun: at(0, 9, 10).toISOString(), gate: "fail" },
    ];
    const callLog = [];
    const MODULES = ["front-desk.reply", "front-desk.qualify", "intake.brief", "copilot.note", "concierge.triage", "management.brief", "front-desk.reply", "front-desk.reply"];
    for (let i = 0; i < 24; i++) {
      const pid = pick(MODULES); const pr = prompts.find((p) => p.id === pid && p.status === "active");
      const tin = between(900, 6000), tout = between(80, 900);
      callLog.push({ id: id("run"), at: minutesAgo(i * between(9, 40) + 3), prompt: pid, version: pr.version, module: pr.module, model: pid.startsWith("front-desk") && i % 3 ? "claude-haiku-5-5" : "claude-opus-5-5", tokensIn: tin, tokensOut: tout, latencyMs: between(700, 4200), costUsd: Number(((tin * 0.000015) + (tout * 0.000075)).toFixed(4)), outcome: i === 4 ? "refused" : i === 11 ? "fallback" : "ok", mode: pid.startsWith("concierge") ? "assist" : pid.startsWith("management") ? "auto" : "assist" });
    }
    const compliance = { retention: { audio: "30 days", conversations: "24 months", lostLeads: "12 months", photos: "until consent withdrawn" }, twoFactor: { enrolled: 6, total: 7 }, dpo: "To be appointed (PDPL)", breachPlaybook: "docs/RUNBOOK.md §9", pseudonymisation: true, zeroRetention: true };

    return { leads, knowledgeBase, intakeTemplates, intakes, consents, documents, photos, protocols, enrolments, roster, metricDefinitions, redLines, prompts, evalSets, callLog, compliance };
  }
  return { generate };
})();
