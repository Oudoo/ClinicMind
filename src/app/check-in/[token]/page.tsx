import type { Metadata } from "next";
import { Clock } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { getPublicCheckIn } from "@/modules/concierge/checkins";
import { CHECK_IN_COPY } from "@/modules/concierge/check-in-copy";
import { CheckInForm } from "@/components/clinicmind/check-in-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Check-in",
  robots: { index: false, follow: false },
  // The token is in the address: never pass it on in a Referer header.
  referrer: "no-referrer",
};

/**
 * `/check-in/[token]` — the patient's check-in behind the link in a concierge
 * message. No dashboard shell and no session: the token in the URL is the
 * only credential, looked up by its hash on the server, so an unknown, used,
 * expired or stopped link renders a readable page instead of an empty form.
 */
export default async function CheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await getPublicCheckIn(token);
  if (!data) return <ExpiredLink />;
  return <CheckInForm token={token} data={data} productName={BRAND.productName} />;
}

function ExpiredLink() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="bento w-full max-w-md space-y-5 text-center">
        <Clock className="mx-auto h-10 w-10 text-warning" aria-hidden="true" />
        <section dir="rtl" lang="ar" className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">{CHECK_IN_COPY.ar.expired.title}</h1>
          <p className="text-sm text-muted-foreground">{CHECK_IN_COPY.ar.expired.body}</p>
        </section>
        <hr className="border-border" />
        <section dir="ltr" lang="en" className="space-y-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">{CHECK_IN_COPY.en.expired.title}</h2>
          <p className="text-sm text-muted-foreground">{CHECK_IN_COPY.en.expired.body}</p>
        </section>
        <p className="text-xs text-muted-foreground">
          {CHECK_IN_COPY.en.poweredBy} {BRAND.productName}
        </p>
      </div>
    </div>
  );
}
