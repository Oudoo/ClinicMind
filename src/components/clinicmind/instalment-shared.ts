import type { InstalmentState } from "@/modules/finance/instalment-schedule";
import type { BadgeTone } from "./patient-shared";

/** Shared by the plan list (client) and the Instalments page (server). */
export const INSTALMENT_TONE: Record<InstalmentState, BadgeTone> = { PAID: "success", OVERDUE: "danger", DUE: "warning", UPCOMING: "default" };

export const instalmentName = (n: number) => (n === 0 ? "Down payment" : `Instalment ${n}`);
