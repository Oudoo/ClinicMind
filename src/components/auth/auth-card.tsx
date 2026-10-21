import Link from "next/link";
import { BRAND } from "@/lib/brand";

/** Centered card used by the sign-in, invitation and password pages. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2">
        {/* Swap the logo by replacing /public/logo.svg */}
        <img src="/logo.svg" alt={BRAND.productName} width={32} height={32} className="h-8 w-8 rounded-md" />
        <span className="font-display text-lg font-semibold tracking-tight">{BRAND.productName}</span>
      </Link>
      <div className="bento w-full max-w-md space-y-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <div className="mt-1 text-sm text-muted-foreground">{description}</div> : null}
        </div>
        {children}
      </div>
      {footer ? <div className="mt-6 text-center text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
