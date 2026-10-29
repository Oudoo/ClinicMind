import type { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { readTenantSetting, updateTenantSettings } from "@/lib/tenant-settings";
import { zOptionalText } from "@/lib/validation";
import { DEFAULT_DISCOUNT_LIMITS, DISCOUNT_LIMITED_ROLES, DISCOUNT_REASONS, discountLimitFor, withinDiscountLimit, type DiscountLimits } from "./constants";
import { FinanceError } from "./errors";

/**
 * Discount limits: each role may give a discount up to a share of the price
 * (reception 10%, nurses 10% and doctors 20% unless the owner sets otherwise;
 * the owner has no limit). Checked on the server wherever a discount is
 * given: on a procedure, and on a line of a draft invoice. Every discount
 * carries a reason from the fixed list (another reason needs its words).
 */

type Tx = Prisma.TransactionClient;
type Actor = { id?: string | null; email?: string | null; ip?: string | null };

const SETTINGS_KEY = "finance";

interface FinanceSettings {
  discountLimits?: Partial<DiscountLimits>;
}

const percent = z.number().int().min(0).max(100);

export const DiscountLimitsInput = z.object(Object.fromEntries(DISCOUNT_LIMITED_ROLES.map((r) => [r, percent])) as Record<(typeof DISCOUNT_LIMITED_ROLES)[number], typeof percent>);

/** A discount's reason, and its words when it is another reason. */
export const DiscountReasonFields = {
  discountReason: z.enum(DISCOUNT_REASONS).optional(),
  discountNote: zOptionalText(300),
};

export async function discountLimits(tenantId: string, client?: Tx): Promise<DiscountLimits> {
  const finance = await readTenantSetting<FinanceSettings>(tenantId, SETTINGS_KEY, {}, client);
  const set = finance.discountLimits ?? {};
  const valid = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;
  return Object.fromEntries(DISCOUNT_LIMITED_ROLES.map((r) => [r, valid(set[r]) ? set[r] : DEFAULT_DISCOUNT_LIMITS[r]])) as DiscountLimits;
}

/** The actor's own limit (a percentage of the price). */
export async function discountLimitOf(tenantId: string, role: UserRole, client?: Tx): Promise<number> {
  return discountLimitFor(role, await discountLimits(tenantId, client));
}

/**
 * Refuse a discount above the role's limit: 403 `discount_limit`, saying
 * what the role may give. No role: an internal call (the seed, the system),
 * not limited.
 */
export async function assertDiscountAllowed(tenantId: string, role: UserRole | null | undefined, price: number, discount: number, client?: Tx): Promise<void> {
  if (!role || discount <= 0) return;
  const limit = await discountLimitOf(tenantId, role, client);
  if (withinDiscountLimit(price, discount, limit)) return;
  const asked = price > 0 ? Math.ceil((discount * 100) / price) : 100;
  throw new FinanceError(403, "discount_limit", `a ${asked}% discount is above the role's limit of ${limit}%`, {
    limit,
    asked,
    message: limit > 0 ? `Your role can give up to ${limit}% off; ${asked}% needs the clinic owner.` : "Discounts are given by the clinic owner.",
  });
}

/** A discount's reason is required with a discount, and another reason needs its words. */
export function discountReasonIssues(discount: number, reason: string | null | undefined, note: string | null | undefined): Record<string, string> {
  if (discount <= 0) return {};
  if (!reason) return { discountReason: "Choose why the discount is given" };
  if (reason === "OTHER" && !note) return { discountNote: "Say why the discount is given" };
  return {};
}

/** The owner sets the limits; every change is audited. */
export async function setDiscountLimits(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<DiscountLimits> {
  const input = DiscountLimitsInput.parse(rawInput);
  const before = await discountLimits(tenantId);
  const current = await readTenantSetting<FinanceSettings>(tenantId, SETTINGS_KEY, {});
  await updateTenantSettings(tenantId, { [SETTINGS_KEY]: { ...current, discountLimits: input } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "finance.discount_limits", entity: "Tenant", entityId: tenantId, before, after: input });
  return discountLimits(tenantId);
}
