import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zText } from "@/lib/validation";
import { PATIENT_FILTER_KEYS, parsePatientListQuery, patientFiltersOnly } from "@/modules/patients/filters";
import type { Actor } from "@/modules/patients/service";

/**
 * Saved views: a user's named filter sets for the patient list. Private to
 * the user who saved them (the row carries tenantId + userId and every query
 * filters on both), capped at 30 per user, parameters whitelisted against the
 * filter vocabulary so a saved view can never smuggle an unknown key.
 */
export const SAVED_VIEW_SCOPE = "patients";
export const MAX_SAVED_VIEWS = 30;

const zParam = z.string().trim().max(100).optional();

/** Only known filter keys (plus sort) survive; blanks are dropped. */
export const SavedViewParams = z
  .object(Object.fromEntries([...PATIENT_FILTER_KEYS, "sort"].map((k) => [k, zParam])))
  .transform((raw) => patientFiltersOnly(parsePatientListQuery(raw as Record<string, string | undefined>)));

export const SavedViewInput = z.object({
  name: zText(60).min(1, "Give the view a name"),
  params: SavedViewParams,
});
export const SavedViewPatch = z.object({
  name: zText(60).min(1, "Give the view a name").optional(),
  params: SavedViewParams.optional(),
});

export class SavedViewLimitError extends Error {
  readonly status = 409;
  constructor() {
    super(`At most ${MAX_SAVED_VIEWS} saved views per user`);
    this.name = "SavedViewLimitError";
  }
}

const select = { id: true, name: true, params: true, createdAt: true, updatedAt: true } as const;

export type SavedViewRow = { id: string; name: string; params: Record<string, string>; createdAt: Date; updatedAt: Date };

function toRow(row: { id: string; name: string; params: unknown; createdAt: Date; updatedAt: Date }): SavedViewRow {
  const params =
    row.params && typeof row.params === "object" && !Array.isArray(row.params)
      ? Object.fromEntries(Object.entries(row.params as Record<string, unknown>).filter(([, v]) => typeof v === "string"))
      : {};
  return { ...row, params: params as Record<string, string> };
}

export async function listSavedViews(tenantId: string, userId: string): Promise<SavedViewRow[]> {
  const rows = await db.savedView.findMany({
    where: { tenantId, userId, scope: SAVED_VIEW_SCOPE },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    take: MAX_SAVED_VIEWS,
    select,
  });
  return rows.map(toRow);
}

export async function createSavedView(tenantId: string, userId: string, input: unknown, actor: Actor = {}) {
  const data = SavedViewInput.parse(input);
  const count = await db.savedView.count({ where: { tenantId, userId, scope: SAVED_VIEW_SCOPE } });
  if (count >= MAX_SAVED_VIEWS) throw new SavedViewLimitError();
  const row = await db.savedView.create({
    data: { tenantId, userId, scope: SAVED_VIEW_SCOPE, name: data.name, params: data.params },
    select,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.view.create",
    entity: "SavedView",
    entityId: row.id,
    after: { name: row.name, params: data.params },
  });
  return toRow(row);
}

/** Rename and/or replace the parameters. `null` when the view is not the user's. */
export async function updateSavedView(tenantId: string, userId: string, id: string, input: unknown, actor: Actor = {}) {
  const patch = SavedViewPatch.parse(input);
  const existing = await db.savedView.findFirst({ where: { id, tenantId, userId, scope: SAVED_VIEW_SCOPE }, select });
  if (!existing) return null;
  const row = await db.savedView.update({
    where: { id: existing.id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.params !== undefined ? { params: patch.params } : {}),
    },
    select,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.view.update",
    entity: "SavedView",
    entityId: row.id,
    before: { name: existing.name, params: existing.params },
    after: { name: row.name, params: row.params },
  });
  return toRow(row);
}

export async function deleteSavedView(tenantId: string, userId: string, id: string, actor: Actor = {}) {
  const existing = await db.savedView.findFirst({ where: { id, tenantId, userId, scope: SAVED_VIEW_SCOPE }, select });
  if (!existing) return null;
  await db.savedView.delete({ where: { id: existing.id } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.view.delete",
    entity: "SavedView",
    entityId: existing.id,
    before: { name: existing.name, params: existing.params },
  });
  return toRow(existing);
}
