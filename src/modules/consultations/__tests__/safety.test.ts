import { describe, expect, it } from "vitest";
import { ageInYears, checkPrescribing, conditionsSayPregnant, parseAllergy, type PrescribingInput } from "../safety/engine";
import { COMBINATIONS, INGREDIENTS } from "../safety/knowledge";
import { identifyMedication, tokenize } from "../safety/identify";

/**
 * The prescribing-safety rule engine, family by family, with a positive and
 * a negative case for each rule the clinic relies on.
 */

const NOW = new Date("2026-10-28T10:00:00Z");
const MAN_40 = { gender: "MALE", dateOfBirth: "1986-05-01" };
const WOMAN_40 = { gender: "FEMALE", dateOfBirth: "1986-05-01" };
const WOMAN_25 = { gender: "FEMALE", dateOfBirth: "2001-02-02" };
const WOMAN_62 = { gender: "FEMALE", dateOfBirth: "1964-01-15" };

type Med = { name: string; dosage?: string; frequency?: string };

function check(proposed: Med[], opts: Partial<Omit<PrescribingInput, "proposed">> = {}) {
  return checkPrescribing({
    patient: MAN_40,
    allergies: [],
    conditions: [],
    activeMedications: [],
    now: NOW,
    ...opts,
    proposed,
  });
}

const rules = (findings: { rule: string; severity: string }[]) => findings.map((f) => `${f.severity}:${f.rule}`);

describe("knowledge table", () => {
  it("maps every alias to one medicine only", () => {
    const owners = new Map<string, string>();
    const clash: string[] = [];
    const add = (alias: string, owner: string) => {
      const key = tokenize(alias).join(" ");
      const existing = owners.get(key);
      if (existing && existing !== owner) clash.push(`${alias}: ${existing} / ${owner}`);
      owners.set(key, owner);
    };
    for (const i of INGREDIENTS) for (const a of i.aliases ?? []) add(typeof a === "string" ? a : a.name, i.key);
    for (const c of COMBINATIONS) for (const a of c.aliases) add(a, c.ingredients.join("+"));
    expect(clash).toEqual([]);
  });

  it("finds every ingredient by its generic name and every combination's parts", () => {
    for (const i of INGREDIENTS) {
      const generic = i.name.replace(/\s*\(.*\)$/, "");
      expect(identifyMedication({ name: generic }).ingredients.map((x) => x.key), generic).toContain(i.key);
    }
    const keys = new Set(INGREDIENTS.map((i) => i.key));
    for (const c of COMBINATIONS) for (const k of c.ingredients) expect(keys.has(k), `${c.name}: ${k}`).toBe(true);
  });
});

describe("brand names and spelling variants", () => {
  it.each([
    ["Roaccutane 20 mg", ["isotretinoin"]],
    ["Acnotren 10mg", ["isotretinoin"]],
    ["Propecia", ["finasteride"]],
    ["Regaine foam 5%", ["minoxidil"]],
    ["Vibramycin 100 mg", ["doxycycline"]],
    ["Augmentin 1 g", ["amoxicillin", "clavulanic-acid"]],
    ["Hibiotic 625", ["amoxicillin", "clavulanic-acid"]],
    ["Ospexin 500", ["cephalexin"]],
    ["Cefalexin", ["cephalexin"]],
    ["Bactrim DS", ["sulfamethoxazole", "trimethoprim"]],
    ["Brufen 400", ["ibuprofen"]],
    ["Cataflam 50", ["diclofenac"]],
    ["Panadol Extra", ["paracetamol"]],
    ["Amoxicilin 500 mg", ["amoxicillin"]], // one-letter typo
    ["Doxycyclin", ["doxycycline"]],
    ["Xylocaine 2%", ["lidocaine"]],
    ["EMLA cream", ["lidocaine", "prilocaine"]],
    ["Botox 20 units", ["botulinum-toxin"]],
    ["إيبوبروفين", ["ibuprofen"]],
  ])("%s → %j", (name, generics) => {
    expect(identifyMedication({ name }).ingredients.map((i) => i.key).sort()).toEqual([...generics].sort());
  });

  it("leaves unknown names unknown", () => {
    expect(identifyMedication({ name: "Emollient cream" }).ingredients).toEqual([]);
    expect(identifyMedication({ name: "Broad-spectrum sunscreen SPF 50" }).ingredients).toEqual([]);
  });
});

