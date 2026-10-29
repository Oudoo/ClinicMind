/**
 * The reply templates every clinic starts with (booking confirmation, price
 * reply, follow-up nudge, intake link, and the recall messages; Arabic and
 * English). Pure data so the seed can import it without the server stack;
 * owners edit them in Settings. A recall message's {{treatment}} and {{date}}
 * are what it is for and when it is due, in the patient's language
 * (modules/recalls/messages.ts).
 */
export interface DefaultTemplate {
  key: string;
  name: string;
  language: "ar" | "en";
  category: string;
  body: string;
}

/** The templates every demo clinic starts with (seeded; owners edit them). */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    key: "booking-confirmation-ar",
    name: "Booking confirmation (AR)",
    language: "ar",
    category: "booking",
    body: "أهلاً {{name}} 👋 تم تأكيد حجزك في {{clinic}} مع {{doctor}} يوم {{date}}. لو احتجت تغيير الميعاد ابعتلنا هنا وإحنا نظبطه.",
  },
  {
    key: "booking-confirmation-en",
    name: "Booking confirmation (EN)",
    language: "en",
    category: "booking",
    body: "Hi {{name}}, your appointment at {{clinic}} with {{doctor}} is confirmed for {{date}}. Reply here if you need to change the time.",
  },
  {
    key: "price-reply-ar",
    name: "Price reply (AR)",
    language: "ar",
    category: "price",
    body: "أهلاً {{name}} 🌿 السعر النهائي بيتحدد بعد الكشف لأنه بيعتمد على حالتك، لكن نقدر نبعتلك نطاق الأسعار دلوقتي. تحب نحجزلك استشارة مع {{doctor}}؟",
  },
  {
    key: "price-reply-en",
    name: "Price reply (EN)",
    language: "en",
    category: "price",
    body: "Hi {{name}}, the final price is confirmed at the consultation because it depends on your case, but we can share the price range now. Shall we book you a consultation with {{doctor}}?",
  },
  {
    key: "follow-up-nudge-ar",
    name: "Follow-up nudge (AR)",
    language: "ar",
    category: "follow-up",
    body: "أهلاً {{name}}، معاك {{clinic}}. حابين نطمن إن كل حاجة واضحة بخصوص استفسارك. لو عندك أي سؤال أو حابب تحجز، إحنا هنا 🙏",
  },
  {
    key: "follow-up-nudge-en",
    name: "Follow-up nudge (EN)",
    language: "en",
    category: "follow-up",
    body: "Hi {{name}}, this is {{clinic}}. Just checking whether you have any questions about your enquiry — happy to help or to book you in whenever suits you.",
  },
  {
    key: "intake-link-ar",
    name: "Intake link (AR)",
    language: "ar",
    category: "intake",
    body: "أهلاً {{name}} 🙌 قبل زيارتك يوم {{date}}، من فضلك املأ نموذج البيانات من هنا: {{link}} — بياخد دقيقتين وبيوفر وقتك في العيادة.",
  },
  {
    key: "intake-link-en",
    name: "Intake link (EN)",
    language: "en",
    category: "intake",
    body: "Hi {{name}}, before your visit on {{date}} please fill in your details here: {{link}} — it takes two minutes and saves time at the clinic.",
  },
  {
    key: "recall-review-ar",
    name: "Recall: review (AR)",
    language: "ar",
    category: "recall",
    body: "أهلاً {{name}}، معاك {{clinic}}. ميعاد {{treatment}} {{date}}. ابعتلنا اليوم اللي يناسبك وإحنا نحجزلك 🌿",
  },
  {
    key: "recall-review-en",
    name: "Recall: review (EN)",
    language: "en",
    category: "recall",
    body: "Hi {{name}}, this is {{clinic}}. Your {{treatment}} is due {{date}}. Reply here with a day that suits you and we'll book you in.",
  },
  {
    key: "recall-session-ar",
    name: "Recall: next session (AR)",
    language: "ar",
    category: "recall",
    body: "أهلاً {{name}}، معاك {{clinic}}. ميعاد {{treatment}} {{date}}. ابعتلنا اليوم والوقت المناسبين ونحجزهولك.",
  },
  {
    key: "recall-session-en",
    name: "Recall: next session (EN)",
    language: "en",
    category: "recall",
    body: "Hi {{name}}, this is {{clinic}}. Your {{treatment}} is due {{date}}. Reply with a day and time that suit you and we'll book it.",
  },
  {
    key: "recall-unbooked-ar",
    name: "Recall: treatment not booked (AR)",
    language: "ar",
    category: "recall",
    body: "أهلاً {{name}}، معاك {{clinic}}. لسه ما حجزناش {{treatment}}. تحب نشوفلك ميعاد مناسب؟ ابعتلنا هنا.",
  },
  {
    key: "recall-unbooked-en",
    name: "Recall: treatment not booked (EN)",
    language: "en",
    category: "recall",
    body: "Hi {{name}}, this is {{clinic}}. Your {{treatment}} isn't booked yet. Shall we find you a time? Just reply here.",
  },
  {
    key: "recall-missed-ar",
    name: "Recall: missed visit (AR)",
    language: "ar",
    category: "recall",
    body: "أهلاً {{name}}، معاك {{clinic}}. افتقدناك {{date}}. تحب نحجزلك ميعاد تاني؟ ابعتلنا هنا ونرتبه.",
  },
  {
    key: "recall-missed-en",
    name: "Recall: missed visit (EN)",
    language: "en",
    category: "recall",
    body: "Hi {{name}}, this is {{clinic}}. We missed you {{date}}. Shall we book you another time? Reply here and we'll arrange it.",
  },
  {
    key: "recall-lapsed-ar",
    name: "Recall: no visit in a while (AR)",
    language: "ar",
    category: "recall",
    body: "أهلاً {{name}}، بقالك فترة ما زرتناش في {{clinic}}. لو حابب تيجي للمتابعة ابعتلنا هنا ونحجزلك ميعاد.",
  },
  {
    key: "recall-lapsed-en",
    name: "Recall: no visit in a while (EN)",
    language: "en",
    category: "recall",
    body: "Hi {{name}}, it's been a while since your last visit to {{clinic}}. If you'd like a check-up, reply here and we'll find you a time.",
  },
];
