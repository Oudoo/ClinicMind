/**
 * Prescribing-safety knowledge table — a STARTER LIST.
 *
 * Everything the prescribing checks know about medicines lives in this one
 * file: ingredients with their brand names, spelling variants and classes,
 * combination products, allergy cross-reactivity, interactions, therapeutic
 * duplication, age limits, pregnancy risk, daily-dose maxima and conditions.
 * The rule engine (`./engine.ts`) only interprets this data.
 *
 * It covers the medicines a dermatology, hair and aesthetics clinic in Cairo
 * prescribes most often, the common antibiotics and analgesics, and the
 * medicines patients commonly already take that interact with them. It is NOT
 * a complete drug database: an unknown name is simply not checked. It will be
 * replaced by a licensed drug database (Phase 4); until then every addition is
 * a clinical decision — keep entries short, sourced from the product labels
 * (SmPC / FDA), and add a unit test with each new rule.
 *
 * Client-safe: pure data, no imports beyond types.
 */

export type Severity = "stop" | "warn";
export type Route = "oral" | "topical" | "injection";
/** Interactions and most contraindications concern systemic exposure. */
export type RouteGroup = "systemic" | "topical";

export const routeGroup = (route: Route): RouteGroup => (route === "topical" ? "topical" : "systemic");

export const DRUG_CLASSES = [
  "antibiotic",
  "beta-lactam",
  "penicillin",
  "cephalosporin",
  "carbapenem",
  "sulfonamide-antibiotic",
  "sulfonamide-non-antibiotic",
  "sulfone",
  "antifolate",
  "tetracycline",
  "macrolide",
  "lincosamide",
  "fluoroquinolone",
  "aminoglycoside",
  "nitroimidazole",
  "analgesic",
  "nsaid",
  "opioid",
  "oral-retinoid",
  "topical-retinoid",
  "vitamin-a",
  "5-alpha-reductase-inhibitor",
  "antiandrogen",
  "vasodilator",
  "potassium-sparing-diuretic",
  "diuretic",
  "potassium-supplement",
  "ace-inhibitor",
  "arb",
  "anticoagulant",
  "vitamin-k-antagonist",
  "antiplatelet",
  "statin",
  "antifungal",
  "azole-antifungal",
  "qt-prolonging",
  "amide-local-anaesthetic",
  "ester-local-anaesthetic",
  "corticosteroid",
  "topical-corticosteroid",
  "immunosuppressant",
  "antimalarial",
  "antihistamine",
  "antiviral",
  "antiparasitic",
  "polyvalent-cation",
  "estrogen",
  "progestogen",
  "combined-oral-contraceptive",
  "antifibrinolytic",
  "ssri",
  "serotonergic",
  "antidepressant",
  "antipsychotic",
  "antiemetic",
  "antiarrhythmic",
  "antidiabetic",
  "alpha-blocker",
  "colchicine",
  "calcineurin-inhibitor",
  "vitamin-d-analogue",
  "keratolytic",
  "depigmenting",
  "botulinum-toxin",
  "dermal-filler",
  "procedure",
] as const;
export type DrugClass = (typeof DRUG_CLASSES)[number];

/** How a class reads inside a sentence: "Amoxicillin is a penicillin". */
export const CLASS_LABELS: Partial<Record<DrugClass, string>> = {
  penicillin: "a penicillin",
  cephalosporin: "a cephalosporin",
  carbapenem: "a carbapenem",
  "sulfonamide-antibiotic": "a sulfa drug (sulfonamide antibiotic type)",
  "sulfonamide-non-antibiotic": "a non-antibiotic sulfonamide",
  sulfone: "a sulfone, related to the sulfa drugs",
  tetracycline: "a tetracycline antibiotic",
  macrolide: "a macrolide antibiotic",
  fluoroquinolone: "a fluoroquinolone antibiotic",
  aminoglycoside: "an aminoglycoside antibiotic",
  nsaid: "an NSAID (anti-inflammatory painkiller)",
  opioid: "an opioid",
  "oral-retinoid": "an oral retinoid (a vitamin A derivative)",
  "topical-retinoid": "a topical retinoid (a vitamin A derivative)",
  "vitamin-a": "vitamin A",
  "5-alpha-reductase-inhibitor": "a 5-alpha-reductase inhibitor",
  "amide-local-anaesthetic": "an amide local anaesthetic",
  "ester-local-anaesthetic": "an ester local anaesthetic",
  "azole-antifungal": "an azole antifungal",
  statin: "a statin",
  anticoagulant: "an anticoagulant",
  ssri: "an SSRI antidepressant",
  "potassium-sparing-diuretic": "a potassium-sparing diuretic",
  "ace-inhibitor": "an ACE inhibitor",
  arb: "an angiotensin receptor blocker",
  corticosteroid: "a corticosteroid",
  "combined-oral-contraceptive": "a combined oral contraceptive",
  "potassium-supplement": "a potassium supplement",
  "polyvalent-cation": "a mineral supplement or antacid",
  "qt-prolonging": "a medicine that prolongs the QT interval",
};

/** Plural, for "both are NSAIDs" and allergy wording. */
export const CLASS_PLURALS: Partial<Record<DrugClass, string>> = {
  penicillin: "penicillins",
  cephalosporin: "cephalosporins",
  carbapenem: "carbapenems",
  "sulfonamide-antibiotic": "sulfa drugs",
  tetracycline: "tetracycline antibiotics",
  macrolide: "macrolide antibiotics",
  fluoroquinolone: "fluoroquinolone antibiotics",
  nsaid: "NSAIDs",
  opioid: "opioids",
  "oral-retinoid": "oral retinoids",
  "topical-retinoid": "topical retinoids",
  "vitamin-a": "vitamin A",
  "5-alpha-reductase-inhibitor": "5-alpha-reductase inhibitors",
  "amide-local-anaesthetic": "amide local anaesthetics",
  "ester-local-anaesthetic": "ester local anaesthetics",
  "azole-antifungal": "azole antifungals",
  statin: "statins",
  anticoagulant: "anticoagulants",
  ssri: "SSRI antidepressants",
  "potassium-sparing-diuretic": "potassium-sparing diuretics",
  "ace-inhibitor": "ACE inhibitors",
  arb: "angiotensin receptor blockers",
  corticosteroid: "systemic corticosteroids",
  "combined-oral-contraceptive": "combined oral contraceptives",
};

// ── Ingredients ──────────────────────────────────────────────────────────────

/** A brand or spelling variant; `route` when the name itself implies one (Isotrex is a gel). */
export type Alias = string | { name: string; route: Route };

export type PregnancyLevel = "teratogen" | "caution";

export interface PregnancyRisk {
  systemic?: PregnancyLevel;
  topical?: PregnancyLevel;
  /** Plain-English reason, completing "…: <why>". */
  why: string;
}

export interface Ingredient {
  /** Stable generic key, also the reconciliation key. */
  key: string;
  /** Display name of the generic. */
  name: string;
  /** Default route when the prescription text gives no hint. */
  route: Route;
  /** Other forms that exist (a "mg" dose picks "oral" when it is listed). */
  alsoRoutes?: readonly Route[];
  classes: readonly DrugClass[];
  aliases?: readonly Alias[];
  /** Usual adult maximum for the oral route, in mg per day. */
  maxDailyMg?: number;
  /** Appended to the dose warning. */
  doseNote?: string;
  /** Taken once a week (methotrexate): a daily schedule is a stop. */
  weeklyOnly?: { maxWeeklyMg: number };
  pregnancy?: PregnancyRisk;
  /** Contraindicated in every female patient, whatever her age (finasteride, dutasteride). */
  femaleContraindicated?: true;
}

const oral = "oral" as const;
const topical = "topical" as const;
const injection = "injection" as const;

const BL = ["antibiotic", "beta-lactam"] as const;
const PEN = [...BL, "penicillin"] as const;
const CEPH = [...BL, "cephalosporin"] as const;
const CARB = [...BL, "carbapenem"] as const;
const TETRA: PregnancyRisk = {
  systemic: "caution",
  why: "tetracyclines stain the baby's teeth and affect bone growth after the first trimester",
};
const TOPICAL_RETINOID: PregnancyRisk = {
  topical: "caution",
  why: "it is a retinoid (a vitamin A derivative)",
};
const FIVE_ARI: PregnancyRisk = {
  systemic: "teratogen",
  topical: "teratogen",
  why: "it blocks male hormones and causes abnormal genitals in a male baby; even handling crushed tablets is unsafe in pregnancy",
};