describe("allergy", () => {
  it("stops a penicillin for a penicillin allergy", () => {
    const f = check([{ name: "Amoxicillin", dosage: "500 mg", frequency: "three times daily" }], { allergies: ["Penicillin"] });
    expect(rules(f)).toEqual(["stop:allergy.direct"]);
    expect(f[0]!.medication).toBe("Amoxicillin");
    expect(f[0]!.message).toMatch(/amoxicillin is a penicillin/i);
    expect(f[0]!.message).toContain("Penicillin");
  });

  it("stops a brand of the same ingredient and another member of the class", () => {
    expect(rules(check([{ name: "Augmentin 1 g" }], { allergies: ["Amoxicillin (rash)"] }))).toEqual(["stop:allergy.direct"]);
    expect(rules(check([{ name: "Flucloxacillin" }], { allergies: ["Amoxicillin"] }))).toEqual(["stop:allergy.class"]);
  });

  it("stops cephalexin for a penicillin allergy (cross-reactivity), and carbapenems too", () => {
    const f = check([{ name: "Cephalexin", dosage: "500 mg", frequency: "Twice daily for 5 days" }], { allergies: ["Penicillin"] });
    expect(rules(f)).toEqual(["stop:allergy.cross-reactivity"]);
    expect(f[0]!.message).toMatch(/cephalexin is a cephalosporin/i);
    for (const name of ["Cefadroxil", "Cefuroxime", "Ceftriaxone 1 g IM", "Meropenem"]) {
      expect(rules(check([{ name }], { allergies: ["Penicillin"] })), name).toEqual(["stop:allergy.cross-reactivity"]);
    }
  });

  it("finds nothing for azithromycin with a penicillin allergy", () => {
    expect(check([{ name: "Azithromycin", dosage: "500 mg", frequency: "once daily" }], { allergies: ["Penicillin"] })).toEqual([]);
  });

  it("reads Arabic allergies", () => {
    expect(rules(check([{ name: "Amoxicillin" }], { allergies: ["البنسلين"] }))).toEqual(["stop:allergy.direct"]);
  });

  it("stops sulfonamide antibiotics for a sulfa allergy and warns for non-antibiotic sulfonamides", () => {
    expect(rules(check([{ name: "Co-trimoxazole 960 mg" }], { allergies: ["Sulfa drugs"] }))).toEqual(["stop:allergy.direct"]);
    expect(rules(check([{ name: "Furosemide 40 mg" }], { allergies: ["Sulfa drugs"] }))).toEqual(["warn:allergy.cross-reactivity"]);
    expect(rules(check([{ name: "Dapsone 50 mg" }], { allergies: ["Sulfonamides"] }))).toEqual(["warn:allergy.cross-reactivity"]);
    expect(check([{ name: "Trimethoprim 200 mg" }], { allergies: ["Sulfa drugs"] })).toEqual([]);
  });

  it("stops every NSAID for an NSAID or aspirin allergy, but not paracetamol", () => {
    expect(rules(check([{ name: "Ibuprofen 400 mg" }], { allergies: ["NSAIDs"] }))).toEqual(["stop:allergy.direct"]);
    expect(rules(check([{ name: "Diclofenac" }], { allergies: ["Aspirin"] }))).toEqual(["stop:allergy.class"]);
    expect(check([{ name: "Paracetamol 500 mg" }], { allergies: ["NSAIDs"] })).toEqual([]);
  });

  it("stops isotretinoin for a vitamin A allergy (oral), warns for a topical retinoid", () => {
    expect(rules(check([{ name: "Isotretinoin 20 mg" }], { allergies: ["Vitamin A"] }))).toEqual(["stop:allergy.cross-reactivity"]);
    expect(rules(check([{ name: "Adapalene 0.1% gel" }], { allergies: ["Vitamin A"] }))).toEqual(["warn:allergy.cross-reactivity"]);
  });

  it("stops other amide local anaesthetics for a lidocaine allergy, not an ester", () => {
    expect(rules(check([{ name: "Mepivacaine 3%", dosage: "1.8 ml", frequency: "local infiltration" }], { allergies: ["Lidocaine"] }))).toEqual(["stop:allergy.class"]);
    expect(rules(check([{ name: "EMLA cream" }], { allergies: ["Xylocaine"] }))).toEqual(["stop:allergy.direct"]);
    expect(check([{ name: "Benzocaine gel" }], { allergies: ["Lidocaine"] })).toEqual([]);
  });

  it("warns about latex for procedures and injections only", () => {
    expect(rules(check([{ name: "Botox", dosage: "20 units" }], { allergies: ["Latex"] }))).toEqual(["warn:allergy.latex"]);
    expect(rules(check([{ name: "Intralesional triamcinolone", dosage: "5 mg/ml" }], { allergies: ["Latex"] }))).toEqual(["warn:allergy.latex"]);
    expect(check([{ name: "Doxycycline 100 mg" }], { allergies: ["Latex"] })).toEqual([]);
  });

  it("ignores 'no known allergies' and non-drug allergies", () => {
    expect(parseAllergy("No known drug allergies")).toBeNull();
    expect(parseAllergy("NKDA")).toBeNull();
    expect(parseAllergy("Peanuts")).toBeNull();
    expect(check([{ name: "Amoxicillin" }], { allergies: ["None", "Shellfish"] })).toEqual([]);
  });
});

