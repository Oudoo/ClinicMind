import type { Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";

/**
 * A room is typed by hand, so one room reaches the book as "Room 1", "room 1",
 * "Room  1 ", "Room1" or "Room ١". Every spelling of a room must clash like the
 * room itself: they share one key, a new booking is stored under the spelling
 * the clinic already uses, and the conflict checks look for every spelling
 * already on the book (older bookings may carry a different one).
 */

type Client = Prisma.TransactionClient;

/** Trimmed, one space between words: how a room the clinic has not used yet is stored. */
export function tidyRoom(room: string): string {
  return room.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits as 0–9. */
function westernDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) % 16));
}

/** The comparison key: capitals, spaces, dashes, dots and the kind of digits do not count. */
export function roomKey(room: string): string {
  return westernDigits(tidyRoom(room)).toLowerCase().replace(/[\s\-_.]/g, "");
}

export interface ResolvedRoom {
  /** The spelling to store: the one the clinic uses most for this room, else the tidied input. */
  room: string;
  /** Every spelling of this room already on the book, for the conflict checks. */
  spellings: string[];
}

export async function resolveRoom(tenantId: string, room: string, client: Client = db): Promise<ResolvedRoom> {
  const key = roomKey(room);
  const used = await client.appointment.groupBy({
    by: ["room"],
    where: { tenantId, ...notDeleted, room: { not: null } },
    _count: { _all: true },
  });
  const same = used
    .filter((r): r is typeof r & { room: string } => r.room !== null && roomKey(r.room) === key)
    .sort((x, y) => y._count._all - x._count._all);
  const tidy = tidyRoom(room);
  const spellings = same.map((r) => r.room);
  return { room: spellings[0] ?? tidy, spellings: spellings.includes(tidy) ? spellings : [...spellings, tidy] };
}
