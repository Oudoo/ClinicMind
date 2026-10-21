import { SetPasswordPage } from "@/components/auth/set-password-page";

export const dynamic = "force-dynamic";

/** Complete a password reset requested at /forgot-password. */
export default function ResetPasswordPage({ params }: { params: { token: string } }) {
  return <SetPasswordPage token={params.token} kind="PASSWORD_RESET" />;
}
