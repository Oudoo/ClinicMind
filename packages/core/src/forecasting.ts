/**
 * Forecasting engine — Holt-Winters triple exponential smoothing with
 * additive seasonality, holdout backtesting (MAPE), prediction intervals,
 * seasonality index extraction and lost-opportunity quantification.
 * Pure TypeScript: zero licensing cost, fully deterministic and traceable.
 */

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface ForecastPoint {
  date: string;
  value: number;
  lower: number;
  upper: number;
}

export interface ForecastOutput {
  points: ForecastPoint[];
  method: string;
  backtestMape: number | null;
  variability: number;
  trainingWindow: { from: string; to: string; observations: number };
}

interface HwParams {
  alpha: number;
  beta: number;
  gamma: number;
  seasonLength: number;
}

function holtWintersFit(
  series: number[],
  { alpha, beta, gamma, seasonLength }: HwParams
): { level: number; trend: number; seasonals: number[]; fitted: number[] } {
  const n = series.length;
  const seasons = Math.floor(n / seasonLength);
  // Initial seasonal components from per-season averages
  const seasonAvgs: number[] = [];
  for (let s = 0; s < seasons; s++) {
    const slice = series.slice(s * seasonLength, (s + 1) * seasonLength);
    seasonAvgs.push(slice.reduce((a, b) => a + b, 0) / seasonLength);
  }
  const seasonals = new Array<number>(seasonLength).fill(0);
  for (let i = 0; i < seasonLength; i++) {
    let sum = 0;
    for (let s = 0; s < seasons; s++) sum += series[s * seasonLength + i] - seasonAvgs[s];
    seasonals[i] = sum / seasons;
  }

  let level = series[0];
  let trend =
    seasons >= 2
      ? (seasonAvgs[1] - seasonAvgs[0]) / seasonLength
      : (series[n - 1] - series[0]) / Math.max(n - 1, 1);

  const fitted: number[] = [];
  for (let i = 0; i < n; i++) {
    const seasonal = seasonals[i % seasonLength];
    fitted.push(level + trend + seasonal);
    const lastLevel = level;
    level = alpha * (series[i] - seasonal) + (1 - alpha) * (level + trend);
    trend = beta * (level - lastLevel) + (1 - beta) * trend;
    seasonals[i % seasonLength] =
      gamma * (series[i] - level) + (1 - gamma) * seasonal;
  }
  return { level, trend, seasonals, fitted };
}

function mape(actual: number[], predicted: number[]): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i]) < 1e-9) continue;
    sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
    count++;
  }
  return count ? (sum / count) * 100 : 0;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 1;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (Math.abs(mean) < 1e-9) return 1;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/**
 * Forecast `horizonDays` ahead. Uses weekly seasonality (7) for daily data,
 * falling back to simple Holt linear trend when history is short.
 */
