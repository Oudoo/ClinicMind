import Link from "next/link";
import { ArrowRight, ShieldCheck, Sparkles, CalendarDays, Users, Stethoscope, LockKeyhole } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          {/* Swap the logo by replacing /public/logo.svg */}
          <img src="/logo.svg" alt="" width={28} height={28} className="h-7 w-7 rounded-md" />
          <span className="font-display text-base font-semibold tracking-tight">{BRAND.productName}</span>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/login">
            Sign in <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="mesh rounded-lg border border-border px-6 py-16 text-center sm:py-20">
          <Badge tone="accent" className="mx-auto mb-6">
            Clinic operating system · AI-first
          </Badge>
          <h1 className="mx-auto max-w-3xl font-display text-4xl font-semibold leading-[1.05] tracking-tightest sm:text-5xl">
            One record of truth for the clinic, with AI that only speaks from it.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
            Patients, appointments and consultations in one place. Every AI answer is grounded in your
            own records and cited; every clinical decision is reviewed and signed by a clinician.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/login">
                Sign in to your clinic <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>

        <section className="my-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Feature
            icon={Users}
            title="Patients and timeline"
            body="A complete patient record: history, allergies, medications, visits and every interaction on one chronological timeline."
          />
          <Feature
            icon={CalendarDays}
            title="Scheduling that holds"
            body="Booking with conflict detection, waitlists and a full lifecycle from confirmation to check-in, completion or no-show."
          />
          <Feature
            icon={Stethoscope}
            title="Consultation intelligence"
            body="Transcripts become structured notes. The clinician edits, reconciles medications and signs; nothing is saved by the AI alone."
          />
          <Feature
            icon={Sparkles}
            title="Grounded assistant"
            body="Ask about your patients in plain language and get answers with citations into the record, or a clear “no records found”."
          />
          <Feature
            icon={ShieldCheck}
            title="Built for accountability"
            body="Roles for every staff member, an append-only audit log enforced in the database, and review-before-sign everywhere."
          />
          <Feature
            icon={LockKeyhole}
            title="Isolated per clinic"
            body="Each clinic runs its own white-labeled instance on its own domain, with data scoped and checked at every query."
          />
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-center">
        <p className="font-mono text-xs text-muted-foreground">{BRAND.productName}</p>
      </footer>
    </div>
  );
}

function Feature({ icon: Icon, title, body }: { icon: typeof Sparkles; title: string; body: string }) {
  return (
    <div className="bento">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-accent-muted text-accent">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