export const INGREDIENTS: readonly Ingredient[] = [
  // ── Penicillins ──
  { key: "penicillin", name: "Penicillin", route: oral, alsoRoutes: [injection], classes: PEN, aliases: ["penicillin", "penicilline", "penicilin", "pcn", "بنسلين", "بنسيلين"] },
  { key: "amoxicillin", name: "Amoxicillin", route: oral, classes: PEN, aliases: ["amoxicillin", "amoxycillin", "amoxicilline", "amoxicilin", "amoxil", "emox", "ibiamox", "اموكسيسيلين", "اموكسيسيللين", "اموكسيل"] },
  { key: "ampicillin", name: "Ampicillin", route: oral, alsoRoutes: [injection], classes: PEN, aliases: ["ampicillin", "ampicilline", "penbritin"] },
  { key: "flucloxacillin", name: "Flucloxacillin", route: oral, classes: PEN, aliases: ["flucloxacillin", "floxacillin", "floxapen"] },
  { key: "cloxacillin", name: "Cloxacillin", route: oral, classes: PEN, aliases: ["cloxacillin", "dicloxacillin"] },
  { key: "phenoxymethylpenicillin", name: "Phenoxymethylpenicillin (penicillin V)", route: oral, classes: PEN, aliases: ["phenoxymethylpenicillin", "phenoxymethyl penicillin", "penicillin v", "penicillin vk", "pen v", "pen vk", "ospen"] },
  { key: "benzylpenicillin", name: "Benzylpenicillin (penicillin G)", route: injection, classes: PEN, aliases: ["benzylpenicillin", "penicillin g", "benzathine penicillin", "benzathine benzylpenicillin", "penadur", "retarpen", "bicillin", "extencilline"] },
  { key: "piperacillin", name: "Piperacillin", route: injection, classes: PEN, aliases: ["piperacillin", "tazocin"] },
  { key: "clavulanic-acid", name: "Clavulanic acid", route: oral, classes: ["antibiotic"], aliases: ["clavulanic acid", "clavulanate", "potassium clavulanate"] },
  { key: "sulbactam", name: "Sulbactam", route: injection, classes: ["antibiotic"], aliases: ["sulbactam"] },
  // ── Cephalosporins ──
  { key: "cephalexin", name: "Cephalexin", route: oral, classes: CEPH, maxDailyMg: 4000, aliases: ["cephalexin", "cefalexin", "cephalexine", "cefalexine", "keflex", "ospexin", "ceporex", "سيفالكسين"] },
  { key: "cefadroxil", name: "Cefadroxil", route: oral, classes: CEPH, maxDailyMg: 2000, aliases: ["cefadroxil", "cefadroxile", "duricef", "biodroxil"] },
  { key: "cefuroxime", name: "Cefuroxime", route: oral, alsoRoutes: [injection], classes: CEPH, aliases: ["cefuroxime", "cefuroxim", "zinnat", "zinacef", "ceftin"] },
  { key: "ceftriaxone", name: "Ceftriaxone", route: injection, classes: CEPH, aliases: ["ceftriaxone", "ceftriaxon", "rocephin"] },
  { key: "cefixime", name: "Cefixime", route: oral, classes: CEPH, aliases: ["cefixime", "cefixim", "suprax"] },
  { key: "cefaclor", name: "Cefaclor", route: oral, classes: CEPH, aliases: ["cefaclor", "ceclor", "distaclor"] },
  { key: "cefprozil", name: "Cefprozil", route: oral, classes: CEPH, aliases: ["cefprozil", "cefzil"] },
  { key: "cefdinir", name: "Cefdinir", route: oral, classes: CEPH, aliases: ["cefdinir", "omnicef"] },
  { key: "cefpodoxime", name: "Cefpodoxime", route: oral, classes: CEPH, aliases: ["cefpodoxime", "orelox", "vantin"] },
  { key: "cefazolin", name: "Cefazolin", route: injection, classes: CEPH, aliases: ["cefazolin", "cephazolin", "ancef", "kefzol"] },
  { key: "cefotaxime", name: "Cefotaxime", route: injection, classes: CEPH, aliases: ["cefotaxime", "claforan"] },
  { key: "ceftazidime", name: "Ceftazidime", route: injection, classes: CEPH, aliases: ["ceftazidime", "fortum", "fortaz"] },
  { key: "cefepime", name: "Cefepime", route: injection, classes: CEPH, aliases: ["cefepime", "maxipime"] },
  { key: "cefoperazone", name: "Cefoperazone", route: injection, classes: CEPH, aliases: ["cefoperazone", "cefobid", "sulperazon"] },
  // ── Carbapenems ──
  { key: "meropenem", name: "Meropenem", route: injection, classes: CARB, aliases: ["meropenem", "meronem", "merrem"] },
  { key: "imipenem", name: "Imipenem", route: injection, classes: CARB, aliases: ["imipenem", "tienam", "primaxin"] },
  { key: "ertapenem", name: "Ertapenem", route: injection, classes: CARB, aliases: ["ertapenem", "invanz"] },
  // ── Sulfonamides, sulfones, trimethoprim ──
  { key: "sulfamethoxazole", name: "Sulfamethoxazole", route: oral, classes: ["antibiotic", "sulfonamide-antibiotic"], aliases: ["sulfamethoxazole", "sulphamethoxazole", "sulfamethoxazol"] },
  { key: "trimethoprim", name: "Trimethoprim", route: oral, classes: ["antibiotic", "antifolate"], aliases: ["trimethoprim", "trimethoprime"] },
  { key: "sulfadiazine", name: "Sulfadiazine", route: oral, classes: ["antibiotic", "sulfonamide-antibiotic"], aliases: ["sulfadiazine", "sulphadiazine"] },
  { key: "silver-sulfadiazine", name: "Silver sulfadiazine", route: topical, classes: ["antibiotic", "sulfonamide-antibiotic"], aliases: ["silver sulfadiazine", "silver sulphadiazine", "flamazine", "dermazin", "silvadene"] },
  { key: "sulfacetamide", name: "Sulfacetamide", route: topical, classes: ["antibiotic", "sulfonamide-antibiotic"], aliases: ["sulfacetamide", "sulphacetamide"] },
  { key: "sulfasalazine", name: "Sulfasalazine", route: oral, classes: ["sulfonamide-antibiotic"], aliases: ["sulfasalazine", "sulphasalazine", "salazopyrin", "azulfidine"] },
  { key: "dapsone", name: "Dapsone", route: oral, alsoRoutes: [topical], classes: ["antibiotic", "sulfone"], aliases: ["dapsone", "dapson", { name: "aczone", route: topical }] },
  { key: "furosemide", name: "Furosemide", route: oral, classes: ["diuretic", "sulfonamide-non-antibiotic"], aliases: ["furosemide", "frusemide", "lasix"] },
  { key: "hydrochlorothiazide", name: "Hydrochlorothiazide", route: oral, classes: ["diuretic", "sulfonamide-non-antibiotic"], aliases: ["hydrochlorothiazide", "hctz", "esidrex"] },
  { key: "indapamide", name: "Indapamide", route: oral, classes: ["diuretic", "sulfonamide-non-antibiotic"], aliases: ["indapamide", "natrilix"] },
  { key: "acetazolamide", name: "Acetazolamide", route: oral, classes: ["diuretic", "sulfonamide-non-antibiotic"], aliases: ["acetazolamide", "diamox"] },
  { key: "glibenclamide", name: "Glibenclamide", route: oral, classes: ["antidiabetic", "sulfonamide-non-antibiotic"], aliases: ["glibenclamide", "glyburide", "daonil"] },
  { key: "gliclazide", name: "Gliclazide", route: oral, classes: ["antidiabetic", "sulfonamide-non-antibiotic"], aliases: ["gliclazide", "diamicron"] },
  { key: "glimepiride", name: "Glimepiride", route: oral, classes: ["antidiabetic", "sulfonamide-non-antibiotic"], aliases: ["glimepiride", "amaryl"] },
  { key: "sumatriptan", name: "Sumatriptan", route: oral, classes: ["sulfonamide-non-antibiotic", "serotonergic"], aliases: ["sumatriptan", "imitrex", "imigran"] },
  { key: "topiramate", name: "Topiramate", route: oral, classes: ["sulfonamide-non-antibiotic"], aliases: ["topiramate", "topamax"] },
  // ── Tetracyclines ──
  { key: "doxycycline", name: "Doxycycline", route: oral, classes: ["antibiotic", "tetracycline"], maxDailyMg: 200, pregnancy: TETRA, aliases: ["doxycycline", "doxycyclin", "doxycycline hyclate", "doxycycline monohydrate", "doxy", "vibramycin", "vibra tabs", "doryx", "doxymycin", "oracea", "periostat", "monodox", "acticlate", "دوكسيسيكلين"] },
  { key: "minocycline", name: "Minocycline", route: oral, classes: ["antibiotic", "tetracycline"], maxDailyMg: 200, pregnancy: TETRA, aliases: ["minocycline", "minocyclin", "minocin", "solodyn", "minolira"] },
  { key: "tetracycline", name: "Tetracycline", route: oral, classes: ["antibiotic", "tetracycline"], maxDailyMg: 2000, pregnancy: TETRA, aliases: ["tetracycline", "tetracyclin", "achromycin", "sumycin"] },
  { key: "lymecycline", name: "Lymecycline", route: oral, classes: ["antibiotic", "tetracycline"], pregnancy: TETRA, aliases: ["lymecycline", "tetralysal"] },
  { key: "oxytetracycline", name: "Oxytetracycline", route: oral, alsoRoutes: [topical], classes: ["antibiotic", "tetracycline"], pregnancy: TETRA, aliases: ["oxytetracycline", "terramycin"] },
  { key: "sarecycline", name: "Sarecycline", route: oral, classes: ["antibiotic", "tetracycline"], pregnancy: TETRA, aliases: ["sarecycline", "seysara"] },
  // ── Macrolides, lincosamides ──
  { key: "azithromycin", name: "Azithromycin", route: oral, classes: ["antibiotic", "macrolide", "qt-prolonging"], aliases: ["azithromycin", "azithromycine", "azithro", "zithromax", "zmax", "xithrone", "ازيثرومايسين"] },
  { key: "clarithromycin", name: "Clarithromycin", route: oral, classes: ["antibiotic", "macrolide", "qt-prolonging"], maxDailyMg: 1000, aliases: ["clarithromycin", "clarithromycine", "clarithro", "klacid", "biaxin"] },
  { key: "erythromycin", name: "Erythromycin", route: oral, alsoRoutes: [topical], classes: ["antibiotic", "macrolide", "qt-prolonging"], aliases: ["erythromycin", "erythromycine", "erythrocin", "eryc", "ery tab"] },
  { key: "roxithromycin", name: "Roxithromycin", route: oral, classes: ["antibiotic", "macrolide", "qt-prolonging"], aliases: ["roxithromycin", "rulid"] },
  { key: "clindamycin", name: "Clindamycin", route: oral, alsoRoutes: [topical], classes: ["antibiotic", "lincosamide"], aliases: ["clindamycin", "clindamycine", "dalacin", { name: "dalacin c", route: oral }, { name: "dalacin t", route: topical }, "cleocin"] },
  // ── Fluoroquinolones, aminoglycosides, others ──
  { key: "ciprofloxacin", name: "Ciprofloxacin", route: oral, classes: ["antibiotic", "fluoroquinolone"], aliases: ["ciprofloxacin", "cipro", "ciprobay", "ciproxin"] },
  { key: "levofloxacin", name: "Levofloxacin", route: oral, classes: ["antibiotic", "fluoroquinolone", "qt-prolonging"], aliases: ["levofloxacin", "tavanic", "levaquin"] },
  { key: "moxifloxacin", name: "Moxifloxacin", route: oral, classes: ["antibiotic", "fluoroquinolone", "qt-prolonging"], aliases: ["moxifloxacin", "avelox", "avalox"] },
  { key: "ofloxacin", name: "Ofloxacin", route: oral, classes: ["antibiotic", "fluoroquinolone"], aliases: ["ofloxacin", "tarivid"] },
  { key: "gentamicin", name: "Gentamicin", route: injection, alsoRoutes: [topical], classes: ["antibiotic", "aminoglycoside"], aliases: ["gentamicin", "gentamycin", "garamycin"] },
  { key: "amikacin", name: "Amikacin", route: injection, classes: ["antibiotic", "aminoglycoside"], aliases: ["amikacin", "amikin"] },
  { key: "metronidazole", name: "Metronidazole", route: oral, alsoRoutes: [topical], classes: ["antibiotic", "nitroimidazole"], aliases: ["metronidazole", "metronidazol", "flagyl", { name: "rozex", route: topical }, { name: "metrogel", route: topical }] },
  { key: "tinidazole", name: "Tinidazole", route: oral, classes: ["antibiotic", "nitroimidazole"], aliases: ["tinidazole", "fasigyn"] },
  { key: "fusidic-acid", name: "Fusidic acid", route: topical, alsoRoutes: [oral], classes: ["antibiotic"], aliases: ["fusidic acid", "sodium fusidate", "fucidin"] },
  { key: "mupirocin", name: "Mupirocin", route: topical, classes: ["antibiotic"], aliases: ["mupirocin", "bactroban"] },
  { key: "nitrofurantoin", name: "Nitrofurantoin", route: oral, classes: ["antibiotic"], aliases: ["nitrofurantoin", "macrobid", "macrodantin"] },
  // ── Analgesics: NSAIDs, paracetamol, opioids ──
  { key: "ibuprofen", name: "Ibuprofen", route: oral, alsoRoutes: [topical], classes: ["analgesic", "nsaid"], maxDailyMg: 2400, aliases: ["ibuprofen", "ibuprofene", "ibuprofeno", "brufen", "advil", "nurofen", "motrin", "ايبوبروفين", "بروفين"] },
  { key: "diclofenac", name: "Diclofenac", route: oral, alsoRoutes: [topical, injection], classes: ["analgesic", "nsaid"], maxDailyMg: 150, aliases: ["diclofenac", "diclofenac sodium", "diclofenac potassium", "voltaren", "cataflam", "declophen", "olfen", "diclac", "ديكلوفيناك", "فولتارين", "كتافلام"] },
  { key: "naproxen", name: "Naproxen", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 1500, aliases: ["naproxen", "naproxene", "naprosyn", "aleve", "anaprox"] },
  { key: "ketoprofen", name: "Ketoprofen", route: oral, alsoRoutes: [topical], classes: ["analgesic", "nsaid"], aliases: ["ketoprofen", "profenid", { name: "fastum", route: topical }] },
  { key: "ketorolac", name: "Ketorolac", route: oral, alsoRoutes: [injection], classes: ["analgesic", "nsaid"], maxDailyMg: 40, aliases: ["ketorolac", "toradol", "ketolac"] },
  { key: "mefenamic-acid", name: "Mefenamic acid", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 1500, aliases: ["mefenamic acid", "mefenamic", "ponstan", "ponstel"] },
  { key: "meloxicam", name: "Meloxicam", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 15, aliases: ["meloxicam", "mobic"] },
  { key: "piroxicam", name: "Piroxicam", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 20, aliases: ["piroxicam", "feldene"] },
  { key: "indomethacin", name: "Indomethacin", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 200, aliases: ["indomethacin", "indometacin", "indocid", "indocin"] },
  { key: "celecoxib", name: "Celecoxib", route: oral, classes: ["analgesic", "nsaid", "sulfonamide-non-antibiotic"], maxDailyMg: 400, aliases: ["celecoxib", "celebrex"] },
  { key: "etoricoxib", name: "Etoricoxib", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 120, aliases: ["etoricoxib", "arcoxia"] },
  { key: "lornoxicam", name: "Lornoxicam", route: oral, classes: ["analgesic", "nsaid"], maxDailyMg: 16, aliases: ["lornoxicam", "xefo"] },
  { key: "aspirin", name: "Aspirin", route: oral, classes: ["analgesic", "nsaid", "antiplatelet"], maxDailyMg: 4000, aliases: ["aspirin", "acetylsalicylic acid", "asa", "aspocid", "jusprin", "disprin", "ecotrin", "اسبرين"] },
  { key: "paracetamol", name: "Paracetamol", route: oral, alsoRoutes: [injection], classes: ["analgesic"], maxDailyMg: 4000, aliases: ["paracetamol", "paracetamole", "acetaminophen", "panadol", "tylenol", "calpol", "abimol", "cetal", "adol", "perfalgan", "باراسيتامول", "بنادول"] },
  { key: "tramadol", name: "Tramadol", route: oral, alsoRoutes: [injection], classes: ["analgesic", "opioid", "serotonergic"], maxDailyMg: 400, aliases: ["tramadol", "tramal", "ultram", "contramal"] },
  { key: "codeine", name: "Codeine", route: oral, classes: ["analgesic", "opioid"], maxDailyMg: 240, aliases: ["codeine", "codeine phosphate"] },
  // ── Retinoids and vitamin A ──
  {
    key: "isotretinoin",
    name: "Isotretinoin",
    route: oral,
    alsoRoutes: [topical],
    classes: ["oral-retinoid"],
    maxDailyMg: 80,
    doseNote: "the mg/kg dose cannot be checked without the patient's weight",
    pregnancy: { systemic: "teratogen", topical: "caution", why: "it causes severe birth defects, even after a single dose" },
    aliases: ["isotretinoin", "isotretinoine", "isotretinoina", "isotretinion", "roaccutane", "accutane", "acnotren", "claravis", "absorica", "amnesteem", "sotret", "myorisan", "zenatane", "oratane", "isotroin", { name: "isotrex", route: topical }, "ايزوتريتينوين", "روكتان"],
  },
  { key: "acitretin", name: "Acitretin", route: oral, classes: ["oral-retinoid"], maxDailyMg: 75, pregnancy: { systemic: "teratogen", why: "it causes severe birth defects, and pregnancy must be avoided for 3 years after stopping" }, aliases: ["acitretin", "acitretine", "neotigason", "soriatane"] },
  { key: "alitretinoin", name: "Alitretinoin", route: oral, alsoRoutes: [topical], classes: ["oral-retinoid"], maxDailyMg: 30, pregnancy: { systemic: "teratogen", topical: "caution", why: "it causes severe birth defects" }, aliases: ["alitretinoin", "toctino", { name: "panretin", route: topical }] },
  { key: "tretinoin", name: "Tretinoin", route: topical, classes: ["topical-retinoid"], pregnancy: TOPICAL_RETINOID, aliases: ["tretinoin", "tretinoine", "retin a", "renova", "avita", "airol", "acretin"] },
  { key: "adapalene", name: "Adapalene", route: topical, classes: ["topical-retinoid"], pregnancy: TOPICAL_RETINOID, aliases: ["adapalene", "adapalen", "differin"] },
  { key: "tazarotene", name: "Tazarotene", route: topical, classes: ["topical-retinoid"], pregnancy: { topical: "caution", why: "it is a retinoid and is contraindicated in pregnancy" }, aliases: ["tazarotene", "tazorac", "zorac", "arazlo", "fabior"] },
  { key: "trifarotene", name: "Trifarotene", route: topical, classes: ["topical-retinoid"], pregnancy: TOPICAL_RETINOID, aliases: ["trifarotene", "aklief"] },
  { key: "vitamin-a", name: "Vitamin A", route: oral, alsoRoutes: [topical], classes: ["vitamin-a"], aliases: ["vitamin a", "vit a", "retinol", "retinyl palmitate", "retinyl acetate", "cod liver oil", "فيتامين ا"] },
  // ── Hair: 5-alpha-reductase inhibitors, minoxidil, antiandrogens ──
  { key: "finasteride", name: "Finasteride", route: oral, alsoRoutes: [topical], classes: ["5-alpha-reductase-inhibitor", "antiandrogen"], maxDailyMg: 5, pregnancy: FIVE_ARI, femaleContraindicated: true, aliases: ["finasteride", "finasterid", "proscar", "propecia", "finpecia", "fincar", "prostride", "فيناسترايد"] },
  { key: "dutasteride", name: "Dutasteride", route: oral, classes: ["5-alpha-reductase-inhibitor", "antiandrogen"], maxDailyMg: 0.5, pregnancy: FIVE_ARI, femaleContraindicated: true, aliases: ["dutasteride", "avodart", "dutas"] },
  { key: "tamsulosin", name: "Tamsulosin", route: oral, classes: ["alpha-blocker"], aliases: ["tamsulosin", "flomax", "omnic"] },
  {
    key: "minoxidil",
    name: "Minoxidil",
    route: topical,
    alsoRoutes: [oral],
    classes: ["vasodilator"],
    maxDailyMg: 5,
    doseNote: "above 5 mg a day is a blood-pressure dose, not a hair-loss dose",
    pregnancy: { systemic: "caution", why: "taken by mouth it can cause excess hair growth and heart problems in the baby" },
    aliases: ["minoxidil", "minoxidile", "rogaine", "regaine", "mintop", { name: "loniten", route: oral }, "مينوكسيديل"],
  },
  { key: "spironolactone", name: "Spironolactone", route: oral, classes: ["potassium-sparing-diuretic", "antiandrogen", "diuretic"], maxDailyMg: 200, pregnancy: { systemic: "caution", why: "it blocks male hormones and can feminise a male baby" }, aliases: ["spironolactone", "spironolacton", "aldactone", "spiractin"] },
  { key: "eplerenone", name: "Eplerenone", route: oral, classes: ["potassium-sparing-diuretic", "diuretic"], aliases: ["eplerenone", "inspra"] },
  { key: "amiloride", name: "Amiloride", route: oral, classes: ["potassium-sparing-diuretic", "diuretic"], aliases: ["amiloride", "midamor"] },
  { key: "cyproterone", name: "Cyproterone acetate", route: oral, classes: ["antiandrogen", "progestogen"], pregnancy: { systemic: "caution", why: "it blocks male hormones and can feminise a male baby" }, aliases: ["cyproterone", "cyproterone acetate", "androcur"] },
  { key: "bicalutamide", name: "Bicalutamide", route: oral, classes: ["antiandrogen"], pregnancy: { systemic: "caution", why: "it blocks male hormones and can feminise a male baby" }, aliases: ["bicalutamide", "casodex"] },
  { key: "flutamide", name: "Flutamide", route: oral, classes: ["antiandrogen"], pregnancy: { systemic: "caution", why: "it blocks male hormones and can feminise a male baby" }, aliases: ["flutamide", "flutamid", "eulexin"] },
  // ── Hormonal contraception ──
  { key: "ethinylestradiol", name: "Ethinylestradiol", route: oral, classes: ["estrogen", "combined-oral-contraceptive"], aliases: ["ethinylestradiol", "ethinyl estradiol", "ethinyloestradiol"] },
  { key: "drospirenone", name: "Drospirenone", route: oral, classes: ["progestogen"], aliases: ["drospirenone"] },
  { key: "levonorgestrel", name: "Levonorgestrel", route: oral, classes: ["progestogen"], aliases: ["levonorgestrel"] },
  { key: "desogestrel", name: "Desogestrel", route: oral, classes: ["progestogen"], aliases: ["desogestrel"] },
  { key: "gestodene", name: "Gestodene", route: oral, classes: ["progestogen"], aliases: ["gestodene"] },
  // ── Anticoagulants, antiplatelets ──
  { key: "warfarin", name: "Warfarin", route: oral, classes: ["anticoagulant", "vitamin-k-antagonist"], aliases: ["warfarin", "warfarine", "coumadin", "marevan", "marivan", "وارفارين", "ماريفان"] },
  { key: "acenocoumarol", name: "Acenocoumarol", route: oral, classes: ["anticoagulant", "vitamin-k-antagonist"], aliases: ["acenocoumarol", "sintrom"] },
  { key: "rivaroxaban", name: "Rivaroxaban", route: oral, classes: ["anticoagulant"], aliases: ["rivaroxaban", "xarelto"] },
  { key: "apixaban", name: "Apixaban", route: oral, classes: ["anticoagulant"], aliases: ["apixaban", "eliquis"] },
  { key: "dabigatran", name: "Dabigatran", route: oral, classes: ["anticoagulant"], aliases: ["dabigatran", "pradaxa"] },
  { key: "edoxaban", name: "Edoxaban", route: oral, classes: ["anticoagulant"], aliases: ["edoxaban", "lixiana", "savaysa"] },
  { key: "enoxaparin", name: "Enoxaparin", route: injection, classes: ["anticoagulant"], aliases: ["enoxaparin", "clexane", "lovenox"] },
  { key: "heparin", name: "Heparin", route: injection, classes: ["anticoagulant"], aliases: ["heparin"] },
  { key: "clopidogrel", name: "Clopidogrel", route: oral, classes: ["antiplatelet"], aliases: ["clopidogrel", "plavix"] },
  // ── Statins ──
  { key: "atorvastatin", name: "Atorvastatin", route: oral, classes: ["statin"], maxDailyMg: 80, aliases: ["atorvastatin", "atorvastatine", "lipitor", "ator"] },
  { key: "simvastatin", name: "Simvastatin", route: oral, classes: ["statin"], maxDailyMg: 80, aliases: ["simvastatin", "simvastatine", "zocor"] },
  { key: "rosuvastatin", name: "Rosuvastatin", route: oral, classes: ["statin"], maxDailyMg: 40, aliases: ["rosuvastatin", "rosuvastatine", "crestor"] },
  { key: "lovastatin", name: "Lovastatin", route: oral, classes: ["statin"], aliases: ["lovastatin", "mevacor"] },
  { key: "pravastatin", name: "Pravastatin", route: oral, classes: ["statin"], aliases: ["pravastatin", "pravachol"] },
  { key: "fluvastatin", name: "Fluvastatin", route: oral, classes: ["statin"], aliases: ["fluvastatin", "lescol"] },
  { key: "pitavastatin", name: "Pitavastatin", route: oral, classes: ["statin"], aliases: ["pitavastatin", "livalo"] },
  // ── Antifungals ──
  { key: "fluconazole", name: "Fluconazole", route: oral, classes: ["antifungal", "azole-antifungal", "qt-prolonging"], maxDailyMg: 800, aliases: ["fluconazole", "fluconazol", "diflucan", "flucoral", "فلوكونازول"] },
  { key: "itraconazole", name: "Itraconazole", route: oral, classes: ["antifungal", "azole-antifungal"], maxDailyMg: 400, aliases: ["itraconazole", "itraconazol", "sporanox", "itrapex"] },
  { key: "ketoconazole", name: "Ketoconazole", route: topical, alsoRoutes: [oral], classes: ["antifungal", "azole-antifungal", "qt-prolonging"], aliases: ["ketoconazole", "ketoconazol", "nizoral"] },
  { key: "voriconazole", name: "Voriconazole", route: oral, classes: ["antifungal", "azole-antifungal", "qt-prolonging"], aliases: ["voriconazole", "vfend"] },
  { key: "posaconazole", name: "Posaconazole", route: oral, classes: ["antifungal", "azole-antifungal", "qt-prolonging"], aliases: ["posaconazole", "noxafil"] },
  { key: "clotrimazole", name: "Clotrimazole", route: topical, classes: ["antifungal", "azole-antifungal"], aliases: ["clotrimazole", "canesten"] },
  { key: "miconazole", name: "Miconazole", route: topical, alsoRoutes: [oral], classes: ["antifungal", "azole-antifungal"], aliases: ["miconazole", "daktarin"] },
  // Terbinafine is a CYP2D6 inhibitor: no clinically relevant statin interaction, so no statin rule.
  { key: "terbinafine", name: "Terbinafine", route: oral, alsoRoutes: [topical], classes: ["antifungal"], maxDailyMg: 250, aliases: ["terbinafine", "terbinafin", "lamisil"] },
  { key: "griseofulvin", name: "Griseofulvin", route: oral, classes: ["antifungal"], pregnancy: { systemic: "caution", why: "it can cause birth defects and is contraindicated in pregnancy" }, aliases: ["griseofulvin", "griseofulvine", "grisovin", "fulvin"] },
  // ── QT-prolonging and serotonergic medicines patients commonly take ──
  { key: "hydroxychloroquine", name: "Hydroxychloroquine", route: oral, classes: ["antimalarial", "qt-prolonging"], maxDailyMg: 400, aliases: ["hydroxychloroquine", "hydroxychloroquin", "plaquenil", "hcq", "hcqs"] },
  { key: "chloroquine", name: "Chloroquine", route: oral, classes: ["antimalarial", "qt-prolonging"], aliases: ["chloroquine", "nivaquine", "aralen"] },
  { key: "domperidone", name: "Domperidone", route: oral, classes: ["antiemetic", "qt-prolonging"], maxDailyMg: 30, aliases: ["domperidone", "domperidon", "motilium", "motinorm"] },
  { key: "ondansetron", name: "Ondansetron", route: oral, alsoRoutes: [injection], classes: ["antiemetic", "qt-prolonging"], aliases: ["ondansetron", "zofran"] },
  { key: "citalopram", name: "Citalopram", route: oral, classes: ["antidepressant", "ssri", "serotonergic", "qt-prolonging"], aliases: ["citalopram", "cipram", "cipramil", "celexa"] },
  { key: "escitalopram", name: "Escitalopram", route: oral, classes: ["antidepressant", "ssri", "serotonergic", "qt-prolonging"], aliases: ["escitalopram", "cipralex", "lexapro"] },
  { key: "fluoxetine", name: "Fluoxetine", route: oral, classes: ["antidepressant", "ssri", "serotonergic"], aliases: ["fluoxetine", "prozac", "philozac"] },
  { key: "sertraline", name: "Sertraline", route: oral, classes: ["antidepressant", "ssri", "serotonergic"], aliases: ["sertraline", "zoloft", "lustral", "serlift", "moodapex"] },
  { key: "paroxetine", name: "Paroxetine", route: oral, classes: ["antidepressant", "ssri", "serotonergic"], aliases: ["paroxetine", "seroxat", "paxil"] },
  { key: "amitriptyline", name: "Amitriptyline", route: oral, classes: ["antidepressant", "serotonergic", "qt-prolonging"], aliases: ["amitriptyline", "tryptizol", "elavil"] },
  { key: "haloperidol", name: "Haloperidol", route: oral, alsoRoutes: [injection], classes: ["antipsychotic", "qt-prolonging"], aliases: ["haloperidol", "haldol"] },
  { key: "quetiapine", name: "Quetiapine", route: oral, classes: ["antipsychotic", "qt-prolonging"], aliases: ["quetiapine", "seroquel"] },
  { key: "amiodarone", name: "Amiodarone", route: oral, classes: ["antiarrhythmic", "qt-prolonging"], aliases: ["amiodarone", "cordarone"] },
  { key: "sotalol", name: "Sotalol", route: oral, classes: ["antiarrhythmic", "qt-prolonging"], aliases: ["sotalol", "sotacor", "betapace"] },
  { key: "methadone", name: "Methadone", route: oral, classes: ["opioid", "qt-prolonging"], aliases: ["methadone"] },
  { key: "hydroxyzine", name: "Hydroxyzine", route: oral, classes: ["antihistamine", "qt-prolonging"], aliases: ["hydroxyzine", "hydroxyzin", "atarax", "vistaril"] },
  // ── Systemic dermatology: immunosuppressants, steroids, others ──
  {
    key: "methotrexate",
    name: "Methotrexate",
    route: oral,
    alsoRoutes: [injection],
    classes: ["immunosuppressant", "antifolate"],
    weeklyOnly: { maxWeeklyMg: 25 },
    pregnancy: { systemic: "teratogen", why: "it causes miscarriage and severe birth defects" },
    aliases: ["methotrexate", "methotrexat", "mtx", "trexall", "otrexup", "rasuvo", "metoject", "emthexate", "unitrexate"],
  },
  { key: "ciclosporin", name: "Ciclosporin", route: oral, classes: ["immunosuppressant", "calcineurin-inhibitor"], aliases: ["ciclosporin", "cyclosporine", "cyclosporin", "neoral", "sandimmun", "sandimmune", "gengraf"] },
  { key: "azathioprine", name: "Azathioprine", route: oral, classes: ["immunosuppressant"], aliases: ["azathioprine", "azathioprin", "imuran"] },
  { key: "mycophenolate", name: "Mycophenolate", route: oral, classes: ["immunosuppressant"], pregnancy: { systemic: "teratogen", why: "it causes miscarriage and severe birth defects" }, aliases: ["mycophenolate", "mycophenolate mofetil", "mmf", "cellcept", "myfortic"] },
  { key: "thalidomide", name: "Thalidomide", route: oral, classes: ["immunosuppressant"], pregnancy: { systemic: "teratogen", why: "it causes severe limb and organ birth defects, even after a single dose" }, aliases: ["thalidomide", "thalomid"] },
  { key: "colchicine", name: "Colchicine", route: oral, classes: ["colchicine"], aliases: ["colchicine", "colcrys"] },
  { key: "prednisolone", name: "Prednisolone", route: oral, classes: ["corticosteroid"], aliases: ["prednisolone", "prednisolon", "solupred", "deltacortril"] },
  { key: "prednisone", name: "Prednisone", route: oral, classes: ["corticosteroid"], aliases: ["prednisone", "deltasone"] },
  { key: "dexamethasone", name: "Dexamethasone", route: oral, alsoRoutes: [injection], classes: ["corticosteroid"], aliases: ["dexamethasone", "decadron", "fortecortin"] },
  { key: "methylprednisolone", name: "Methylprednisolone", route: oral, alsoRoutes: [injection], classes: ["corticosteroid"], aliases: ["methylprednisolone", "medrol", "solu medrol", "depo medrol"] },
  { key: "betamethasone", name: "Betamethasone", route: topical, alsoRoutes: [injection, oral], classes: ["topical-corticosteroid"], aliases: ["betamethasone", "betnovate", "diprosone", { name: "diprospan", route: injection }, "celestone"] },
  { key: "mometasone", name: "Mometasone", route: topical, classes: ["topical-corticosteroid"], aliases: ["mometasone", "elocon", "elica"] },
  { key: "clobetasol", name: "Clobetasol", route: topical, classes: ["topical-corticosteroid"], aliases: ["clobetasol", "clobetasol propionate", "dermovate", "clobex"] },
  { key: "hydrocortisone", name: "Hydrocortisone", route: topical, alsoRoutes: [oral], classes: ["topical-corticosteroid"], aliases: ["hydrocortisone"] },
  { key: "fluocinolone", name: "Fluocinolone", route: topical, classes: ["topical-corticosteroid"], aliases: ["fluocinolone", "fluocinolone acetonide"] },
  { key: "triamcinolone", name: "Triamcinolone", route: injection, alsoRoutes: [topical], classes: ["topical-corticosteroid"], aliases: ["triamcinolone", "triamcinolone acetonide", "kenacort", "kenalog", "adcortyl"] },
  // ── Antihistamines, antivirals, antiparasitics ──
  { key: "cetirizine", name: "Cetirizine", route: oral, classes: ["antihistamine"], aliases: ["cetirizine", "zyrtec"] },
  { key: "levocetirizine", name: "Levocetirizine", route: oral, classes: ["antihistamine"], aliases: ["levocetirizine", "xyzal"] },
  { key: "loratadine", name: "Loratadine", route: oral, classes: ["antihistamine"], aliases: ["loratadine", "claritin", "clarityne"] },
  { key: "desloratadine", name: "Desloratadine", route: oral, classes: ["antihistamine"], aliases: ["desloratadine", "aerius", "clarinex"] },
  { key: "fexofenadine", name: "Fexofenadine", route: oral, classes: ["antihistamine"], aliases: ["fexofenadine", "telfast", "allegra"] },
  { key: "chlorphenamine", name: "Chlorphenamine", route: oral, classes: ["antihistamine"], aliases: ["chlorphenamine", "chlorpheniramine", "piriton"] },
  { key: "aciclovir", name: "Aciclovir", route: oral, alsoRoutes: [topical], classes: ["antiviral"], maxDailyMg: 4000, aliases: ["aciclovir", "acyclovir", "zovirax"] },
  { key: "valaciclovir", name: "Valaciclovir", route: oral, classes: ["antiviral"], maxDailyMg: 3000, aliases: ["valaciclovir", "valacyclovir", "valtrex"] },
  { key: "famciclovir", name: "Famciclovir", route: oral, classes: ["antiviral"], maxDailyMg: 1500, aliases: ["famciclovir", "famvir"] },
  { key: "ivermectin", name: "Ivermectin", route: oral, alsoRoutes: [topical], classes: ["antiparasitic"], aliases: ["ivermectin", "ivermectine", "stromectol", "iverzine", { name: "soolantra", route: topical }] },
  { key: "permethrin", name: "Permethrin", route: topical, classes: ["antiparasitic"], aliases: ["permethrin", "lyclear", "elimite"] },
  // ── Topical dermatology ──
  { key: "benzoyl-peroxide", name: "Benzoyl peroxide", route: topical, classes: ["keratolytic"], aliases: ["benzoyl peroxide", "bpo", "panoxyl", "benzac", "acnecide"] },
  { key: "azelaic-acid", name: "Azelaic acid", route: topical, classes: ["keratolytic"], aliases: ["azelaic acid", "skinoren", "finacea"] },
  { key: "salicylic-acid", name: "Salicylic acid", route: topical, classes: ["keratolytic"], aliases: ["salicylic acid"] },
  { key: "hydroquinone", name: "Hydroquinone", route: topical, classes: ["depigmenting"], aliases: ["hydroquinone", "eldoquin"] },
  { key: "calcipotriol", name: "Calcipotriol", route: topical, classes: ["vitamin-d-analogue"], aliases: ["calcipotriol", "calcipotriene", "daivonex", "dovonex"] },
  { key: "tacrolimus", name: "Tacrolimus", route: topical, classes: ["calcineurin-inhibitor"], aliases: ["tacrolimus", "protopic"] },
  { key: "pimecrolimus", name: "Pimecrolimus", route: topical, classes: ["calcineurin-inhibitor"], aliases: ["pimecrolimus", "elidel"] },
  { key: "zinc-oxide", name: "Zinc oxide", route: topical, classes: [], aliases: ["zinc oxide"] },
  // ── Tranexamic acid (melasma) ──
  { key: "tranexamic-acid", name: "Tranexamic acid", route: oral, alsoRoutes: [topical, injection], classes: ["antifibrinolytic"], maxDailyMg: 3900, aliases: ["tranexamic acid", "tranexamic", "txa", "kapron", "cyklokapron", "transamin", "lysteda"] },
  // ── Minerals and supplements that bind other medicines ──
  { key: "iron", name: "Iron", route: oral, classes: ["polyvalent-cation"], aliases: ["iron", "ferrous sulfate", "ferrous sulphate", "ferrous fumarate", "ferrous gluconate", "ferrous", "feroglobin", "ferrograd"] },
  { key: "zinc", name: "Zinc", route: oral, classes: ["polyvalent-cation"], aliases: ["zinc", "zinc sulfate", "zinc sulphate", "zinc gluconate", "octozinc"] },
  { key: "calcium", name: "Calcium", route: oral, classes: ["polyvalent-cation"], aliases: ["calcium", "calcium carbonate", "calcium citrate", "caltrate"] },
  { key: "magnesium", name: "Magnesium", route: oral, classes: ["polyvalent-cation"], aliases: ["magnesium", "magnesium hydroxide", "magnesium oxide"] },
  { key: "antacid", name: "Antacid (aluminium/magnesium)", route: oral, classes: ["polyvalent-cation"], aliases: ["antacid", "antacids", "maalox", "gaviscon", "aluminium hydroxide", "aluminum hydroxide"] },
  { key: "potassium", name: "Potassium supplement", route: oral, classes: ["potassium-supplement"], aliases: ["potassium chloride", "potassium citrate", "potassium bicarbonate", "potassium supplement", "kcl", "slow k", "kay cee l", "sando k"] },
  // ── Blood pressure, diabetes ──
  { key: "lisinopril", name: "Lisinopril", route: oral, classes: ["ace-inhibitor"], aliases: ["lisinopril", "zestril", "prinivil"] },
  { key: "enalapril", name: "Enalapril", route: oral, classes: ["ace-inhibitor"], aliases: ["enalapril", "renitec", "vasotec"] },
  { key: "ramipril", name: "Ramipril", route: oral, classes: ["ace-inhibitor"], aliases: ["ramipril", "tritace"] },
  { key: "captopril", name: "Captopril", route: oral, classes: ["ace-inhibitor"], aliases: ["captopril", "capoten"] },
  { key: "perindopril", name: "Perindopril", route: oral, classes: ["ace-inhibitor"], aliases: ["perindopril", "coversyl"] },
  { key: "losartan", name: "Losartan", route: oral, classes: ["arb"], aliases: ["losartan", "cozaar"] },
  { key: "valsartan", name: "Valsartan", route: oral, classes: ["arb"], aliases: ["valsartan", "diovan", "tareg"] },
  { key: "candesartan", name: "Candesartan", route: oral, classes: ["arb"], aliases: ["candesartan", "atacand"] },
  { key: "irbesartan", name: "Irbesartan", route: oral, classes: ["arb"], aliases: ["irbesartan", "aprovel"] },
  { key: "telmisartan", name: "Telmisartan", route: oral, classes: ["arb"], aliases: ["telmisartan", "micardis"] },
  { key: "olmesartan", name: "Olmesartan", route: oral, classes: ["arb"], aliases: ["olmesartan", "benicar", "olmetec"] },
  { key: "metformin", name: "Metformin", route: oral, classes: ["antidiabetic"], maxDailyMg: 2550, aliases: ["metformin", "metformine", "glucophage", "cidophage", "ميتفورمين", "جلوكوفاج"] },
  // ── Local anaesthetics ──
  { key: "lidocaine", name: "Lidocaine", route: injection, alsoRoutes: [topical], classes: ["amide-local-anaesthetic"], aliases: ["lidocaine", "lidocain", "lignocaine", "xylocaine", "ليدوكايين", "زيلوكايين"] },
  { key: "prilocaine", name: "Prilocaine", route: injection, alsoRoutes: [topical], classes: ["amide-local-anaesthetic"], aliases: ["prilocaine", "citanest"] },
  { key: "mepivacaine", name: "Mepivacaine", route: injection, classes: ["amide-local-anaesthetic"], aliases: ["mepivacaine", "carbocaine", "scandonest"] },
  { key: "bupivacaine", name: "Bupivacaine", route: injection, classes: ["amide-local-anaesthetic"], aliases: ["bupivacaine", "marcaine"] },
  { key: "levobupivacaine", name: "Levobupivacaine", route: injection, classes: ["amide-local-anaesthetic"], aliases: ["levobupivacaine", "chirocaine"] },
  { key: "ropivacaine", name: "Ropivacaine", route: injection, classes: ["amide-local-anaesthetic"], aliases: ["ropivacaine", "naropin"] },
  { key: "articaine", name: "Articaine", route: injection, classes: ["amide-local-anaesthetic"], aliases: ["articaine", "septocaine", "ubistesin"] },
  { key: "benzocaine", name: "Benzocaine", route: topical, classes: ["ester-local-anaesthetic"], aliases: ["benzocaine", "orajel"] },
  { key: "procaine", name: "Procaine", route: injection, classes: ["ester-local-anaesthetic"], aliases: ["procaine", "novocain", "novocaine"] },
  { key: "tetracaine", name: "Tetracaine", route: topical, classes: ["ester-local-anaesthetic"], aliases: ["tetracaine", "amethocaine", "ametop"] },
  // ── Aesthetic procedures (checked for latex allergy and contraindications) ──
  { key: "botulinum-toxin", name: "Botulinum toxin", route: injection, classes: ["botulinum-toxin", "procedure"], aliases: ["botulinum toxin", "botulinum", "botox", "dysport", "xeomin", "azzalure", "bocouture", "jeuveau", "daxxify", "بوتوكس"] },
  { key: "dermal-filler", name: "Dermal filler", route: injection, classes: ["dermal-filler", "procedure"], aliases: ["dermal filler", "filler", "fillers", "hyaluronic acid filler", "ha filler", "juvederm", "restylane", "belotero", "teosyal", "radiesse", "sculptra", "profhilo", "فيلر"] },
  { key: "prp", name: "PRP (platelet-rich plasma)", route: injection, classes: ["procedure"], aliases: ["prp", "platelet rich plasma"] },
  { key: "mesotherapy", name: "Mesotherapy", route: injection, classes: ["procedure"], aliases: ["mesotherapy", "meso therapy", "ميزوثيرابي"] },
  { key: "chemical-peel", name: "Chemical peel", route: topical, classes: ["procedure"], aliases: ["chemical peel", "peel", "tca peel", "glycolic peel", "jessner peel"] },
  { key: "microneedling", name: "Microneedling", route: topical, classes: ["procedure"], aliases: ["microneedling", "micro needling", "dermapen"] },
];