export function forecastSeries(history: SeriesPoint[], horizonDays: number): ForecastOutput {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const values = sorted.map((p) => p.value);
  const lastDate = sorted[sorted.length - 1]?.date ?? new Date().toISOString().slice(0, 10);
  const variability = coefficientOfVariation(values);
  const trainingWindow = {
    from: sorted[0]?.date ?? lastDate,
    to: lastDate,
    observations: values.length,
  };

  if (values.length < 14) {
    // Naive drift forecast for sparse history
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
    const points: ForecastPoint[] = [];
    for (let h = 1; h <= horizonDays; h++) {
      points.push({
        date: addDays(lastDate, h),
        value: round2(mean),
        lower: round2(mean * 0.5),
        upper: round2(mean * 1.5),
      });
    }
    return { points, method: "naive_mean", backtestMape: null, variability, trainingWindow };
  }

  const seasonLength = 7;
  const params: HwParams = { alpha: 0.35, beta: 0.05, gamma: 0.25, seasonLength };

  // Backtest: hold out the final 20% (min 7 days)
  const holdout = Math.max(7, Math.floor(values.length * 0.2));
  let backtestMape: number | null = null;
  if (values.length - holdout >= seasonLength * 2) {
    const train = values.slice(0, values.length - holdout);
    const fit = holtWintersFit(train, params);
    const preds: number[] = [];
    for (let h = 1; h <= holdout; h++) {
      preds.push(
        fit.level + h * fit.trend + fit.seasonals[(train.length + h - 1) % seasonLength]
      );
    }
    backtestMape = round2(mape(values.slice(values.length - holdout), preds));
  }

  const fit = holtWintersFit(values, params);
  // Residual std for prediction intervals
  const residuals = values.map((v, i) => v - fit.fitted[i]);
  const residStd = Math.sqrt(
    residuals.reduce((a, b) => a + b * b, 0) / Math.max(residuals.length - 1, 1)
  );

  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizonDays; h++) {
    const value = fit.level + h * fit.trend + fit.seasonals[(values.length + h - 1) % seasonLength];
    const widening = residStd * 1.96 * Math.sqrt(1 + h / values.length);
    points.push({
      date: addDays(lastDate, h),
      value: round2(Math.max(0, value)),
      lower: round2(Math.max(0, value - widening)),
      upper: round2(value + widening),
    });
  }

  return { points, method: "holt_winters_additive", backtestMape, variability, trainingWindow };
}

export interface MonthlySeasonality {
  month: number;
  index: number;
  label: string;
}

/**
 * Monthly seasonality indices (1.0 = baseline) for heatmaps and budget
 * scaling maps. Requires at least ~6 months of daily data.
 */
export function extractMonthlySeasonality(history: SeriesPoint[]): MonthlySeasonality[] {
  const byMonth = new Map<number, number[]>();
  for (const p of history) {
    const month = Number(p.date.slice(5, 7));
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(p.value);
  }
  const monthAvgs = new Map<number, number>();
  for (const [month, vals] of byMonth) {
    monthAvgs.set(month, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  const overall =
    [...monthAvgs.values()].reduce((a, b) => a + b, 0) / Math.max(monthAvgs.size, 1);
  const labels = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const out: MonthlySeasonality[] = [];
  for (let m = 1; m <= 12; m++) {
    const avg = monthAvgs.get(m);
    out.push({
      month: m,
      index: avg !== undefined && overall > 0 ? round2(avg / overall) : 1,
      label: labels[m],
    });
  }
  return out;
}

export interface LostOpportunityEstimate {
  missedLow: number;
  missedHigh: number;
  methodology: string;
  evidenceCount: number;
}

/**
 * Lost Opportunity Quantifier — compares actual performance during
 * high-season windows (seasonality index > threshold) against what the
 * seasonal index implies was achievable, returning a conservative range.
 */
export function quantifyLostOpportunity(
  history: SeriesPoint[],
  seasonality: MonthlySeasonality[],
  threshold = 1.15
): LostOpportunityEstimate {
  const baseline =
    history.reduce((a, p) => a + p.value, 0) / Math.max(history.length, 1);
  let missedLow = 0;
  let missedHigh = 0;
  let evidenceCount = 0;
  const seasonalityByMonth = new Map(seasonality.map((s) => [s.month, s.index]));

  for (const p of history) {
    const month = Number(p.date.slice(5, 7));
    const index = seasonalityByMonth.get(month) ?? 1;
    if (index <= threshold) continue;
    const expected = baseline * index;
    if (p.value < expected) {
      const gap = expected - p.value;
      // Conservative band: 50–100% of the modelled gap is attributable
      missedLow += gap * 0.5;
      missedHigh += gap;
      evidenceCount++;
    }
  }
  return {
    missedLow: round2(missedLow),
    missedHigh: round2(missedHigh),
    methodology: `Seasonal-index gap analysis: daily actuals during months with seasonality index > ${threshold} compared against baseline × index; 50–100% of the shortfall attributed.`,
    evidenceCount,
  };
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
