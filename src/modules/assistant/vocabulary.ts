/**
 * Clinical vocabulary for the assistant's structured (cohort) questions.
 *
 * Each concept lists the names a clinician may type or a chart may contain:
 * the generic name first, then brands, British/American spellings, common
 * abbreviations and Arabic (Egyptian) forms. Arabic is written as typed; the
 * matcher normalises spelling variants and the article itself.
 *
 * Drug classes serve two purposes: a class name in a question ("who is on
 * antibiotics?") matches every member, and for an allergy question a member of
 * a cross-reactive class matches the whole class ("allergic to penicillin"
 * also lists a recorded amoxicillin allergy, labelled "penicillin class").
 *
 * The tables are deliberately small and conservative: anything not listed is
 * still searched as typed (free text), and a typo is corrected only when it is
 * close to exactly one known name.
 */

export type ConceptKind = "drug" | "condition" | "allergen" | "procedure";

export interface Concept {
  id: string;
  kind: ConceptKind;
  /** Display label (generic name / preferred clinical term). */
  label: string;
  /** Every name that means this concept, including `label`. */
  names: string[];
  /** Drug classes the concept belongs to. */
  classes?: string[];
}

export interface DrugClass {
  id: string;
  label: string;
  /** Names of the class itself ("penicillins", "beta-lactam antibiotics", "sulfa drugs"). */
  names: string[];
  /**
   * An allergy to one member is clinically an allergy to the class, so an
   * allergy question about any member lists every member's allergy.
   */
  crossReactive: boolean;
}

export const DRUG_CLASSES: DrugClass[] = [
  { id: "penicillins", label: "penicillin class", names: ["penicillins", "penicillin antibiotics", "beta-lactams", "beta lactam antibiotics", "البنسلينات"], crossReactive: true },
  { id: "cephalosporins", label: "cephalosporins", names: ["cephalosporins", "cephalosporin", "السيفالوسبورينات"], crossReactive: false },
  { id: "sulfonamides", label: "sulfonamide class", names: ["sulfa", "sulfa drugs", "sulpha", "sulpha drugs", "sulfonamides", "sulphonamides", "sulfonamide antibiotics", "سلفا", "السلفا", "مركبات السلفا"], crossReactive: true },
  { id: "nsaids", label: "NSAID class", names: ["nsaids", "nsaid", "non-steroidal anti-inflammatory drugs", "anti-inflammatories", "painkillers nsaid", "مسكنات", "مضادات الالتهاب"], crossReactive: true },
  { id: "tetracyclines", label: "tetracyclines", names: ["tetracyclines"], crossReactive: false },
  { id: "macrolides", label: "macrolides", names: ["macrolides"], crossReactive: false },
  { id: "retinoids", label: "retinoids", names: ["retinoids", "retinoid", "ريتينويد"], crossReactive: false },
  { id: "corticosteroids", label: "corticosteroids", names: ["corticosteroids", "corticosteroid", "steroids", "steroid", "topical steroids", "steroid creams", "كورتيزون", "الكورتيزون", "كورتيزونات"], crossReactive: false },
  { id: "antibiotics", label: "antibiotics", names: ["antibiotics", "antibiotic", "مضاد حيوي", "مضادات حيويه", "المضاد الحيوي"], crossReactive: false },
  { id: "antihistamines", label: "antihistamines", names: ["antihistamines", "antihistamine", "مضادات الهستامين", "مضاد هستامين"], crossReactive: false },
  { id: "antifungals", label: "antifungals", names: ["antifungals", "antifungal", "مضادات الفطريات"], crossReactive: false },
  { id: "local-anaesthetics", label: "local anaesthetics", names: ["local anaesthetics", "local anesthetics", "local anaesthetic", "local anesthetic", "بنج موضعي", "مخدر موضعي"], crossReactive: false },
];

const AB = "antibiotics";

