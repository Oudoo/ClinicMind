import type { ObjectionTagKey } from "@/modules/crm/shared";

/**
 * Deterministic objection tagger for inbound messages. The AI receptionist
 * sets objection tags while a thread runs; offline (and in tests) this small
 * keyword tagger stands in, so the inbox always has suggestions for staff to
 * confirm. Arabic (Egyptian) and English keywords; substring matching for
 * Arabic, word-boundary matching for short English words.
 */
const KEYWORDS: Record<ObjectionTagKey, { en: string[]; ar: string[] }> = {
  PRICE: {
    en: ["price", "prices", "cost", "costs", "expensive", "how much", "discount", "cheaper", "installment", "installments", "budget", "afford"],
    ar: ["سعر", "السعر", "الاسعار", "الأسعار", "بكام", "بكم", "غالي", "غاليه", "غالية", "خصم", "تكلفة", "تكلفه", "فلوس", "اقساط", "أقساط", "تقسيط", "ارخص", "أرخص", "ميزانية"],
  },
  PAIN: {
    en: ["pain", "painful", "hurt", "hurts", "anesthesia", "anaesthesia", "needle", "needles", "injection hurts", "bleeding"],
    ar: ["بيوجع", "يوجع", "وجع", "ألم", "الم", "موجع", "مؤلم", "بنج", "إبر", "ابر", "الابرة", "الإبرة", "نزيف"],
  },
  DOWNTIME: {
    en: ["downtime", "recovery", "days off", "time off", "swelling", "back to work", "heal", "healing", "redness", "scab", "scabs", "bandage"],
    ar: ["تورم", "ورم", "اجازة", "إجازة", "الشغل", "راحة", "نقاهة", "الشفاء", "هرجع الشغل", "احمرار", "قشور", "قشر", "كام يوم"],
  },
  RESULTS_DOUBT: {
    en: ["does it work", "will it work", "guarantee", "guaranteed", "results", "result", "permanent", "before and after", "effective", "actually work", "side effects"],
    ar: ["ضمان", "مضمون", "مضمونة", "نتيجة", "النتيجة", "نتايج", "النتايج", "نتائج", "هينفع", "ينفع", "بيجيب نتيجة", "دايم", "دائم", "اعراض جانبية", "أعراض جانبية", "قبل وبعد"],
  },
  TRUST: {
    en: ["reviews", "review", "qualified", "certified", "experience", "experienced", "license", "licensed", "real doctor", "trust", "scam", "legit", "credentials", "complaints"],
    ar: ["تقييمات", "تقييم", "خبرة", "خبره", "ثقة", "نصب", "نصابين", "شهادة", "شهادات", "ترخيص", "دكتور بجد", "معتمد", "معتمدة", "شكاوى", "سمعة", "تجارب"],
  },
  TIMING: {
    en: ["later", "next month", "next week", "busy", "not now", "after ramadan", "after eid", "after the summer", "travel", "travelling", "traveling", "think about it", "let me think", "another time", "exams"],
    ar: ["بعدين", "مش دلوقتي", "مش دلوقتى", "الشهر الجاي", "الاسبوع الجاي", "الأسبوع الجاي", "بعد العيد", "بعد رمضان", "رمضان", "مشغول", "مشغولة", "مسافر", "مسافرة", "هفكر", "افكر", "أفكر", "وقت تاني", "بعد الامتحانات", "الصيف"],
  },
};

const ORDER: ObjectionTagKey[] = ["PRICE", "PAIN", "DOWNTIME", "RESULTS_DOUBT", "TRUST", "TIMING"];

function hasEnglishKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(text);
}

/** Objection tags suggested by the wording of `text` (deduplicated, stable order). */
export function tagObjections(text: string | null | undefined): ObjectionTagKey[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Arabic has no case; normalise the common letter variants so one keyword list covers them.
  const arabic = lower.replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "");
  const out: ObjectionTagKey[] = [];
  for (const tag of ORDER) {
    const { en, ar } = KEYWORDS[tag];
    const hit =
      en.some((k) => hasEnglishKeyword(lower, k)) ||
      ar.some((k) => arabic.includes(k.replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")));
    if (hit) out.push(tag);
  }
  return out;
}
