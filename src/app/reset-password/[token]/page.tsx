import { SetPasswordPage } from "@/components/auth/set-password-page";

export const dynamic = "force-dynamic";

/** Complete a password reset requested at /forgot-password. */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SetPasswordPage token={token} kind="PASSWORD_RESET" />;
}