export const CONCEPTS: Concept[] = [
  // ── Antibiotics ───────────────────────────────────────────────────────────
  { id: "penicillin", kind: "drug", label: "penicillin", names: ["penicillin", "penicillin v", "penicillin g", "pen v", "benzylpenicillin", "phenoxymethylpenicillin", "benzathine penicillin", "بنسلين", "بنسيلين", "بنيسيلين", "البنسلين طويل المفعول"], classes: ["penicillins", AB] },
  { id: "amoxicillin", kind: "drug", label: "amoxicillin", names: ["amoxicillin", "amoxycillin", "amoxil", "amoxil forte", "اموكسيسيلين", "اموكسيل"], classes: ["penicillins", AB] },
  { id: "co-amoxiclav", kind: "drug", label: "amoxicillin-clavulanate", names: ["amoxicillin-clavulanate", "amoxicillin clavulanate", "amoxicillin/clavulanic acid", "co-amoxiclav", "augmentin", "hibiotic", "megamox", "اوجمنتين", "هاي بيوتك", "ميجاموكس"], classes: ["penicillins", AB] },
  { id: "ampicillin", kind: "drug", label: "ampicillin", names: ["ampicillin", "unasyn", "امبيسيلين"], classes: ["penicillins", AB] },
  { id: "flucloxacillin", kind: "drug", label: "flucloxacillin", names: ["flucloxacillin", "floxapen", "فلوكلوكساسيلين"], classes: ["penicillins", AB] },
  { id: "cloxacillin", kind: "drug", label: "cloxacillin", names: ["cloxacillin"], classes: ["penicillins", AB] },
  { id: "piperacillin", kind: "drug", label: "piperacillin", names: ["piperacillin", "tazocin", "piperacillin-tazobactam"], classes: ["penicillins", AB] },
  { id: "cephalexin", kind: "drug", label: "cephalexin", names: ["cephalexin", "cefalexin", "keflex", "ceporex", "سيفالكسين", "سيفاليكسين", "سيفالكس", "كيفلكس"], classes: ["cephalosporins", AB] },
  { id: "cefadroxil", kind: "drug", label: "cefadroxil", names: ["cefadroxil", "duricef", "سيفادروكسيل"], classes: ["cephalosporins", AB] },
  { id: "cefuroxime", kind: "drug", label: "cefuroxime", names: ["cefuroxime", "zinnat", "سيفوروكسيم", "زينات"], classes: ["cephalosporins", AB] },
  { id: "ceftriaxone", kind: "drug", label: "ceftriaxone", names: ["ceftriaxone", "rocephin", "سيفترياكسون"], classes: ["cephalosporins", AB] },
  { id: "cefixime", kind: "drug", label: "cefixime", names: ["cefixime", "suprax", "سيفيكسيم"], classes: ["cephalosporins", AB] },
  { id: "doxycycline", kind: "drug", label: "doxycycline", names: ["doxycycline", "vibramycin", "doxymycin", "doxy", "دوكسيسيكلين", "دوكسي سيكلين", "دوكسي"], classes: ["tetracyclines", AB] },
  { id: "minocycline", kind: "drug", label: "minocycline", names: ["minocycline", "minocin", "مينوسيكلين"], classes: ["tetracyclines", AB] },
  { id: "tetracycline", kind: "drug", label: "tetracycline", names: ["tetracycline", "lymecycline", "تتراسيكلين"], classes: ["tetracyclines", AB] },
  { id: "azithromycin", kind: "drug", label: "azithromycin", names: ["azithromycin", "zithromax", "xithrone", "ازيثرومايسين", "زيثروماكس"], classes: ["macrolides", AB] },
  { id: "clarithromycin", kind: "drug", label: "clarithromycin", names: ["clarithromycin", "klacid", "كلاريثرومايسين"], classes: ["macrolides", AB] },
  { id: "erythromycin", kind: "drug", label: "erythromycin", names: ["erythromycin", "اريثرومايسين"], classes: ["macrolides", AB] },
  { id: "clindamycin", kind: "drug", label: "clindamycin", names: ["clindamycin", "dalacin", "dalacin c", "كليندامايسين", "دالاسين"], classes: [AB] },
  { id: "metronidazole", kind: "drug", label: "metronidazole", names: ["metronidazole", "flagyl", "rozex", "metrogel", "ميترونيدازول", "فلاجيل"], classes: [AB] },
  { id: "co-trimoxazole", kind: "drug", label: "co-trimoxazole", names: ["co-trimoxazole", "cotrimoxazole", "sulfamethoxazole", "trimethoprim-sulfamethoxazole", "septrin", "bactrim", "سبترين"], classes: ["sulfonamides", AB] },
  { id: "fusidic-acid", kind: "drug", label: "fusidic acid", names: ["fusidic acid", "fucidin", "فيوسيدين"], classes: [AB] },
  { id: "mupirocin", kind: "drug", label: "mupirocin", names: ["mupirocin", "bactroban", "باكتروبان"], classes: [AB] },
  { id: "ciprofloxacin", kind: "drug", label: "ciprofloxacin", names: ["ciprofloxacin", "cipro", "ciprobay", "سيبروفلوكساسين"], classes: [AB] },

  // ── Acne, pigmentation, hair ─────────────────────────────────────────────
  { id: "isotretinoin", kind: "drug", label: "isotretinoin", names: ["isotretinoin", "roaccutane", "accutane", "acnotren", "claravis", "absorica", "amnesteem", "ايزوتريتينوين", "ايزوتريتنوين", "روكتان", "روكيوتان", "رواكيوتان", "اكنوترين"], classes: ["retinoids"] },
  { id: "acitretin", kind: "drug", label: "acitretin", names: ["acitretin", "neotigason", "اسيتريتين"], classes: ["retinoids"] },
  { id: "tretinoin", kind: "drug", label: "tretinoin", names: ["tretinoin", "retin-a", "retin a", "airol", "تريتينوين"], classes: ["retinoids"] },
  { id: "adapalene", kind: "drug", label: "adapalene", names: ["adapalene", "differin", "epiduo", "ادابالين", "ديفرين"], classes: ["retinoids"] },
  { id: "tazarotene", kind: "drug", label: "tazarotene", names: ["tazarotene", "zorac"], classes: ["retinoids"] },
  { id: "benzoyl-peroxide", kind: "drug", label: "benzoyl peroxide", names: ["benzoyl peroxide", "benzac", "بنزويل بيروكسيد"] },
  { id: "azelaic-acid", kind: "drug", label: "azelaic acid", names: ["azelaic acid", "skinoren", "finacea", "حمض الازيليك"] },
  { id: "salicylic-acid", kind: "drug", label: "salicylic acid", names: ["salicylic acid", "حمض الساليسيليك"] },
  { id: "spironolactone", kind: "drug", label: "spironolactone", names: ["spironolactone", "aldactone", "سبيرونولاكتون", "الدكتون"] },
  { id: "tranexamic-acid", kind: "drug", label: "tranexamic acid", names: ["tranexamic acid", "tranexamic", "txa", "cyklokapron", "kapron", "ترانيكساميك", "حمض الترانيكساميك", "كابرون"] },
  { id: "hydroquinone", kind: "drug", label: "hydroquinone", names: ["hydroquinone", "eldoquin", "هيدروكينون"] },
  { id: "kojic-acid", kind: "drug", label: "kojic acid", names: ["kojic acid", "حمض الكوجيك"] },
  { id: "niacinamide", kind: "drug", label: "niacinamide", names: ["niacinamide", "نياسيناميد"] },
  { id: "finasteride", kind: "drug", label: "finasteride", names: ["finasteride", "propecia", "proscar", "fincar", "فيناسترايد", "فيناستيريد", "فيناستريد", "بروبيشيا", "بروسكار"] },
  { id: "dutasteride", kind: "drug", label: "dutasteride", names: ["dutasteride", "avodart", "دوتاستيرايد", "افودارت"] },
  { id: "minoxidil", kind: "drug", label: "minoxidil", names: ["minoxidil", "rogaine", "regaine", "loniten", "مينوكسيديل", "مينوكسيدل"] },
  { id: "biotin", kind: "drug", label: "biotin", names: ["biotin", "بيوتين"] },

  // ── Steroids, psoriasis, eczema, rosacea ─────────────────────────────────
  { id: "triamcinolone", kind: "drug", label: "triamcinolone", names: ["triamcinolone", "intralesional triamcinolone", "kenalog", "kenacort", "تريامسينولون", "كيناكورت"], classes: ["corticosteroids"] },
  { id: "mometasone", kind: "drug", label: "mometasone", names: ["mometasone", "elocon", "موميتازون", "ايلوكون"], classes: ["corticosteroids"] },
  { id: "clobetasol", kind: "drug", label: "clobetasol", names: ["clobetasol", "dermovate", "كلوبيتازول", "ديرموفيت"], classes: ["corticosteroids"] },
  { id: "betamethasone", kind: "drug", label: "betamethasone", names: ["betamethasone", "betnovate", "diprosone", "بيتاميثازون", "بيتنوفيت"], classes: ["corticosteroids"] },
  { id: "calcipotriol-betamethasone", kind: "drug", label: "calcipotriol/betamethasone", names: ["calcipotriol/betamethasone", "calcipotriol betamethasone", "daivobet", "xamiol", "دايفوبيت"], classes: ["corticosteroids"] },
  { id: "calcipotriol", kind: "drug", label: "calcipotriol", names: ["calcipotriol", "calcipotriene", "daivonex", "كالسيبوتريول"] },
  { id: "hydrocortisone", kind: "drug", label: "hydrocortisone", names: ["hydrocortisone", "هيدروكورتيزون"], classes: ["corticosteroids"] },
  { id: "prednisolone", kind: "drug", label: "prednisolone", names: ["prednisolone", "prednisone", "solupred", "hostacortin", "بريدنيزولون", "سولوبريد"], classes: ["corticosteroids"] },
  { id: "tacrolimus", kind: "drug", label: "tacrolimus", names: ["tacrolimus", "protopic", "تاكروليمس", "بروتوبيك"] },
  { id: "pimecrolimus", kind: "drug", label: "pimecrolimus", names: ["pimecrolimus", "elidel"] },
  { id: "methotrexate", kind: "drug", label: "methotrexate", names: ["methotrexate", "mtx", "ميثوتريكسات"] },
  { id: "cyclosporine", kind: "drug", label: "cyclosporine", names: ["cyclosporine", "ciclosporin", "neoral", "sandimmun", "سيكلوسبورين"] },
  { id: "dupilumab", kind: "drug", label: "dupilumab", names: ["dupilumab", "dupixent", "دوبيلوماب", "دوبيكسنت"] },
  { id: "ivermectin", kind: "drug", label: "ivermectin", names: ["ivermectin", "soolantra", "stromectol", "iverzine", "ايفرمكتين", "ايفرميكتين"] },
  { id: "permethrin", kind: "drug", label: "permethrin", names: ["permethrin", "lyclear", "بيرمثرين"] },
  { id: "coal-tar", kind: "drug", label: "coal tar", names: ["coal tar", "coal tar shampoo", "قطران"] },
  { id: "emollient", kind: "drug", label: "emollient", names: ["emollient", "emollients", "moisturiser", "moisturizer", "مرطب"] },
  { id: "sunscreen", kind: "drug", label: "sunscreen", names: ["sunscreen", "sun screen", "sunblock", "spf", "واقي شمس", "صن بلوك"] },
  { id: "saline-spray", kind: "drug", label: "saline spray", names: ["saline spray", "saline", "محلول ملحي"] },

  // ── Antifungals, antivirals, antihistamines ──────────────────────────────
  { id: "ketoconazole", kind: "drug", label: "ketoconazole", names: ["ketoconazole", "nizoral", "كيتوكونازول", "نيزورال"], classes: ["antifungals"] },
  { id: "terbinafine", kind: "drug", label: "terbinafine", names: ["terbinafine", "lamisil", "تيربينافين", "لاميزيل"], classes: ["antifungals"] },
  { id: "fluconazole", kind: "drug", label: "fluconazole", names: ["fluconazole", "diflucan", "فلوكونازول"], classes: ["antifungals"] },
  { id: "itraconazole", kind: "drug", label: "itraconazole", names: ["itraconazole", "sporanox", "ايتراكونازول"], classes: ["antifungals"] },
  { id: "acyclovir", kind: "drug", label: "acyclovir", names: ["acyclovir", "aciclovir", "zovirax", "اسيكلوفير", "زوفيراكس"] },
  { id: "valacyclovir", kind: "drug", label: "valacyclovir", names: ["valacyclovir", "valaciclovir", "valtrex", "فالاسيكلوفير"] },
  { id: "cetirizine", kind: "drug", label: "cetirizine", names: ["cetirizine", "zyrtec", "سيتريزين", "زيرتك"], classes: ["antihistamines"] },
  { id: "levocetirizine", kind: "drug", label: "levocetirizine", names: ["levocetirizine", "xyzal"], classes: ["antihistamines"] },
  { id: "loratadine", kind: "drug", label: "loratadine", names: ["loratadine", "claritine", "claritin", "لوراتادين", "كلاريتين"], classes: ["antihistamines"] },
  { id: "desloratadine", kind: "drug", label: "desloratadine", names: ["desloratadine", "aerius"], classes: ["antihistamines"] },
  { id: "fexofenadine", kind: "drug", label: "fexofenadine", names: ["fexofenadine", "telfast", "فيكسوفينادين", "تلفاست"], classes: ["antihistamines"] },
  { id: "hydroxyzine", kind: "drug", label: "hydroxyzine", names: ["hydroxyzine", "atarax", "هيدروكسيزين", "اتاراكس"], classes: ["antihistamines"] },
  { id: "hydroxychloroquine", kind: "drug", label: "hydroxychloroquine", names: ["hydroxychloroquine", "plaquenil", "هيدروكسي كلوروكين", "بلاكونيل"] },

  // ── Analgesics, anaesthetics ─────────────────────────────────────────────
  { id: "ibuprofen", kind: "drug", label: "ibuprofen", names: ["ibuprofen", "brufen", "advil", "nurofen", "ايبوبروفين", "بروفين"], classes: ["nsaids"] },
  { id: "diclofenac", kind: "drug", label: "diclofenac", names: ["diclofenac", "voltaren", "cataflam", "ديكلوفيناك", "فولتارين", "كتافلام"], classes: ["nsaids"] },
  { id: "naproxen", kind: "drug", label: "naproxen", names: ["naproxen", "naprosyn", "نابروكسين"], classes: ["nsaids"] },
  { id: "aspirin", kind: "drug", label: "aspirin", names: ["aspirin", "acetylsalicylic acid", "aspocid", "اسبرين", "اسبوسيد"], classes: ["nsaids"] },
  { id: "mefenamic-acid", kind: "drug", label: "mefenamic acid", names: ["mefenamic acid", "ponstan", "بونستان"], classes: ["nsaids"] },
  { id: "celecoxib", kind: "drug", label: "celecoxib", names: ["celecoxib", "celebrex", "سيليبريكس"], classes: ["nsaids"] },
  { id: "paracetamol", kind: "drug", label: "paracetamol", names: ["paracetamol", "acetaminophen", "panadol", "tylenol", "abimol", "باراسيتامول", "بانادول"] },
  { id: "lidocaine", kind: "drug", label: "lidocaine", names: ["lidocaine", "lignocaine", "xylocaine", "lidocain", "ليدوكايين", "ليدوكاين", "ليدوكائين", "زيلوكايين", "زيلوكاين"], classes: ["local-anaesthetics"] },
  { id: "prilocaine", kind: "drug", label: "prilocaine", names: ["prilocaine", "emla", "بريلوكايين"], classes: ["local-anaesthetics"] },
  { id: "bupivacaine", kind: "drug", label: "bupivacaine", names: ["bupivacaine", "marcaine", "بوبيفاكايين"], classes: ["local-anaesthetics"] },
  { id: "articaine", kind: "drug", label: "articaine", names: ["articaine", "ارتيكايين"], classes: ["local-anaesthetics"] },
  { id: "benzocaine", kind: "drug", label: "benzocaine", names: ["benzocaine", "بنزوكايين"], classes: ["local-anaesthetics"] },

  // ── Common chronic medication ────────────────────────────────────────────
  { id: "metformin", kind: "drug", label: "metformin", names: ["metformin", "glucophage", "cidophage", "ميتفورمين", "جلوكوفاج", "سيدوفاج"] },
  { id: "insulin", kind: "drug", label: "insulin", names: ["insulin", "انسولين"] },
  { id: "levothyroxine", kind: "drug", label: "levothyroxine", names: ["levothyroxine", "thyroxine", "eltroxin", "euthyrox", "synthroid", "ليفوثيروكسين", "التروكسين", "يوثيروكس"] },
  { id: "amlodipine", kind: "drug", label: "amlodipine", names: ["amlodipine", "norvasc", "amlo", "املوديبين", "نورفاسك"] },
  { id: "bisoprolol", kind: "drug", label: "bisoprolol", names: ["bisoprolol", "concor", "بيسوبرولول", "كونكور"] },
  { id: "lisinopril", kind: "drug", label: "lisinopril", names: ["lisinopril", "zestril", "ليسينوبريل"] },
  { id: "losartan", kind: "drug", label: "losartan", names: ["losartan", "cozaar", "لوسارتان"] },
  { id: "atorvastatin", kind: "drug", label: "atorvastatin", names: ["atorvastatin", "lipitor", "ator", "اتورفاستاتين", "ليبيتور"] },
  { id: "warfarin", kind: "drug", label: "warfarin", names: ["warfarin", "coumadin", "marevan", "وارفارين", "ماريفان"] },
  { id: "clopidogrel", kind: "drug", label: "clopidogrel", names: ["clopidogrel", "plavix", "كلوبيدوجريل", "بلافيكس"] },
  { id: "oral-contraceptive", kind: "drug", label: "oral contraceptive", names: ["oral contraceptive", "combined oral contraceptive", "the pill", "yasmin", "diane-35", "حبوب منع الحمل"] },
  { id: "vitamin-d", kind: "drug", label: "vitamin D", names: ["vitamin d", "vitamin d3", "cholecalciferol", "فيتامين د"] },
  { id: "iron", kind: "drug", label: "iron supplement", names: ["iron supplement", "ferrous sulfate", "ferrous sulphate", "ferrous fumarate", "حديد", "مكمل حديد"] },
  { id: "zinc", kind: "drug", label: "zinc", names: ["zinc", "زنك"] },
  { id: "botulinum-toxin", kind: "drug", label: "botulinum toxin", names: ["botulinum toxin", "botox", "dysport", "بوتوكس"] },

  // ── Non-drug allergens ───────────────────────────────────────────────────
  { id: "latex", kind: "allergen", label: "latex", names: ["latex", "rubber latex", "لاتكس", "لاتيكس"] },
  { id: "nickel", kind: "allergen", label: "nickel", names: ["nickel", "نيكل"] },
  { id: "peanut", kind: "allergen", label: "peanuts", names: ["peanut", "peanuts", "groundnut", "فول سوداني", "سوداني"] },
  { id: "tree-nuts", kind: "allergen", label: "tree nuts", names: ["tree nuts", "nuts", "مكسرات"] },
  { id: "shellfish", kind: "allergen", label: "shellfish", names: ["shellfish", "seafood", "shrimp", "جمبري", "مأكولات بحريه"] },
  { id: "egg", kind: "allergen", label: "eggs", names: ["egg", "eggs", "بيض"] },
  { id: "milk", kind: "allergen", label: "milk", names: ["milk", "dairy", "cow's milk", "لبن", "حليب", "الالبان"] },
  { id: "iodine", kind: "allergen", label: "iodine", names: ["iodine", "iodinated contrast", "contrast dye", "povidone-iodine", "betadine", "يود", "بيتادين"] },
  { id: "chlorhexidine", kind: "allergen", label: "chlorhexidine", names: ["chlorhexidine", "hibiscrub", "كلورهيكسيدين"] },
  { id: "adhesive", kind: "allergen", label: "adhesive tape", names: ["adhesive tape", "adhesive", "plaster", "sticking plaster", "لزق"] },
  { id: "fragrance", kind: "allergen", label: "fragrance", names: ["fragrance", "perfume", "عطور", "برفان"] },
  { id: "ppd", kind: "allergen", label: "hair dye (PPD)", names: ["ppd", "paraphenylenediamine", "para-phenylenediamine", "hair dye", "صبغه الشعر", "صبغه"] },
  { id: "bee-venom", kind: "allergen", label: "bee stings", names: ["bee sting", "bee stings", "bee venom", "wasp sting", "قرص النحل", "لدغ النحل"] },
  { id: "dust-mites", kind: "allergen", label: "dust mites", names: ["dust mites", "house dust mite", "dust", "تراب", "الغبار"] },
  { id: "pollen", kind: "allergen", label: "pollen", names: ["pollen", "hay fever", "حبوب اللقاح"] },

  // ── Conditions ───────────────────────────────────────────────────────────
  { id: "acne", kind: "condition", label: "acne", names: ["acne", "acne vulgaris", "pimples", "حب الشباب", "حبوب الشباب", "اكني"] },
  { id: "melasma", kind: "condition", label: "melasma", names: ["melasma", "chloasma", "كلف", "الكلف", "نمش الحمل"] },
  { id: "hyperpigmentation", kind: "condition", label: "hyperpigmentation", names: ["hyperpigmentation", "post-inflammatory hyperpigmentation", "pigmentation", "pih", "تصبغات", "تصبغ", "اسمرار"] },
  { id: "pcos", kind: "condition", label: "PCOS", names: ["pcos", "polycystic ovary syndrome", "polycystic ovarian syndrome", "polycystic ovaries", "polycystic ovary", "pco", "تكيس المبايض", "تكيس على المبايض", "تكيسات المبايض", "تكيس مبايض", "متلازمه تكيس المبايض"] },
  { id: "atopic-dermatitis", kind: "condition", label: "atopic dermatitis", names: ["atopic dermatitis", "eczema", "atopic eczema", "اكزيما", "الاكزيما", "التهاب الجلد التاتبي"] },
  { id: "seborrheic-dermatitis", kind: "condition", label: "seborrheic dermatitis", names: ["seborrheic dermatitis", "seborrhoeic dermatitis", "seborrheic eczema", "dandruff", "الاكزيما الدهنيه", "قشره"] },
  { id: "contact-dermatitis", kind: "condition", label: "contact dermatitis", names: ["contact dermatitis", "التهاب الجلد التماسي"] },
  { id: "psoriasis", kind: "condition", label: "psoriasis", names: ["psoriasis", "plaque psoriasis", "psoriatic", "صدفيه", "الصدفيه"] },
  { id: "rosacea", kind: "condition", label: "rosacea", names: ["rosacea", "papulopustular rosacea", "ورديه", "الورديه", "العد الوردي"] },
  { id: "alopecia-areata", kind: "condition", label: "alopecia areata", names: ["alopecia areata", "ثعلبه", "الثعلبه", "داء الثعلبه"] },
  { id: "androgenetic-alopecia", kind: "condition", label: "androgenetic alopecia", names: ["androgenetic alopecia", "androgenic alopecia", "aga", "male pattern baldness", "male pattern hair loss", "female pattern hair loss", "pattern hair loss", "الصلع الوراثي", "صلع وراثي"] },
  { id: "hair-loss", kind: "condition", label: "hair loss (any alopecia)", names: ["hair loss", "hair fall", "hairloss", "alopecia", "baldness", "telogen effluvium", "thinning hair", "تساقط الشعر", "تساقط شعر", "وقوع الشعر", "صلع", "الصلع"] },
  { id: "hirsutism", kind: "condition", label: "hirsutism", names: ["hirsutism", "excess hair", "unwanted hair", "الشعر الزائد", "شعر زائد"] },
  { id: "warts", kind: "condition", label: "warts", names: ["warts", "wart", "plantar warts", "verruca", "verrucae", "ثاليل", "الثاليل", "سنط", "السنط"] },
  { id: "vitiligo", kind: "condition", label: "vitiligo", names: ["vitiligo", "بهاق", "البهاق"] },
  { id: "urticaria", kind: "condition", label: "urticaria", names: ["urticaria", "hives", "chronic urticaria", "ارتكاريا", "الارتيكاريا", "ارتيكاريا"] },
  { id: "keloid", kind: "condition", label: "keloid", names: ["keloid", "keloids", "hypertrophic scar", "كيلويد", "الكيلويد"] },
  { id: "scabies", kind: "condition", label: "scabies", names: ["scabies", "جرب", "الجرب"] },
  { id: "tinea", kind: "condition", label: "tinea (fungal infection)", names: ["tinea", "tinea capitis", "tinea corporis", "tinea versicolor", "ringworm", "fungal infection", "فطريات", "التينيا"] },
  { id: "herpes", kind: "condition", label: "herpes", names: ["herpes", "herpes simplex", "cold sores", "shingles", "herpes zoster", "هربس", "الهربس"] },
  { id: "lichen-planus", kind: "condition", label: "lichen planus", names: ["lichen planus", "الحزاز المسطح"] },
  { id: "hidradenitis", kind: "condition", label: "hidradenitis suppurativa", names: ["hidradenitis suppurativa", "hidradenitis"] },
  { id: "folliculitis", kind: "condition", label: "folliculitis", names: ["folliculitis", "التهاب بصيلات الشعر"] },
  { id: "hypertension", kind: "condition", label: "hypertension", names: ["hypertension", "essential hypertension", "high blood pressure", "htn", "ضغط الدم", "ضغط دم", "ارتفاع ضغط الدم", "ضغط عالي", "الضغط العالي", "الضغط"] },
  { id: "type-2-diabetes", kind: "condition", label: "type 2 diabetes", names: ["type 2 diabetes", "type ii diabetes", "type 2 diabetes mellitus", "t2dm", "dm2", "diabetes type 2", "سكر من النوع الثاني", "السكري من النوع الثاني"] },
  { id: "type-1-diabetes", kind: "condition", label: "type 1 diabetes", names: ["type 1 diabetes", "type i diabetes", "t1dm", "dm1", "diabetes type 1", "سكر من النوع الاول"] },
  { id: "diabetes", kind: "condition", label: "diabetes (any type)", names: ["diabetes", "diabetes mellitus", "diabetic", "diabetics", "dm", "سكر", "السكر", "السكري", "مرض السكر"] },
  { id: "hypothyroidism", kind: "condition", label: "hypothyroidism", names: ["hypothyroidism", "underactive thyroid", "hashimoto", "hashimoto's thyroiditis", "قصور الغده الدرقيه", "قصور الدرقيه", "خمول الغده الدرقيه", "خمول الغده"] },
  { id: "hyperthyroidism", kind: "condition", label: "hyperthyroidism", names: ["hyperthyroidism", "overactive thyroid", "graves disease", "فرط نشاط الغده الدرقيه", "نشاط الغده"] },
  { id: "anaemia", kind: "condition", label: "anaemia", names: ["anaemia", "anemia", "iron deficiency", "iron deficiency anaemia", "iron deficiency anemia", "low ferritin", "انيميا", "الانيميا", "فقر الدم", "فقر دم"] },
  { id: "asthma", kind: "condition", label: "asthma", names: ["asthma", "asthmatic", "ربو", "الربو", "حساسيه صدر", "حساسيه الصدر", "حساسيه على الصدر"] },
  { id: "pregnancy", kind: "condition", label: "pregnancy", names: ["pregnancy", "pregnant", "حمل", "حامل", "حوامل"] },
  { id: "migraine", kind: "condition", label: "migraine", names: ["migraine", "صداع نصفي"] },
  { id: "depression", kind: "condition", label: "depression", names: ["depression", "اكتئاب", "الاكتئاب"] },
  { id: "hepatitis-c", kind: "condition", label: "hepatitis C", names: ["hepatitis c", "hcv", "فيروس سي", "التهاب الكبد الوبائي سي"] },
  { id: "lupus", kind: "condition", label: "lupus", names: ["lupus", "sle", "الذئبه الحمراء", "ذئبه"] },

  // ── Procedures and surgeries ─────────────────────────────────────────────
  { id: "hair-transplant", kind: "procedure", label: "hair transplant", names: ["hair transplant", "hair transplantation", "fue hair transplant", "fue", "fut", "follicular unit extraction", "follicular unit transplantation", "transplant", "زراعه شعر", "زراعه الشعر", "زرع شعر"] },
  { id: "organ-transplant", kind: "procedure", label: "organ transplant", names: ["kidney transplant", "renal transplant", "liver transplant", "heart transplant", "organ transplant", "bone marrow transplant", "زراعه كلي", "زراعه كبد"] },
  { id: "prp", kind: "procedure", label: "PRP", names: ["prp", "platelet-rich plasma", "platelet rich plasma", "بلازما", "حقن البلازما"] },
  { id: "laser", kind: "procedure", label: "laser treatment", names: ["laser", "laser hair removal", "laser session", "laser treatment", "fractional laser", "co2 laser", "ليزر", "الليزر", "ازاله الشعر بالليزر"] },
  { id: "chemical-peel", kind: "procedure", label: "chemical peel", names: ["chemical peel", "peel", "peeling", "تقشير", "تقشير كيميائي"] },
  { id: "fillers", kind: "procedure", label: "fillers", names: ["fillers", "filler", "dermal filler", "hyaluronic acid filler", "فيلر"] },
  { id: "cryotherapy", kind: "procedure", label: "cryotherapy", names: ["cryotherapy", "cryo", "كي بالتبريد"] },
  { id: "microneedling", kind: "procedure", label: "microneedling", names: ["microneedling", "dermapen", "ديرمابن"] },
  { id: "rhinoplasty", kind: "procedure", label: "rhinoplasty", names: ["rhinoplasty", "nose job", "تجميل الانف"] },
  { id: "liposuction", kind: "procedure", label: "liposuction", names: ["liposuction", "شفط الدهون"] },
  { id: "c-section", kind: "procedure", label: "caesarean section", names: ["caesarean section", "c-section", "cesarean", "قيصريه", "ولاده قيصريه"] },
  { id: "appendectomy", kind: "procedure", label: "appendectomy", names: ["appendectomy", "appendicectomy", "الزائده"] },
];

