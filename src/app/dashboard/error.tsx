"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * A page that throws shows this instead of a blank screen: what happened,
 * a retry, and a way back to the overview. The error is logged for the console.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-lg space-y-4 py-10">
      <h2 className="font-display text-xl font-semibold tracking-tight">This page could not be shown</h2>
      <p className="text-sm text-muted-foreground">
        Something went wrong while loading it. Try again; if it keeps happening, tell the person running the demo
        {error.digest ? ` and quote ${error.digest}` : ""}.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="outline" onClick={() => router.push("/dashboard")}>
          Back to the overview
        </Button>
      </div>
    </div>
  );
}
