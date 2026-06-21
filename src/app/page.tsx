import Link from "next/link";
import { Activity, ArrowRight, ShieldCheck, Sparkles, Boxes } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-flow text-white">
            <Activity className="h-4 w-4" />
          </div>
          <span className="font-display text-base font-semibold tracking-tight">
            {BRAND.productName}
          </span>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard">
            Open Console <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="mesh rounded-lg border border-border py-20 text-center">
          <Badge tone="accent" className="mx-auto mb-6">
            Medical AI OS · Multi-tenant
          </Badge>
          <h1 className="mx-auto max-w-3xl font-display text-5xl font-semibold leading-[1.05] tracking-tightest">
            The AI-first operating system for clinics.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
            {BRAND.tagline} ClinicMind runs as a tab inside the GROW Engine and embeds on any
            client's own domain — each clinic gets its own isolated, white-labeled instance.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/dashboard">
                Launch dashboard <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>

        <section className="my-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Feature
            icon={Sparkles}
            title="AI, grounded"
            body="Doctor chat, consultation intelligence and receptionist agents — every answer retrieval-grounded with citations."
          />
          <Feature
            icon={Boxes}
            title="Truly multi-tenant"
            body="Custom domains, per-tenant branding and an isolated data boundary. One platform, many clinics."
          />
          <Feature
            icon={ShieldCheck}
            title="Built for trust"
            body="RBAC, immutable audit, soft delete and review-before-sign on every clinical decision."
          />
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-center">
        <p className="font-mono text-xs text-muted-foreground">
          {BRAND.productName} — a GROW Engine tool · Institutional Tech
        </p>
      </footer>
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Sparkles;
  title: string;
  body: string;
}) {
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