/** Products that contain more than one ingredient. */
export interface Combination {
  name: string;
  aliases: readonly string[];
  ingredients: readonly string[];
  route?: Route;
}

export const COMBINATIONS: readonly Combination[] = [
  { name: "Amoxicillin + clavulanic acid", aliases: ["augmentin", "augmentine", "co amoxiclav", "coamoxiclav", "amoxiclav", "clavulin", "hibiotic", "megamox", "curam"], ingredients: ["amoxicillin", "clavulanic-acid"], route: oral },
  { name: "Ampicillin + sulbactam", aliases: ["unasyn", "unictam", "sultamicillin"], ingredients: ["ampicillin", "sulbactam"], route: oral },
  { name: "Piperacillin + tazobactam", aliases: ["piperacillin tazobactam", "pip tazo"], ingredients: ["piperacillin"], route: injection },
  { name: "Co-trimoxazole", aliases: ["co trimoxazole", "cotrimoxazole", "bactrim", "septrin", "septra", "smx tmp", "tmp smx"], ingredients: ["sulfamethoxazole", "trimethoprim"], route: oral },
  { name: "Paracetamol + codeine", aliases: ["co codamol", "cocodamol", "solpadeine"], ingredients: ["paracetamol", "codeine"], route: oral },
  { name: "Tramadol + paracetamol", aliases: ["tramacet", "ultracet"], ingredients: ["tramadol", "paracetamol"], route: oral },
  { name: "Isotretinoin + erythromycin gel", aliases: ["isotrexin"], ingredients: ["isotretinoin", "erythromycin"], route: topical },
  { name: "Adapalene + benzoyl peroxide", aliases: ["epiduo"], ingredients: ["adapalene", "benzoyl-peroxide"], route: topical },
  { name: "Clindamycin + benzoyl peroxide", aliases: ["duac", "clindoxyl"], ingredients: ["clindamycin", "benzoyl-peroxide"], route: topical },
  { name: "Clindamycin + tretinoin", aliases: ["treclin", "acnatac", "ziana"], ingredients: ["clindamycin", "tretinoin"], route: topical },
  { name: "Fusidic acid + betamethasone", aliases: ["fucicort"], ingredients: ["fusidic-acid", "betamethasone"], route: topical },
  { name: "Fusidic acid + hydrocortisone", aliases: ["fucidin h"], ingredients: ["fusidic-acid", "hydrocortisone"], route: topical },
  { name: "Calcipotriol + betamethasone", aliases: ["daivobet", "xamiol", "enstilar"], ingredients: ["calcipotriol", "betamethasone"], route: topical },
  { name: "Hydroquinone + tretinoin + fluocinolone", aliases: ["tri luma", "triluma"], ingredients: ["hydroquinone", "tretinoin", "fluocinolone"], route: topical },
  { name: "Lidocaine + prilocaine", aliases: ["emla"], ingredients: ["lidocaine", "prilocaine"], route: topical },
  { name: "Dutasteride + tamsulosin", aliases: ["duodart", "jalyn"], ingredients: ["dutasteride", "tamsulosin"], route: oral },
  { name: "Spironolactone + hydrochlorothiazide", aliases: ["aldactazide"], ingredients: ["spironolactone", "hydrochlorothiazide"], route: oral },
  { name: "Amiloride + hydrochlorothiazide", aliases: ["moduretic"], ingredients: ["amiloride", "hydrochlorothiazide"], route: oral },
  { name: "Cyproterone + ethinylestradiol", aliases: ["diane", "dianette", "ginette"], ingredients: ["cyproterone", "ethinylestradiol"], route: oral },
  { name: "Drospirenone + ethinylestradiol", aliases: ["yasmin", "yaz"], ingredients: ["drospirenone", "ethinylestradiol"], route: oral },
  { name: "Levonorgestrel + ethinylestradiol", aliases: ["microgynon"], ingredients: ["levonorgestrel", "ethinylestradiol"], route: oral },
  { name: "Desogestrel + ethinylestradiol", aliases: ["marvelon"], ingredients: ["desogestrel", "ethinylestradiol"], route: oral },
  { name: "Gestodene + ethinylestradiol", aliases: ["gynera"], ingredients: ["gestodene", "ethinylestradiol"], route: oral },
];

