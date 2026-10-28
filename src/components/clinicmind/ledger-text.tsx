import { describeEntry, type LedgerEntry, type LedgerLanguage } from "@/modules/finance/ledger-copy";

/**
 * A ledger line's wording. Names, numbers and English text sit in their own
 * <bdi>, so an Arabic statement keeps "ZAM-INV-000042" and "Laser hair
 * removal" in one piece and in order.
 */
export function LedgerText({ entry, language = "en" }: { entry: Parameters<typeof describeEntry>[0]; language?: LedgerLanguage }) {
  return (
    <>
      {describeEntry(entry, language).map((p, i) =>
        p.iso ? (
          <bdi key={i} dir={p.iso === "ltr" ? "ltr" : undefined} className={p.iso === "ltr" ? "whitespace-nowrap" : undefined}>
            {p.t}
          </bdi>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </>
  );
}

export type { LedgerEntry };
