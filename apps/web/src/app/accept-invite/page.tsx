"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { acceptInvite } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

function AcceptInviteForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    form.set("token", token);
    const result = await acceptInvite(form);
    setLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.push(`/login`);
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">Accept your invitation</CardTitle>
        <CardDescription>Set up your account to join the workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Your name</Label>
            <Input id="name" name="name" required />
          </div>
          <div>
            <Label htmlFor="password">Password (min 10 characters)</Label>
            <Input id="password" name="password" type="password" minLength={10} required />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !token}>
            {loading ? "Joining…" : "Join workspace"}
          </Button>
          {!token && <p className="text-sm text-destructive">Missing invitation token.</p>}
        </form>
      </CardContent>
    </Card>
  );
}

export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Suspense>
        <AcceptInviteForm />
      </Suspense>
    </main>
  );
}
