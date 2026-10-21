"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Client-facing integration snippets. A client drops the loader on their own
 * website; their backend mints a short-lived embed token (see /api/embed/token)
 * with the tenant's embed secret so the iframe loads an authenticated,
 * tenant-scoped session. The secret itself never appears here or in the page.
 *
 * Keep these in sync with `public/embed.js` and `docs/INTEGRATION.md`.
 */
export function EmbedInstructions({ appUrl, tenantSlug }: { appUrl: string; tenantSlug: string }) {
  const snippet = `<!-- ClinicMind embed — place where the tool should appear -->
<div id="clinicmind-root" style="height:800px"></div>
<script
  src="${appUrl}/embed.js"
  data-clinicmind-tenant="${tenantSlug}"
  data-clinicmind-host="${appUrl}"
  data-clinicmind-token-endpoint="/api/clinicmind/token"
  defer
></script>`;

  const serverSnippet = `// Your backend route (e.g. /api/clinicmind/token), for the logged-in staff member only.
// Exchange the embed secret — stored server-side, never in the browser — for a session token:
//
//   POST ${appUrl}/api/embed/token
//   x-clinicmind-embed-secret: <your embed secret>
//   Content-Type: application/json
//
//   { "tenantSlug": "${tenantSlug}",
//     "userId": "<the staff member's ClinicMind user id>",
//     "origin": "https://your-site.example",   // must be on the allowed-origins list
//     "role": "DOCTOR" }                        // optional; never wider than the user's own role
//
//   -> { "token": "<jwt>", "expiresIn": 600, "role": "DOCTOR" }
//
// Reply to embed.js with { "token": "<jwt>" }.`;

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
