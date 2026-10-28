import { ApiError } from "@/lib/http";
import { dateKeyInTz, zonedParts } from "@/lib/time";
import { cn, initials } from "@/lib/utils";
import { Badge } from "@/components/ui/primitives";
import {
  CHANNEL_LABELS,
  LOST_REASON_LABELS,
  OBJECTION_LABELS,
  SOURCE_LABELS,
  STAGE_LABELS,
  type CampaignPlatformKey,
  type ChannelKey,
  type LeadSourceKey,
  type LeadStageKey,
  type LostReasonKey,
  type ObjectionTagKey,
} from "@/modules/crm/shared";

/**
 * Pieces shared by the CRM pages and the inbox, on the server and in the
 * browser: badges, the owner chip, option shapes and error wording. No
 * directive and no server imports, so both sides can use it.
 */

type Tone = "default" | "accent" | "success" | "warning" | "danger";

export interface StaffOption {
  id: string;
  fullName: string;
  role: string;
}

export interface TreatmentOption {
  key: string;
  name: string;
}

export interface CampaignOption {
  id: string;
  name: string;
  platform: string;
  active: boolean;
}

export const PLATFORM_LABELS: Record<CampaignPlatformKey, string> = { META: "Meta", GOOGLE: "Google", TIKTOK: "TikTok", OTHER: "Other" };

export const STAGE_TONE: Record<LeadStageKey, Tone> = {
  NEW: "accent",
  CONTACTED: "default",
  QUALIFIED: "default",
  CONSULTATION_BOOKED: "warning",
  CONSULTATION_ATTENDED: "warning",
  PROCEDURE_BOOKED: "success",
  WON: "success",
  LOST: "danger",
};

/** Short source names for badges on cards (the full label goes into the title). */
export const SOURCE_SHORT: Record<LeadSourceKey, string> = {
  CLICK_TO_WHATSAPP_AD: "WhatsApp ad",
  INSTAGRAM_ORGANIC: "Instagram",
  WEBSITE: "Website",
  REFERRAL: "Referral",
  WALK_IN: "Walk-in",
  PHONE: "Phone",
  OTHER: "Other",
};

const SOURCE_TONE: Record<LeadSourceKey, Tone> = {
  CLICK_TO_WHATSAPP_AD: "success",
  INSTAGRAM_ORGANIC: "accent",
  WEBSITE: "default",
  REFERRAL: "warning",
  WALK_IN: "default",
  PHONE: "default",
  OTHER: "default",
};

export function StageBadge({ stage, className }: { stage: LeadStageKey; className?: string }) {
  return (
    <Badge tone={STAGE_TONE[stage]} className={className}>
      {STAGE_LABELS[stage]}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: LeadSourceKey }) {
  return (
    <Badge tone={SOURCE_TONE[source]} title={SOURCE_LABELS[source]}>
      {SOURCE_SHORT[source]}
    </Badge>
  );
}

export function ChannelBadge({ channel }: { channel: ChannelKey }) {
  return <Badge tone={channel === "WHATSAPP" ? "success" : channel === "WEB_CHAT" ? "accent" : "default"}>{CHANNEL_LABELS[channel]}</Badge>;
}

export function ObjectionBadges({ objections, className }: { objections: readonly ObjectionTagKey[]; className?: string }) {
  if (!objections.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {objections.map((o) => (
        <Badge key={o} tone="warning">
          {OBJECTION_LABELS[o]}
        </Badge>
      ))}
    </span>
  );
}

export function LostReasonBadge({ reason }: { reason: LostReasonKey | null }) {
  if (!reason) return null;
  return <Badge tone="danger">{LOST_REASON_LABELS[reason]}</Badge>;
}

