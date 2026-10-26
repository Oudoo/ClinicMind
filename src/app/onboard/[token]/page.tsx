import type { Metadata } from "next";
import { headers } from "next/headers";
import { Clock } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { getPublicIntake } from "@/modules/intake/service";
import { IntakeForm } from "@/components/clinicmind/intake-form";
import { INTAKE_COPY } from "@/components/clinicmind/intake-copy";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Onboarding form",
  robots: { index: false, follow: false },
};

/**
 * `/onboard/[token]` — the patient-facing onboarding form behind a shareable
 * link. No dashboard shell and no session: the token in the URL is the only
 * credential, resolved server-side (hash lookup) so a dead link renders a
 * readable "expired" page instead of an empty form.
 */
export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const headerStore = await headers();
  const intake = await getPublicIntake(token, { host: headerStore.get("x-forwarded-host") ?? headerStore.get("host") });
  if (!intake) return <ExpiredLink />;
  return <IntakeForm token={token} intake={intake} />;
}

function ExpiredLink() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="bento w-full max-w-md space-y-5 text-center">
        <Clock className="mx-auto h-10 w-10 text-warning" aria-hidden="true" />
        <section dir="rtl" lang="ar" className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">{INTAKE_COPY.ar.expired.title}</h1>
          <p className="text-sm text-muted-foreground">{INTAKE_COPY.ar.expired.body}</p>
        </section>
        <hr className="border-border" />
        <section dir="ltr" lang="en" className="space-y-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">{INTAKE_COPY.en.expired.title}</h2>
          <p className="text-sm text-muted-foreground">{INTAKE_COPY.en.expired.body}</p>
        </section>
        <p className="text-xs text-muted-foreground">
          {INTAKE_COPY.en.poweredBy} {BRAND.productName}
        </p>
      </div>
    </div>
  );
}