/**
 * Conditions that are biologically specific to one sex. A cohort that asks for
 * the other sex still lists what the chart says, with a data-quality note.
 */
export const SEX_SPECIFIC_CONDITIONS: Record<string, "MALE" | "FEMALE"> = {
  pcos: "FEMALE",
  pregnancy: "FEMALE",
};

// ── Keyword lexicons (written in normalised form: see text.ts) ───────────────

/** Words/phrases that open a "list / which / who" question. */
export const LIST_INTENT = [
  "which", "whcih", "wich", "whihc", "wihch", "whch", "who", "whom", "list", "show", "display", "find", "name", "get", "give me", "tell me", "what patients", "what patient",
  "which patients", "any patients", "any patient", "anyone", "anybody", "everyone", "everybody", "all patients", "are there", "is there",
  "do we have", "does anyone", "does anybody", "has anyone", "is anyone", "are any", "do any", "does any", "is any", "has any",
  "have any", "do any patients", "does any patient", "are any patients", "is any patient", "has any patient", "have any patients",
  "search", "pull up", "bring up", "look up",
  "مين", "من هم", "من هو", "مين اللي", "اي المرضى", "اي مريض", "ايه المرضى", "اعرض", "اعرضلي", "اعرض لي", "وريني", "طلعلي", "طلع لي",
  "هات", "هاتلي", "هات لي", "قائمه", "ليسته", "هل في", "هل فيه", "هل يوجد", "في حد", "فيه حد", "هل في حد", "حد", "ابحث", "دور",
];