// ── Prescription wording ─────────────────────────────────────────────────────

/** Dosage-form words: dropped from names, and hints for the route. */
export const FORM_WORDS: readonly string[] = [
  "solution", "soln", "sol", "cream", "creams", "crm", "gel", "gels", "lotion", "foam", "ointment", "oint",
  "tablet", "tablets", "tab", "tabs", "capsule", "capsules", "cap", "caps", "softgel", "softgels", "spray", "sprays",
  "shampoo", "serum", "drops", "drop", "syrup", "suspension", "susp", "sachet", "sachets", "injection", "injections",
  "inj", "injectable", "ampoule", "ampoules", "amp", "amps", "vial", "vials", "patch", "patches", "plaster", "wash",
  "cleanser", "powder", "emulsion", "emulgel", "film", "coated", "fc", "er", "xr", "sr", "mr", "cr", "dr", "la", "xl",
  "retard", "topical", "oral", "liquid", "paint", "stick", "mousse", "chewable", "effervescent", "dispersible",
  "modified", "release", "extended", "delayed", "sustained", "enteric", "prolonged", "depot", "prefilled", "pen",
  "syringe", "mg", "mgs", "mcg", "ug", "ml", "mls", "g", "gm", "iu", "units", "unit", "w", "v", "apply", "external",
  "for", "x", "plus", "with", "and", "of", "in", "intralesional",
  "كريم", "اقراص", "قرص", "كبسول", "كبسولات", "كبسوله", "شراب", "حقن", "حقنه", "جل", "مرهم", "محلول", "بخاخ", "شامبو", "لوشن",
];

