import { describe, expect, it } from "vitest";
import { deidentify, nameWords, patientLabel, Pseudonyms, scrubNumbers } from "@/lib/ai/deidentify";

/**
 * What may leave the clinic for an AI provider: names as labels, numbers and
 * e-mail addresses out, dates, doses and staff names kept, and the answer read
 * back with the real names.
 */

const FATMA = { id: "p1", fullName: "Fatma Fouad", phone: "+201001234567", nationalId: "29801011234567", email: "fatma@example.com", dateOfBirth: new Date("1992-03-07T00:00:00Z") };
const OMAR = { id: "p2", fullName: "Omar Fouad Nabil", phone: "01112223334" };
const KARIM = { id: "p3", fullName: "Karim Lotfy" };

describe("numbers and e-mail addresses", () => {
  it("takes out any e-mail and any run of eight digits or more, keeping dates and doses", () => {
    expect(scrubNumbers("Call 0100 123 4567 or +20-2-2735-0101, mail a.b@clinic.example; ID ٢٩٨٠١٠١١٢٣٤٥٦٧.")).toBe("Call [number] or [number], mail [email]; ID [number].");
    expect(scrubNumbers("Visit on 2026-10-29: isotretinoin 20 mg, 1 000 IU, 55 kg, room 12, code 1234567.")).toBe(
      "Visit on 2026-10-29: isotretinoin 20 mg, 1 000 IU, 55 kg, room 12, code 1234567.",
    );
  });
});

describe("one patient", () => {
  it("calls them the patient, and takes their numbers, e-mail and date of birth out", () => {
    expect(
      deidentify("Fatma Fouad (born 1992-03-07, 07/03/1992) on +201001234567, fatma@example.com, ID 29801011234567: Fatma says the cream burns.", FATMA),
    ).toBe("the patient (born [date of birth], [date of birth]) on [number], [email], ID [number]: the patient says the cream burns.");
  });

  it("matches names whole, in any case, and leaves staff names alone", () => {
    const hassan = { fullName: "Mona Hassan" };
    expect(deidentify("mona HASSAN was seen by Dr. Layla Hassan; Hassanein is another word.", hassan, ["Dr. Layla Hassan", "Layla Hassan"])).toBe(
      "the patient was seen by Dr. Layla Hassan; Hassanein is another word.",
    );
  });

  it("does nothing without a patient but the numbers", () => {
    expect(deidentify("Doxycycline 100 mg, call 01001234567", null)).toBe("Doxycycline 100 mg, call [number]");
  });
});

describe("several patients", () => {
  it("labels each, a shared name word becomes [name], and the answer comes back with the names", () => {
    const p = new Pseudonyms([FATMA, OMAR, KARIM]);
    expect(p.labelOf("p2")).toBe("Patient B");
    const sent = p.scrub("Fatma Fouad and Omar Fouad Nabil are allergic; Karim is not. Fouad called; Omar's phone is 01112223334.");
    expect(sent).toBe("Patient A and Patient B are allergic; Patient C is not. [name] called; Patient B's phone is [number].");
    expect(p.restore("Patient A [1] and Patient B [2]; Patient C has no allergy [3].")).toBe("Fatma Fouad [1] and Omar Fouad Nabil [2]; Karim Lotfy has no allergy [3].");
  });

  it("gives labels beyond Z", () => {
    expect(patientLabel(0)).toBe("Patient A");
    expect(patientLabel(25)).toBe("Patient Z");
    expect(patientLabel(26)).toBe("Patient AA");
  });

  it("keeps the words of a name worth matching", () => {
    expect(nameWords("Ali El-Sayed O'Neil")).toEqual(["Ali", "Sayed", "O'Neil"]);
  });
});
