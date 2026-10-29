/**
 * A source's text as the panel searches and cites it: split at its headings
 * ("# …", "## …", or a short line ending in ":"), then into passages of a
 * few paragraphs (about 700 characters, never splitting a sentence when it
 * can be helped). Each passage keeps the heading it sits under.
 */

export interface Passage {
  index: number;
  heading: string | null;
  content: string;
}

const TARGET = 700;
const HARD_MAX = 1_400;

function headingOf(line: string): string | null {
  const t = line.trim();
  const md = /^#{1,4}\s+(.+?)\s*#*$/.exec(t);
  if (md) return md[1]!.trim();
  // A short line of its own ending in a colon ("Monitoring:"), not a sentence.
  if (t.length <= 80 && t.endsWith(":") && !/[.!?؟]\s/.test(t)) return t.slice(0, -1).trim();
  return null;
}

/** Sentences of a paragraph (English and Arabic punctuation). */
export function sentences(text: string): string[] {
  return (
    text
      .replace(/\s+/g, " ")
      .match(/[^.!?؟]+(?:[.!?؟]+|$)/g)
      ?.map((s) => s.trim())
      .filter((s) => s.length > 1) ?? []
  );
}

export function splitPassages(body: string): Passage[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const sections: { heading: string | null; paragraphs: string[] }[] = [{ heading: null, paragraphs: [] }];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) sections[sections.length - 1]!.paragraphs.push(text);
    paragraph = [];
  };
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      flush();
      sections.push({ heading, paragraphs: [] });
    } else if (!line.trim()) {
      flush();
    } else {
      // A list item is its own paragraph.
      if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) flush();
      paragraph.push(line.trim().replace(/^([-*•]|\d+[.)])\s+/, ""));
    }
  }
  flush();

  const out: Passage[] = [];
  for (const section of sections) {
    let current = "";
    const push = () => {
      if (current.trim()) out.push({ index: out.length, heading: section.heading, content: current.trim() });
      current = "";
    };
    for (const p of section.paragraphs) {
      if (current && current.length + p.length + 1 > TARGET) push();
      if (p.length <= HARD_MAX) {
        current = current ? `${current}\n${p}` : p;
        continue;
      }
      // A very long paragraph: by sentences.
      for (const s of sentences(p)) {
        if (current && current.length + s.length + 1 > TARGET) push();
        current = current ? `${current} ${s}` : s;
      }
    }
    push();
  }
  return out;
}
