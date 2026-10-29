import type { QuoteLanguage, QuoteState } from "./constants";

/**
 * Every word of a quote the patient sees — the printed or online copy, the
 * page where they accept it and the WhatsApp message that links to it — in
 * Arabic and English, kept in one object so the two never drift. No server
 * imports: the patient's page and the document use it.
 */
export interface QuoteCopy {
  dir: "rtl" | "ltr";
  locale: string;
  title: string;
  draft: string;
  number: string;
  date: string;
  validUntil: string;
  preparedFor: string;
  doctor: string;
  branch: string;
  phase: (n: number) => string;
  treatment: string;
  amount: string;
  phaseTotal: string;
  beforeDiscounts: string;
  discounts: string;
  total: string;
  discount: (amount: string) => string;
  sessions: (n: number) => string;
  quantity: (n: string, unit: string) => string;
  terms: (date: string) => string;
  signature: string;
  signatureDate: string;
  accepted: (name: string, date: string, via: "clinic" | "link") => string;
  acceptedTotal: string;
  itemAccepted: string;
  notAccepted: string;
  declined: (date: string) => string;
  withdrawn: (date: string) => string;
  expired: (date: string) => string;
  state: Record<QuoteState, string>;
  thanks: string;
  print: string;
  form: {
    title: string;
    intro: string;
    choose: string;
    chooseHint: string;
    name: string;
    sign: string;
    signHint: string;
    clear: string;
    agree: (total: string) => string;
    accept: string;
    sending: string;
    declineOpen: string;
    declineTitle: string;
    declineReason: string;
    decline: string;
    back: string;
  };
  done: {
    accepted: { title: string; body: string };
    declined: { title: string; body: string };
  };
  closed: { expired: (date: string) => string; withdrawn: string; declined: string };
  errors: { items: string; name: string; signature: string; agree: string; generic: string; closed: string; tooMany: string };
  /** The link's own page when the link no longer works. */
  gone: { title: string; body: string };
}

const arabicSessions = (n: number) => (n === 1 ? "جلسة واحدة" : n === 2 ? "جلستان" : n <= 10 ? `${n} جلسات` : `${n} جلسة`);

