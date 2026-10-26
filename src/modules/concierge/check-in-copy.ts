import type { Language } from "./protocols";

/**
 * Patient-facing strings of the public check-in page, Egyptian Arabic and
 * English. Pure values (the page and its client form both read them).
 */
export interface CheckInCopy {
  dir: "rtl" | "ltr";
  title: string;
  switchTo: string;
  greeting: (name: string) => string;
  intro: string;
  late: string;
  required: string;
  optional: string;
  scaleHint: string;
  scaleNotAnswered: string;
  yes: string;
  no: string;
  numberPlaceholder: string;
  satisfaction: string;
  stars: (n: number) => string;
  photosTitle: string;
  photosHint: string;
  extraPhoto: string;
  takePhoto: string;
  retake: string;
  remove: string;
  preparing: string;
  freeText: string;
  freeTextHint: string;
  submit: string;
  sending: string;
  privacy: string;
  errors: {
    required: string;
    satisfaction: string;
    photos: string;
    fix: string;
    photoRead: string;
    photoTooLarge: string;
    tooLarge: string;
    tooMany: string;
    generic: string;
    offline: string;
  };
  done: {
    title: string;
    ok: string;
    watch: string;
    urgentTitle: string;
    urgent: (minutes: number) => string;
    callNow: string;
    noPhone: string;
    emergency: string;
    close: string;
  };
  expired: { title: string; body: string };
  poweredBy: string;
}

