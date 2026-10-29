/**
 * The vocabulary of expenses and suppliers, shared by the service, the API
 * and the client components. Deliberately free of server imports.
 */
export const EXPENSE_CATEGORIES = [
  "RENT",
  "SALARIES",
  "UTILITIES",
  "SUPPLIES",
  "LAB",
  "EQUIPMENT",
  "MAINTENANCE",
  "MARKETING",
  "FEES",
  "LICENCES",
  "BANK",
  "CLEANING",
  "HOSPITALITY",
  "TRANSPORT",
  "OTHER",
] as const;
export type ExpenseCategoryValue = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategoryValue, string> = {
  RENT: "Rent",
  SALARIES: "Salaries",
  UTILITIES: "Electricity, water and internet",
  SUPPLIES: "Medical supplies",
  LAB: "Lab fees",
  EQUIPMENT: "Equipment",
  MAINTENANCE: "Maintenance and repairs",
  MARKETING: "Marketing",
  FEES: "Accountant and other fees",
  LICENCES: "Licences and insurance",
  BANK: "Bank and card fees",
  CLEANING: "Cleaning",
  HOSPITALITY: "Hospitality",
  TRANSPORT: "Transport and delivery",
  OTHER: "Other",
};

/** Categories only the owner records and sees: what the staff are paid is not the staff's to read. */
export const OWNER_ONLY_CATEGORIES: readonly ExpenseCategoryValue[] = ["SALARIES"];

/** Where an expense stands: nothing paid yet, part of it, all of it, or voided. */
export const EXPENSE_STATUSES = ["OPEN", "PART_PAID", "PAID", "VOID"] as const;
export type ExpenseStatusValue = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatusValue, string> = {
  OPEN: "To pay",
  PART_PAID: "Part paid",
  PAID: "Paid",
  VOID: "Voided",
};

/** The lists on the Expenses page. */
export const EXPENSE_VIEWS = ["due", "month", "recurring", "voided"] as const;
export type ExpenseView = (typeof EXPENSE_VIEWS)[number];

/** How often a recurring expense comes back, in months. */
export const RECURRING_EVERY = [1, 2, 3, 6, 12] as const;

export const RECURRING_EVERY_LABELS: Record<(typeof RECURRING_EVERY)[number], string> = {
  1: "Every month",
  2: "Every 2 months",
  3: "Every 3 months",
  6: "Every 6 months",
  12: "Every year",
};

/** At most this many receipt photos (or PDFs) on one expense, and this large each. */
export const MAX_EXPENSE_FILES = 6;
export const MAX_EXPENSE_FILE_BYTES = 5 * 1024 * 1024;
/** The page downsizes photos to this longest side (JPEG) before upload. */
export const MAX_EXPENSE_PHOTO_SIDE = 1600;

export const isOwnerOnlyCategory = (category: string) => (OWNER_ONLY_CATEGORIES as readonly string[]).includes(category);