/** Words/phrases that turn a list question into a count. */
export const COUNT_INTENT = ["how many", "number of", "count", "count of", "total number", "كام", "كم", "عدد"];

/** Openers of an open (non-list) question: these never take the cohort path on their own. */
export const OPEN_INTENT = [
  "summarise", "summarize", "summary", "compare", "explain", "describe", "why", "how", "what is", "what are", "what was", "what were",
  "what did", "what does", "what do", "when", "tell me about", "recommend", "suggest", "should", "advise", "draft", "write", "review",
  "لخص", "لخصلي", "ملخص", "قارن", "اشرح", "ليه", "ازاي", "امتى", "ايه هو", "ايه هي", "اكتب",
];

export const NEGATIONS = [
  "not", "no", "without", "never", "none", "nobody", "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't", "haven't",
  "hasn't", "hadn't", "won't", "can't", "cannot", "isnt", "arent", "wasnt", "werent", "dont", "doesnt", "didnt", "havent", "hasnt",
  "hadnt", "non", "free of", "lacking",
  "مش", "مو", "ما", "لا", "ليس", "ليسوا", "لم", "بدون", "من غير", "غير", "ماعندوش", "معندوش", "ماعندهاش", "معندهاش", "ماعندهمش",
  "معندهمش", "مبياخدش", "مابياخدش", "مبتاخدش", "مابتاخدش", "مبياخدوش", "مابياخدوش", "محدش", "مافيش", "مفيش",
];

