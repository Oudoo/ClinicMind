"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

/**
 * Thin Apache ECharts wrapper — resize-aware, SSR-safe.
 */
export function EChart({
  option,
  height = 320,
  className,
}: {
  option: echarts.EChartsOption;
  height?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = echarts.init(ref.current);
    chartRef.current.setOption(option);
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chartRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} style={{ height }} className={className} />;
}
