/**
 * The words of the patient's account, on screen and on the printed statement,
 * in English and Arabic. Client-safe: no server imports.
 */

export type LedgerLanguage = "en" | "ar";

/** How a family member is related to the head of the household. */
export const RELATIONS = ["SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"] as const;
export type RelationValue = (typeof RELATIONS)[number];

export const RELATION_LABELS: Record<LedgerLanguage, Record<RelationValue, string>> = {
  en: { SPOUSE: "Spouse", CHILD: "Child", PARENT: "Parent", SIBLING: "Sibling", OTHER: "Other family" },
  ar: { SPOUSE: "زوج/زوجة", CHILD: "ابن/ابنة", PARENT: "والد/والدة", SIBLING: "أخ/أخت", OTHER: "قريب" },
};

export const relationLabel = (relation: string | null | undefined, language: LedgerLanguage = "en"): string | null =>
  relation && (RELATIONS as readonly string[]).includes(relation) ? RELATION_LABELS[language][relation as RelationValue] : null;

/** What moved the balance: work charged (or reversed), money in or out, or money a family member put in. */
export const LEDGER_KINDS = ["CHARGE", "REVERSAL", "NO_CHARGE", "DISCOUNT", "CONSULTATION_FEE", "PAYMENT", "DEPOSIT", "REFUND", "WRITE_OFF", "PAID_BY", "PAID_FOR"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerEntry {
  /** `charge:…`, `payment:…` or `transfer:…`: stable across reads. */
  id: string;
  at: string;
  kind: LedgerKind;
  /** Whose account the line is on (a family statement holds several). */
  patientId: string;
  patientName: string;
  /** The receipt or refund voucher number; for a charge, the invoice that bills it. */
  reference: string | null;
  /** A charge's own wording. */
  description: string | null;
  method: string | null;
  /** The procedure a payment went towards. */
  towards: string | null;
  /** A refund's reason, or a write-off's words. */
  note: string | null;
  /** A discount's or a write-off's reason (a key of the fixed list). */
  reason: string | null;
  /** Who paid for this patient, or whom this patient paid for. */
  counterpart: string | null;
  invoiceNumber: string | null;
  /** Adds to what is owed. */
  debit: number;
  /** Takes off what is owed. */
  credit: number;
  /** Owed after this line; negative is credit. */
  balance: number;
}

export const METHOD_WORDS: Record<LedgerLanguage, Record<string, string>> = {
  en: { CASH: "Cash", CARD: "Card", BANK_TRANSFER: "Bank transfer", WALLET: "Wallet", POS: "Card machine", INSTAPAY: "InstaPay", CHEQUE: "Cheque", OTHER: "Other" },
  ar: { CASH: "نقدًا", CARD: "بطاقة", BANK_TRANSFER: "تحويل بنكي", WALLET: "محفظة إلكترونية", POS: "ماكينة دفع", INSTAPAY: "إنستاباي", CHEQUE: "شيك", OTHER: "أخرى" },
};

/** The reasons of the fixed lists, as a statement says them. */
export const DISCOUNT_WORDS: Record<LedgerLanguage, Record<string, string>> = {
  en: { LOYALTY: "returning patient", FAMILY: "family of a patient", STAFF: "staff", PROMOTION: "campaign offer", PACKAGE: "package price", GOODWILL: "goodwill", DOCTOR: "the doctor's decision", OTHER: "another reason" },
  ar: { LOYALTY: "عميل دائم", FAMILY: "قريب لمريض", STAFF: "موظف أو قريب لموظف", PROMOTION: "عرض", PACKAGE: "سعر باقة", GOODWILL: "تقديرًا للمريض", DOCTOR: "بقرار الطبيب", OTHER: "سبب آخر" },
};
export const WRITE_OFF_WORDS: Record<LedgerLanguage, Record<string, string>> = {
  en: { BAD_DEBT: "bad debt", SMALL_BALANCE: "too small to chase", DISPUTE: "a dispute settled", GOODWILL: "goodwill", DECEASED: "the patient has died", OTHER: "another reason" },
  ar: { BAD_DEBT: "دين معدوم", SMALL_BALANCE: "مبلغ صغير", DISPUTE: "تسوية خلاف", GOODWILL: "تقديرًا للمريض", DECEASED: "وفاة المريض", OTHER: "سبب آخر" },
};

/** A piece of a line's wording; `iso` pieces (names, numbers, English text) keep their own direction. */
export interface Part {
  t: string;
  iso?: "auto" | "ltr";
}

const KIND_WORDS: Record<LedgerLanguage, Record<"CONSULTATION_FEE" | "PAYMENT" | "DEPOSIT" | "REFUND", string>> = {
  en: { CONSULTATION_FEE: "Consultation fee", PAYMENT: "Payment", DEPOSIT: "Deposit", REFUND: "Refund" },
  ar: { CONSULTATION_FEE: "رسوم كشف", PAYMENT: "دفعة", DEPOSIT: "عربون", REFUND: "استرداد" },
};

/** The line's wording in the language asked for. */
export function describeEntry(e: Pick<LedgerEntry, "kind" | "description" | "method" | "towards" | "note" | "counterpart" | "invoiceNumber"> & { reason?: string | null }, language: LedgerLanguage = "en"): Part[] {
  const ar = language === "ar";
  const sep: Part = { t: " · " };
  const method = e.method ? (METHOD_WORDS[language][e.method] ?? e.method) : null;
  switch (e.kind) {
    case "CHARGE":
    case "NO_CHARGE":
      return [{ t: e.description ?? "", iso: "auto" }];
    case "REVERSAL": {
      const what = (e.description ?? "").replace(/^Reversed:\s*/, "");
      return ar ? [{ t: "إلغاء: " }, { t: what, iso: "auto" }] : [{ t: "Reversed: " }, { t: what, iso: "auto" }];
    }
    case "DISCOUNT": {
      // Stored in English, as the invoice line reads ("Discount (returning patient): Acne treatment").
      if (!ar) return [{ t: e.description ?? "", iso: "auto" }];
      const what = (e.description ?? "").replace(/^Discount \([^)]*\):\s*/, "");
      return [{ t: `خصم (${DISCOUNT_WORDS.ar[e.reason ?? ""] ?? DISCOUNT_WORDS.ar.OTHER}): ` }, { t: what, iso: "auto" }];
    }
    case "WRITE_OFF": {
      const why = WRITE_OFF_WORDS[language][e.reason ?? ""] ?? WRITE_OFF_WORDS[language].OTHER!;
      return ar
        ? [{ t: `شطب (${why}): الفاتورة ` }, { t: e.invoiceNumber ?? "", iso: "ltr" }]
        : [{ t: `Written off (${why}): invoice ` }, { t: e.invoiceNumber ?? "", iso: "ltr" }];
    }
    case "CONSULTATION_FEE":
    case "PAYMENT":
    case "DEPOSIT":
    case "REFUND": {
      const parts: Part[] = [{ t: KIND_WORDS[language][e.kind] }];
      if (method) parts.push(sep, { t: method });
      if (e.towards) parts.push(sep, { t: ar ? "عن " : "towards " }, { t: e.towards, iso: "auto" });
      if (e.kind === "REFUND" && e.note) parts.push(sep, { t: e.note, iso: "auto" });
      return parts;
    }
    case "PAID_BY":
      return ar
        ? [{ t: "دفعها " }, { t: e.counterpart ?? "", iso: "auto" }, { t: " عن الفاتورة " }, { t: e.invoiceNumber ?? "", iso: "ltr" }]
        : [{ t: "Paid by " }, { t: e.counterpart ?? "", iso: "auto" }, { t: " on invoice " }, { t: e.invoiceNumber ?? "", iso: "ltr" }];
    case "PAID_FOR":
      return ar
        ? [{ t: "دفعت عن " }, { t: e.counterpart ?? "", iso: "auto" }, { t: ": الفاتورة " }, { t: e.invoiceNumber ?? "", iso: "ltr" }]
        : [{ t: "Paid for " }, { t: e.counterpart ?? "", iso: "auto" }, { t: ": invoice " }, { t: e.invoiceNumber ?? "", iso: "ltr" }];
  }
}

/** The line's wording as plain text (English screens, tests). */
export const entryText = (e: Parameters<typeof describeEntry>[0], language: LedgerLanguage = "en") =>
  describeEntry(e, language)
    .map((p) => p.t)
    .join("");

/** "Owes 2,400 EGP", "In credit 600 EGP" or "Settled". */
export function balanceWords(balance: number, language: LedgerLanguage = "en"): string {
  const n = Math.abs(balance).toLocaleString("en-US");
  if (language === "ar") return balance > 0 ? `مستحق ${n} جنيه` : balance < 0 ? `رصيد دائن ${n} جنيه` : "لا يوجد مستحق";
  return balance > 0 ? `Owes ${n} EGP` : balance < 0 ? `In credit ${n} EGP` : "Settled";
}