export const CHECK_IN_COPY: Record<Language, CheckInCopy> = {
  ar: {
    dir: "rtl",
    title: "متابعة بعد الجلسة",
    switchTo: "English",
    greeting: (name) => `أهلاً ${name} 👋`,
    intro: "جاوب على الأسئلة دي عشان الدكتور وفريق التمريض يطمّنوا عليك. مش هتاخد أكتر من دقيقة.",
    late: "الرسالة دي عدّى عليها وقت، بس إجاباتك لسه مهمة لينا.",
    required: "مطلوب",
    optional: "اختياري",
    scaleHint: "حرّك أو اضغط على الشريط",
    scaleNotAnswered: "لسه ما اخترتش",
    yes: "أيوه",
    no: "لأ",
    numberPlaceholder: "اكتب رقم",
    satisfaction: "قد إيه إنت راضي عن الرعاية لحد دلوقتي؟",
    stars: (n) => `${n} من ٥`,
    photosTitle: "الصور",
    photosHint: "في نور النهار، من غير كاب ولا فلاتر. الصور بتتحفظ في ملفك عند الدكتور بس.",
    extraPhoto: "عايز تبعت صورة؟",
    takePhoto: "صوّر",
    retake: "صوّر تاني",
    remove: "شيل الصورة",
    preparing: "بنجهز الصورة…",
    freeText: "في حاجة تانية حابب تقولها؟",
    freeTextHint: "مثلاً: نزيف، سخونية، ألم جامد، أي حاجة قلقاك.",
    submit: "ابعت الإجابات",
    sending: "بيتبعت…",
    privacy: "إجاباتك بتروح للعيادة بس.",
    errors: {
      required: "جاوب على السؤال ده",
      satisfaction: "اختار من نجمة لخمس نجوم",
      photos: "ضيف صورة واحدة على الأقل",
      fix: "راجع الأسئلة اللي متعلّم عليها بالأحمر.",
      photoRead: "مش قادرين نقرا الصورة دي. صوّرها تاني بالكاميرا.",
      photoTooLarge: "الصورة دي كبيرة قوي. صوّرها تاني.",
      tooLarge: "الصور كبيرة على بعض. جرّب صور أقل.",
      tooMany: "محاولات كتير. استنى دقيقة وجرّب تاني.",
      generic: "حصلت مشكلة. جرّب تاني بعد شوية.",
      offline: "مفيش إنترنت. اتأكد من الاتصال وجرّب تاني.",
    },
    done: {
      title: "شكراً!",
      ok: "وصلتنا إجاباتك، وكل حاجة ماشية زي ما متوقع. هنبعتلك المتابعة الجاية في ميعادها.",
      watch: "وصلتنا إجاباتك. حد من فريق التمريض هيراجعها النهارده ويكلمك لو محتاج.",
      urgentTitle: "إجاباتك محتاجة متابعة دلوقتي",
      urgent: (minutes) => `حد من العيادة هيكلمك خلال ${minutes} دقيقة. خلّي تليفونك جنبك.`,
      callNow: "لو حاسس إنك أسوأ، كلّمنا دلوقتي:",
      noPhone: "لو حاسس إنك أسوأ، كلّم العيادة دلوقتي.",
      emergency: "لو صعب تتنفس أو النزيف ما بيقفش، روح أقرب طوارئ فوراً.",
      close: "تقدر تقفل الصفحة دي.",
    },
    expired: {
      title: "الرابط ده مش شغال",
      body: "يمكن يكون اتستخدم قبل كده أو انتهت صلاحيته. لو العيادة بعتتلك رسالة أحدث، افتح الرابط اللي فيها. ولو محتاج أي حاجة كلّم العيادة.",
    },
    poweredBy: "بواسطة",
  },
  en: {
    dir: "ltr",
    title: "Your follow-up",
    switchTo: "عربي",
    greeting: (name) => `Hi ${name},`,
    intro: "Answer these questions so the doctor and the nursing team can keep an eye on you. It takes about a minute.",
    late: "This check-in is a little late, but your answers still matter to us.",
    required: "required",
    optional: "optional",
    scaleHint: "Slide or tap the bar",
    scaleNotAnswered: "Not answered yet",
    yes: "Yes",
    no: "No",
    numberPlaceholder: "Type a number",
    satisfaction: "How satisfied are you with your care so far?",
    stars: (n) => `${n} of 5`,
    photosTitle: "Photos",
    photosHint: "In daylight, without a cap or filters. Photos go into your file for the doctor only.",
    extraPhoto: "Want to add a photo?",
    takePhoto: "Take photo",
    retake: "Retake",
    remove: "Remove photo",
    preparing: "Preparing the photo…",
    freeText: "Anything else you would like to tell us?",
    freeTextHint: "For example: bleeding, fever, strong pain, anything that worries you.",
    submit: "Send my answers",
    sending: "Sending…",
    privacy: "Your answers go to the clinic only.",
    errors: {
      required: "Please answer this question",
      satisfaction: "Choose 1 to 5 stars",
      photos: "Add at least one photo",
      fix: "Please check the questions marked in red.",
      photoRead: "We could not read this photo. Please take it again with the camera.",
      photoTooLarge: "This photo is too large. Please take it again.",
      tooLarge: "The photos are too large together. Try fewer photos.",
      tooMany: "Too many attempts. Please wait a minute and try again.",
      generic: "Something went wrong. Please try again in a moment.",
      offline: "No connection. Check your internet and try again.",
    },
    done: {
      title: "Thank you!",
      ok: "We have your answers and everything looks as expected. Your next check-in arrives on schedule.",
      watch: "We have your answers. A nurse will review them today and contact you if needed.",
      urgentTitle: "Your answers need attention now",
      urgent: (minutes) => `Someone from the clinic will call you within ${minutes} minutes. Please keep your phone close.`,
      callNow: "If you feel worse, call us now:",
      noPhone: "If you feel worse, call the clinic now.",
      emergency: "If you find it hard to breathe or bleeding does not stop, go to the nearest emergency department now.",
      close: "You can close this page.",
    },
    expired: {
      title: "This link is no longer active",
      body: "It may have been used already, or it has expired. If the clinic sent you a newer message, open the link in that one. If you need anything, call the clinic.",
    },
    poweredBy: "Powered by",
  },
};
