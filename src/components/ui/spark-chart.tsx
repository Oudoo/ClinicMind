import { cn } from "@/lib/utils";

/**
 * Blueprint-style area/line chart. Thin indigo line over a semi-transparent
 * indigo fill on a mesh grid — per the brand's data-viz guidelines. Pure SVG,
 * no client JS, so it renders in server components.
 */
export function SparkChart({
  data,
  width = 560,
  height = 160,
  className,
}: {
  data: { day: string; count: number }[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (!data.length) {
    return (
      <div className={cn("mesh flex h-40 items-center justify-center rounded-lg", className)}>
        <span className="data-label">no data</span>
      </div>
    );
  }

  const pad = 8;
  const max = Math.max(1, ...data.map((d) => d.count));
  const stepX = (width - pad * 2) / Math.max(1, data.length - 1);
  const points = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (d.count / max) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
  const area = `${line} L ${points[points.length - 1]![0]} ${height - pad} L ${points[0]![0]} ${
    height - pad
  } Z`;

  return (
    <div className={cn("mesh rounded-lg p-2", className)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="cm-indigo-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4F46E5" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#4F46E5" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#cm-indigo-fill)" />
        <path d={line} fill="none" stroke="#4F46E5" strokeWidth="1.5" />
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2" fill="#4F46E5" />
        ))}
      </svg>
    </div>
  );
}
