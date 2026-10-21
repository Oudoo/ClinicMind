import Link from "next/link";
import type { AuthTokenKind } from "@prisma/client";
import { AuthCard } from "@/components/auth/auth-card";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { Alert } from "@/components/ui/field";
import { inspectAuthToken } from "@/lib/auth/auth-tokens";

/**
 * Server-rendered body shared by /invite/[token] and /reset-password/[token]:
 * validates the token first so a stale link shows a clear message instead of a
 * form that fails on submit.
 */
export async function SetPasswordPage({ token, kind }: { token: string; kind: AuthTokenKind }) {
  const lookup = await inspectAuthToken(token);
  const valid = lookup.status === "valid" && lookup.kind === kind;
  const isInvite = kind === "INVITE";

  if (!valid) {
    const why =
      lookup.status === "expired"
        ? "This link has expired."
        : lookup.status === "used"
          ? "This link has already been used."
          : "This link is not valid.";
    return (
      <AuthCard title={isInvite ? "Invitation" : "Reset your password"}>
        <Alert>{why}</Alert>
        <p className="text-sm text-muted-foreground">
          {isInvite
            ? "Ask your clinic administrator to send a new invitation, or request a link yourself below."
            : "Request a new link below."}
        </p>
        <div className="flex gap-4 text-sm">
          <Link href="/forgot-password" className="text-accent hover:underline">
            Request a new link
          </Link>
          <Link href="/login" className="text-muted-foreground hover:text-accent">
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={isInvite ? `Welcome to ${lookup.user.tenantName}` : "Choose a new password"}
      description={
        <>
          {isInvite ? "Choose a password for " : "Setting a new password for "}
          <span className="font-medium text-foreground">{lookup.user.email}</span>.
        </>
      }
    >
      <SetPasswordForm token={token} kind={kind} />
    </AuthCard>
  );
}
