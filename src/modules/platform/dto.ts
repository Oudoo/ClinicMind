import { z } from "zod";

/**
 * Platform console contracts: provisioning and administering tenants
 * (clients). Shared by the API routes, the console UI and the tests.
 */

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Subdomain-safe tenant identifier: lowercase letters, digits, single dashes. */
export const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase letters, digits and single dashes");

/** A bare hostname such as `app.nourclinics.com` (no scheme, no path). */
export const zDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOSTNAME, "enter a hostname such as app.example.com");

/** An exact web origin: scheme + host [+ port], nothing else. */
export const zOrigin = z
  .string()
  .trim()
  .max(255)
  .refine((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }, "enter an origin such as https://www.example.com");

export const zTimezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown IANA time zone");

/**
 * White-label settings. Every key is optional: a PATCH only touches the keys
 * it names, and an empty string clears a key.
 */
export const BrandingInput = z
  .object({
    productName: z.string().trim().max(60).optional(),
    accent: z
      .string()
      .trim()
      .optional()
      .refine((v) => v === undefined || v === "" || HEX_COLOUR.test(v), "accent must be a hex colour like #4F46E5"),
    logoUrl: z
      .string()
      .trim()
      .max(500)
      .optional()
      .refine((v) => v === undefined || v === "" || /^https?:\/\//.test(v), "logo must be an https URL"),
  })
  .strict();
export type BrandingPatch = z.infer<typeof BrandingInput>;

export const ProvisionInput = z
  .object({
    slug: zSlug,
    name: z.string().trim().min(1).max(120),
    ownerEmail: z.string().trim().min(3).max(254).email(),
    ownerFullName: z.string().trim().max(120).optional(),
    timezone: zTimezone.optional(),
    branding: BrandingInput.optional(),
    customDomain: zDomain.optional(),
    allowedOrigins: z.array(zOrigin).max(20).optional(),
  })
  .strict();
export type ProvisionRequest = z.infer<typeof ProvisionInput>;

export const TenantPatchInput = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Only the two operational states are settable; archival is a separate, destructive step. */
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    branding: BrandingInput.optional(),
    customDomain: zDomain.nullable().optional(),
    customDomainVerified: z.boolean().optional(),
    allowedOrigins: z.array(zOrigin).max(20).optional(),
    embedEnabled: z.boolean().optional(),
  })
  .strict();
export type TenantPatch = z.infer<typeof TenantPatchInput>;

export const OwnerInviteInput = z
  .object({
    email: z.string().trim().min(3).max(254).email(),
    fullName: z.string().trim().max(120).optional(),
  })
  .strict();
export type OwnerInviteRequest = z.infer<typeof OwnerInviteInput>;

/** Slugs that would collide with platform hostnames or routes. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "platform",
  "www",
  "api",
  "app",
  "admin",
  "login",
  "embed",
  "dashboard",
  "assets",
  "static",
  "mail",
  "smtp",
  "ns1",
  "ns2",
]);