export const INJECTION_WORDS: readonly string[] = [
  "inj", "injection", "injections", "injectable", "intralesional", "intradermal", "intramuscular", "intravenous",
  "subcutaneous", "im", "iv", "sc", "ampoule", "ampoules", "amp", "vial", "vials", "infiltration", "infusion",
  "prefilled", "syringe", "depot", "حقن", "حقنه",
];

export const ORAL_WORDS: readonly string[] = [
  "oral", "orally", "po", "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "softgel",
  "softgels", "syrup", "suspension", "susp", "sachet", "sachets", "chewable", "effervescent", "dispersible",
  "lozenge", "granules", "elixir", "swallow", "mouth", "اقراص", "قرص", "كبسول", "كبسولات", "كبسوله", "شراب", "فموي",
];

export const TOPICAL_WORDS: readonly string[] = [
  "cream", "creams", "crm", "gel", "gels", "lotion", "solution", "soln", "foam", "ointment", "oint", "shampoo",
  "serum", "wash", "cleanser", "topical", "topically", "spray", "paint", "plaster", "patch", "mousse", "emulgel",
  "apply", "application", "scalp", "skin", "emollient", "liniment", "paste", "drops", "eye", "ear", "nasal",
  "كريم", "جل", "مرهم", "لوشن", "محلول", "بخاخ", "شامبو", "موضعي", "دهان",
];

