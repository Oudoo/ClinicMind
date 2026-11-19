/**
 * Room names as pure functions (no database): how a typed room is tidied for
 * storage and which spellings count as the same room.
 */
import { describe, expect, it } from "vitest";
import { roomKey, tidyRoom } from "@/modules/appointments/rooms";

describe("tidyRoom", () => {
  it("trims and keeps one space between words", () => {
    expect(tidyRoom("  Procedure   room ")).toBe("Procedure room");
    expect(tidyRoom("Laser\tsuite")).toBe("Laser suite");
  });

  it("keeps the clinic's own capitals", () => {
    expect(tidyRoom("Room 1")).toBe("Room 1");
  });
});

describe("roomKey", () => {
  it("ignores capitals, spaces, dashes and dots", () => {
    const key = roomKey("Room 1");
    for (const s of ["room 1", "ROOM 1", "  Room   1 ", "Room1", "room-1", "Room.1", "room_1"]) {
      expect(roomKey(s), s).toBe(key);
    }
  });

  it("reads Arabic-Indic and Persian digits as Western ones", () => {
    expect(roomKey("Room ١")).toBe(roomKey("Room 1"));
    expect(roomKey("غرفة ٢")).toBe(roomKey("غرفة 2"));
    expect(roomKey("غرفة ۳")).toBe(roomKey("غرفة 3"));
  });

  it("keeps different rooms apart", () => {
    expect(roomKey("Room 1")).not.toBe(roomKey("Room 11"));
    expect(roomKey("Room 1")).not.toBe(roomKey("Room 2"));
    expect(roomKey("Procedure room")).not.toBe(roomKey("Laser suite"));
  });
});