/** Negated "has" verbs in Egyptian Arabic that also open a has-argument. */
export const NEGATED_HAS = ["ماعندوش", "معندوش", "ماعندهاش", "معندهاش", "ماعندهمش", "معندهمش"];
/** Negated "takes" verbs in Egyptian Arabic that also open a medication argument. */
export const NEGATED_TAKES = ["مبياخدش", "مابياخدش", "مبتاخدش", "مابتاخدش", "مبياخدوش", "مابياخدوش"];

export const SEX_WORDS: Record<string, "MALE" | "FEMALE"> = {
  male: "MALE", males: "MALE", man: "MALE", men: "MALE", gentlemen: "MALE", gentleman: "MALE", gents: "MALE", boys: "MALE", boy: "MALE",
  mens: "MALE", "male patients": "MALE",
  female: "FEMALE", females: "FEMALE", woman: "FEMALE", women: "FEMALE", ladies: "FEMALE", lady: "FEMALE", girls: "FEMALE", girl: "FEMALE",
  womens: "FEMALE", womans: "FEMALE", femal: "FEMALE", femle: "FEMALE", feamle: "FEMALE", femail: "FEMALE", wemen: "FEMALE", womem: "FEMALE",
  رجال: "MALE", رجاله: "MALE", رجل: "MALE", راجل: "MALE", ذكور: "MALE", ذكر: "MALE", رجالة: "MALE", الرجال: "MALE", الرجاله: "MALE", الذكور: "MALE",
  ستات: "FEMALE", سيدات: "FEMALE", السيدات: "FEMALE", الستات: "FEMALE", نساء: "FEMALE", النساء: "FEMALE", حريم: "FEMALE",
  اناث: "FEMALE", الاناث: "FEMALE", انثي: "FEMALE", بنات: "FEMALE", البنات: "FEMALE", مريضات: "FEMALE", المريضات: "FEMALE", سيده: "FEMALE",
};

