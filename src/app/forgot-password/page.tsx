import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      description="Enter your e-mail address and we will send you a link to choose a new password."
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