export const QUOTE_COPY: Record<QuoteLanguage, QuoteCopy> = {
  en: {
    dir: "ltr",
    locale: "en-GB",
    title: "Treatment plan and quote",
    draft: "Draft — not given to the patient yet",
    number: "Quote no.",
    date: "Date",
    validUntil: "Valid until",
    preparedFor: "Prepared for",
    doctor: "Doctor",
    branch: "Branch",
    phase: (n) => `Phase ${n}`,
    treatment: "Treatment",
    amount: "Amount (EGP)",
    phaseTotal: "Phase total",
    beforeDiscounts: "Before discounts",
    discounts: "Discounts",
    total: "Total",
    discount: (amount) => `${amount} off`,
    sessions: (n) => (n === 1 ? "1 session" : `${n} sessions`),
    quantity: (n, unit) => `${n} ${unit}`,
    terms: (date) => `These prices hold until ${date}. Each treatment is charged when it is done; the sessions of a course are charged one by one, as each is done.`,
    signature: "Patient's signature",
    signatureDate: "Date",
    accepted: (name, date, via) => `Accepted by ${name} on ${date}${via === "clinic" ? ", signed at the clinic" : ", signed online"}`,
    acceptedTotal: "Accepted",
    itemAccepted: "Accepted",
    notAccepted: "Not accepted",
    declined: (date) => `Declined on ${date}`,
    withdrawn: (date) => `Withdrawn by the clinic on ${date}`,
    expired: (date) => `This quote held until ${date}.`,
    state: { DRAFT: "Draft", SENT: "Open", EXPIRED: "Expired", ACCEPTED: "Accepted", DECLINED: "Declined", WITHDRAWN: "Withdrawn" },
    thanks: "Thank you for choosing",
    print: "Print or save as PDF",
    form: {
      title: "Accept your treatment plan",
      intro: "Choose what you accept, type your name and sign. The clinic will call you to book.",
      choose: "What you accept",
      chooseHint: "Everything is ticked: untick what you do not want for now.",
      name: "Your full name",
      sign: "Sign here",
      signHint: "With your finger, or the mouse on a computer.",
      clear: "Clear",
      agree: (total) => `I accept the treatment ticked above, ${total} EGP, at the prices of this quote.`,
      accept: "Accept and sign",
      sending: "Sending…",
      declineOpen: "Not for now? Tell the clinic",
      declineTitle: "Decline this plan",
      declineReason: "Anything you want the clinic to know (optional)",
      decline: "Decline the plan",
      back: "Back",
    },
    done: {
      accepted: { title: "Thank you!", body: "The clinic has your signed plan and will call you to book your first session." },
      declined: { title: "Thank you for letting us know", body: "The clinic keeps your plan; call them whenever you are ready." },
    },
    closed: {
      expired: (date) => `This quote is no longer open: its prices held until ${date}. Ask the clinic for a new one.`,
      withdrawn: "The clinic replaced or withdrew this quote. Ask them for the latest one.",
      declined: "This plan was declined. Call the clinic whenever you want to talk about it again.",
    },
    errors: {
      items: "Choose at least one treatment.",
      name: "Type your full name.",
      signature: "Sign in the box: a little more than a dot.",
      agree: "Tick the box to accept.",
      generic: "Something went wrong. Please try again.",
      closed: "This quote is no longer open.",
      tooMany: "Too many attempts. Please wait a few minutes and try again.",
    },
    gone: { title: "This link no longer works", body: "Ask the clinic to send the treatment plan again." },
  },
  ar: {
    dir: "rtl",
    locale: "ar-EG-u-nu-latn",
    title: "خطة العلاج وعرض السعر",
    draft: "مسودة — لم تُسلَّم للمريض بعد",
    number: "رقم العرض",
    date: "التاريخ",
    validUntil: "ساري حتى",
    preparedFor: "مُعَدّ لـ",
    doctor: "الطبيب",
    branch: "الفرع",
    phase: (n) => `المرحلة ${n}`,
    treatment: "العلاج",
    amount: "المبلغ (جنيه)",
    phaseTotal: "إجمالي المرحلة",
    beforeDiscounts: "قبل الخصم",
    discounts: "الخصومات",
    total: "الإجمالي",
    discount: (amount) => `خصم ${amount}`,
    sessions: arabicSessions,
    quantity: (n, unit) => `${n} ${unit}`,
    terms: (date) => `هذه الأسعار سارية حتى ${date}. يُحاسَب كل علاج عند إجرائه، وتُحاسَب جلسات الكورس جلسةً بجلسة عند إجراء كل منها.`,
    signature: "توقيع المريض",
    signatureDate: "التاريخ",
    accepted: (name, date, via) => `وافق عليه ${name} في ${date}${via === "clinic" ? "، ووقّع في العيادة" : "، ووقّع إلكترونيًا"}`,
    acceptedTotal: "ما تمت الموافقة عليه",
    itemAccepted: "تمت الموافقة",
    notAccepted: "لم تتم الموافقة عليه",
    declined: (date) => `رُفض في ${date}`,
    withdrawn: (date) => `سحبته العيادة في ${date}`,
    expired: (date) => `كان هذا العرض ساريًا حتى ${date}.`,
    state: { DRAFT: "مسودة", SENT: "ساري", EXPIRED: "منتهي", ACCEPTED: "تمت الموافقة", DECLINED: "مرفوض", WITHDRAWN: "مسحوب" },
    thanks: "شكرًا لاختياركم",
    print: "طباعة أو حفظ PDF",
    form: {
      title: "الموافقة على خطة العلاج",
      intro: "اختر ما توافق عليه، واكتب اسمك ووقّع. ستتصل بك العيادة لحجز موعدك.",
      choose: "ما توافق عليه",
      chooseHint: "كل البنود محددة: أزل التحديد عما لا تريده الآن.",
      name: "اسمك بالكامل",
      sign: "وقّع هنا",
      signHint: "بإصبعك، أو بالماوس على الكمبيوتر.",
      clear: "مسح",
      agree: (total) => `أوافق على العلاج المحدد أعلاه بإجمالي ${total} جنيه وبأسعار هذا العرض.`,
      accept: "موافقة وتوقيع",
      sending: "جارٍ الإرسال…",
      declineOpen: "لا تريده الآن؟ أخبر العيادة",
      declineTitle: "رفض الخطة",
      declineReason: "أي شيء تريد أن تعرفه العيادة (اختياري)",
      decline: "رفض الخطة",
      back: "رجوع",
    },
    done: {
      accepted: { title: "شكرًا لك!", body: "وصلت خطتك الموقّعة إلى العيادة، وسيتصلون بك لحجز أول جلسة." },
      declined: { title: "شكرًا لإخبارنا", body: "تحتفظ العيادة بخطتك؛ اتصل بهم متى كنت مستعدًا." },
    },
    closed: {
      expired: (date) => `هذا العرض لم يعد ساريًا: كانت أسعاره سارية حتى ${date}. اطلب من العيادة عرضًا جديدًا.`,
      withdrawn: "استبدلت العيادة هذا العرض أو سحبته. اطلب منهم أحدث عرض.",
      declined: "تم رفض هذه الخطة. اتصل بالعيادة متى أردت الحديث عنها مرة أخرى.",
    },
    errors: {
      items: "اختر علاجًا واحدًا على الأقل.",
      name: "اكتب اسمك بالكامل.",
      signature: "وقّع داخل المربع: أكثر من مجرد نقطة.",
      agree: "ضع علامة في المربع للموافقة.",
      generic: "حدث خطأ ما. حاول مرة أخرى.",
      closed: "هذا العرض لم يعد ساريًا.",
      tooMany: "محاولات كثيرة. انتظر بضع دقائق ثم حاول مرة أخرى.",
    },
    gone: { title: "هذا الرابط لم يعد يعمل", body: "اطلب من العيادة إرسال خطة العلاج مرة أخرى." },
  },
};

/** The units of the price list, as a quote prints them after a quantity ("2,400 grafts", "3 areas"). */
export function unitWord(unit: string, unitLabel: string | null, n: number, language: QuoteLanguage): string {
  if (language === "ar") {
    if (unit === "UNIT" && unitLabel) return unitLabel;
    return ({ AREA: "منطقة", SESSION: "جلسة", TOOTH: "سن", ARCH: "فك", UNIT: "وحدة" } as Record<string, string>)[unit] ?? "";
  }
  const one = unit === "UNIT" && unitLabel ? unitLabel : (({ AREA: "area", SESSION: "session", TOOTH: "tooth", ARCH: "arch", UNIT: "unit" } as Record<string, string>)[unit] ?? "");
  if (n === 1 || !one) return one;
  return one === "tooth" ? "teeth" : one.endsWith("s") ? one : `${one}s`;
}
