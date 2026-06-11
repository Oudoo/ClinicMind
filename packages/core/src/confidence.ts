/**
 * AI Confidence Framework — every forecast, DMAIC output, recommendation
 * and quantified insight carries a confidence score, the data sources used
 * and an evidence count. Scores are computed from measurable signals, not
 * model self-reports.
 */

export interface ConfidenceInput {
  /** Number of independent supporting data points / evidence items */
  evidenceCount: number;
  /** Days of history backing the analysis */
  dataWindowDays: number;
  /** Hours since the most recent underlying data point */
  dataFreshnessHours: number;
  /** Coefficient of variation of the underlying series (0 = perfectly stable) */
  variability?: number;
  /** Backtest accuracy when available (MAPE, lower is better) */
  backtestMape?: number;
  /** Fraction of records that passed the Sanity Check Engine (0-1) */
  sanityPassRate?: number;
  /** Distinct data sources (providers) corroborating */
  sourceCount?: number;
}

export interface ConfidenceResult {
  /** 0-100 */
  score: number;
  band: "low" | "moderate" | "high" | "very_high";
  factors: { name: string; contribution: number; detail: string }[];
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const factors: ConfidenceResult["factors"] = [];

  // Evidence volume: saturates at 50 items → up to 30 points
  const evidence = clamp((Math.log10(input.evidenceCount + 1) / Math.log10(51)) * 30, 0, 30);
  factors.push({
    name: "evidence_volume",
    contribution: round(evidence),
    detail: `${input.evidenceCount} supporting evidence items`,
  });

  // History depth: saturates at 365 days → up to 25 points
  const history = clamp((input.dataWindowDays / 365) * 25, 0, 25);
  factors.push({
    name: "history_depth",
    contribution: round(history),
    detail: `${input.dataWindowDays} days of historical data`,
  });

  // Freshness: full 15 points if <24h old, decays to 0 at 14 days
  const freshness = clamp(15 * (1 - input.dataFreshnessHours / (14 * 24)), 0, 15);
  factors.push({
    name: "data_freshness",
    contribution: round(freshness),
    detail: `${Math.round(input.dataFreshnessHours)}h since latest data point`,
  });

  // Stability: low variability earns up to 10 points
  const variability = input.variability ?? 0.5;
  const stability = clamp(10 * (1 - clamp(variability, 0, 1.5) / 1.5), 0, 10);
  factors.push({
    name: "series_stability",
    contribution: round(stability),
    detail: `coefficient of variation ${variability.toFixed(2)}`,
  });

  // Backtest: MAPE 0% → 10 pts, ≥50% → 0 pts. Neutral 5 when unavailable.
  const backtest =
    input.backtestMape === undefined
      ? 5
      : clamp(10 * (1 - clamp(input.backtestMape, 0, 50) / 50), 0, 10);
  factors.push({
    name: "backtest_accuracy",
    contribution: round(backtest),
    detail:
      input.backtestMape === undefined
        ? "no backtest available (neutral)"
        : `backtest MAPE ${input.backtestMape.toFixed(1)}%`,
  });

  // Sanity pass rate: up to 5 points
  const sanity = clamp((input.sanityPassRate ?? 1) * 5, 0, 5);
  factors.push({
    name: "data_quality",
    contribution: round(sanity),
    detail: `${Math.round((input.sanityPassRate ?? 1) * 100)}% of records passed sanity checks`,
  });

  // Source corroboration: up to 5 points for 3+ independent sources
  const sources = clamp(((input.sourceCount ?? 1) / 3) * 5, 0, 5);
  factors.push({
    name: "source_corroboration",
    contribution: round(sources),
    detail: `${input.sourceCount ?? 1} independent data source(s)`,
  });

  const score = round(
    factors.reduce((acc, f) => acc + f.contribution, 0)
  );

  return {
    score,
    band: score >= 85 ? "very_high" : score >= 70 ? "high" : score >= 50 ? "moderate" : "low",
    factors,
  };
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}
