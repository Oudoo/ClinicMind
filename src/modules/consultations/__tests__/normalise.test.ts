import { describe, expect, it } from "vitest";
import { baseMedicationName, medicationKey, normaliseClinicalTerm } from "../normalise";
import { dailyDose, dosesPerDay, identifyMedication } from "../safety/identify";

/** Medication reconciliation keys and prescription parsing (pure, no database). */

describe("medicationKey", () => {
  it("treats strengths, forms, % and punctuation as the same medication", () => {
    const key = medicationKey({ name: "Minoxidil 5% solution" });
    expect(key).toBe("minoxidil@topical");
    for (const name of ["Minoxidil 5%", "minoxidil  5 %  Solution", "Minoxidil (5%) foam", "Regaine", "Rogaine 5% foam"]) {
      expect(medicationKey({ name }), name).toBe(key);
    }
  });

  it("maps brands to the generic", () => {
    expect(medicationKey({ name: "Roaccutane 20 mg" })).toBe(medicationKey({ name: "Isotretinoin" }));
    expect(medicationKey({ name: "Vibramycin 100mg capsules" })).toBe(medicationKey({ name: "Doxycycline" }));
    expect(medicationKey({ name: "Augmentin 1g tablets" })).toBe("amoxicillin+clavulanic-acid");
  });

  it("keeps the oral and topical forms of one generic apart", () => {
    expect(medicationKey({ name: "Minoxidil 2.5 mg tablets" })).toBe("minoxidil");
    expect(medicationKey({ name: "Minoxidil", dosage: "2.5 mg", frequency: "once daily" })).toBe("minoxidil");
    expect(medicationKey({ name: "Minoxidil", dosage: "1 ml", frequency: "twice daily" })).toBe("minoxidil@topical");
    expect(medicationKey({ name: "Isotrex gel" })).toBe("isotretinoin@topical");
    expect(medicationKey({ name: "Ketoconazole 2% shampoo" })).not.toBe(medicationKey({ name: "Ketoconazole 200 mg tablets" }));
  });

  it("falls back to the bare name for medicines the table does not know", () => {
    expect(medicationKey({ name: "Emollient cream" })).toBe("emollient");
    expect(medicationKey({ name: "Old drug" })).toBe("old drug");
    expect(medicationKey({ name: "Saline spray" })).toBe(medicationKey({ name: "saline" }));
  });
});

describe("baseMedicationName", () => {
  it.each([
    ["Minoxidil 5% solution", "minoxidil"],
    ["Doxycycline 100 mg capsules", "doxycycline"],
    ["Adapalene 0.1% gel", "adapalene"],
    ["Amoxicillin 250mg/5ml suspension", "amoxicillin"],
    ["Paracetamol 2 x 500 mg tablets", "paracetamol"],
    ["Calcipotriol/betamethasone gel", "calcipotriol betamethasone"],
  ])("%s → %s", (name, base) => {
    expect(baseMedicationName(name)).toBe(base);
  });

  it("leaves diagnosis de-duplication case- and space-insensitive", () => {
    expect(normaliseClinicalTerm("  Type 2   Diabetes ")).toBe("type 2 diabetes");
  });
});

describe("routes", () => {
  it.each([
    ["Doxycycline 100 mg", "oral"],
    ["Minoxidil 5% solution", "topical"],
    ["Daktarin oral gel", "oral"],
    ["Intralesional triamcinolone", "injection"],
    ["Ceftriaxone 1 g IM", "injection"],
    ["Botox", "injection"],
    ["Tretinoin", "topical"],
    ["Loniten", "oral"],
  ])("%s → %s", (name, route) => {
    expect(identifyMedication({ name }).route).toBe(route);
  });
});

describe("dosesPerDay", () => {
  it.each([
    ["once daily", 1],
    ["Once daily for 8 weeks", 1],
    ["Twice daily for 5 days", 2],
    ["BID", 2],
    ["b.i.d.", 2],
    ["tds", 3],
    ["three times a day", 3],
    ["3 times daily", 3],
    ["QID", 4],
    ["every 6 hours", 4],
    ["q8h", 3],
    ["12-hourly", 2],
    ["1-0-1", 2],
    ["1-1-1", 3],
    ["nightly", 1],
    ["at bedtime", 1],
    ["every other day", 0.5],
    ["daily x 8 weeks", 1],
    ["مرتين يوميا", 2],
  ])("%s → %d", (text, n) => {
    expect(dosesPerDay(text)).toBe(n);
  });

  it("reads weekly schedules as a fraction of a day", () => {
    expect(dosesPerDay("once weekly")).toBeCloseTo(1 / 7);
    expect(dosesPerDay("weekly on Fridays")).toBeCloseTo(1 / 7);
    expect(dosesPerDay("twice a week")).toBeCloseTo(2 / 7);
    expect(dosesPerDay("Three times weekly")).toBeCloseTo(3 / 7);
    expect(dosesPerDay("Every 4 weeks")).toBeCloseTo(1 / 28);
  });

  it("returns null when the frequency cannot be read", () => {
    expect(dosesPerDay("as needed")).toBeNull();
    expect(dosesPerDay("")).toBeNull();
    expect(dosesPerDay(null)).toBeNull();
  });
});

describe("dailyDose", () => {
  it("multiplies the dose, the tablets and the frequency", () => {
    expect(dailyDose({ name: "Doxycycline", dosage: "100 mg", frequency: "twice daily" })?.dailyMg).toBe(200);
    expect(dailyDose({ name: "Doxycycline 100 mg", dosage: "2 tablets", frequency: "1-0-1" })?.dailyMg).toBe(400);
    expect(dailyDose({ name: "Paracetamol", dosage: "1 g", frequency: "every 6 hours" })?.dailyMg).toBe(4000);
    expect(dailyDose({ name: "Paracetamol", dosage: "2 x 500 mg", frequency: "TID" })?.dailyMg).toBe(3000);
    expect(dailyDose({ name: "Ibuprofen", dosage: "400 mg three times a day" })?.dailyMg).toBe(1200);
    expect(dailyDose({ name: "Spironolactone", dosage: "100 mg/day" })?.dailyMg).toBe(100);
    expect(dailyDose({ name: "Finasteride", dosage: "1000 mcg", frequency: "daily" })?.dailyMg).toBe(1);
  });

  it("gives up on concentrations, weight-based and topical amounts", () => {
    expect(dailyDose({ name: "Amoxicillin 250mg/5ml", dosage: "10 ml", frequency: "TID" })).toBeNull();
    expect(dailyDose({ name: "Isotretinoin", dosage: "0.5 mg/kg", frequency: "daily" })).toBeNull();
    expect(dailyDose({ name: "Minoxidil 5%", dosage: "1 ml", frequency: "BID" })).toBeNull();
  });

  it("assumes one dose when the frequency is unreadable", () => {
    expect(dailyDose({ name: "Isotretinoin", dosage: "120 mg" })).toMatchObject({ dailyMg: 120, dosesPerDay: null });
  });
});
