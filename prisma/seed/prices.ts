import type { PriceUnit } from "@prisma/client";
import type { SeedContext } from "./index";

/**
 * The demo clinic's price list: what Aura charges for each consultation,
 * session, area, graft and syringe, plus course packages sold below the price
 * of their sessions. Every item has a price in force since two years ago; a
 * third of them went up on 1 January this year, so the history shows the
 * increase; and two changes are scheduled (full-body laser on the 1st of next
 * month, the dermatology consultation on 1 January next year), so the list
 * shows what is coming. Prices are whole EGP and fall in the treatment
 * catalogue's ranges.
 */

interface ItemSeed {
  code: string;
  name: string;
  category: "hair" | "skin" | "laser" | "injectables" | "general";
  unit: PriceUnit;
  unitLabel?: string;
  treatment: string;
  /** Today's price. */
  price: number;
  /** The price before the January increase, when there was one. */
  before?: number;
  /** A course package: this many sessions of the item with this code. */
  sessions?: number;
  of?: string;
}

const ITEMS: readonly ItemSeed[] = [
  { code: "CONS-HAIR", name: "Hair consultation and trichoscopy", category: "hair", unit: "VISIT", treatment: "hair-transplant", price: 500, before: 400 },
  { code: "FUE-GRAFT", name: "FUE hair transplant", category: "hair", unit: "UNIT", unitLabel: "graft", treatment: "hair-transplant", price: 25, before: 22 },
  { code: "DHI-GRAFT", name: "DHI hair transplant (implanter pen)", category: "hair", unit: "UNIT", unitLabel: "graft", treatment: "hair-transplant", price: 32 },
  { code: "BEARD-GRAFT", name: "Beard transplant", category: "hair", unit: "UNIT", unitLabel: "graft", treatment: "hair-transplant", price: 30 },
  { code: "PRP-HAIR", name: "PRP for hair loss", category: "hair", unit: "SESSION", treatment: "prp-hair", price: 1_800, before: 1_500 },
  { code: "PRP-HAIR-5", name: "PRP for hair loss, course", category: "hair", unit: "PACKAGE", treatment: "prp-hair", price: 7_500, before: 6_500, sessions: 5, of: "PRP-HAIR" },
  { code: "MESO-HAIR", name: "Hair mesotherapy", category: "hair", unit: "SESSION", treatment: "prp-hair", price: 1_200 },

  { code: "PEEL-ACNE", name: "Salicylic peel for acne", category: "skin", unit: "SESSION", treatment: "acne", price: 1_500, before: 1_300 },
  { code: "PEEL-ACNE-4", name: "Acne peel course", category: "skin", unit: "PACKAGE", treatment: "acne", price: 5_200, sessions: 4, of: "PEEL-ACNE" },
  { code: "ACNE-EXTRACT", name: "Acne extraction and blue light", category: "skin", unit: "SESSION", treatment: "acne", price: 900 },
  { code: "MICRONEEDLE", name: "Microneedling for acne scars", category: "skin", unit: "SESSION", treatment: "acne", price: 2_200 },
  { code: "PEEL-MELASMA", name: "Depigmentation peel", category: "skin", unit: "SESSION", treatment: "pigmentation", price: 3_200, before: 2_800 },
  { code: "HYDRAFACIAL", name: "Hydrafacial", category: "skin", unit: "SESSION", treatment: "general-dermatology", price: 1_800 },

  { code: "LHR-FACE", name: "Laser hair removal, face", category: "laser", unit: "AREA", treatment: "laser-hair-removal", price: 1_500 },
  { code: "LHR-UNDERARM", name: "Laser hair removal, underarms", category: "laser", unit: "AREA", treatment: "laser-hair-removal", price: 1_200, before: 1_000 },
  { code: "LHR-UNDERARM-6", name: "Laser hair removal, underarms course", category: "laser", unit: "PACKAGE", treatment: "laser-hair-removal", price: 6_000, sessions: 6, of: "LHR-UNDERARM" },
  { code: "LHR-LEGS", name: "Laser hair removal, full legs", category: "laser", unit: "AREA", treatment: "laser-hair-removal", price: 3_800 },
  { code: "LHR-BODY", name: "Laser hair removal, full body", category: "laser", unit: "SESSION", treatment: "laser-hair-removal", price: 7_200, before: 6_500 },
  { code: "LHR-BODY-6", name: "Laser hair removal, full body course", category: "laser", unit: "PACKAGE", treatment: "laser-hair-removal", price: 36_000, sessions: 6, of: "LHR-BODY" },
  { code: "LASER-TONING", name: "Laser toning for melasma", category: "laser", unit: "SESSION", treatment: "pigmentation", price: 3_000 },

  { code: "BOTOX-AREA", name: "Botulinum toxin", category: "injectables", unit: "AREA", treatment: "botox-fillers", price: 2_500, before: 2_200 },
  { code: "BOTOX-SWEAT", name: "Botulinum toxin for underarm sweating", category: "injectables", unit: "SESSION", treatment: "botox-fillers", price: 9_500 },
  { code: "FILLER", name: "Hyaluronic acid filler", category: "injectables", unit: "UNIT", unitLabel: "syringe", treatment: "botox-fillers", price: 6_000, before: 5_500 },
  { code: "SKIN-BOOSTER", name: "Skin booster injection", category: "injectables", unit: "UNIT", unitLabel: "syringe", treatment: "botox-fillers", price: 7_500 },

  { code: "CONS-DERM", name: "Dermatology consultation", category: "general", unit: "VISIT", treatment: "general-dermatology", price: 600, before: 500 },
  { code: "FOLLOW-UP", name: "Follow-up visit", category: "general", unit: "VISIT", treatment: "general-dermatology", price: 300 },
  { code: "CRYO", name: "Cryotherapy", category: "general", unit: "UNIT", unitLabel: "lesion", treatment: "general-dermatology", price: 400 },
  { code: "MOLE-RF", name: "Mole removal (radiofrequency)", category: "general", unit: "UNIT", unitLabel: "lesion", treatment: "general-dermatology", price: 1_200 },
  { code: "BIOPSY", name: "Skin biopsy", category: "general", unit: "UNIT", unitLabel: "sample", treatment: "general-dermatology", price: 1_500 },
];

