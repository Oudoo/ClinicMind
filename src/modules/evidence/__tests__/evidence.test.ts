import { describe, expect, it } from "vitest";
import type { AiMessage, AiProvider, ChatResult } from "@/lib/ai/types";
import { pregnancyKnown, pregnancyLine } from "@/modules/patients/pregnancy";
import { answerablePassages, answerQuestion, libraryAnswer, noGoodSource, statementsFromReply, type CandidatePassage } from "../answer";
import { NO_GOOD_SOURCE, NO_GOOD_SOURCE_AR } from "../constants";
import { redactQuestion } from "../context";
import { sentences, splitPassages } from "../passages";
import { analyzeQuestion, rank, stem, tokenize } from "../search";

/**
 * The evidence panel's pure parts: a source split into passages under their
 * headings, the search (English and Arabic, a drug by any of its names), which
 * passages may answer, the answer only from them (quoted, or a model's
 * sentences each carrying a passage's marker), the question without the
 * patient's name and numbers, and how long a recorded pregnancy counts.
 */

const ISO = "Isotretinoin for acne: the clinic's protocol";
const DOXY = "Doxycycline: drug information sheet";
const PEEL = "بروتوكول العيادة: التقشير الكيميائي";

const PASSAGES: CandidatePassage[] = [
  { id: "iso-0", sourceId: "iso", title: ISO, heading: "Before starting", content: "Lipids and liver tests at baseline. Women who could become pregnant: a negative pregnancy test before the first prescription, and contraception agreed and documented." },
  { id: "iso-1", sourceId: "iso", title: ISO, heading: "Monitoring during treatment", content: "A pregnancy test every month for women who could become pregnant. Repeat lipids and liver tests after one month, then every three months." },
  { id: "iso-2", sourceId: "iso", title: ISO, heading: "Do not combine", content: "Do not prescribe tetracyclines (doxycycline, minocycline) with isotretinoin: together they raise the risk of benign intracranial hypertension. No vitamin A supplements during the course." },
  { id: "doxy-0", sourceId: "doxy", title: DOXY, heading: "How to take it", content: "With a full glass of water, sitting or standing. Two to three hours apart from antacids, iron or calcium." },
  { id: "doxy-1", sourceId: "doxy", title: DOXY, heading: "Who should not take it", content: "Pregnancy and breastfeeding: tetracyclines stain the baby's teeth. Children under 8 years. Patients taking isotretinoin: together they raise the risk of benign intracranial hypertension." },
  { id: "peel-0", sourceId: "peel", title: PEEL, heading: "الحمل والرضاعة", content: "لا يُستخدم حمض الساليسيليك ولا مادة TCA أثناء الحمل والرضاعة." },
  { id: "botox-0", sourceId: "botox", title: "Botulinum toxin: the clinic's protocol", heading: "Treatment", content: "At least three months between treatments of the same area." },
];

const ids = (question: string) => answerablePassages(question, PASSAGES).map((c) => c.item.id);

function provider(reply: string | Error): AiProvider & { sent: AiMessage[][] } {
  const sent: AiMessage[][] = [];
  return {
    name: "fake",
    sent,
    isConfigured: () => true,
    supportsEmbeddings: () => false,
    supportsTranscription: () => false,
    chatModel: () => "fake-model",
    embeddingModel: () => null,
    transcriptionModel: () => null,
    async chat(messages): Promise<ChatResult> {
      sent.push(messages);
      if (reply instanceof Error) throw reply;
      return { provider: "fake", model: "fake-model", content: reply, latencyMs: 1, finishReason: "stop" };
    },
    embed: () => Promise.reject(new Error("no")),
    transcribe: () => Promise.reject(new Error("no")),
  };
}

const echo = { ...provider(""), name: "echo" };
const titles = new Map([
  ["iso", ISO],
  ["doxy", DOXY],
]);

describe("splitting a source", () => {
  it("keeps each passage under its heading: markdown headings and short lines ending in a colon", () => {
    const passages = splitPassages("Demo text.\n\n# Before starting\nLipids at baseline.\nA pregnancy test.\n\nMonitoring:\n- Monthly test\n- Lipids after one month");
    expect(passages).toEqual([
      { index: 0, heading: null, content: "Demo text." },
      { index: 1, heading: "Before starting", content: "Lipids at baseline. A pregnancy test." },
      { index: 2, heading: "Monitoring", content: "Monthly test\nLipids after one month" },
    ]);
  });

  it("starts a new passage near 700 characters and splits a very long paragraph by sentences", () => {
    const sentence = "Isotretinoin needs a pregnancy test every month for women who could become pregnant. ";
    const passages = splitPassages(`# Long\n${sentence.repeat(30)}`);
    expect(passages.length).toBeGreaterThan(2);
    for (const p of passages) {
      expect(p.heading).toBe("Long");
      expect(p.content.length).toBeLessThanOrEqual(800);
      expect(p.content.endsWith(".")).toBe(true);
    }
  });

  it("splits sentences in English and Arabic", () => {
    expect(sentences("One. Two? ثلاثة؟ Four")).toEqual(["One.", "Two?", "ثلاثة؟", "Four"]);
  });
});

