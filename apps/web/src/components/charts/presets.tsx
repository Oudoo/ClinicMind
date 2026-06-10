"use client";

import type { EChartsOption } from "echarts";
import { EChart } from "./echart";

const PALETTE = ["#0d9466", "#0ea5e9", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6"];

export function TimeSeriesChart({
  series,
  height = 300,
}: {
  series: { name: string; data: [string, number][]; area?: boolean }[];
  height?: number;
}) {
  const option: EChartsOption = {
    color: PALETTE,
    tooltip: { trigger: "axis" },
    legend: { show: series.length > 1, top: 0 },
    grid: { left: 50, right: 20, top: series.length > 1 ? 35 : 15, bottom: 30 },
    xAxis: { type: "time" },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f3" } } },
    series: series.map((s) => ({
      name: s.name,
      type: "line",
      smooth: true,
      showSymbol: false,
      areaStyle: s.area ? { opacity: 0.12 } : undefined,
      data: s.data,
    })),
  };
  return <EChart option={option} height={height} />;
}

/** Forecast chart with confidence band (lower/upper). */
export function ForecastChart({
  history,
  forecast,
  height = 320,
}: {
  history: [string, number][];
  forecast: { date: string; value: number; lower: number; upper: number }[];
  height?: number;
}) {
  const option: EChartsOption = {
    color: PALETTE,
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { left: 55, right: 20, top: 35, bottom: 30 },
    xAxis: { type: "time" },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f3" } } },
    series: [
      { name: "Actual", type: "line", showSymbol: false, smooth: true, data: history },
      {
        name: "Forecast",
        type: "line",
        showSymbol: false,
        smooth: true,
        lineStyle: { type: "dashed" },
        data: forecast.map((p) => [p.date, p.value]),
      },
      {
        name: "Lower bound",
        type: "line",
        stack: "band",
        symbol: "none",
        lineStyle: { opacity: 0 },
        data: forecast.map((p) => [p.date, p.lower]),
      },
      {
        name: "Confidence band",
        type: "line",
        stack: "band",
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: "#0d9466", opacity: 0.1 },
        data: forecast.map((p) => [p.date, p.upper - p.lower]),
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

/** Seasonality heatmap: 12 months × metric index. */
export function SeasonalityHeatmap({
  cells,
  height = 180,
}: {
  cells: { month: number; index: number; label: string }[];
  height?: number;
}) {
  const option: EChartsOption = {
    tooltip: {
      formatter: (p) =>
        `${(p as { name: string }).name}: index ${((p as { value: number[] }).value)[2]}`,
    },
    grid: { left: 40, right: 20, top: 10, bottom: 50 },
    xAxis: {
      type: "category",
      data: cells.map((c) => c.label),
      splitArea: { show: true },
    },
    yAxis: { type: "category", data: ["Index"], splitArea: { show: true } },
    visualMap: {
      min: 0.5,
      max: 1.8,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: ["#e0f2fe", "#0d9466", "#f59e0b"] },
    },
    series: [
      {
        type: "heatmap",
        data: cells.map((c, i) => [i, 0, c.index]),
        label: { show: true, formatter: (p) => String((p.value as number[])[2]) },
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

export function BarChart({
  categories,
  series,
  height = 300,
  horizontal = false,
}: {
  categories: string[];
  series: { name: string; data: number[] }[];
  height?: number;
  horizontal?: boolean;
}) {
  const catAxis = { type: "category" as const, data: categories };
  const valAxis = { type: "value" as const, splitLine: { lineStyle: { color: "#eef0f3" } } };
  const option: EChartsOption = {
    color: PALETTE,
    tooltip: { trigger: "axis" },
    legend: { show: series.length > 1, top: 0 },
    grid: { left: horizontal ? 130 : 50, right: 20, top: series.length > 1 ? 35 : 15, bottom: 30 },
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? catAxis : valAxis,
    series: series.map((s) => ({ name: s.name, type: "bar", data: s.data, barMaxWidth: 28 })),
  };
  return <EChart option={option} height={height} />;
}

export function DonutChart({
  data,
  height = 260,
}: {
  data: { name: string; value: number }[];
  height?: number;
}) {
  const option: EChartsOption = {
    color: PALETTE,
    tooltip: { trigger: "item" },
    legend: { orient: "vertical", right: 0, top: "center" },
    series: [
      {
        type: "pie",
        radius: ["55%", "80%"],
        center: ["35%", "50%"],
        label: { show: false },
        data,
      },
    ],
  };
  return <EChart option={option} height={height} />;
}

export function GaugeChart({ value, height = 220 }: { value: number; height?: number }) {
  const option: EChartsOption = {
    series: [
      {
        type: "gauge",
        startAngle: 200,
        endAngle: -20,
        min: 0,
        max: 100,
        progress: { show: true, width: 14 },
        axisLine: { lineStyle: { width: 14 } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: true,
          fontSize: 28,
          offsetCenter: [0, "-10%"],
          formatter: (v) => `${Math.round(v)}`,
        },
        data: [{ value }],
        itemStyle: { color: value >= 70 ? "#0d9466" : value >= 50 ? "#f59e0b" : "#ef4444" },
      },
    ],
  };
  return <EChart option={option} height={height} />;
}
