import Link from "next/link";
import { ArrowRight, Check, CheckCheck, MessageCircle, TriangleAlert } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { VisitJourney } from "@/components/landing/visit-journey";

/**
 * The public home page. It makes one offer (the clinic's whole day in one record, with an AI
 * that only speaks from it) and then shows a working day hour by hour, in the product's own
 * interface: each moment is a real piece of a screen with the demo clinic's sample data, not a
 * claim about it. No customer names, figures or testimonials exist, so none appear.
 */
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2">
          {/* Swap the logo by replacing /public/logo.svg */}
          <img src="/logo.svg" alt="" width={28} height={28} className="h-7 w-7 rounded-md" />
          <span className="font-display text-base font-semibold tracking-tight">{BRAND.productName}</span>
        </div>
        <Button asChild variant="outline">
          <Link href="/login">Sign in</Link>
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-5 sm:px-8">
        <section className="pb-14 pt-10 sm:pb-20 sm:pt-16">
          <h1 className="max-w-[22ch] font-display text-[2.5rem] font-semibold leading-[1.05] tracking-[-0.035em] [text-wrap:balance] sm:text-5xl lg:text-[3.75rem]">
            One record of truth for the clinic, with AI that only speaks from it.
          </h1>
          <p className="mt-6 max-w-[58ch] text-base leading-relaxed text-muted-foreground sm:text-lg">
            Patients, appointments, consultations and billing in one place. Every answer the AI gives is taken from your
            own records and says where it came from; every clinical note is reviewed and signed by a clinician.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button asChild size="lg">
              <Link href="/login">
                Sign in to your clinic <ArrowRight />
              </Link>
            </Button>
            <p className="text-sm text-muted-foreground">Access is by invitation from your clinic&apos;s administrator.</p>
          </div>
        </section>

        <section aria-labelledby="day">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border pb-4">
            <h2 id="day" className="font-display text-2xl font-semibold tracking-[-0.02em]">
              A day at the clinic
            </h2>
            <p className="text-sm text-muted-foreground">The screens the staff use, with sample data from the demo clinic.</p>
          </div>

          <ol className="divide-y divide-border">
            <Moment
              time="09:58"
              title="The desk sees who has arrived"
              body="Booked, confirmed, checked in, in consultation, done: every visit shows its step, who is running late and what the patient owes. The next step is one tap."
            >
              <VisitJourney />
            </Moment>

            <Moment
              time="10:20"
              title="The note is drafted; the doctor signs it"
              body="The consultation is dictated in Arabic or English and becomes a structured draft. Medicines are checked against the record. Nothing reaches the patient's file until a clinician signs."
            >
              <Shot label="A consultation draft awaiting signature: the diagnosis and plan, and amoxicillin flagged because a penicillin allergy is on record.">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <p className="text-sm font-medium">Sherif Nabil · draft</p>
                  <Badge tone="warning" dot>
                    Not in the record yet
                  </Badge>
                </div>
                <dl className="space-y-2.5 px-4 py-3 text-sm">
                  <Line term="Diagnosis">Plaque psoriasis, elbows and scalp</Line>
                  <Line term="Plan">Topical calcipotriol with betamethasone for 4 weeks; review in 6 weeks</Line>
                  <Line term="Medicines">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      Amoxicillin 500 mg
                      <Badge tone="danger" className="gap-1">
                        <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                        Penicillin allergy on record
                      </Badge>
                    </span>
                  </Line>
                </dl>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                  <p className="text-xs text-muted-foreground">Dr. Mariam Tarek reviews every line before signing.</p>
                  <FakeButton primary>Sign and save</FakeButton>
                </div>
              </Shot>
            </Moment>

            <Moment
              time="10:41"
              title="The assistant answers from the record, and says where"
              body="Ask about a patient in plain language. The answer points to the visit, result or note it came from. When the record has nothing, it says so."
            >
              <Shot label="A question to the assistant about a patient's last blood test, answered with a citation to the lab result of 12 October 2026.">
                <div className="space-y-3 px-4 py-4 text-sm">
                  <p className="ms-auto w-fit max-w-[85%] rounded-lg bg-accent px-3 py-2 text-accent-foreground">
                    When were Sherif Nabil&apos;s liver tests last done?
                  </p>
                  <div className="max-w-[92%] space-y-2">
                    <p>
                      On 12 October 2026. ALT was 31 U/L and AST 27 U/L, both within range.{" "}
                      <span className="align-super text-xs font-medium text-accent">1</span>
                    </p>
                    <p className="flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
                      <span className="font-medium tabular-nums text-accent">1</span>
                      Lab result · 12 Oct 2026 · ordered by Dr. Mariam Tarek
                    </p>
                  </div>
                </div>
              </Shot>
            </Moment>

            <Moment
              time="10:46"
              title="Every payment is numbered"
              body="Invoices and receipts take the next number when they are issued and are never edited or deleted. A mistake is credited, and the trail stays."
            >
              <Shot label="Invoice ZAM-INV-000204 for 600 Egyptian pounds, paid by card.">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <p className="font-mono text-sm font-medium">ZAM-INV-000204</p>
                  <Badge tone="success" className="gap-1">
                    <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
                    Paid
                  </Badge>
                </div>
                <div className="space-y-2 px-4 py-3 text-sm">
                  <p className="flex items-baseline justify-between gap-4">
                    <span>Psoriasis consultation</span>
                    <span className="whitespace-nowrap tabular-nums">600 EGP</span>
                  </p>
                  <p className="flex items-baseline justify-between gap-4 text-muted-foreground">
                    <span>Card, 10 Nov 2026 at 10:46</span>
                    <span className="whitespace-nowrap tabular-nums">600 EGP</span>
                  </p>
                </div>
              </Shot>
            </Moment>

            <Moment
              time="16:00"
              title="The follow-up is not left to memory"
              body="When a visit is signed, the next one goes onto the desk's call list. Patients get their reminder on WhatsApp, in their own language."
            >
              <Shot label="A recall for the second of three hair-loss sessions, due in 3 days, with the WhatsApp reminder sent in Arabic.">
                <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">Nadine Adel</p>
                    <p className="truncate text-xs text-muted-foreground">Hair loss / PRP · session 2 of 3</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="warning" dot>
                      Due in 3 days
                    </Badge>
                    <FakeButton>Book</FakeButton>
                  </div>
                </div>
                <div className="px-4 py-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MessageCircle className="h-3 w-3" aria-hidden="true" />
                    WhatsApp, sent at 16:00
                  </p>
                  <p dir="rtl" lang="ar" className="w-fit max-w-full rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed">
                    مرحبًا نادين، موعد جلستك الثانية بعد ٣ أيام. هل تودّين تحديد موعد؟
                  </p>
                </div>
              </Shot>
            </Moment>

            <Moment
              time="21:05"
              title="The day closes to the same totals"
              body="The cash in the drawer is counted against the day's receipts. The owner sees the money, the recalls and the no-shows without a second spreadsheet."
            >
              <Shot label="The day close: 12,400 Egyptian pounds counted in the drawer, 12,400 in the books, no difference.">
                <dl className="divide-y divide-border text-sm">
                  <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <dt className="text-muted-foreground">Cash counted</dt>
                    <dd className="tabular-nums">12,400 EGP</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <dt className="text-muted-foreground">Cash in the books</dt>
                    <dd className="tabular-nums">12,400 EGP</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                    <dt className="font-medium">Difference</dt>
                    <dd>
                      <Badge tone="success" className="gap-1">
                        <CheckCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                        None: the drawer matches
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </Shot>
            </Moment>
          </ol>
        </section>

        <section aria-labelledby="care" className="border-t border-border py-14 sm:py-20">
          <h2 id="care" className="max-w-[26ch] font-display text-2xl font-semibold tracking-[-0.02em] [text-wrap:balance] sm:text-3xl">
            Built for what a clinic answers for.
          </h2>
          <dl className="mt-8 grid gap-x-10 gap-y-8 md:grid-cols-3">
            <Fact term="Each clinic is its own space">
              Its own address, name and colours, and its own data: every query is checked against the clinic it belongs to.
            </Fact>
            <Fact term="Each person sees their own work">
              Six roles, from reception to owner. Signing a note, the assistant and the evidence panel are for clinicians only.
            </Fact>
            <Fact term="Every change leaves a record">
              An audit log that can only be added to, kept in the database, with who did what and when.
            </Fact>
          </dl>
          <div className="mt-10">
            <Button asChild size="lg">
              <Link href="/login">
                Sign in to your clinic <ArrowRight />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-muted-foreground sm:px-8">
          <p>{BRAND.productName}</p>
          <Link href="/login" className="underline-offset-4 hover:text-foreground hover:underline">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}

