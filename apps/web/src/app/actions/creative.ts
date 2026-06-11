"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, creativeAssets, catApprovals, abPilots, clients, decisions } from "@growengine/db";
import { audit, publishEvent, EVENT_TYPES, uploadObject } from "@growengine/core";
import { requirePermission, requireUser } from "@/lib/session";

const assetSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(2).max(160),
  assetType: z.enum(["image", "video", "carousel", "copy", "landing_page"]),
  copyText: z.string().max(10000).optional(),
  platforms: z.string(),
});

export async function createCreativeAsset(formData: FormData) {
  const user = await requirePermission("creative:manage");
  const parsed = assetSchema.safeParse({
    clientId: formData.get("clientId"),
    name: formData.get("name"),
    assetType: formData.get("assetType"),
    copyText: formData.get("copyText") || undefined,
    platforms: formData.get("platforms") ?? "meta",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, parsed.data.clientId), eq(clients.tenantId, user.tenantId)));
  if (!client) return { error: "Client not found" };

  let storageKey: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) {
    if (file.size > 200 * 1024 * 1024) return { error: "Asset exceeds 200MB limit" };
    const ext = file.name.split(".").pop() ?? "bin";
    storageKey = `${user.tenantId}/creative/${crypto.randomUUID()}.${ext}`;
    await uploadObject(storageKey, Buffer.from(await file.arrayBuffer()), file.type || "application/octet-stream");
  }

  const [asset] = await db
    .insert(creativeAssets)
    .values({
      tenantId: user.tenantId,
      clientId: client.id,
      name: parsed.data.name,
      assetType: parsed.data.assetType,
      copyText: parsed.data.copyText,
      storageKey,
      platforms: parsed.data.platforms.split(",").map((p) => p.trim()).filter(Boolean),
      createdBy: user.id,
      status: "internal_review",
    })
    .returning();

  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "creative.create",
    entityType: "creative_asset",
    entityId: asset.id,
  });
  revalidatePath(`/clients/${client.id}`);
  return { ok: true, assetId: asset.id };
}

/** Send a creative for Creative Acceptance Testing (client sign-off). */
export async function requestCatApproval(assetId: string) {
  const user = await requirePermission("creative:manage");
  const [asset] = await db
    .select()
    .from(creativeAssets)
    .where(and(eq(creativeAssets.id, assetId), eq(creativeAssets.tenantId, user.tenantId)));
  if (!asset) return { error: "Asset not found" };

  const [approval] = await db
    .insert(catApprovals)
    .values({
      tenantId: user.tenantId,
      clientId: asset.clientId,
      creativeAssetId: asset.id,
      requestedBy: user.id,
      checklist: [
        { key: "brand", label: "On-brand visuals and tone", confirmed: false },
        { key: "claims", label: "All claims are accurate and substantiated", confirmed: false },
        { key: "compliance", label: "Meets platform & legal compliance", confirmed: false },
      ],
      expiresAt: new Date(Date.now() + 14 * 86400_000),
    })
    .returning();

  await db
    .update(creativeAssets)
    .set({ status: "awaiting_client_approval", updatedAt: new Date() })
    .where(eq(creativeAssets.id, asset.id));

  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.catRequested,
    entityType: "cat_approval",
    entityId: approval.id,
    payload: { clientId: asset.clientId, assetName: asset.name },
  });
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true };
}

const catDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "changes_requested"]),
  note: z.string().max(5000).optional(),
});