describe("searching", () => {
  it("stems English and Arabic words the same way in the question and the passage", () => {
    expect(stem("pregnancy")).toBe(stem("pregnant"));
    expect(stem("monitoring")).toBe("monitor");
    expect(stem("tests")).toBe("test");
    expect(tokenize("الحمل والرضاعة")).toEqual(["حمل", "رضاعه"]);
  });

  it("counts a drug once, by any of its names: an Arabic brand finds the English passage", () => {
    const { units } = analyzeQuestion("ينفع دوكسيسيكلين مع روكيوتان؟");
    expect(units.filter((u) => u.concept).map((u) => u.phrases[0])).toEqual([["doxycycline"], ["isotretinoin"]]);
    expect(ids("ينفع دوكسيسيكلين مع روكيوتان؟")).toEqual(expect.arrayContaining(["iso-2", "doxy-1"]));
    expect(ids("Can doxycycline be given with isotretinoin?").slice(0, 2).sort()).toEqual(["doxy-1", "iso-2"]);
  });

  it("finds an Arabic passage for an English question, and an English one for an Arabic question", () => {
    expect(ids("Can a pregnant woman have a chemical peel?")).toEqual(["peel-0"]);
    expect(ids("متابعة الحمل مع الايزوتريتينوين")).toContain("iso-1");
  });

  it("a name inside a longer one counts as the longer one", () => {
    const { units } = analyzeQuestion("حبوب منع الحمل مع الروكتان");
    expect(units.filter((u) => u.concept)).toHaveLength(2);
  });

  it("the source's title counts: a passage of the isotretinoin protocol is about isotretinoin", () => {
    expect(ids("isotretinoin monitoring")).toEqual(["iso-1"]);
  });

  it("ranks by BM25: rarer words weigh more", () => {
    const ranked = rank(
      [
        { id: "a", text: "liver tests liver tests" },
        { id: "b", text: "intracranial hypertension liver" },
      ],
      ["intracranial", "liver"],
    );
    expect(ranked.map((r) => r.item.id)).toEqual(["b", "a"]);
    expect(ranked[0]!.matched).toEqual(["intracranial", "liver"]);
  });

  it("answers nothing when no passage speaks of what the question names", () => {
    expect(ids("Is finasteride safe for women?")).toEqual([]);
    expect(ids("What dose of tranexamic acid for melasma?")).toEqual([]);
    expect(ids("??")).toEqual([]);
  });
});

describe("answering", () => {
  it("offline (echo): quotes the passages' own sentences, each with its passage, numbered in the order cited", async () => {
    const answer = await answerQuestion("Can doxycycline be given with isotretinoin?", PASSAGES, { provider: echo, titles, context: [] });
    expect(answer.grounded).toBe(true);
    expect(answer.mode).toBe("library");
    expect(answer.prompt).toBeNull();
    expect(answer.statements.length).toBeGreaterThan(0);
    for (const s of answer.statements) {
      expect(s.cites).toHaveLength(1);
      expect(answer.cited[s.cites[0]! - 1]!.item.content).toContain(s.text);
    }
    expect(answer.statements.map((s) => s.cites[0])).toEqual([...answer.statements.map((s) => s.cites[0])].sort());
    expect(answer.statements.some((s) => /intracranial hypertension/.test(s.text))).toBe(true);
  });

  it("says plainly when no good source answers, in the question's language", async () => {
    const answer = await answerQuestion("Is finasteride safe for women?", PASSAGES, { provider: provider("should not be asked"), titles, context: [] });
    expect(answer).toMatchObject({ grounded: false, statements: [], cited: [] });
    expect(noGoodSource("Is finasteride safe?")).toBe(NO_GOOD_SOURCE);
    expect(noGoodSource("ينفع فيناسترايد للستات؟")).toBe(NO_GOOD_SOURCE_AR);
  });

  it("with a model: sends only the numbered passages and the context without identifiers; keeps only sentences carrying a marker", async () => {
    const model = provider("Do not combine them [1]. Tetracyclines raise the risk of intracranial hypertension with isotretinoin [1][2]. Ask her to drink water. Use a cream [9].");
    const answer = await answerQuestion("Can doxycycline be given with isotretinoin?", PASSAGES, { provider: model, titles, context: ["Woman, 24 years", "Pregnancy excluded on 20 Oct 2026"] });
    expect(answer.mode).toBe("model");
    expect(answer.statements).toEqual([
      { text: "Do not combine them.", cites: [1] },
      { text: "Tetracyclines raise the risk of intracranial hypertension with isotretinoin.", cites: [1, 2] },
    ]);
    expect(answer.cited).toHaveLength(2);
    const system = model.sent[0]![0]!.content;
    expect(system).toContain("ONLY the numbered passages");
    expect(system).toContain("[1] ");
    expect(system).toContain("Woman, 24 years; Pregnancy excluded on 20 Oct 2026");
    expect(system).not.toMatch(/Lipids and liver tests at baseline/); // a passage that does not answer is not sent
    expect(answer.prompt).toContain("Question: Can doxycycline be given with isotretinoin?");
  });

  it("a model that finds no answer in the passages, or cites none, gives no good source", async () => {
    for (const reply of ["NO_GOOD_SOURCE", "They can be combined safely."]) {
      const answer = await answerQuestion("Can doxycycline be given with isotretinoin?", PASSAGES, { provider: provider(reply), titles, context: [] });
      expect(answer.grounded).toBe(false);
      expect(answer.mode).toBe("model");
    }
  });

  it("reads markers after the full stop and drops numbers it was not given", () => {
    expect(statementsFromReply("First. [2] Second [1].", 2)).toEqual([
      { text: "First.", cites: [2] },
      { text: "Second.", cites: [1] },
    ]);
    expect(statementsFromReply("Only [3].", 2)).toBeNull();
  });

  it("the library answer renumbers the passages it quotes", () => {
    const cited = answerablePassages("Can doxycycline be given with isotretinoin?", PASSAGES);
    const answer = libraryAnswer("Can doxycycline be given with isotretinoin?", cited);
    expect(answer.cited.map((c) => c.item.id)).toEqual([...new Set(answer.statements.flatMap((s) => s.cites))].map((n) => answer.cited[n - 1]!.item.id));
  });
});