describe("duplicate therapy", () => {
  it("warns for the same generic under another name or strength (active + proposed)", () => {
    const f = check([{ name: "Minoxidil 5%", dosage: "1 ml", frequency: "twice daily" }], {
      activeMedications: [{ name: "Minoxidil 5% solution", dosage: "1 ml", frequency: "Twice daily" }],
    });
    expect(rules(f)).toEqual(["warn:duplicate.same-drug"]);
    expect(f[0]!.message).toMatch(/Minoxidil 5% solution/);
    expect(f[0]!.message).toMatch(/updates that entry/);
  });

  it("warns when the same generic is prescribed twice", () => {
    const f = check([{ name: "Brufen 400 mg" }, { name: "Ibuprofen 200 mg" }]);
    expect(rules(f)).toEqual(["warn:duplicate.same-drug"]);
    expect(f[0]!.medication).toBe("Ibuprofen 200 mg");
  });

  it("does not warn when the same line is simply continued or its dose changed", () => {
    expect(check([{ name: "metformin", dosage: "1000 mg", frequency: "twice daily" }], { activeMedications: [{ name: "Metformin", dosage: "500 mg" }] })).toEqual([]);
  });

  it("warns for two members of a duplicated class (two NSAIDs)", () => {
    expect(rules(check([{ name: "Diclofenac 50 mg" }], { activeMedications: [{ name: "Ibuprofen 400 mg" }] }))).toEqual(["warn:duplicate.same-class"]);
    expect(rules(check([{ name: "Finasteride 1 mg" }, { name: "Dutasteride 0.5 mg" }]))).toEqual(["warn:duplicate.same-class"]);
  });
});

