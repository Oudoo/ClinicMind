import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Server-component friendly pagination: links that preserve the current query
 * string and change `page`. `total` is the number of rows, `pageSize` the page
 * length; both come from the service that produced the page.
 */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  query = {},
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  query?: Record<string, string | undefined>;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    params.set("page", String(p));
    return `${basePath}?${params.toString()}`;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className={cn("flex items-center justify-between gap-4 px-5 py-3 text-xs text-muted-foreground", className)}>
      <span className="font-mono tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <PageLink href={href(page - 1)} disabled={page <= 1} label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </PageLink>
        <span className="px-2 font-mono tabular-nums">
          {page} / {pages}
        </span>
        <PageLink href={href(page + 1)} disabled={page >= pages} label="Next page">
          <ChevronRight className="h-4 w-4" />
        </PageLink>
      </div>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const cls = "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border";
  if (disabled) {
    return (
      <span className={cn(cls, "opacity-40")} aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={cn(cls, "hover:bg-muted")} aria-label={label}>
      {children}
    </Link>
  );
}