describe("what leaves the clinic with the question", () => {
  it("takes the patient's name words, long numbers and e-mail addresses out of the question", () => {
    const ids = ["Mervat", "Adel", "+201001234567", "29801011234567", "mervat@example.com"];
    expect(redactQuestion("Can Mervat Adel (+20 100 123 4567, ID 29801011234567, mervat@example.com) take doxycycline?", ids)).toBe(
      "Can the patient ([number], ID [number], [email]) take doxycycline?",
    );
    expect(redactQuestion("هل ميرفت تقدر تاخد روكيوتان؟", ["ميرفت", "عادل"])).toBe("هل the patient تقدر تاخد روكيوتان؟");
    // Doses and short numbers stay: they are part of the question.
    expect(redactQuestion("Is 20 mg of isotretinoin a day enough at 55 kg?", ["Mervat"])).toBe("Is 20 mg of isotretinoin a day enough at 55 kg?");
  });
});

describe("how long a recorded pregnancy counts", () => {
  const NOW = new Date("2026-10-29T10:00:00Z");
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it("an exclusion for 30 days, a pregnancy for 300; nothing recorded is unknown", () => {
    expect(pregnancyKnown({ pregnancyStatus: "NOT_PREGNANT", pregnancyCheckedAt: days(29) }, NOW)).toBe(false);
    expect(pregnancyKnown({ pregnancyStatus: "NOT_PREGNANT", pregnancyCheckedAt: days(31) }, NOW)).toBeNull();
    expect(pregnancyKnown({ pregnancyStatus: "PREGNANT", pregnancyCheckedAt: days(200) }, NOW)).toBe(true);
    expect(pregnancyKnown({ pregnancyStatus: "PREGNANT", pregnancyCheckedAt: days(301) }, NOW)).toBeNull();
    expect(pregnancyKnown({ pregnancyStatus: null, pregnancyCheckedAt: null }, NOW)).toBeNull();
  });

  it("says what is recorded and whether it still counts", () => {
    expect(pregnancyLine({ pregnancyStatus: "NOT_PREGNANT", pregnancyCheckedAt: days(5) }, "Africa/Cairo", NOW)).toBe("Pregnancy excluded on 24 Oct 2026");
    expect(pregnancyLine({ pregnancyStatus: "NOT_PREGNANT", pregnancyCheckedAt: days(40) }, "Africa/Cairo", NOW)).toMatch(/more than 30 days ago: not known now$/);
    expect(pregnancyLine({ pregnancyStatus: "PREGNANT", pregnancyCheckedAt: days(70) }, "Africa/Cairo", NOW)).toBe("Pregnant (recorded 20 Aug 2026)");
    expect(pregnancyLine({ pregnancyStatus: null, pregnancyCheckedAt: null }, "Africa/Cairo", NOW)).toBe("Pregnancy not recorded");
  });
});
