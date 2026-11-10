import Link from "next/link";
import { BRAND } from "@/lib/brand";

/** Centered card used by the sign-in, invitation and password pages. */
export function AuthCard({
  title,
  description,
  children,
  footer,
  brand,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** The tenant's white-label identity when the page is served on its own host. */
  brand?: { name: string; logoUrl: string | null };
}) {
  const name = brand?.name ?? BRAND.productName;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2.5 rounded-md">
        {/* Tenant logo from branding, else the default in /public/logo.svg */}
        <img src={brand?.logoUrl || "/logo.svg"} alt="" width={32} height={32} className="h-8 w-8 rounded-md object-contain" />
        <span className="font-display text-lg font-semibold tracking-tight">{name}</span>
      </Link>
      <div className="bento w-full max-w-sm space-y-6 p-6">
        <div>
          <h1 className="font-display text-[1.375rem] font-semibold leading-7 tracking-[-0.02em] [text-wrap:balance]">{title}</h1>
          {description ? <div className="mt-1.5 text-sm text-muted-foreground">{description}</div> : null}
        </div>
        {children}
      </div>
      {footer ? <div className="mt-6 max-w-sm text-center text-xs text-muted-foreground [text-wrap:balance]">{footer}</div> : null}
    </div>
  );
}
