import type { IntakeLanguage } from "@/modules/intake/form";

/**
 * Every string of the public onboarding form, in Arabic and English, kept in
 * one object so the two never drift. Plain module (no "use client") so the
 * server-rendered "link expired" page can use it too.
 */
export interface IntakeCopy {
  dir: "rtl" | "ltr";
  langName: string;
  switchTo: string;
  title: string;
  intro: string;
  stepOf: (n: number, total: number) => string;
  steps: [string, string, string, string, string];
  next: string;
  back: string;
  submit: string;
  sending: string;
  optional: string;
  personal: {
    fullName: string;
    phone: string;
    phoneHint: string;
    whatsappSame: string;
    whatsapp: string;
    dateOfBirth: string;
    gender: string;
    genders: Record<"MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED", string>;
    city: string;
    nationalId: string;
  };
  contact: {
    email: string;
    address: string;
    emergencyTitle: string;
    emergencyHint: string;
    emergencyName: string;
    emergencyPhone: string;
    emergencyRelation: string;
    relationHint: string;
  };
  visit: {
    treatments: string;
    treatmentsHint: string;
    concern: string;
    concernPlaceholder: string;
    sinceWhen: string;
    sinceWhenHint: string;
  };
  history: {
    chronic: string;
    chronicHint: string;
    allergies: string;
    allergiesHint: string;
    medications: string;
    medName: string;
    medDose: string;
    addMedication: string;
    surgeries: string;
    surgeriesHint: string;
    add: string;
    remove: string;
    none: string;
  };
  consent: {
    title: string;
    processing: string;
    processingDetail: string;
    whatsappUpdates: string;
    review: string;
  };
  done: { title: string; body: string; close: string };
  errors: {
    required: string;
    name: string;
    phone: string;
    date: string;
    email: string;
    consent: string;
    generic: string;
    expired: string;
    tooMany: string;
    fix: string;
  };
  expired: { title: string; body: string };
  poweredBy: string;
}