/** One moment of the day: the time, what happens in the clinic's words, and the screen that does it. */
function Moment({ time, title, body, children }: { time: string; title: string; body: string; children: React.ReactNode }) {
  return (
    <li className="grid gap-x-10 gap-y-5 py-10 md:grid-cols-[4.5rem_minmax(0,19rem)_minmax(0,1fr)] lg:gap-x-14">
      <p className="font-display text-2xl font-semibold tabular-nums tracking-[-0.02em] text-muted-foreground">
        <time dateTime={time}>{time}</time>
      </p>
      <div>
        <h3 className="font-display text-xl font-semibold leading-snug tracking-[-0.015em] [text-wrap:balance]">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
      <div className="min-w-0 md:col-span-2 lg:col-span-1">{children}</div>
    </li>
  );
}

/** A piece of a screen shown as a picture: described by its label, inert to the keyboard. */
function Shot({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="img" aria-label={label} className="bento overflow-hidden p-0">
      <div inert>{children}</div>
    </div>
  );
}

function Line({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <dt className="data-label pt-0.5">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A button as the product draws it, for a picture of a screen. */
function FakeButton({ primary = false, children }: { primary?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={
        primary
          ? "inline-flex h-9 items-center whitespace-nowrap rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground"
          : "inline-flex h-8 items-center whitespace-nowrap rounded-lg border border-border bg-card px-3 text-sm font-medium"
      }
    >
      {children}
    </span>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-4">
      <dt className="font-display text-base font-semibold">{term}</dt>
      <dd className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}
