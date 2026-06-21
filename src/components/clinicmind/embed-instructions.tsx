"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Client-facing integration snippet. A client drops this on their own website to
 * embed their isolated ClinicMind instance; the host backend mints a short-lived
 * embed token (see /api/embed/token) so the iframe loads an authenticated,
 * tenant-scoped session.
 */
export function EmbedInstructions({
  appUrl,
  tenantSlug,
  publicKey,
}: {
  appUrl: string;
  tenantSlug: string;
  publicKey: string;
}) {
  const snippet = `<!-- ClinicMind embed — place where the tool should appear -->
<div id="clinicmind-root" style="height:800px"></div>
<script
  src="${appUrl}/embed.js"
  data-clinicmind-tenant="${tenantSlug}"
  data-clinicmind-key="${publicKey}"
  data-clinicmind-host="${appUrl}"
  defer
></script>`;

  const serverSnippet = `// Your backend mints a short-lived token for the logged-in staff member.
// POST ${appUrl}/api/embed/token
//   Authorization: Bearer <your service credential>
//   body: { tenantSlug: "${tenantSlug}", userId, role }
// -> { token }  // hand this to embed.js via window.postMessage`;

  return (
    <div className="space-y-4">
      <CodeBlock title="1 · Website embed snippet" code={snippet} />
      <CodeBlock title="2 · Mint a session token (server-side)" code={serverSnippet} />
    </div>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="data-label">{title}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-muted-foreground">
        {code}
      </pre>
    </div>
  );
}