/** Changes already set for later: [code, new price, when]. */
const SCHEDULED: readonly (readonly [string, number, "next-month" | "next-year"])[] = [
  ["LHR-BODY", 7_800, "next-month"],
  ["CONS-DERM", 700, "next-year"],
];

export async function seedPrices(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const treatments = new Map((await db.treatment.findMany({ where: { tenantId }, select: { id: true, key: true } })).map((t) => [t.key, t.id]));
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const { y, m } = ctx.calendarDay(0);
  // A price applies from the start of its day on the clinic clock.
  const since = ctx.zoned(y - 2, 1, 1, 0, 0);
  const january = ctx.zoned(y, 1, 1, 0, 0);
  const later = { "next-month": ctx.zoned(y, m + 1, 1, 0, 0), "next-year": ctx.zoned(y + 1, 1, 1, 0, 0) };

  const ids = new Map<string, string>();
  let order = 0;
  for (const item of ITEMS) {
    const treatmentId = treatments.get(item.treatment);
    if (!treatmentId) continue;
    const prices = item.before
      ? [
          { tenantId, amount: item.before, effectiveFrom: since, createdById: owner.id, createdAt: since },
          { tenantId, amount: item.price, effectiveFrom: january, createdById: owner.id, createdAt: new Date(january.getTime() - 14 * 86_400_000) },
        ]
      : [{ tenantId, amount: item.price, effectiveFrom: since, createdById: owner.id, createdAt: since }];
    const row = await db.priceItem.create({
      data: {
        tenantId,
        code: item.code,
        name: item.name,
        category: item.category,
        unit: item.unit,
        unitLabel: item.unitLabel ?? null,
        treatmentId,
        sessions: item.sessions ?? null,
        sessionItemId: item.of ? (ids.get(item.of) ?? null) : null,
        sortOrder: (order += 10),
        createdAt: since,
        prices: { create: prices },
      },
      select: { id: true },
    });
    ids.set(item.code, row.id);
  }

  const scheduled = SCHEDULED.filter(([code]) => ids.has(code));
  await db.priceItemPrice.createMany({
    data: scheduled.map(([code, amount, when]) => ({ tenantId, priceItemId: ids.get(code)!, amount, effectiveFrom: later[when], createdById: owner.id })),
  });
  console.log(`     prices: ${ids.size} items, ${scheduled.length} changes scheduled.`);
}
