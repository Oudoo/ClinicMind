import { askAssistant, type AssistantActor, type AssistantAnswer } from "../service";
import { EVAL_CASES, loadSnapshot, type EvalCase, type Expectation, type Snapshot } from "./questions";

/**
 * Runs the evaluation set against one tenant and scores every answer:
 *   - the answer mode (cohort / patient / clarify / rag);
 *   - for list answers: exactly the expected patients across all pages
 *     (precision and recall 100%), and the citations name exactly the listed
 *     patients (the grounding rule);
 *   - for yes/no checks: the verdict;
 *   - for open questions: retrieval was used and every cited patient meets the
 *     question's criteria.
 * Answers are not logged (record: false): an evaluation is not a clinical query.
 */

export interface EvalOutcome {
  id: string;
  category: string;
  question: string;
  expected: Expectation;
  mode: string;
  /** Patients in the answer (rows across all pages, or the cited patients for retrieval). */
  got: string[];
  precision: number;
  recall: number;
  pass: boolean;
  problems: string[];
  ms: number;
}

export async function runEvalSet(
  actor: AssistantActor,
  opts: { cases?: EvalCase[]; now?: Date; snapshot?: Snapshot } = {},
): Promise<EvalOutcome[]> {
  const now = opts.now ?? new Date();
  const snapshot = opts.snapshot ?? (await loadSnapshot(actor.tenantId, now));
  const out: EvalOutcome[] = [];
  for (const c of opts.cases ?? EVAL_CASES) {
    const started = Date.now();
    const expected = c.expect(snapshot);
    const problems: string[] = [];
    let answer: AssistantAnswer;
    try {
      answer = await askAssistant(actor, { query: c.question }, { now, record: false });
    } catch (err) {
      out.push({ id: c.id, category: c.category, question: c.question, expected, mode: "error", got: [], precision: 0, recall: 0, pass: false, problems: [String(err)], ms: Date.now() - started });
      continue;
    }

    let got: string[] = [];
    if (answer.mode === "cohort" || answer.mode === "patient") {
      const rows = [...(answer.cohort?.rows ?? [])];
      let cited = answer.citations.map((x) => x.patientId);
      // Fetch every page: the set must be complete, not just the first 200.
      for (let page = 2; answer.cohort && page <= answer.cohort.pages; page++) {
        const next = await askAssistant(actor, { query: c.question, page }, { now, record: false });
        rows.push(...(next.cohort?.rows ?? []));
        cited = cited.concat(next.citations.map((x) => x.patientId));
      }
      got = rows.map((r) => r.patientId);
      const citedSet = new Set(cited.filter((x): x is string => Boolean(x)));
      if (!sameSet(citedSet, new Set(got))) problems.push("citations do not match the patients listed");
      if (answer.cohort && answer.cohort.total !== got.length) problems.push(`total ${answer.cohort.total} but ${got.length} rows`);
    } else if (answer.mode === "rag") {
      got = [...new Set(answer.citations.map((x) => x.patientId).filter((x): x is string => Boolean(x)))];
    }

    if (answer.mode !== expected.mode) problems.push(`mode ${answer.mode}, expected ${expected.mode}`);
    let precision = 1;
    let recall = 1;
    if (expected.ids) {
      const want = new Set(expected.ids);
      const have = new Set(got);
      const hit = [...have].filter((x) => want.has(x)).length;
      precision = have.size ? hit / have.size : want.size ? 0 : 1;
      recall = want.size ? hit / want.size : 1;
      if (precision < 1) problems.push(`${have.size - hit} patient(s) listed who do not match`);
      if (recall < 1) problems.push(`${want.size - hit} matching patient(s) missing`);
    }
    if (expected.verdict) {
      const head = answer.cohort?.headline ?? answer.answer;
      // (\b does not work after Arabic letters, hence the explicit lookahead.)
      const verdict = /^(yes|نعم)(?=[\s—,.:-]|$)/i.test(head.trim()) ? "yes" : /^(no|لا)(?=[\s—,.:-]|$)/i.test(head.trim()) ? "no" : "unclear";
      if (verdict !== expected.verdict) problems.push(`verdict ${verdict}, expected ${expected.verdict}`);
    }
    if (expected.citedWithin) {
      const allowed = new Set(expected.citedWithin);
      const outside = got.filter((x) => !allowed.has(x));
      if (outside.length) {
        problems.push(`${outside.length} cited patient(s) do not meet the question's criteria`);
        precision = got.length ? (got.length - outside.length) / got.length : 1;
      }
      if (answer.model === "retrieval-gate" || answer.model === "cohort-gate" || !answer.citations.length) problems.push("no records were retrieved");
    }
    out.push({
      id: c.id,
      category: c.category,
      question: c.question,
      expected,
      mode: answer.mode,
      got,
      precision,
      recall,
      pass: problems.length === 0,
      problems,
      ms: Date.now() - started,
    });
  }
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** A plain-text table of the outcomes (for the command-line run). */
export function formatEvalTable(outcomes: EvalOutcome[]): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const header = ["#", "result", "mode", "expected", "got", "precision", "recall", "question"];
  const rows = outcomes.map((o, i) => [
    String(i + 1),
    o.pass ? "PASS" : "FAIL",
    o.mode,
    o.expected.ids ? String(o.expected.ids.length) : o.expected.citedWithin ? `⊆${o.expected.citedWithin.length}` : "-",
    String(o.got.length),
    pct(o.precision),
    pct(o.recall),
    o.question.length > 70 ? `${o.question.slice(0, 69)}…` : o.question,
  ]);
  const widths = header.map((h, k) => Math.max(h.length, ...rows.map((r) => r[k]!.length)));
  const line = (cells: string[]) => cells.map((c, k) => c.padEnd(widths[k]!)).join("  ");
  const failures = outcomes.filter((o) => !o.pass).map((o) => `  ✗ ${o.id}: ${o.problems.join("; ")}`);
  const passed = outcomes.filter((o) => o.pass).length;
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `${passed}/${outcomes.length} passed`,
    ...(failures.length ? ["", "Failures:", ...failures] : []),
  ].join("\n");
}