/** Words that never carry meaning in a cohort question (skipped when looking for ignored parts). */
export const FILLERS = new Set([
  "a", "an", "the", "of", "our", "my", "your", "their", "his", "her", "its", "this", "that", "these", "those", "all", "any", "every", "each",
  "some", "patient", "patients", "pts", "pt", "people", "persons", "person", "individuals", "individual", "ones", "one", "cases", "case",
  "clients", "client", "clinic", "here", "currently", "presently", "now", "still", "actively", "documented", "recorded", "known",
  "noted", "listed", "registered", "confirmed", "reported", "charted", "documentation", "history", "record", "records", "chart",
  "charts", "file", "files", "system", "database", "in", "at", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "there", "please", "kindly", "thanks", "thank", "you", "me", "us", "we", "i", "can", "could", "would", "will", "should", "tell",
  "show", "give", "list", "find", "get", "display", "which", "who", "whom", "whose", "what", "and", "or", "also", "too", "them",
  "they", "ever", "so", "far", "right", "as", "well", "with", "have", "has", "had", "having", "got", "on", "to", "for", "by", "from",
  "about", "if", "it", "whether", "whole", "entire", "full", "complete", "everyone", "everybody", "anyone", "anybody", "somebody",
  "someone", "named", "called", "need", "want", "like", "know", "see", "just", "only", "how", "many", "much", "number", "count",
  "total", "list", "lists", "listing", "names", "name", "current", "active", "presently", "today's", "please?", "currently?", "moment",
  "time", "same", "under", "etc", "yes", "ok", "okay", "hi", "hello", "dear", "doctor's", "clinic's", "practice",
  "مين", "من", "ايه", "ايش", "اي", "هل", "في", "فيه", "المرضى", "مرضى", "المريض", "مريض", "العيانين", "الناس", "اللي", "الي", "الذين",
  "التي", "الذي", "كل", "عندنا", "لدينا", "عدد", "كام", "كم", "اعرض", "اعرضلي", "وريني", "طلعلي", "هات", "هاتلي", "قائمه", "لي",
  "حاليا", "دلوقتي", "الان", "مسجل", "مسجله", "مسجلين", "متسجل", "متسجله", "موثق", "موثقه", "حد", "و", "او", "ولا", "يا", "لو",
  "سمحت", "من فضلك", "العياده", "بالعياده", "عياده", "الملف", "ملف", "ملفه", "ملفها", "ملفهم", "سجل", "سجله", "السجل", "هو", "هي", "هم",
  "انا", "احنا", "عايز", "عاوز", "عايزه", "اعرف", "يعني", "بس", "كمان", "برضه", "دول", "ده", "دي", "حاجه", "مع", "على", "عن", "ب", "ل",
  "حالات", "حاله", "بتاعنا", "بتوعنا", "شخص", "اشخاص", "ممكن", "لو سمحت", "شكرا", "اسماء", "الاسماء", "اسم",
]);

/** Phrases that are filler as a whole ("on file", "in their records"). */
export const FILLER_PHRASES = [
  "on file", "on record", "on the record", "on their record", "on their records", "on our records", "in the record", "in the records",
  "in their record", "in their records", "in the chart", "in their chart", "in their charts", "in our records", "in the system",
  "in our system", "in their history", "in the history", "in their medical history", "in the medical history", "medical history",
  "of our patients", "of the patients", "in the clinic", "in our clinic", "at the clinic", "at the moment", "right now", "so far",
  "as of now", "as of today", "if any", "at all", "could you", "can you", "would you", "please tell me", "i want to know", "i need",
  "let me know", "do you know", "full list", "complete list", "a list of", "the list of", "list of", "names of", "the names of",
  "في الملف", "في ملفهم", "في السجل", "في العياده", "عندنا في العياده", "لو سمحت", "من فضلك", "عايز اعرف", "عاوز اعرف", "ممكن تقولي",
  "قولي", "قوللي",
];

