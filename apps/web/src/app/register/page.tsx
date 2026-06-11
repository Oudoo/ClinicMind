"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { registerTenant } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const result = await registerTenant(form);
    if (result.error) {
      setError(result.error);
      setLoading(false);
      return;
    }
    // Auto-login into the new workspace
    await signIn("credentials", {
      email: form.get("email"),
      password: form.get("password"),
      tenantSlug: result.tenantSlug,
      redirect: false,
    });
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Create your workspace</CardTitle>
          <CardDescription>
            Multi-tenant by design — your data is fully isolated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="organizationName">Organization name</Label>
              <Input id="organizationName" name="organizationName" placeholder="Acme Growth Agency" required />
            </div>
            <div>
              <Label htmlFor="name">Your name</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div>
              <Label htmlFor="password">Password (min 10 characters)</Label>
              <Input id="password" name="password" type="password" minLength={10} required />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating…" : "Create workspace"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have one?{" "}
              <Link href="/login" className="text-primary underline">
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