/** Client-portal sign-off on a CAT request. */
export async function decideCatApproval(approvalId: string, formData: FormData) {
  const user = await requireUser();
  const parsed = catDecisionSchema.safeParse({
    decision: formData.get("decision"),
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [approval] = await db
    .select()
    .from(catApprovals)
    .where(and(eq(catApprovals.id, approvalId), eq(catApprovals.tenantId, user.tenantId)));
  if (!approval) return { error: "Approval not found" };
  if (user.clientId && user.clientId !== approval.clientId) return { error: "Forbidden" };

  await db
    .update(catApprovals)
    .set({
      status: parsed.data.decision,
      decidedByUserId: user.id,
      decidedByName: user.name ?? user.email ?? "Client",
      decisionNote: parsed.data.note,
      decidedAt: new Date(),
    })
    .where(eq(catApprovals.id, approvalId));

  await db
    .update(creativeAssets)
    .set({
      status:
        parsed.data.decision === "approved"
          ? "approved"
          : parsed.data.decision === "rejected"
            ? "rejected"
            : "draft",
      updatedAt: new Date(),
    })
    .where(eq(creativeAssets.id, approval.creativeAssetId));

  // CAT decisions are first-class Decisions in the AOM
  await db.insert(decisions).values({
    tenantId: user.tenantId,
    clientId: approval.clientId,
    title: `Creative sign-off (${parsed.data.decision})`,
    outcome: parsed.data.decision === "approved" ? "approved" : parsed.data.decision === "rejected" ? "rejected" : "modified",
    reason: parsed.data.note,
    approvedByName: user.name ?? user.email ?? "Client",
    approvedByUserId: user.id,
    sourceEntityType: "cat_approval",
    sourceEntityId: approvalId,
  });

  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.catDecided,
    entityType: "cat_approval",
    entityId: approvalId,
    payload: { clientId: approval.clientId, decision: parsed.data.decision },
  });
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "cat.decide",
    entityType: "cat_approval",
    entityId: approvalId,
    changes: { decision: parsed.data.decision },
  });

  revalidatePath(`/client`);
  revalidatePath(`/clients/${approval.clientId}`);
  return { ok: true };
}

const pilotSchema = z.object({
  name: z.string().min(2).max(160),
  platform: z.string().min(2),
  dailyBudget: z.coerce.number().positive().max(1000),
  externalCampaignId: z.string().max(120).optional(),
});

/** Launch a 7-day micro-budget pilot for an approved creative. */
export async function createPilot(assetId: string, formData: FormData) {
  const user = await requirePermission("creative:manage");
  const parsed = pilotSchema.safeParse({
    name: formData.get("name"),
    platform: formData.get("platform"),
    dailyBudget: formData.get("dailyBudget"),
    externalCampaignId: formData.get("externalCampaignId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [asset] = await db
    .select()
    .from(creativeAssets)
    .where(and(eq(creativeAssets.id, assetId), eq(creativeAssets.tenantId, user.tenantId)));
  if (!asset) return { error: "Asset not found" };
  if (asset.status !== "approved") {
    return { error: "Pilots require client CAT approval first — this is a strict gate." };
  }

  const start = new Date();
  const end = new Date(start.getTime() + 7 * 86400_000);
  await db.insert(abPilots).values({
    tenantId: user.tenantId,
    clientId: asset.clientId,
    creativeAssetId: asset.id,
    name: parsed.data.name,
    platform: parsed.data.platform,
    dailyBudget: String(parsed.data.dailyBudget),
    externalCampaignId: parsed.data.externalCampaignId,
    status: "running",
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });

  await db
    .update(creativeAssets)
    .set({ status: "in_pilot", updatedAt: new Date() })
    .where(eq(creativeAssets.id, asset.id));
  revalidatePath(`/clients/${asset.clientId}`);
  return { ok: true };
}

export async function concludePilot(pilotId: string, promote: boolean) {
  const user = await requirePermission("creative:manage");
  const [pilot] = await db
    .select()
    .from(abPilots)
    .where(and(eq(abPilots.id, pilotId), eq(abPilots.tenantId, user.tenantId)));
  if (!pilot) return { error: "Pilot not found" };

  await db
    .update(abPilots)
    .set({ status: promote ? "promoted" : "completed", updatedAt: new Date() })
    .where(eq(abPilots.id, pilotId));
  await db
    .update(creativeAssets)
    .set({ status: promote ? "scaled" : "retired", updatedAt: new Date() })
    .where(eq(creativeAssets.id, pilot.creativeAssetId));
  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.pilotCompleted,
    entityType: "ab_pilot",
    entityId: pilotId,
    payload: { clientId: pilot.clientId, promoted: promote },
  });
  revalidatePath(`/clients/${pilot.clientId}`);
  return { ok: true };
}