describe("interactions", () => {
  it("stops isotretinoin with doxycycline (intracranial hypertension), either way round", () => {
    const f = check([{ name: "Isotretinoin", dosage: "20 mg", frequency: "daily" }, { name: "Doxycycline", dosage: "100 mg", frequency: "daily" }]);
    expect(rules(f)).toEqual(["stop:interaction.retinoid-tetracycline"]);
    expect(f[0]!.message).toMatch(/^Isotretinoin with Doxycycline: .*intracranial hypertension/);
    expect(rules(check([{ name: "Roaccutane 20 mg" }], { activeMedications: [{ name: "Minocycline 100 mg" }] }))).toEqual(["stop:interaction.retinoid-tetracycline"]);
  });

  it("ignores a topical retinoid with doxycycline", () => {
    expect(check([{ name: "Isotrex gel" }, { name: "Doxycycline 100 mg" }])).toEqual([]);
  });

  it("stops isotretinoin with vitamin A supplements", () => {
    expect(rules(check([{ name: "Isotretinoin 20 mg" }], { activeMedications: [{ name: "Vitamin A 25,000 IU" }] }))).toEqual(["stop:interaction.retinoid-vitamin-a"]);
  });

  it("stops methotrexate with trimethoprim or co-trimoxazole", () => {
    expect(rules(check([{ name: "Bactrim", dosage: "960 mg", frequency: "twice daily" }], { activeMedications: [{ name: "Methotrexate", dosage: "15 mg", frequency: "once weekly" }] }))).toEqual(["stop:interaction.methotrexate-trimethoprim"]);
    expect(rules(check([{ name: "Trimethoprim 200 mg" }], { activeMedications: [{ name: "Methotrexate", dosage: "10 mg", frequency: "weekly" }] }))).toEqual(["stop:interaction.methotrexate-trimethoprim"]);
  });

  it("warns for spironolactone with potassium, ACE inhibitors or ARBs", () => {
    expect(rules(check([{ name: "Spironolactone 100 mg" }], { activeMedications: [{ name: "Potassium chloride" }] }))).toEqual(["warn:interaction.potassium-sparing-potassium"]);
    expect(rules(check([{ name: "Aldactone 50 mg" }], { activeMedications: [{ name: "Lisinopril 10 mg" }] }))).toEqual(["warn:interaction.potassium-sparing-raas"]);
    expect(rules(check([{ name: "Spironolactone 50 mg" }], { activeMedications: [{ name: "Losartan 50 mg" }] }))).toEqual(["warn:interaction.potassium-sparing-raas"]);
  });

  it("warns for warfarin with NSAIDs or aspirin", () => {
    expect(rules(check([{ name: "Ibuprofen 400 mg" }], { activeMedications: [{ name: "Warfarin 5 mg" }] }))).toEqual(["warn:interaction.anticoagulant-nsaid"]);
    expect(rules(check([{ name: "Aspirin 75 mg" }], { activeMedications: [{ name: "Marevan" }] }))).toEqual(["warn:interaction.anticoagulant-nsaid"]);
    expect(check([{ name: "Diclofenac gel" }], { activeMedications: [{ name: "Warfarin" }] })).toEqual([]);
  });

  it("warns for oral azoles with the statins they affect, not terbinafine", () => {
    expect(rules(check([{ name: "Itraconazole 200 mg" }], { activeMedications: [{ name: "Simvastatin 20 mg" }] }))).toEqual(["warn:interaction.azole-statin"]);
    expect(rules(check([{ name: "Fluconazole 150 mg" }], { activeMedications: [{ name: "Atorvastatin 20 mg" }] }))).toEqual(["warn:interaction.fluconazole-statin"]);
    expect(check([{ name: "Terbinafine 250 mg" }], { activeMedications: [{ name: "Atorvastatin 20 mg" }] })).toEqual([]);
    expect(check([{ name: "Itraconazole 200 mg" }], { activeMedications: [{ name: "Rosuvastatin 10 mg" }] })).toEqual([]);
    expect(check([{ name: "Ketoconazole 2% shampoo" }], { activeMedications: [{ name: "Simvastatin 20 mg" }] })).toEqual([]);
  });

  it("warns for azithromycin or clarithromycin with QT-prolonging medicines", () => {
    expect(rules(check([{ name: "Azithromycin 500 mg" }], { activeMedications: [{ name: "Hydroxychloroquine 200 mg" }] }))).toEqual(["warn:interaction.macrolide-qt"]);
    expect(rules(check([{ name: "Clarithromycin 500 mg" }], { activeMedications: [{ name: "Citalopram 20 mg" }] }))).toEqual(["warn:interaction.macrolide-qt"]);
    expect(check([{ name: "Azithromycin 500 mg" }], { activeMedications: [{ name: "Cetirizine 10 mg" }] })).toEqual([]);
  });
});

