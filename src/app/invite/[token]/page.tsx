import { SetPasswordPage } from "@/components/auth/set-password-page";

export const dynamic = "force-dynamic";

/** Accept a staff invitation: single-use link e-mailed by POST /api/users. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SetPasswordPage token={token} kind="INVITE" />;
}
