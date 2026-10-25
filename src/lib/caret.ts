/**
 * Insert dictated text into a field at the caret (or over the selection),
 * adding one space where the join would otherwise glue two words together.
 * Returns the new value and where the caret should sit afterwards.
 */
export function insertAtCaret(
  value: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  fragment: string,
): { value: string; caret: number } {
  const text = fragment.trim();
  if (!text) return { value, caret: value.length };
  const start = selectionStart == null ? value.length : Math.max(0, Math.min(selectionStart, value.length));
  const end = selectionEnd == null ? start : Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const sepBefore = before.length && !/\s$/.test(before) ? " " : "";
  const sepAfter = after.length && !/^\s/.test(after) ? " " : "";
  const head = `${before}${sepBefore}${text}`;
  return { value: `${head}${sepAfter}${after}`, caret: head.length };
}
