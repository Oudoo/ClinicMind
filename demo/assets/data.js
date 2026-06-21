/* ClinicMind demo seed data — entirely client-side, no backend. */
window.CM_DATA = {
  tenant: { name: "Aura Demo Clinic", slug: "demo", locale: "en" },
  metrics: {
    patients: 1284,
    appointmentsToday: 18,
    upcoming: 63,
    noShowRate: 0.09,
    aiInteractions: 412,
    activeConsultations: 3,
    retention: 0.86,
    revenueMonth: 392500,
  },
  appointmentTrend: [
    { day: "Mon", count: 14 }, { day: "Tue", count: 19 }, { day: "Wed", count: 22 },
    { day: "Thu", count: 17 }, { day: "Fri", count: 25 }, { day: "Sat", count: 12 }, { day: "Sun", count: 9 },
  ],
  diagnoses: [
    { label: "Essential hypertension", count: 214 },
    { label: "Type 2 diabetes mellitus", count: 188 },
    { label: "Hyperlipidemia", count: 121 },
    { label: "Asthma", count: 96 },
    { label: "Hypothyroidism", count: 64 },
    { label: "Acute pharyngitis", count: 41 },
  ],
  patients: [
    { id: "p1", name: "Ahmed Mahmoud", age: 54, phone: "+20 100 555 0101", conditions: ["Hypertension"], appts: 12, visits: 9, risk: "moderate" },
    { id: "p2", name: "Mohamed Saleh", age: 61, phone: "+20 100 555 0102", conditions: ["Hypertension", "Type 2 Diabetes"], appts: 21, visits: 18, risk: "high" },
    { id: "p3", name: "Sara Ibrahim", age: 33, phone: "+20 100 555 0103", conditions: ["Asthma"], appts: 7, visits: 5, risk: "low" },
    { id: "p4", name: "Nour El-Din", age: 47, phone: "+20 100 555 0104", conditions: ["Type 2 Diabetes"], appts: 15, visits: 11, risk: "high" },
    { id: "p5", name: "Fatma Adel", age: 28, phone: "+20 100 555 0105", conditions: [], appts: 3, visits: 2, risk: "low" },
    { id: "p6", name: "Khaled Mansour", age: 58, phone: "+20 100 555 0106", conditions: ["Hyperlipidemia", "Hypertension"], appts: 16, visits: 14, risk: "high" },
    { id: "p7", name: "Mariam Tarek", age: 41, phone: "+20 100 555 0107", conditions: ["Hypothyroidism"], appts: 9, visits: 7, risk: "moderate" },
    { id: "p8", name: "Youssef Hany", age: 36, phone: "+20 100 555 0108", conditions: ["Asthma"], appts: 6, visits: 4, risk: "low" },
  ],
  appointments: [
    { time: "09:00", patient: "Ahmed Mahmoud", reason: "BP follow-up", status: "CONFIRMED", day: 0 },
    { time: "09:30", patient: "Sara Ibrahim", reason: "Asthma review", status: "CHECKED_IN", day: 0 },
    { time: "10:15", patient: "Mohamed Saleh", reason: "Diabetes + HbA1c", status: "IN_PROGRESS", day: 0 },
    { time: "11:00", patient: "Fatma Adel", reason: "New patient", status: "SCHEDULED", day: 0 },
    { time: "12:30", patient: "Mariam Tarek", reason: "Thyroid panel", status: "SCHEDULED", day: 0 },
    { time: "09:45", patient: "Nour El-Din", reason: "Insulin titration", status: "SCHEDULED", day: 1 },
    { time: "11:30", patient: "Khaled Mansour", reason: "Lipid review", status: "WAITLISTED", day: 1 },
    { time: "10:00", patient: "Youssef Hany", reason: "Spirometry", status: "SCHEDULED", day: 2 },
    { time: "13:00", patient: "Ahmed Mahmoud", reason: "Medication renewal", status: "SCHEDULED", day: 3 },
  ],
  conversations: [
    { channel: "WHATSAPP", patient: "Sara Ibrahim", locale: "arz", msgs: 6, summary: "Patient rescheduled her asthma review from Tue to Wed 09:30. Confirmed automatically." },
    { channel: "VOICE", patient: "Mohamed Saleh", locale: "ar", msgs: 4, summary: "Outbound reminder call for HbA1c fasting instructions. Patient acknowledged." },
    { channel: "WHATSAPP", patient: "Fatma Adel", locale: "en", msgs: 8, summary: "New patient intake: collected name, DOB, complaint (sore throat). Booked 11:00 slot." },
    { channel: "VOICE", patient: "Khaled Mansour", locale: "arz", msgs: 5, summary: "Patient requested earlier lipid appointment; placed on waitlist, will notify on opening." },
  ],
  consultation: {
    patient: "Mohamed Saleh",
    transcript:
      "Doctor: Good morning Mohamed, how have you been since the last visit?\n" +
      "Patient: Honestly not great, I get headaches in the afternoon and feel very thirsty.\n" +
      "Doctor: Are you taking the metformin twice daily as prescribed?\n" +
      "Patient: Yes but I missed a few doses last week when I traveled.\n" +
      "Doctor: Your blood pressure today is 148 over 92, and your fasting sugar is elevated. " +
      "Let's add amlodipine 5mg once daily for the pressure, continue metformin 1000mg twice daily, " +
      "and I want an HbA1c and a lipid panel. Come back in four weeks.\n" +
      "Patient: Okay doctor, thank you.",
    extraction: {
      symptoms: ["Afternoon headaches", "Polydipsia (excessive thirst)"],
      diagnoses: ["Uncontrolled type 2 diabetes mellitus", "Stage 2 hypertension"],
      medications: [
        { name: "Amlodipine", dosage: "5 mg", frequency: "Once daily" },
        { name: "Metformin", dosage: "1000 mg", frequency: "Twice daily" },
      ],
      tests: ["HbA1c", "Lipid panel"],
      followUps: ["Review in 4 weeks", "Medication adherence counseling"],
    },
    summary:
      "54-year-old male with type 2 diabetes and hypertension presents with afternoon headaches and " +
      "polydipsia. BP 148/92, elevated fasting glucose, reports missed metformin doses. Plan: add " +
      "amlodipine 5mg OD, continue metformin 1000mg BD, order HbA1c and lipid panel, review in 4 weeks.",
  },
  // Canned, retrieval-grounded assistant answers for the demo (no API cost).
  assistant: [
    {
      match: ["miss", "follow"],
      answer:
        "3 patients have missed follow-ups in the last 30 days:\n• Nour El-Din — insulin titration review (12 days overdue)\n• Khaled Mansour — lipid panel review (8 days overdue)\n• Ahmed Mahmoud — BP recheck (5 days overdue)\nI can draft WhatsApp reminders for all three.",
      citations: [
        { source: "APPOINTMENT", snippet: "Nour El-Din — status NO_SHOW, scheduled 12 days ago" },
        { source: "VISIT_NOTE", snippet: "Khaled Mansour — 'order lipid panel, review in 1 week'" },
      ],
      confidence: 0.88,
    },
    {
      match: ["today", "summary", "appointment"],
      answer:
        "Today you have 18 appointments. 1 in progress (Mohamed Saleh — diabetes), 1 checked in (Sara Ibrahim — asthma), 5 scheduled, and the rest completed. 2 are high-risk patients flagged for longer slots. No conflicts detected.",
      citations: [{ source: "APPOINTMENT", snippet: "18 appointments for 2025-06-21, 2 flagged high-risk" }],
      confidence: 0.91,
    },
    {
      match: ["diabet", "high", "risk"],
      answer:
        "4 high-risk diabetic patients need attention:\n• Mohamed Saleh — BP 148/92, missed metformin doses\n• Nour El-Din — overdue insulin titration\nBoth show rising trends. Khaled Mansour and Ahmed Mahmoud are borderline. Recommend prioritizing Mohamed and Nour this week.",
      citations: [
        { source: "DIAGNOSIS", snippet: "Mohamed Saleh — uncontrolled type 2 diabetes mellitus" },
        { source: "MEDICATION", snippet: "Nour El-Din — insulin glargine, titration pending" },
      ],
      confidence: 0.86,
    },
    {
      match: ["compar", "hypertension", "progress"],
      answer:
        "Comparing Ahmed and Mohamed (hypertension):\n• Ahmed Mahmoud — BP trend improving (152→138 over 3 visits) on amlodipine; controlled.\n• Mohamed Saleh — BP worsening (140→148) with adherence gaps; just escalated to amlodipine 5mg. Needs closer follow-up.",
      citations: [
        { source: "VISIT_NOTE", snippet: "Ahmed — BP 138/86, 'controlled, continue current regimen'" },
        { source: "VISIT_NOTE", snippet: "Mohamed — BP 148/92, 'add amlodipine, review 4 weeks'" },
      ],
      confidence: 0.84,
    },
  ],
};
