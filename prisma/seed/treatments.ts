import type { SeedContext } from "./index";
import { ensureDefaultTreatments } from "../../src/modules/treatments/service";

/** The clinic's treatment catalogue (prices in whole EGP). */
export async function seedTreatments(ctx: SeedContext): Promise<void> {
  await ensureDefaultTreatments(ctx.tenantId, ctx.db);
}
