import { describe, expect, it } from "vitest";
import { csvRowCount, toCsv } from "@/modules/reporting/csv";

describe("toCsv", () => {
  it("keeps text a spreadsheet would run as a formula as text", () => {
    const csv = toCsv(["Patient", "Amount"], [
      ['=HYPERLINK("http://evil.example","Open")', 500],
      ["+20100", -250],
      ["@SUM(A1)", 0],
      ["-5 days", null],
      ["Mona Adel", 1200.5],
    ]);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil.example"",""Open"")",500`);
    expect(lines[2]).toBe("'+20100,-250"); // negative numbers stay numbers
    expect(lines[3]).toBe("'@SUM(A1),0");
    expect(lines[4]).toBe("'-5 days,");
    expect(lines[5]).toBe("Mona Adel,1200.5");
  });

  it("starts with a byte-order mark and counts data rows", () => {
    const csv = toCsv(["A"], [["x"], ["y"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csvRowCount(csv)).toBe(2);
    expect(csvRowCount(toCsv(["A"], []))).toBe(0);
  });
});
