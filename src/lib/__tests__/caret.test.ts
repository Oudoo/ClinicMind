import { describe, expect, it } from "vitest";
import { insertAtCaret } from "@/lib/caret";

describe("insertAtCaret", () => {
  it("appends to an empty field", () => {
    expect(insertAtCaret("", null, null, "  Hair loss follow-up ")).toEqual({ value: "Hair loss follow-up", caret: 19 });
  });

  it("appends with a space when the caret is at the end of text", () => {
    const r = insertAtCaret("Patient travelling.", 19, 19, "Call before the visit");
    expect(r.value).toBe("Patient travelling. Call before the visit");
    expect(r.caret).toBe(r.value.length);
  });

  it("inserts at the caret and spaces both sides", () => {
    const r = insertAtCaret("one three", 3, 3, "two");
    expect(r.value).toBe("one two three");
    expect(r.caret).toBe(7);
  });

  it("replaces a selection", () => {
    const r = insertAtCaret("keep this out please", 5, 9, "that");
    expect(r.value).toBe("keep that out please");
    expect(r.caret).toBe(9);
  });

  it("does not double spaces or newlines already there", () => {
    expect(insertAtCaret("line one\n", 9, 9, "line two").value).toBe("line one\nline two");
    expect(insertAtCaret("a  b", 2, 2, "x").value).toBe("a x b");
  });

  it("ignores an empty transcript", () => {
    expect(insertAtCaret("unchanged", 2, 2, "   ")).toEqual({ value: "unchanged", caret: 9 });
  });

  it("clamps a stale caret to the value", () => {
    expect(insertAtCaret("ab", 10, 20, "c").value).toBe("ab c");
  });
});
