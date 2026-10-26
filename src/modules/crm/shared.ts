/**
 * The lead pipeline and the labels shared by the CRM service, the API and the
 * UI. Deliberately free of server imports (no Prisma client, no db) so client
 * components can import it.
 */

export const LEAD_STAGES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CONSULTATION_BOOKED",
  "CONSULTATION_ATTENDED",
  "PROCEDURE_BOOKED",
  "WON",
  "LOST",
] as const;
export type LeadStageKey = (typeof LEAD_STAGES)[number];

/** The forward path; LOST sits beside it and is reached from any stage. */
export const PIPELINE_STAGES = LEAD_STAGES.filter((s) => s !== "LOST") as Exclude<LeadStageKey, "LOST">[];

export const STAGE_LABELS: Record<LeadStageKey, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CONSULTATION_BOOKED: "Consultation booked",
  CONSULTATION_ATTENDED: "Consultation attended",
  PROCEDURE_BOOKED: "Procedure booked",
  WON: "Won",
  LOST: "Lost",
};

/** Stages at or after a consultation booking (the campaign "consultations" count). */
export const CONSULTATION_STAGES: readonly LeadStageKey[] = ["CONSULTATION_BOOKED", "CONSULTATION_ATTENDED", "PROCEDURE_BOOKED", "WON"];

export const LEAD_SOURCES = ["CLICK_TO_WHATSAPP_AD", "INSTAGRAM_ORGANIC", "WEBSITE", "REFERRAL", "WALK_IN", "PHONE", "OTHER"] as const;
export type LeadSourceKey = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABELS: Record<LeadSourceKey, string> = {
  CLICK_TO_WHATSAPP_AD: "Click-to-WhatsApp ad",
  INSTAGRAM_ORGANIC: "Instagram organic",
  WEBSITE: "Website",
  REFERRAL: "Referral",
  WALK_IN: "Walk-in",
  PHONE: "Phone",
  OTHER: "Other",
};

export const LOST_REASONS = ["NO_RESPONSE", "PRICE", "TIMING", "CHOSE_COMPETITOR", "DISTANCE", "NOT_A_FIT", "OTHER"] as const;
export type LostReasonKey = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABELS: Record<LostReasonKey, string> = {
  NO_RESPONSE: "No response",
  PRICE: "Price",
  TIMING: "Timing",
  CHOSE_COMPETITOR: "Chose a competitor",
  DISTANCE: "Distance",
  NOT_A_FIT: "Not a fit",
  OTHER: "Other",
};

export const OBJECTION_TAGS = ["PRICE", "PAIN", "DOWNTIME", "RESULTS_DOUBT", "TRUST", "TIMING"] as const;
export type ObjectionTagKey = (typeof OBJECTION_TAGS)[number];

export const OBJECTION_LABELS: Record<ObjectionTagKey, string> = {
  PRICE: "Price",
  PAIN: "Pain",
  DOWNTIME: "Downtime",
  RESULTS_DOUBT: "Doubts about results",
  TRUST: "Trust",
  TIMING: "Timing",
};

export const CAMPAIGN_PLATFORMS = ["META", "GOOGLE", "TIKTOK", "OTHER"] as const;
export type CampaignPlatformKey = (typeof CAMPAIGN_PLATFORMS)[number];

export const CHANNELS = ["WHATSAPP", "VOICE", "SMS", "WEB_CHAT", "IN_PERSON"] as const;
export type ChannelKey = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  WHATSAPP: "WhatsApp",
  VOICE: "Call",
  SMS: "SMS",
  WEB_CHAT: "Web chat",
  IN_PERSON: "In person",
};

export const LEAD_SORTS = ["newest", "lastContact", "oldest"] as const;
export type LeadSortKey = (typeof LEAD_SORTS)[number];

export const FOLLOW_UP_SCOPES = ["due", "overdue", "mine"] as const;
export type FollowUpScope = (typeof FOLLOW_UP_SCOPES)[number];

export function stageIndex(stage: LeadStageKey): number {
  return LEAD_STAGES.indexOf(stage);
}

/**
 * Stage rules of the pipeline: a lead moves forward any distance (skipping
 * steps is allowed: a walk-in can be qualified at once), or one step back to
 * correct a mistake. LOST is only reached through "mark lost" (it needs a
 * reason) and only left through "reopen"; WON is final.
 */
export function canMoveStage(from: LeadStageKey, to: LeadStageKey): { ok: boolean; reason: string } {
  if (from === to) return { ok: false, reason: "The lead is already in that stage." };
  if (to === "LOST") return { ok: false, reason: "Use “Mark lost” so the reason is recorded." };
  if (from === "LOST") return { ok: false, reason: "Reopen the lead first." };
  if (from === "WON") return { ok: false, reason: "A won lead stays won." };
  const delta = stageIndex(to) - stageIndex(from);
  if (delta > 0) return { ok: true, reason: "" };
  if (delta === -1) return { ok: true, reason: "" };
  return { ok: false, reason: "A lead can only step back one stage at a time." };
}

/** Stages the "Move" menu offers from `from`. */
export function moveTargets(from: LeadStageKey): LeadStageKey[] {
  return LEAD_STAGES.filter((s) => canMoveStage(from, s).ok);
}

/** The channel a booking made for this lead is attributed to. */
export function sourceToChannel(source: LeadSourceKey): ChannelKey {
  switch (source) {
    case "CLICK_TO_WHATSAPP_AD":
    case "INSTAGRAM_ORGANIC":
      return "WHATSAPP";
    case "WEBSITE":
      return "WEB_CHAT";
    case "PHONE":
      return "VOICE";
    default:
      return "IN_PERSON";
  }
}

/** The lead source an unknown inbound contact on `channel` is recorded with. */
export function channelToSource(channel: ChannelKey): LeadSourceKey {
  switch (channel) {
    case "WHATSAPP":
      return "CLICK_TO_WHATSAPP_AD";
    case "WEB_CHAT":
      return "WEBSITE";
    case "VOICE":
    case "SMS":
      return "PHONE";
    default:
      return "OTHER";
  }
}

/** "3h", "2d", "5w": how long ago a lead came in. */
export function ageLabel(since: Date | string, now: Date = new Date()): string {
  const from = typeof since === "string" ? new Date(since) : since;
  const ms = Math.max(0, now.getTime() - from.getTime());
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** Digits-only form for a `wa.me` link, or null when the number is unusable. */
export function waMeLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}`;
}

/** Egyptian-friendly phone normalisation to E.164 (+20…); other countries keep their prefix. */
export function normalisePhone(raw: string): string {
  let s = raw.trim().replace(/[\s()\-.]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^01[0-9]{9}$/.test(s)) return `+2${s}`;
  if (/^1[0-9]{9}$/.test(s)) return `+20${s}`;
  if (/^20[0-9]{10}$/.test(s)) return `+${s}`;
  if (/^[0-9]+$/.test(s)) return `+${s}`;
  return s;
}