// ── Allergies ────────────────────────────────────────────────────────────────

/**
 * Words in a documented allergy that name a whole class ("Penicillin",
 * "Sulfa drugs", "NSAIDs"). A named ingredient ("Amoxicillin") is found
 * through the ingredient table instead.
 */
export interface AllergyTerm {
  terms: readonly string[];
  classes?: readonly DrugClass[];
  latex?: true;
  label: string;
}

export const ALLERGY_TERMS: readonly AllergyTerm[] = [
  { label: "penicillin", classes: ["penicillin"], terms: ["penicillin", "penicillins", "penicilin", "penicilline", "pcn", "بنسلين", "بنسيلين"] },
  { label: "beta-lactam antibiotics", classes: ["penicillin", "cephalosporin", "carbapenem"], terms: ["beta lactam", "beta lactams", "betalactam", "betalactams", "β lactam", "β lactams"] },
  { label: "cephalosporins", classes: ["cephalosporin"], terms: ["cephalosporin", "cephalosporins", "cephalosporine", "سيفالوسبورين"] },
  { label: "carbapenems", classes: ["carbapenem"], terms: ["carbapenem", "carbapenems"] },
  { label: "sulfa drugs", classes: ["sulfonamide-antibiotic"], terms: ["sulfa", "sulpha", "sulfas", "sulphas", "sulfonamide", "sulfonamides", "sulphonamide", "sulphonamides", "sulfa drugs", "sulpha drugs", "سلفا"] },
  { label: "NSAIDs", classes: ["nsaid"], terms: ["nsaid", "nsaids", "non steroidal", "nonsteroidal", "anti inflammatory", "anti inflammatories", "antiinflammatory", "antiinflammatories", "salicylate", "salicylates", "مضادات التهاب", "مضادات الالتهاب"] },
  { label: "tetracyclines", classes: ["tetracycline"], terms: ["tetracyclines"] },
  { label: "macrolides", classes: ["macrolide"], terms: ["macrolide", "macrolides"] },
  { label: "fluoroquinolones", classes: ["fluoroquinolone"], terms: ["quinolone", "quinolones", "fluoroquinolone", "fluoroquinolones"] },
  { label: "opioids", classes: ["opioid"], terms: ["opioid", "opioids", "opiate", "opiates", "morphine"] },
  { label: "local anaesthetics", classes: ["amide-local-anaesthetic", "ester-local-anaesthetic"], terms: ["local anaesthetic", "local anaesthetics", "local anesthetic", "local anesthetics", "anaesthetic", "anaesthetics", "anesthetic", "anesthetics", "مخدر موضعي", "بنج موضعي"] },
  { label: "amide local anaesthetics", classes: ["amide-local-anaesthetic"], terms: ["amide anaesthetic", "amide anaesthetics", "amide anesthetic", "amide anesthetics", "amides"] },
  { label: "ester local anaesthetics", classes: ["ester-local-anaesthetic"], terms: ["ester anaesthetic", "ester anaesthetics", "ester anesthetic", "ester anesthetics", "esters"] },
  { label: "retinoids", classes: ["oral-retinoid", "topical-retinoid"], terms: ["retinoid", "retinoids"] },
  { label: "latex", latex: true, terms: ["latex", "rubber", "natural rubber", "لاتكس", "اللاتكس"] },
];

/**
 * Allergy groups: an allergy to one member means avoiding every member.
 * "stop" when cross-reactivity within the class is high, "warn" when it is
 * possible but uncommon.
 */
export const ALLERGY_GROUPS: Partial<Record<DrugClass, Severity>> = {
  penicillin: "stop",
  cephalosporin: "stop",
  carbapenem: "stop",
  "sulfonamide-antibiotic": "stop",
  tetracycline: "stop",
  fluoroquinolone: "stop",
  nsaid: "stop",
  "amide-local-anaesthetic": "stop",
  "ester-local-anaesthetic": "stop",
  "oral-retinoid": "stop",
  "vitamin-a": "stop",
  "5-alpha-reductase-inhibitor": "stop",
  macrolide: "warn",
  "azole-antifungal": "warn",
  opioid: "warn",
  "topical-retinoid": "warn",
};

/** Which medicines a route constraint, an ingredient list or a class list picks out. */
export interface Matcher {
  ingredients?: readonly string[];
  classes?: readonly DrugClass[];
  notClasses?: readonly DrugClass[];
  /** Interactions default to systemic exposure on both sides. */
  routes?: readonly RouteGroup[];
}

/** Cross-reactivity between different classes (same-class allergy is ALLERGY_GROUPS). */
export interface AllergyCrossRule {
  id: string;
  allergy: DrugClass;
  drug: Matcher;
  severity: Severity;
  /** Completes "<Drug> is <class>; the patient has a documented <allergy> allergy and <why>." */
  why: string;
}

export const ALLERGY_CROSS_RULES: readonly AllergyCrossRule[] = [
  { id: "penicillin-cephalosporin", allergy: "penicillin", drug: { classes: ["cephalosporin"] }, severity: "stop", why: "cephalosporins can cross-react with penicillins" },
  { id: "penicillin-carbapenem", allergy: "penicillin", drug: { classes: ["carbapenem"] }, severity: "stop", why: "carbapenems can cross-react with penicillins" },
  { id: "cephalosporin-penicillin", allergy: "cephalosporin", drug: { classes: ["penicillin"] }, severity: "warn", why: "penicillins can cross-react with cephalosporins" },
  { id: "cephalosporin-carbapenem", allergy: "cephalosporin", drug: { classes: ["carbapenem"] }, severity: "warn", why: "carbapenems can cross-react with cephalosporins" },
  { id: "sulfa-non-antibiotic", allergy: "sulfonamide-antibiotic", drug: { classes: ["sulfonamide-non-antibiotic"] }, severity: "warn", why: "a cross-reaction with non-antibiotic sulfonamides is uncommon but reported" },
  { id: "sulfa-sulfone", allergy: "sulfonamide-antibiotic", drug: { classes: ["sulfone"] }, severity: "warn", why: "dapsone can cross-react with sulfa drugs" },
  { id: "vitamin-a-oral-retinoid", allergy: "vitamin-a", drug: { classes: ["oral-retinoid"], routes: ["systemic"] }, severity: "stop", why: "oral retinoids are vitamin A derivatives" },
  { id: "vitamin-a-topical-retinoid", allergy: "vitamin-a", drug: { classes: ["oral-retinoid", "topical-retinoid"], routes: ["topical"] }, severity: "warn", why: "topical retinoids are vitamin A derivatives" },
  { id: "retinoid-vitamin-a", allergy: "oral-retinoid", drug: { classes: ["vitamin-a"] }, severity: "warn", why: "vitamin A is chemically related to the retinoids" },
];