export const INTAKE_COPY: Record<IntakeLanguage, IntakeCopy> = {
  en: {
    dir: "ltr",
    langName: "English",
    switchTo: "العربية",
    title: "Patient onboarding",
    intro: "A few details before your visit — it takes about three minutes.",
    stepOf: (n, total) => `Step ${n} of ${total}`,
    steps: ["Personal", "Contact", "Your visit", "Medical history", "Consent"],
    next: "Next",
    back: "Back",
    submit: "Send the form",
    sending: "Sending…",
    optional: "optional",
    personal: {
      fullName: "Full name",
      phone: "Mobile number",
      phoneHint: "e.g. 010 1234 5678",
      whatsappSame: "My WhatsApp is the same number",
      whatsapp: "WhatsApp number",
      dateOfBirth: "Date of birth",
      gender: "Gender",
      genders: { MALE: "Male", FEMALE: "Female", OTHER: "Other", UNDISCLOSED: "Prefer not to say" },
      city: "City",
      nationalId: "National ID",
    },
    contact: {
      email: "E-mail",
      address: "Address",
      emergencyTitle: "Emergency contact",
      emergencyHint: "Someone we can call if needed.",
      emergencyName: "Name",
      emergencyPhone: "Phone",
      emergencyRelation: "Relationship",
      relationHint: "e.g. spouse, parent, sibling",
    },
    visit: {
      treatments: "What brings you to the clinic?",
      treatmentsHint: "Choose everything that applies.",
      concern: "Tell us more about your concern",
      concernPlaceholder: "e.g. thinning at the crown, acne flare-ups before my period…",
      sinceWhen: "Since when?",
      sinceWhenHint: "e.g. 6 months, two years",
    },
    history: {
      chronic: "Chronic conditions",
      chronicHint: "e.g. diabetes, high blood pressure, thyroid",
      allergies: "Allergies",
      allergiesHint: "medicines, foods, latex…",
      medications: "Current medications",
      medName: "Medication",
      medDose: "Dose",
      addMedication: "Add medication",
      surgeries: "Past surgeries",
      surgeriesHint: "e.g. appendectomy (2019)",
      add: "Add",
      remove: "Remove",
      none: "Nothing added yet.",
    },
    consent: {
      title: "Consent",
      processing: "I agree that the clinic stores and processes the information in this form to prepare and deliver my care.",
      processingDetail: "Your details are seen only by the clinic team and kept in your medical record. You can ask the clinic to correct or delete them at any time.",
      whatsappUpdates: "The clinic may send me appointment reminders and updates on WhatsApp.",
      review: "Please check your answers before sending.",
    },
    done: {
      title: "Thank you!",
      body: "We received your form. The reception team will review it before your visit.",
      close: "You can close this page now.",
    },
    errors: {
      required: "Please fill in this field.",
      name: "Please enter your full name.",
      phone: "Enter a valid mobile number.",
      date: "Enter a valid date in the past.",
      email: "Enter a valid e-mail address.",
      consent: "Consent is required to continue.",
      generic: "Something went wrong. Please try again.",
      expired: "This link has expired or has already been used.",
      tooMany: "Too many attempts. Please wait a few minutes and try again.",
      fix: "Please check the highlighted fields.",
    },
    expired: {
      title: "This link has expired",
      body: "The onboarding link is no longer valid. Please ask the clinic to send you a new one.",
    },
    poweredBy: "Powered by",
  },
  ar: {
    dir: "rtl",
    langName: "العربية",
    switchTo: "English",
    title: "تسجيل مريض جديد",
    intro: "بعض البيانات قبل زيارتك — تستغرق حوالي ثلاث دقائق.",
    stepOf: (n, total) => `الخطوة ${n} من ${total}`,
    steps: ["البيانات الشخصية", "التواصل", "سبب الزيارة", "التاريخ المرضي", "الموافقة"],
    next: "التالي",
    back: "رجوع",
    submit: "إرسال النموذج",
    sending: "جارٍ الإرسال…",
    optional: "اختياري",
    personal: {
      fullName: "الاسم بالكامل",
      phone: "رقم الموبايل",
      // The number sits in a left-to-right isolate (U+2066 … U+2069) so it reads 010 1234 5678, not 5678 1234 010.
      phoneHint: "مثال: \u2066010 1234 5678\u2069",
      whatsappSame: "رقم الواتساب هو نفس الرقم",
      whatsapp: "رقم الواتساب",
      dateOfBirth: "تاريخ الميلاد",
      gender: "النوع",
      genders: { MALE: "ذكر", FEMALE: "أنثى", OTHER: "آخر", UNDISCLOSED: "أفضّل عدم الإفصاح" },
      city: "المدينة",
      nationalId: "الرقم القومي",
    },
    contact: {
      email: "البريد الإلكتروني",
      address: "العنوان",
      emergencyTitle: "جهة اتصال للطوارئ",
      emergencyHint: "شخص يمكننا الاتصال به عند الحاجة.",
      emergencyName: "الاسم",
      emergencyPhone: "رقم الهاتف",
      emergencyRelation: "صلة القرابة",
      relationHint: "مثال: زوج/زوجة، أب/أم، أخ/أخت",
    },
    visit: {
      treatments: "ما سبب زيارتك للعيادة؟",
      treatmentsHint: "اختر كل ما ينطبق.",
      concern: "احكِ لنا أكثر عن شكواك",
      concernPlaceholder: "مثال: خفة الشعر في مقدمة الرأس، ظهور حب الشباب قبل الدورة…",
      sinceWhen: "منذ متى؟",
      sinceWhenHint: "مثال: ٦ شهور، سنتين",
    },
    history: {
      chronic: "الأمراض المزمنة",
      chronicHint: "مثال: السكري، الضغط، الغدة الدرقية",
      allergies: "الحساسية",
      allergiesHint: "أدوية، أطعمة، لاتكس…",
      medications: "الأدوية الحالية",
      medName: "الدواء",
      medDose: "الجرعة",
      addMedication: "إضافة دواء",
      surgeries: "عمليات جراحية سابقة",
      surgeriesHint: "مثال: استئصال الزائدة (٢٠١٩)",
      add: "إضافة",
      remove: "حذف",
      none: "لم يُضف شيء بعد.",
    },
    consent: {
      title: "الموافقة",
      processing: "أوافق على أن تحتفظ العيادة بالبيانات الواردة في هذا النموذج وتعالجها لإعداد رعايتي وتقديمها.",
      processingDetail: "بياناتك يطّلع عليها فريق العيادة فقط وتُحفظ في ملفك الطبي. يمكنك طلب تصحيحها أو حذفها في أي وقت.",
      whatsappUpdates: "يمكن للعيادة إرسال تذكيرات بالمواعيد وتحديثات عبر واتساب.",
      review: "من فضلك راجع إجاباتك قبل الإرسال.",
    },
    done: {
      title: "شكرًا لك!",
      body: "استلمنا النموذج. سيراجعه فريق الاستقبال قبل زيارتك.",
      close: "يمكنك إغلاق هذه الصفحة الآن.",
    },
    errors: {
      required: "من فضلك املأ هذا الحقل.",
      name: "من فضلك أدخل اسمك بالكامل.",
      phone: "أدخل رقم موبايل صحيح.",
      date: "أدخل تاريخًا صحيحًا في الماضي.",
      email: "أدخل بريدًا إلكترونيًا صحيحًا.",
      consent: "الموافقة مطلوبة للمتابعة.",
      generic: "حدث خطأ ما. حاول مرة أخرى.",
      expired: "انتهت صلاحية هذا الرابط أو تم استخدامه من قبل.",
      tooMany: "محاولات كثيرة. انتظر بضع دقائق ثم حاول مرة أخرى.",
      fix: "من فضلك راجع الحقول المحددة.",
    },
    expired: {
      title: "انتهت صلاحية هذا الرابط",
      body: "رابط التسجيل لم يعد صالحًا. من فضلك اطلب رابطًا جديدًا من العيادة.",
    },
    poweredBy: "مقدَّم من",
  },
};

/** Arabic names for the default treatment catalogue; other keys fall back to the clinic's name. */
const TREATMENT_AR: Record<string, string> = {
  "hair-transplant": "زراعة الشعر",
  "prp-hair": "تساقط الشعر / بلازما",
  acne: "علاج حب الشباب",
  pigmentation: "التصبغات / الكلف",
  "laser-hair-removal": "إزالة الشعر بالليزر",
  "botox-fillers": "بوتوكس وفيلر",
  "general-dermatology": "جلدية عامة",
};

export function treatmentLabel(key: string, name: string, language: IntakeLanguage): string {
  return language === "ar" ? (TREATMENT_AR[key] ?? name) : name;
}