/** The owner's initials in a small square, the full name on hover. */
export function OwnerChip({ owner, size = "sm" }: { owner: { fullName: string } | null; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs";
  if (!owner) {
    return (
      <span title="Unassigned" className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-dashed border-border font-mono text-muted-foreground", box)}>
        –
      </span>
    );
  }
  return (
    <span title={owner.fullName} className={cn("inline-flex shrink-0 items-center justify-center rounded-md bg-accent-muted font-mono text-accent", box)}>
      {initials(owner.fullName.replace(/^Dr\.?\s+/i, ""))}
    </span>
  );
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * "Thu 22 Oct" / "22 Oct 2026" on the clinic clock, built from numeric parts:
 * the same string on the server and in every browser (ICU versions disagree
 * on commas and on "Sep"/"Sept", which would break hydration).
 */
export function clinicDate(date: Date, timezone: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const p = zonedParts(date, timezone);
  return [opts.weekday ? WEEKDAY_SHORT[p.weekday] : null, pad2(p.day), MONTH_SHORT[p.month - 1], opts.year ? String(p.year) : null].filter(Boolean).join(" ");
}

/** "09:30" on the clinic clock (24-hour), deterministic like `clinicDate`. */
export function clinicTime(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "Today 14:30", "Yesterday 09:10", "Wed 29 Oct 10:00" or "12 Mar 2026" on the clinic clock. */
export function whenLabel(iso: string | Date, timezone: string, now: Date, opts: { withTime?: boolean } = {}): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const withTime = opts.withTime ?? true;
  const time = withTime ? ` ${clinicTime(date, timezone)}` : "";
  const key = dateKeyInTz(date, timezone);
  if (key === dateKeyInTz(now, timezone)) return `Today${time}`;
  if (key === dateKeyInTz(new Date(now.getTime() - 86_400_000), timezone)) return `Yesterday${time}`;
  if (key === dateKeyInTz(new Date(now.getTime() + 86_400_000), timezone)) return `Tomorrow${time}`;
  const days = Math.abs(date.getTime() - now.getTime()) / 86_400_000;
  if (days < 6) return `${clinicDate(date, timezone, { weekday: true })}${time}`;
  return clinicDate(date, timezone, { year: zonedParts(date, timezone).year !== zonedParts(now, timezone).year });
}

/** "2 days overdue" style distance for a due date in the past. */
export function overdueLabel(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min overdue`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h overdue`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} overdue`;
}

export const LEADS_TABS = ["pipeline", "list", "follow-ups", "campaigns"] as const;
export type LeadsTab = (typeof LEADS_TABS)[number];

/** The leads page's filters as they sit in the URL (all optional strings). */
export interface LeadQueryState {
  q?: string;
  stage?: string;
  source?: string;
  ownerId?: string;
  interest?: string;
  campaignId?: string;
  from?: string;
  to?: string;
  sort?: string;
  page?: number;
  scope?: string;
}

export const LEAD_FILTER_KEYS = ["q", "stage", "source", "ownerId", "interest", "campaignId", "from", "to"] as const;

/** `/dashboard/leads?tab=list&source=…`: defaults (pipeline, page 1, newest first) stay out of the URL. */
export function leadsHref(tab: LeadsTab, query: LeadQueryState = {}): string {
  const params = new URLSearchParams();
  if (tab !== "pipeline") params.set("tab", tab);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "page" && Number(value) <= 1) continue;
    if (key === "sort" && value === "newest") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `/dashboard/leads${qs ? `?${qs}` : ""}`;
}

const CRM_ERRORS: Record<string, string> = {
  invalid_stage: "That move is not allowed from the lead's current stage.",
  already_lost: "This lead is already marked lost.",
  not_lost: "Only a lost lead can be reopened.",
  already_converted: "This lead is already linked to a patient.",
  follow_up_done: "This follow-up was already completed.",
  lead_lost: "Reopen the lead before booking.",
  duplicate_external_id: "Another campaign already uses this platform id.",
  duplicate_key: "A template with this key already exists.",
  conflict: "That slot is already taken.",
  patient_conflict: "The patient already has an appointment at that time.",
};

/** A sentence for a failed API call (field errors are handled by the forms themselves). */
export function crmErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const known = CRM_ERRORS[err.code];
    if (known) {
      const message = (err.body as { message?: unknown } | null)?.message;
      return err.code === "invalid_stage" && typeof message === "string" ? message : known;
    }
    if (err.status === 404) return "It no longer exists, or belongs to another clinic.";
    return err.message;
  }
  return "Could not reach the server. Please try again.";
}