// ── Interactions ─────────────────────────────────────────────────────────────

export interface InteractionRule {
  id: string;
  a: Matcher;
  b: Matcher;
  severity: Severity;
  /** Completes "<A> with <B>: <why>". */
  why: string;
}

const STRONG_CYP3A4_AZOLES = ["itraconazole", "ketoconazole", "posaconazole", "voriconazole"];

export const INTERACTIONS: readonly InteractionRule[] = [
  { id: "retinoid-tetracycline", a: { classes: ["oral-retinoid"] }, b: { classes: ["tetracycline"] }, severity: "stop", why: "both raise the pressure around the brain (benign intracranial hypertension). Do not combine." },
  { id: "retinoid-vitamin-a", a: { classes: ["oral-retinoid"] }, b: { classes: ["vitamin-a"] }, severity: "stop", why: "extra vitamin A on top of a retinoid causes vitamin A poisoning (hypervitaminosis A)." },
  { id: "methotrexate-trimethoprim", a: { ingredients: ["methotrexate"] }, b: { ingredients: ["trimethoprim", "sulfamethoxazole"] }, severity: "stop", why: "trimethoprim and sulfamethoxazole block folate and slow the clearance of methotrexate: risk of fatal bone-marrow suppression." },
  { id: "methotrexate-acitretin", a: { ingredients: ["methotrexate"] }, b: { ingredients: ["acitretin"] }, severity: "stop", why: "the combination causes serious liver damage (hepatitis); it is contraindicated." },
  { id: "methotrexate-nsaid", a: { ingredients: ["methotrexate"] }, b: { classes: ["nsaid"] }, severity: "warn", why: "NSAIDs slow the clearance of methotrexate (toxicity); check blood counts and kidney function." },
  { id: "potassium-sparing-potassium", a: { classes: ["potassium-sparing-diuretic"] }, b: { classes: ["potassium-supplement"] }, severity: "warn", why: "both raise blood potassium (hyperkalaemia). Check potassium or avoid the supplement." },
  { id: "potassium-sparing-raas", a: { classes: ["potassium-sparing-diuretic"] }, b: { classes: ["ace-inhibitor", "arb"] }, severity: "warn", why: "together they raise blood potassium (hyperkalaemia). Check potassium and kidney function within 1–2 weeks." },
  { id: "potassium-sparing-trimethoprim", a: { classes: ["potassium-sparing-diuretic"] }, b: { ingredients: ["trimethoprim"] }, severity: "warn", why: "trimethoprim also raises blood potassium (hyperkalaemia)." },
  { id: "potassium-sparing-drospirenone", a: { classes: ["potassium-sparing-diuretic"] }, b: { ingredients: ["drospirenone"] }, severity: "warn", why: "drospirenone also raises blood potassium (hyperkalaemia); check potassium in the first month." },
  { id: "anticoagulant-nsaid", a: { classes: ["anticoagulant"] }, b: { classes: ["nsaid", "antiplatelet"] }, severity: "warn", why: "the combination raises the risk of serious bleeding." },
  { id: "warfarin-potentiator", a: { classes: ["vitamin-k-antagonist"] }, b: { ingredients: ["fluconazole", "miconazole", "itraconazole", "ketoconazole", "voriconazole", "metronidazole", "sulfamethoxazole", "trimethoprim", "clarithromycin", "erythromycin", "ciprofloxacin", "levofloxacin"] }, severity: "warn", why: "it increases the effect of the anticoagulant (INR rise, bleeding). Check the INR within 3–5 days." },
  { id: "azole-statin", a: { ingredients: STRONG_CYP3A4_AZOLES }, b: { ingredients: ["simvastatin", "lovastatin", "atorvastatin"] }, severity: "warn", why: "the antifungal blocks the breakdown of the statin (CYP3A4): risk of muscle damage (rhabdomyolysis). Pause the statin during the course." },
  { id: "fluconazole-statin", a: { ingredients: ["fluconazole"] }, b: { ingredients: ["simvastatin", "lovastatin", "atorvastatin", "fluvastatin"] }, severity: "warn", why: "fluconazole raises the statin level: risk of muscle damage (rhabdomyolysis). Pause the statin or monitor for muscle pain." },
  { id: "macrolide-statin-contraindicated", a: { ingredients: ["clarithromycin", "erythromycin"] }, b: { ingredients: ["simvastatin", "lovastatin"] }, severity: "stop", why: "the antibiotic blocks the breakdown of the statin: high risk of muscle damage (rhabdomyolysis). Pause the statin during the course." },
  { id: "macrolide-statin", a: { ingredients: ["clarithromycin", "erythromycin"] }, b: { ingredients: ["atorvastatin"] }, severity: "warn", why: "the antibiotic raises the statin level: risk of muscle damage. Pause the statin or use a lower dose." },
  { id: "macrolide-qt", a: { classes: ["macrolide"] }, b: { classes: ["qt-prolonging"], notClasses: ["macrolide"] }, severity: "warn", why: "both prolong the QT interval (risk of a dangerous heart rhythm). Consider an ECG or an alternative." },
  { id: "qt-combination", a: { classes: ["qt-prolonging"], notClasses: ["macrolide"] }, b: { classes: ["qt-prolonging"], notClasses: ["macrolide"] }, severity: "warn", why: "both prolong the QT interval (risk of a dangerous heart rhythm). Consider an ECG or an alternative." },
  { id: "colchicine-clarithromycin", a: { ingredients: ["colchicine"] }, b: { ingredients: ["clarithromycin"] }, severity: "stop", why: "clarithromycin stops colchicine being cleared: fatal colchicine poisoning has been reported." },
  { id: "colchicine-inhibitor", a: { ingredients: ["colchicine"] }, b: { ingredients: ["erythromycin", "itraconazole", "ketoconazole", "ciclosporin"] }, severity: "warn", why: "it raises the colchicine level (toxicity); reduce the colchicine dose." },
  { id: "ciclosporin-statin", a: { ingredients: ["ciclosporin"] }, b: { classes: ["statin"] }, severity: "warn", why: "ciclosporin raises statin levels (muscle damage); use the lowest statin dose or pause it." },
  { id: "ciclosporin-inhibitor", a: { ingredients: ["ciclosporin"] }, b: { ingredients: ["clarithromycin", "erythromycin", "ketoconazole", "itraconazole", "fluconazole", "voriconazole"] }, severity: "warn", why: "it raises the ciclosporin level (kidney toxicity); check ciclosporin levels and creatinine." },
  { id: "tetracycline-cation", a: { classes: ["tetracycline"] }, b: { classes: ["polyvalent-cation"] }, severity: "warn", why: "the mineral binds the antibiotic in the gut and stops it working: take them at least 2–3 hours apart." },
  { id: "tranexamic-contraceptive", a: { classes: ["antifibrinolytic"] }, b: { classes: ["combined-oral-contraceptive"] }, severity: "warn", why: "both raise the risk of blood clots (thrombosis)." },
  { id: "botulinum-aminoglycoside", a: { classes: ["botulinum-toxin"] }, b: { classes: ["aminoglycoside"] }, severity: "warn", why: "aminoglycosides strengthen the effect of botulinum toxin on muscles (weakness, breathing problems)." },
  { id: "tramadol-serotonergic", a: { ingredients: ["tramadol"] }, b: { classes: ["ssri", "antidepressant"] }, severity: "warn", why: "risk of serotonin syndrome and seizures." },
];

/** Classes where two different members at once are a therapeutic duplication (warn). */
export const DUPLICATE_CLASSES: readonly { cls: DrugClass; routes?: readonly RouteGroup[]; why: string }[] = [
  { cls: "nsaid", routes: ["systemic"], why: "two NSAIDs together add stomach-bleeding and kidney risk without extra pain relief" },
  { cls: "tetracycline", routes: ["systemic"], why: "two tetracycline antibiotics at once add side effects without extra benefit" },
  { cls: "oral-retinoid", routes: ["systemic"], why: "two oral retinoids together cause vitamin A poisoning" },
  { cls: "5-alpha-reductase-inhibitor", why: "finasteride and dutasteride work the same way; using both adds side effects" },
  { cls: "macrolide", routes: ["systemic"], why: "two macrolide antibiotics at once add side effects without extra benefit" },
  { cls: "azole-antifungal", routes: ["systemic"], why: "two systemic azole antifungals at once add liver and heart-rhythm risk" },
  { cls: "anticoagulant", why: "two anticoagulants together greatly raise the bleeding risk" },
  { cls: "statin", why: "two statins at once add muscle and liver risk" },
  { cls: "ssri", why: "two SSRIs together risk serotonin syndrome" },
  { cls: "potassium-sparing-diuretic", why: "two potassium-sparing diuretics together risk dangerous hyperkalaemia" },
  { cls: "ace-inhibitor", why: "two ACE inhibitors at once is a duplication" },
  { cls: "arb", why: "two angiotensin receptor blockers at once is a duplication" },
  { cls: "corticosteroid", routes: ["systemic"], why: "two systemic corticosteroids at once is a duplication" },
  { cls: "topical-retinoid", routes: ["topical"], why: "two topical retinoids at once mostly add irritation" },
  { cls: "combined-oral-contraceptive", why: "two combined contraceptive pills at once double the clot risk" },
];

// ── Age ──────────────────────────────────────────────────────────────────────

export interface AgeRule {
  id: string;
  drug: Matcher;
  /** Applies when the patient is younger than this, in whole years. */
  under: number;
  severity: Severity;
  why: string;
}

export const AGE_RULES: readonly AgeRule[] = [
  { id: "tetracycline-under-8", drug: { classes: ["tetracycline"], routes: ["systemic"] }, under: 8, severity: "stop", why: "tetracyclines permanently stain developing teeth and affect bone growth in children under 8" },
  { id: "isotretinoin-under-12", drug: { ingredients: ["isotretinoin"], routes: ["systemic"] }, under: 12, severity: "warn", why: "isotretinoin is not established for children under 12" },
  { id: "aspirin-under-16", drug: { ingredients: ["aspirin"], routes: ["systemic"] }, under: 16, severity: "warn", why: "aspirin can cause Reye's syndrome (brain and liver damage) in children and teenagers under 16" },
  { id: "opioid-under-12", drug: { ingredients: ["codeine", "tramadol"], routes: ["systemic"] }, under: 12, severity: "stop", why: "codeine and tramadol can cause fatal breathing problems in children under 12" },
  { id: "fluoroquinolone-under-18", drug: { classes: ["fluoroquinolone"], routes: ["systemic"] }, under: 18, severity: "warn", why: "fluoroquinolones can damage growing joints and tendons; avoid under 18 unless there is no alternative" },
];