/** Allergy words (any form). */
export const ALLERGY_WORDS = [
  "allergy", "allergies", "allergic", "alergy", "alergies", "alergic", "allergie", "allergys", "allergi", "alergi", "allergik",
  "allrgy", "allegy", "allergc", "hypersensitivity", "hypersensitive", "intolerance", "intolerant", "sensitivity", "حساسيه", "حساسيات",
  "متحسس", "متحسسه", "متحسسين", "بيتحسس", "يتحسس", "تحسس", "حساس",
];

/** Prepositions that introduce an allergy's agent: "allergic TO x", "حساسيه MN x". */
export const ALLERGY_PREPOSITIONS = ["to", "for", "against", "of", "towards", "from", "من", "ل", "لل", "ضد", "تجاه", "على"];

/** "No known allergies" and friends. */
export const NO_ALLERGY_PHRASES = [
  "nkda", "nka", "no known allergies", "no known allergy", "no known drug allergies", "no allergies", "no allergy",
  "no recorded allergies", "no documented allergies", "without allergies", "without any allergies", "without any allergy",
  "not allergic to anything", "allergy free", "no drug allergies", "معندهمش حساسيه", "ماعندهمش حساسيه", "معندوش حساسيه",
  "ماعندوش حساسيه", "معندهاش حساسيه", "ماعندهاش حساسيه", "بدون حساسيه", "مالهمش حساسيه", "لا يوجد حساسيه",
];

export const CONDITION_TRIGGERS = [
  "diagnosed with", "a diagnosis of", "diagnosis of", "with a diagnosis of", "suffering from", "suffer from", "suffers from",
  "treated for", "being treated for", "under treatment for", "receiving treatment for", "history of", "a history of", "living with",
  "affected by", "cases of", "presenting with", "presented with", "seen for",
  "مصاب ب", "مصابين ب", "مصابه ب", "مصاب", "مصابين", "مصابه", "بيعاني من", "يعاني من", "يعانون من", "بتعاني من", "تعاني من",
  "بيعانوا من", "مشخص ب", "متشخص ب", "متشخصين ب", "تشخيص", "تشخيصه", "تشخيصهم", "بيتعالج من", "بيتعالجوا من", "اتعالج من",
  "اتعالجوا من", "يتعالج من", "عنده مرض", "عندهم مرض",
];

/** Verbs that introduce a medication unambiguously ("taking X"). */
export const MEDICATION_TRIGGERS = [
  "currently taking", "taking", "take", "takes", "taken", "took", "using", "uses", "use", "prescribed", "been prescribed",
  "receiving", "receive", "receives", "given", "started on", "put on", "treated with", "on treatment with", "on a course of",
  "a course of", "prescription for", "prescriptions for", "prescribed with",
  "بياخد", "بياخدوا", "بتاخد", "بتاخدي", "ياخد", "ياخدوا", "ياخذ", "ياخذون", "يتناول", "يتناولون", "تاخد", "واخد", "واخدين", "واخده",
  "بيستخدم", "بيستخدموا", "بتستخدم", "يستخدم", "يستخدمون", "بيستعمل", "بيستعملوا", "يستعمل", "موصوف له", "موصوف لها", "موصوف لهم",
  "موصوفلهم", "مكتوب له", "مكتوب لها", "مكتوب لهم", "متعالج ب", "بيتعالج ب", "بيتعالجوا ب", "ماشي على", "ماشيين على",
];

/** "on X" / "على X": a medication only when X is recognisably a drug. */
export const ON_TRIGGERS = ["currently on", "on", "على", "علي", "على علاج", "على دوا", "على دواء"];

export const PROCEDURE_TRIGGERS = [
  "underwent", "undergone", "had surgery for", "operated for", "operated on for", "surgery for", "post-op", "post op",
  "عمل عمليه", "عملت عمليه", "عملوا عمليه", "اتعمل له", "اتعملها", "اتعملهم", "عمل", "عملت", "عملوا", "اجري", "اجرت", "اجروا", "عمليه",
];

/** Words in an argument that make it a surgery/procedure rather than a condition. */
export const PROCEDURE_WORDS = ["surgery", "operation", "procedure", "transplant", "transplantation", "op", "عمليه", "جراحه", "زراعه"];

/** Generic "has" verbs: the argument decides the kind (allergy, condition, drug, procedure). */
export const HAS_TRIGGERS = [
  "have", "has", "had", "having", "with", "got", "who have", "who has", "that have",
  "عنده", "عندها", "عندهم", "عندهن", "عندو", "ليه", "لديه", "لديها", "لديهم", "عندهوم",
];

export const TAG_TRIGGERS = ["tagged as", "tagged", "with the tag", "with tag", "tag", "labelled", "labeled", "labelled as", "labeled as", "وسم", "تاج", "متعلم"];

export const DOCTOR_TITLES = ["dr", "doctor", "doc", "د", "دكتور", "دكتوره", "الدكتور", "الدكتوره", "دكتورة"];

export const DOCTOR_LINKS = [
  "patients of", "seen by", "treated by", "under", "under the care of", "booked with", "with", "of", "by", "followed by", "under dr",
  "مرضى", "مع", "عند", "بتاع", "بتوع", "بتاعه", "تبع", "متابعين مع", "بيتابعوا مع", "بيتابع مع",
];

export const APPOINTMENT_WORDS = [
  "appointment", "appointments", "appt", "appts", "booking", "bookings", "booked", "scheduled", "visit booked", "session booked",
  "follow-up", "follow up", "follow-ups", "follow ups", "followup", "followups", "متابعه", "استشاره",
  "ميعاد", "معاد", "مواعيد", "حجز", "حجوزات", "محجوز", "محجوزين", "حاجز", "حاجزين", "زياره جايه",
];

export const VISIT_WORDS = ["visit", "visits", "seen", "visited", "been in", "come in", "came in", "attended", "زياره", "زار", "جه", "جاء", "حضر", "اتشاف"];

