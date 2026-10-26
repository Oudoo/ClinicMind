import type { ChannelKey, LeadSourceKey, LeadStageKey, LostReasonKey, ObjectionTagKey, CampaignPlatformKey } from "./shared";

/**
 * JSON-safe shapes the CRM pages hand to client components and the API
 * returns (dates as ISO strings). Free of server imports.
 */

export interface PersonDTO {
  id: string;
  fullName: string;
}

export interface StaffDTO extends PersonDTO {
  role: string;
}

export interface TreatmentDTO {
  id: string;
  key: string;
  name: string;
}

export interface CampaignRefDTO {
  id: string;
  name: string;
  platform: CampaignPlatformKey;
}

export interface LeadCardDTO {
  id: string;
  fullName: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  stage: LeadStageKey;
  source: LeadSourceKey;
  interests: string[];
  campaign: CampaignRefDTO | null;
  owner: PersonDTO | null;
  patientId: string | null;
  createdAt: string;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  lostReason: LostReasonKey | null;
  wonAt: string | null;
  objections: ObjectionTagKey[];
}

export interface BoardColumnDTO {
  stage: LeadStageKey;
  total: number;
  leads: LeadCardDTO[];
}

export interface FollowUpDTO {
  id: string;
  leadId: string;
  lead: { id: string; fullName: string; phone: string | null; stage: LeadStageKey; interests: string[] };
  owner: PersonDTO | null;
  dueAt: string;
  note: string | null;
  channel: ChannelKey | null;
  doneAt: string | null;
  outcome: string | null;
  createdAt: string;
}

export interface CampaignDTO {
  id: string;
  externalId: string;
  name: string;
  platform: CampaignPlatformKey;
  source: LeadSourceKey;
  treatment: TreatmentDTO | null;
  active: boolean;
  startedAt: string | null;
  endedAt: string | null;
  leads: number;
  consultations: number;
  won: number;
  totalCost: number;
}

export interface CostRowDTO {
  line: number;
  periodStart: string;
  periodEnd: string;
  amount: number;
}

export interface CostImportPreviewDTO {
  rows: CostRowDTO[];
  errors: { line: number; message: string }[];
  imported: number;
}