// ── Pregnancy ────────────────────────────────────────────────────────────────

/** Pregnancy checks apply to female patients in this age range (or of unknown age). */
export const CHILDBEARING_AGE = { from: 12, to: 55 } as const;

// ── Conditions ───────────────────────────────────────────────────────────────

/**
 * A condition from the patient's chronic conditions or diagnoses. Patterns
 * run on lower-cased text with Arabic letters normalised (أإآ → ا, ة → ه, ى → ي).
 */
export interface ConditionConcept {
  key: string;
  label: string;
  patterns: readonly RegExp[];
}

export const CONDITIONS: readonly ConditionConcept[] = [
  { key: "ckd", label: "chronic kidney disease", patterns: [/\bckd\b/, /chronic kidney/, /\bkidney (disease|failure|impairment|insufficiency)/, /\brenal (disease|failure|impairment|insufficiency)/, /\bdialysis\b/, /\besrd\b/, /\bnephropathy\b/, /(ال)?(فشل|قصور) (ال)?كلوي/] },
  { key: "depression", label: "depression or another mental-health condition", patterns: [/\bdepress/, /\bsuicid/, /\bbipolar\b/, /\bpsychos[ie]s\b/, /\bpsychotic\b/, /\bschizophren/, /اكتئاب/] },
  { key: "hypotension", label: "low blood pressure", patterns: [/\bhypotension\b/, /\blow blood pressure\b/, /\borthostatic\b/, /هبوط (في )?(ال)?ضغط/, /(ال)?ضغط (ال)?منخفض/] },
  { key: "heart-failure", label: "heart failure", patterns: [/\bheart failure\b/, /\bcardiac failure\b/, /\bchf\b/, /\bhf[rp]ef\b/, /\bcardiomyopath/, /\bpericardial effusion\b/, /(فشل|قصور) (في )?(ال)?قلب/] },
  { key: "liver-disease", label: "liver disease", patterns: [/\bcirrho/, /\bhepatitis\b/, /\bliver (disease|failure|impairment)/, /\bhepatic (disease|failure|impairment)/, /\bfatty liver\b/, /\b(nafld|mafld|nash|hcv|hbv)\b/, /تليف (ال)?كبد/, /فيروس سي/, /التهاب (ال)?كبد/] },
  { key: "peptic-ulcer", label: "a peptic ulcer or stomach bleeding", patterns: [/\bpeptic ulcer/, /\b(gastric|duodenal|stomach) ulcer/, /\bgi bleed/, /\bgastrointestinal (bleed|haemorrhage|hemorrhage)/, /\bpud\b/, /قرحه/] },
  { key: "asthma", label: "asthma", patterns: [/\basthma/, /ربو/] },
  { key: "hyperkalaemia", label: "high potassium or Addison's disease", patterns: [/\bhyperkal(a)?emia\b/, /\bhigh potassium\b/, /\baddison/, /ارتفاع (ال)?بوتاسيوم/] },
  { key: "long-qt", label: "a long QT interval", patterns: [/\blong qt\b/, /\bqt prolong/, /\bprolonged qt\b/, /\blqts\b/, /\btorsade/] },
  { key: "thromboembolism", label: "a history of blood clots or stroke", patterns: [/\bdvt\b/, /\bdeep (vein|venous) thrombosis\b/, /\bpulmonary embol/, /\bthromboembol/, /\bthrombosis\b/, /\bstroke\b/, /\bcva\b/, /\bthrombophilia\b/, /\bfactor v leiden\b/, /\bantiphospholipid\b/, /جلطه/] },
  { key: "g6pd", label: "G6PD deficiency", patterns: [/\bg6pd\b/, /\bfavism\b/, /انيميا (ال)?فول/] },
  { key: "myasthenia", label: "myasthenia gravis", patterns: [/\bmyasthenia\b/, /\blambert.?eaton\b/] },
  { key: "intracranial-hypertension", label: "raised intracranial pressure", patterns: [/\bintracranial hypertension\b/, /\bpseudotumou?r cerebri\b/, /\biih\b/] },
  { key: "hypertriglyceridaemia", label: "high triglycerides or pancreatitis", patterns: [/\bhypertriglycerid/, /\bhigh triglycerides\b/, /\bpancreatitis\b/] },
  { key: "epilepsy", label: "epilepsy", patterns: [/\bepilep/, /\bseizure/, /صرع/] },
  { key: "lactation", label: "breastfeeding", patterns: [/\bbreast ?feeding\b/, /\blactat/, /\bnursing mother\b/, /رضاعه/] },
];

export interface ConditionRule {
  id: string;
  condition: string;
  drug: Matcher;
  severity: Severity;
  /** Follows "<Drug>: the patient has <condition>." */
  why: string;
}

const SYSTEMIC = ["systemic"] as const;

export const CONDITION_RULES: readonly ConditionRule[] = [
  { id: "nsaid-ckd", condition: "ckd", drug: { classes: ["nsaid"], routes: SYSTEMIC }, severity: "warn", why: "NSAIDs can worsen kidney function." },
  { id: "nsaid-peptic-ulcer", condition: "peptic-ulcer", drug: { classes: ["nsaid"], routes: SYSTEMIC }, severity: "warn", why: "NSAIDs can cause stomach bleeding." },
  { id: "nsaid-heart-failure", condition: "heart-failure", drug: { classes: ["nsaid"], routes: SYSTEMIC }, severity: "warn", why: "NSAIDs cause fluid retention and can worsen heart failure." },
  { id: "nsaid-asthma", condition: "asthma", drug: { classes: ["nsaid"], routes: SYSTEMIC }, severity: "warn", why: "NSAIDs can trigger asthma attacks in sensitive patients." },
  { id: "isotretinoin-depression", condition: "depression", drug: { classes: ["oral-retinoid"], routes: SYSTEMIC }, severity: "warn", why: "isotretinoin has been linked with depression and suicidal thoughts: screen mood before starting and at every visit." },
  { id: "retinoid-liver", condition: "liver-disease", drug: { classes: ["oral-retinoid"], routes: SYSTEMIC }, severity: "warn", why: "oral retinoids can damage the liver: check liver tests before and during treatment." },
  { id: "retinoid-lipids", condition: "hypertriglyceridaemia", drug: { classes: ["oral-retinoid"], routes: SYSTEMIC }, severity: "warn", why: "oral retinoids raise triglycerides (risk of pancreatitis): check lipids." },
  { id: "intracranial-pressure", condition: "intracranial-hypertension", drug: { classes: ["oral-retinoid", "tetracycline"], routes: SYSTEMIC }, severity: "warn", why: "it can raise the pressure around the brain again." },
  { id: "minoxidil-hypotension", condition: "hypotension", drug: { ingredients: ["minoxidil"], routes: SYSTEMIC }, severity: "warn", why: "oral minoxidil lowers blood pressure further (dizziness, fainting)." },
  { id: "minoxidil-heart-failure", condition: "heart-failure", drug: { ingredients: ["minoxidil"], routes: SYSTEMIC }, severity: "warn", why: "oral minoxidil causes fluid retention and can cause fluid around the heart." },
  { id: "metformin-ckd", condition: "ckd", drug: { ingredients: ["metformin"] }, severity: "warn", why: "metformin can cause lactic acidosis when the kidneys are weak: check the eGFR (stop below 30)." },
  { id: "methotrexate-ckd", condition: "ckd", drug: { ingredients: ["methotrexate"] }, severity: "warn", why: "methotrexate is cleared by the kidneys: toxicity risk; reduce the dose or avoid it." },
  { id: "methotrexate-liver", condition: "liver-disease", drug: { ingredients: ["methotrexate"] }, severity: "warn", why: "methotrexate damages the liver: avoid it or monitor liver tests closely." },
  { id: "antifungal-liver", condition: "liver-disease", drug: { ingredients: ["terbinafine", "ketoconazole", "itraconazole"], routes: SYSTEMIC }, severity: "warn", why: "oral antifungals can damage the liver: check liver tests." },
  { id: "antiandrogen-liver", condition: "liver-disease", drug: { ingredients: ["bicalutamide", "flutamide", "cyproterone"] }, severity: "warn", why: "it can damage the liver: check liver tests." },
  { id: "potassium-sparing-hyperkalaemia", condition: "hyperkalaemia", drug: { classes: ["potassium-sparing-diuretic"] }, severity: "stop", why: "it raises potassium further; it is contraindicated." },
  { id: "potassium-sparing-ckd", condition: "ckd", drug: { classes: ["potassium-sparing-diuretic"] }, severity: "warn", why: "weak kidneys and a potassium-sparing diuretic risk hyperkalaemia: check potassium." },
  { id: "qt-long-qt", condition: "long-qt", drug: { classes: ["qt-prolonging"], routes: SYSTEMIC }, severity: "warn", why: "it prolongs the QT interval further (risk of a dangerous heart rhythm)." },
  { id: "tranexamic-thrombosis", condition: "thromboembolism", drug: { classes: ["antifibrinolytic"], routes: SYSTEMIC }, severity: "stop", why: "tranexamic acid promotes clotting; it is contraindicated after a thrombosis." },
  { id: "contraceptive-thrombosis", condition: "thromboembolism", drug: { classes: ["combined-oral-contraceptive"] }, severity: "stop", why: "combined pills raise the clot risk; they are contraindicated after a thrombosis." },
  { id: "dapsone-g6pd", condition: "g6pd", drug: { classes: ["sulfone"], routes: SYSTEMIC }, severity: "stop", why: "dapsone causes severe haemolysis (destruction of red blood cells) in G6PD deficiency." },
  { id: "sulfonamide-g6pd", condition: "g6pd", drug: { classes: ["sulfonamide-antibiotic"], routes: SYSTEMIC }, severity: "warn", why: "sulfa drugs can cause haemolysis in G6PD deficiency." },
  { id: "botulinum-myasthenia", condition: "myasthenia", drug: { classes: ["botulinum-toxin"] }, severity: "stop", why: "botulinum toxin worsens muscle weakness; it is contraindicated." },
  { id: "antibiotic-myasthenia", condition: "myasthenia", drug: { classes: ["macrolide", "fluoroquinolone", "aminoglycoside"], routes: SYSTEMIC }, severity: "warn", why: "these antibiotics can worsen muscle weakness." },
  { id: "tramadol-epilepsy", condition: "epilepsy", drug: { ingredients: ["tramadol"] }, severity: "warn", why: "tramadol lowers the seizure threshold." },
  { id: "breastfeeding", condition: "lactation", drug: { ingredients: ["isotretinoin", "acitretin", "alitretinoin", "methotrexate", "mycophenolate", "thalidomide"], routes: SYSTEMIC }, severity: "warn", why: "it passes into breast milk; avoid it while breastfeeding." },
];