export const DETAIL_PHRASES: { phrase: string; detail: "dose" | "medications" | "grafts" | "dates" | "age" }[] = [
  { phrase: "and at what dose", detail: "dose" },
  { phrase: "at what dose", detail: "dose" },
  { phrase: "at which dose", detail: "dose" },
  { phrase: "what dose", detail: "dose" },
  { phrase: "which dose", detail: "dose" },
  { phrase: "what doses", detail: "dose" },
  { phrase: "and the dose", detail: "dose" },
  { phrase: "with the dose", detail: "dose" },
  { phrase: "with doses", detail: "dose" },
  { phrase: "and dose", detail: "dose" },
  { phrase: "and dosage", detail: "dose" },
  { phrase: "what dosage", detail: "dose" },
  { phrase: "what strength", detail: "dose" },
  { phrase: "dosage", detail: "dose" },
  { phrase: "the dose", detail: "dose" },
  { phrase: "dose", detail: "dose" },
  { phrase: "doses", detail: "dose" },
  { phrase: "بجرعه كام", detail: "dose" },
  { phrase: "بجرعه ايه", detail: "dose" },
  { phrase: "الجرعه كام", detail: "dose" },
  { phrase: "والجرعه", detail: "dose" },
  { phrase: "الجرعه", detail: "dose" },
  { phrase: "and what was prescribed", detail: "medications" },
  { phrase: "what was prescribed", detail: "medications" },
  { phrase: "and what were they prescribed", detail: "medications" },
  { phrase: "what were they prescribed", detail: "medications" },
  { phrase: "what was given", detail: "medications" },
  { phrase: "what were they given", detail: "medications" },
  { phrase: "and what medications", detail: "medications" },
  { phrase: "what medications", detail: "medications" },
  { phrase: "which medications", detail: "medications" },
  { phrase: "what medication", detail: "medications" },
  { phrase: "and their medications", detail: "medications" },
  { phrase: "with their medications", detail: "medications" },
  { phrase: "what treatment", detail: "medications" },
  { phrase: "and what treatment", detail: "medications" },
  { phrase: "واتكتب لهم ايه", detail: "medications" },
  { phrase: "اتكتب لهم ايه", detail: "medications" },
  { phrase: "اتوصف لهم ايه", detail: "medications" },
  { phrase: "بياخدوا ايه", detail: "medications" },
  { phrase: "وعلاجهم ايه", detail: "medications" },
  { phrase: "علاجهم ايه", detail: "medications" },
  { phrase: "and how many grafts", detail: "grafts" },
  { phrase: "how many grafts", detail: "grafts" },
  { phrase: "number of grafts", detail: "grafts" },
  { phrase: "graft count", detail: "grafts" },
  { phrase: "with grafts", detail: "grafts" },
  { phrase: "كام بصيله", detail: "grafts" },
  { phrase: "عدد البصيلات", detail: "grafts" },
  { phrase: "and since when", detail: "dates" },
  { phrase: "since when", detail: "dates" },
  { phrase: "and when", detail: "dates" },
  { phrase: "من امتى", detail: "dates" },
  { phrase: "and how old", detail: "age" },
  { phrase: "how old", detail: "age" },
  { phrase: "their ages", detail: "age" },
  { phrase: "their age", detail: "age" },
  { phrase: "with ages", detail: "age" },
  { phrase: "اعمارهم", detail: "age" },
];

export const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يونيه: 6, يوليو: 7, يوليه: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10,
  نوفمبر: 11, ديسمبر: 12,
};

/** Arabic and English number words used for ages and durations. */
export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  eighteen: 18, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, a: 1, an: 1,
  واحد: 1, اتنين: 2, اثنين: 2, تلاته: 3, ثلاثه: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, تمانيه: 8, ثمانيه: 8,
  تسعه: 9, عشره: 10, عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, تمانين: 80, ثمانين: 80,
};

/** Duration units → days. Arabic duals ("شهرين" = two months) carry their count. */
export const DURATION_UNITS: Record<string, { days: number; count?: number }> = {
  day: { days: 1 }, days: { days: 1 }, week: { days: 7 }, weeks: { days: 7 }, month: { days: 30 }, months: { days: 30 },
  year: { days: 365 }, years: { days: 365 }, yr: { days: 365 }, yrs: { days: 365 },
  يوم: { days: 1 }, ايام: { days: 1 }, يومين: { days: 1, count: 2 }, اسبوع: { days: 7 }, اسابيع: { days: 7 }, اسبوعين: { days: 7, count: 2 },
  شهر: { days: 30 }, شهور: { days: 30 }, اشهر: { days: 30 }, شهرين: { days: 30, count: 2 }, سنه: { days: 365 }, سنين: { days: 365 },
  سنوات: { days: 365 }, سنتين: { days: 365, count: 2 },
};

/**
 * Common Egyptian names in Arabic script and their usual Latin spellings, so an
 * Arabic question can name a patient or doctor whose record is in Latin script
 * ("هل طارق عزت بياخد سيفالكسين؟"). Keys are normalised (see text.ts).
 */
export const NAME_TRANSLITERATIONS: Record<string, string[]> = {
  احمد: ["ahmed", "ahmad"], محمد: ["mohamed", "mohammed", "muhammad", "mohammad"], عمر: ["omar", "omer"], يوسف: ["youssef", "yousef", "yusuf", "joseph"],
  خالد: ["khaled", "khalid"], محمود: ["mahmoud", "mahmood"], كريم: ["karim", "kareem"], طارق: ["tarek", "tariq", "tarik"], حسن: ["hassan", "hasan"],
  حسين: ["hussein", "hussain", "hossam"], عمرو: ["amr", "amro"], مصطفي: ["mostafa", "mustafa", "moustafa"], زياد: ["ziad", "ziyad"],
  شريف: ["sherif", "sharif"], هاني: ["hany", "hani"], عادل: ["adel"], ابراهيم: ["ibrahim", "ebrahim"], سامح: ["sameh"], سمير: ["samir"],
  عزت: ["ezzat", "izzat"], صالح: ["saleh", "salah"], صلاح: ["salah"], منصور: ["mansour", "mansur"], فتحي: ["fathy", "fathi"], كامل: ["kamel", "kamal"],
  شعبان: ["shaaban", "shaban"], جمال: ["gamal", "jamal"], زكي: ["zaki", "zakey"], فواد: ["fouad", "fuad"], نبيل: ["nabil", "nabeel"], حمدي: ["hamdy", "hamdi"],
  لطفي: ["lotfy", "lotfi"], فهمي: ["fahmy", "fahmi"], الدين: ["el-din", "eldin", "el din", "al-din"], عبد: ["abdel", "abd", "abdul"], الرحمن: ["rahman"],
  ساره: ["sara", "sarah"], نور: ["nour", "noor", "nur"], فاطمه: ["fatma", "fatima", "fatmah"], مريم: ["mariam", "maryam", "mariem"],
  هبه: ["heba", "hiba"], دينا: ["dina", "deena"], ياسمين: ["yasmin", "yasmine", "jasmine"], سلمي: ["salma", "selma"], رنا: ["rana"], ايا: ["aya"],
  منه: ["menna", "mennah"], هاله: ["hala"], ليلي: ["laila", "layla", "leila"], نادين: ["nadine", "nadeen"], ريم: ["reem", "rim"],
  فريده: ["farida", "fareeda"], نسمه: ["nesma", "nisma"], ناديه: ["nadia", "nadya"], هند: ["hind", "hend"], امل: ["amal"],
  ميرنا: ["merna", "mirna"], شيماء: ["shaimaa", "shimaa"], اسماء: ["asmaa", "asma"], هدي: ["hoda", "huda"], رحاب: ["rehab"], دعاء: ["doaa"],
};

/** Concept lookups, built once. */
const byId = new Map(CONCEPTS.map((c) => [c.id, c]));
const classById = new Map(DRUG_CLASSES.map((c) => [c.id, c]));

export function conceptById(id: string): Concept | undefined {
  return byId.get(id);
}

export function drugClassById(id: string): DrugClass | undefined {
  return classById.get(id);
}

/** Drugs that belong to a class. */
export function classMembers(classId: string): Concept[] {
  return CONCEPTS.filter((c) => c.classes?.includes(classId));
}