describe("pregnancy and sex", () => {
  it("stops finasteride for a 40-year-old woman and finds nothing for a man", () => {
    const f = check([{ name: "Finasteride", dosage: "1 mg", frequency: "Once daily" }], { patient: WOMAN_40 });
    expect(rules(f)).toEqual(["stop:pregnancy.teratogen"]);
    expect(f[0]!.message).toMatch(/Finasteride/);
    expect(f[0]!.message).toMatch(/male baby/);
    expect(check([{ name: "Finasteride", dosage: "1 mg", frequency: "Once daily" }], { patient: MAN_40 })).toEqual([]);
  });

  it("stops finasteride and dutasteride for any woman, whatever her age or pregnancy status", () => {
    expect(rules(check([{ name: "Dutasteride 0.5 mg" }], { patient: WOMAN_62 }))).toEqual(["stop:pregnancy.teratogen"]);
    expect(rules(check([{ name: "Finasteride 1 mg" }], { patient: { ...WOMAN_25, pregnant: false } }))).toEqual(["stop:pregnancy.teratogen"]);
  });

  it("stops isotretinoin and methotrexate for a woman of childbearing age unless pregnancy is excluded", () => {
    expect(rules(check([{ name: "Isotretinoin 20 mg" }], { patient: WOMAN_25 }))).toEqual(["stop:pregnancy.teratogen"]);
    expect(rules(check([{ name: "Methotrexate 15 mg", frequency: "once weekly" }], { patient: WOMAN_25 }))).toEqual(["stop:pregnancy.teratogen"]);
    expect(rules(check([{ name: "Isotretinoin 20 mg" }], { patient: { ...WOMAN_25, pregnant: false } }))).toEqual(["warn:pregnancy.contraception"]);
    expect(check([{ name: "Isotretinoin 20 mg" }], { patient: WOMAN_62 })).toEqual([]);
  });

  it("warns for the other pregnancy-risk medicines in a woman of childbearing age", () => {
    for (const name of ["Spironolactone 100 mg", "Doxycycline 100 mg", "Minoxidil 2.5 mg tablets", "Tazarotene 0.1% gel", "Adapalene 0.1% gel"]) {
      expect(rules(check([{ name }], { patient: WOMAN_25 })), name).toEqual(["warn:pregnancy.caution"]);
    }
    // Topical minoxidil is not on the list.
    expect(check([{ name: "Minoxidil 5% solution" }], { patient: WOMAN_25 })).toEqual([]);
  });

  it("makes every pregnancy risk a stop when the patient is pregnant (recorded or in her conditions)", () => {
    expect(rules(check([{ name: "Doxycycline 100 mg" }], { patient: { ...WOMAN_25, pregnant: true } }))).toEqual(["stop:pregnancy.pregnant"]);
    expect(rules(check([{ name: "Spironolactone 50 mg" }], { patient: WOMAN_25, conditions: ["Pregnant, 12 weeks"] }))).toEqual(["stop:pregnancy.pregnant"]);
    expect(conditionsSayPregnant(["Post-pregnancy hair loss"])).toBe(false);
    expect(conditionsSayPregnant(["Pregnancy test negative"])).toBe(false);
    expect(conditionsSayPregnant(["حامل في الشهر الثالث"])).toBe(true);
  });

  it("warns that a teratogen could not be checked when the sex is not recorded", () => {
    expect(rules(check([{ name: "Isotretinoin 20 mg" }], { patient: { gender: "UNDISCLOSED", dateOfBirth: null } }))).toEqual(["warn:pregnancy.sex-unknown"]);
    expect(check([{ name: "Doxycycline 100 mg" }], { patient: { gender: "UNDISCLOSED", dateOfBirth: null } })).toEqual([]);
  });
});

