import { SetPasswordPage } from "@/components/auth/set-password-page";

export const dynamic = "force-dynamic";

/** Accept a staff invitation: single-use link e-mailed by POST /api/users. */
export default function InvitePage({ params }: { params: { token: string } }) {
  return <SetPasswordPage token={params.token} kind="INVITE" />;
}
