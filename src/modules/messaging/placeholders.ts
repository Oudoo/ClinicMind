/**
 * Reply-template placeholders. Pure and free of server imports so the inbox's
 * reply box fills them in the browser and the server refuses a reply that
 * still carries one (a patient must never receive "{{date}}").
 */
export const TEMPLATE_PLACEHOLDERS = ["name", "clinic", "doctor", "date", "link", "treatment"] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export type TemplateVars = Partial<Record<TemplatePlaceholder, string | null | undefined>>;

export const PLACEHOLDER_HINTS: Record<TemplatePlaceholder, string> = {
  name: "The contact's first name",
  clinic: "The clinic's name",
  doctor: "The doctor of the patient's next appointment",
  date: "The date and time of the patient's next appointment",
  link: "A link for the patient (the clinic's public address by default)",
  treatment: "What a recall brings the patient back for (recall messages; typed in the inbox)",
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

/** Replace every `{{ key }}` whose value is known; unknown or empty ones are left in place. */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(PLACEHOLDER, (whole, key: string) => {
    const value = vars[key.toLowerCase() as TemplatePlaceholder];
    return value ? String(value) : whole;
  });
}

/** The known placeholders still present in `body` (deduplicated, in order). */
export function unfilledPlaceholders(body: string): TemplatePlaceholder[] {
  const found: TemplatePlaceholder[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const key = match[1]!.toLowerCase();
    if ((TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key) && !found.includes(key as TemplatePlaceholder)) {
      found.push(key as TemplatePlaceholder);
    }
  }
  return found;
}