describe("age", () => {
  it("stops doxycycline for a 6-year-old, not for a 9-year-old", () => {
    const six = { gender: "MALE", dateOfBirth: "2020-03-01" };
    const f = check([{ name: "Doxycycline", dosage: "50 mg", frequency: "twice daily" }], { patient: six });
    expect(rules(f)).toEqual(["stop:age.tetracycline-under-8"]);
    expect(f[0]!.message).toMatch(/The patient is 6/);
    expect(check([{ name: "Doxycycline", dosage: "50 mg" }], { patient: { gender: "MALE", dateOfBirth: "2017-03-01" } })).toEqual([]);
  });

  it("warns for isotretinoin under 12 and aspirin under 16", () => {
    expect(rules(check([{ name: "Isotretinoin 10 mg" }], { patient: { gender: "MALE", dateOfBirth: "2015-06-01" } }))).toEqual(["warn:age.isotretinoin-under-12"]);
    expect(rules(check([{ name: "Aspirin 300 mg" }], { patient: { gender: "MALE", dateOfBirth: "2012-06-01" } }))).toEqual(["warn:age.aspirin-under-16"]);
    expect(check([{ name: "Aspirin 300 mg" }], { patient: { gender: "MALE", dateOfBirth: "2008-06-01" } })).toEqual([]);
  });

  it("computes the age in whole years on the reference date", () => {
    expect(ageInYears("2020-10-29", NOW)).toBe(5);
    expect(ageInYears("2020-10-28", NOW)).toBe(6);
    expect(ageInYears(null, NOW)).toBeNull();
  });
});

describe("dose", () => {
  it("warns above the daily maximum and stays quiet at it", () => {
    expect(rules(check([{ name: "Isotretinoin", dosage: "60 mg", frequency: "twice daily" }]))).toEqual(["warn:dose.max-daily"]);
    expect(check([{ name: "Isotretinoin", dosage: "40 mg", frequency: "twice daily" }])).toEqual([]);
    expect(rules(check([{ name: "Finasteride", dosage: "10 mg", frequency: "daily" }]))).toEqual(["warn:dose.max-daily"]);
    expect(rules(check([{ name: "Minoxidil tablets", dosage: "5 mg", frequency: "twice daily" }]))).toEqual(["warn:dose.max-daily"]);
    expect(rules(check([{ name: "Doxycycline 100 mg", dosage: "1 tablet", frequency: "three times daily" }]))).toEqual(["warn:dose.max-daily"]);
    expect(rules(check([{ name: "Cephalexin", dosage: "1 g", frequency: "every 4 hours" }]))).toEqual(["warn:dose.max-daily"]);
    expect(rules(check([{ name: "Ibuprofen", dosage: "800 mg", frequency: "QID" }]))).toEqual(["warn:dose.max-daily"]);
    expect(rules(check([{ name: "Paracetamol 500mg", dosage: "2 tablets", frequency: "every 4 hours" }]))).toEqual(["warn:dose.max-daily"]);
    expect(check([{ name: "Paracetamol 500mg", dosage: "2 tablets", frequency: "1-1-1" }])).toEqual([]);
  });

  it("names the drug and the numbers", () => {
    const [f] = check([{ name: "Isotretinoin", dosage: "60 mg", frequency: "twice daily" }]);
    expect(f!.message).toMatch(/Isotretinoin: 120 mg a day is above the usual maximum of 80 mg a day/);
    expect(f!.message).toMatch(/weight/);
    expect(f!.detail).toMatchObject({ dailyMg: 120, maxDailyMg: 80 });
  });

  it("does not dose-check topical forms", () => {
    expect(check([{ name: "Minoxidil 5% solution", dosage: "1 ml", frequency: "twice daily" }])).toEqual([]);
  });

  it("stops a daily methotrexate schedule and asks for the frequency when it is missing", () => {
    expect(rules(check([{ name: "Methotrexate 2.5 mg", dosage: "4 tablets", frequency: "daily" }]))).toEqual(["stop:dose.weekly-only"]);
    expect(check([{ name: "Methotrexate 2.5 mg", dosage: "4 tablets", frequency: "once weekly" }])).toEqual([]);
    expect(rules(check([{ name: "Methotrexate", dosage: "15 mg" }]))).toEqual(["warn:dose.weekly-only"]);
    expect(rules(check([{ name: "Methotrexate", dosage: "30 mg", frequency: "weekly" }]))).toEqual(["warn:dose.max-weekly"]);
  });
});

