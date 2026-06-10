import { marked } from "marked";

/** Render trusted, platform-generated markdown (reports, SOWs, QBRs). */
export function Markdown({ content, className }: { content: string; className?: string }) {
  const html = marked.parse(content, { async: false }) as string;
  return (
    <div
      className={`prose-doc text-sm ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
