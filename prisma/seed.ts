import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/**
 * Seeds a demo tenant ("demo") with realistic clinical data so the dashboard,
 * AI assistant and embed flow are demonstrable end-to-end out of the box.
 */
async function main() {
  console.log("🌱 Seeding ClinicMind demo tenant…");

  const tenant = await db.tenant.upsert({
    where: { slug: "demo" },
    update: { status: "ACTIVE" },
    create: {
      slug: "demo",
      name: "Aura Demo Clinic",
      status: "ACTIVE",
      branding: { accent: "#4F46E5", productName: "ClinicMind" },
      settings: { locale: "en", channels: { whatsapp: false, voice: false } },
      embed: { create: { enabled: true, allowedOrigins: ["http://localhost:3000"] } },
      clinics: { create: { name: "Aura Demo Clinic", timezone: "Africa/Cairo" } },
    },
    include: { clinics: true },
  });

  const owner = await db.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "owner@demo.clinic" } },
    update: {},
    create: {
      tenantId: tenant.id,
      clinicId: tenant.clinics[0]?.id,
      email: "owner@demo.clinic",
      fullName: "Dr. Layla Hassan",
      role: "CLINIC_OWNER",
      status: "ACTIVE",
    },
  });

  await db.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "doctor@demo.clinic" } },
    update: {},
    create: {
      tenantId: tenant.id,
      clinicId: tenant.clinics[0]?.id,
      email: "doctor@demo.clinic",
      fullName: "Dr. Omar Fahmy",
      role: "DOCTOR",
      status: "ACTIVE",
    },
  });

  const patientsSeed = [
    { fullName: "Ahmed Mahmoud", gender: "MALE" as const, conditions: ["Hypertension"], diagnoses: ["Essential hypertension"], meds: ["Amlodipine"] },
    { fullName: "Mohamed Saleh", gender: "MALE" as const, conditions: ["Hypertension", "Type 2 Diabetes"], diagnoses: ["Type 2 diabetes mellitus"], meds: ["Metformin"] },
    { fullName: "Sara Ibrahim", gender: "FEMALE" as const, conditions: ["Asthma"], diagnoses: ["Mild persistent asthma"], meds: ["Salbutamol inhaler"] },
    { fullName: "Nour El-Din", gender: "MALE" as const, conditions: ["Type 2 Diabetes"], diagnoses: ["Type 2 diabetes mellitus"], meds: ["Insulin glargine"] },
    { fullName: "Fatma Adel", gender: "FEMALE" as const, conditions: [], diagnoses: ["Acute pharyngitis"], meds: [] },
  ];

  for (const [i, p] of patientsSeed.entries()) {
    const patient = await db.patient.create({
      data: {
        tenantId: tenant.id,
        fullName: p.fullName,
        gender: p.gender,
        dateOfBirth: new Date(1970 + i * 5, i, 10),
        phone: `+20100000000${i}`,
        whatsapp: `+20100000000${i}`,
        medicalHistory: {
          create: {
            chronicConditions: p.conditions,
            diagnoses: p.diagnoses,
            allergies: i % 2 === 0 ? ["Penicillin"] : [],
          },
        },
        medications: {
          create: p.meds.map((name) => ({ name, dosage: "1 tab", frequency: "Daily", startDate: new Date() })),
        },
      },
    });

    // A past visit and an upcoming appointment per patient.
    await db.appointment.create({
      data: {
        tenantId: tenant.id,
        clinicId: tenant.clinics[0]?.id,
        patientId: patient.id,
        doctorId: owner.id,
        startsAt: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
        status: i === 0 ? "CONFIRMED" : "SCHEDULED",
        reason: p.diagnoses[0] ?? "Follow-up",
      },
    });

    await db.timelineEvent.create({
      data: {
        tenantId: tenant.id,
        patientId: patient.id,
        kind: "DIAGNOSIS",
        title: p.diagnoses[0] ?? "Consultation",
        occurredAt: new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000),
      },
    });
  }

  console.log(`✅ Seeded tenant "${tenant.slug}" with ${patientsSeed.length} patients.`);
  console.log("   Visit http://localhost:3000/dashboard (dev auto-auths as the demo owner).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