describe("conditions", () => {
  it("warns for NSAIDs with chronic kidney disease", () => {
    const f = check([{ name: "Ibuprofen 400 mg" }], { conditions: ["CKD stage 3"] });
    expect(rules(f)).toEqual(["warn:condition.nsaid-ckd"]);
    expect(f[0]!.message).toMatch(/^Ibuprofen 400 mg: the patient has chronic kidney disease \(“CKD stage 3”\)\. NSAIDs/);
  });

  it("warns for isotretinoin with depression", () => {
    expect(rules(check([{ name: "Isotretinoin 20 mg" }], { conditions: ["Depression"] }))).toEqual(["warn:condition.isotretinoin-depression"]);
  });

  it("warns for oral minoxidil with low blood pressure or heart failure, not for the scalp solution or hypertension", () => {
    expect(rules(check([{ name: "Minoxidil 2.5 mg" }], { conditions: ["Hypotension"] }))).toEqual(["warn:condition.minoxidil-hypotension"]);
    expect(rules(check([{ name: "Minoxidil 2.5 mg" }], { conditions: ["Heart failure (EF 35%)"] }))).toEqual(["warn:condition.minoxidil-heart-failure"]);
    expect(check([{ name: "Minoxidil 5% solution" }], { conditions: ["Heart failure"] })).toEqual([]);
    expect(check([{ name: "Minoxidil 2.5 mg" }], { conditions: ["Hypertension"] })).toEqual([]);
  });
});

describe("output", () => {
  it("lists stops before warnings and only checks proposed medications", () => {
    const f = check(
      [
        { name: "Adapalene 0.1% gel" },
        { name: "Isotretinoin 20 mg" },
      ],
      { patient: WOMAN_25, activeMedications: [{ name: "Doxycycline 100 mg" }, { name: "Ibuprofen" }] },
    );
    expect(f.map((x) => x.severity)).toEqual(["stop", "stop", "warn"]);
    expect(f.every((x) => ["Adapalene 0.1% gel", "Isotretinoin 20 mg"].includes(x.medication))).toBe(true);
  });

  it("returns nothing when nothing is proposed", () => {
    expect(check([], { allergies: ["Penicillin"], activeMedications: [{ name: "Amoxicillin" }] })).toEqual([]);
  });
});

describe("per-kilogram doses", () => {
  const isotretinoin = (dosage: string) => [{ name: "Isotretinoin", dosage, frequency: "Once daily" }];
  const MAN_50KG = { ...MAN_40, weightKg: 50 };

  it("warns when the daily dose is above the usual mg/kg for the recorded weight", () => {
    const findings = check(isotretinoin("60 mg"), { patient: MAN_50KG });
    expect(rules(findings)).toEqual(["warn:dose.per-kg"]);
    expect(findings[0]!.message).toBe("Isotretinoin: 60 mg a day is 1.2 mg/kg a day for 50 kg, above the usual 0.5 to 1 mg/kg a day. Check the dose (written: “60 mg, Once daily”).");
  });

  it("says nothing within the usual range, and cannot check without a weight", () => {
    expect(check(isotretinoin("40 mg"), { patient: MAN_50KG })).toEqual([]);
    expect(check(isotretinoin("60 mg"), { patient: MAN_40 })).toEqual([]);
    // Above the daily maximum without a weight: the warning says the mg/kg dose could not be checked.
    const unknown = check(isotretinoin("100 mg"), { patient: MAN_40 });
    expect(rules(unknown)).toEqual(["warn:dose.max-daily"]);
    expect(unknown[0]!.message).toContain("cannot be checked without the patient's weight");
    // With a weight both say so, and the note goes.
    const both = check(isotretinoin("100 mg"), { patient: MAN_50KG });
    expect(rules(both)).toEqual(["warn:dose.max-daily", "warn:dose.per-kg"]);
    expect(both[0]!.message).not.toContain("cannot be checked");
  });
});

