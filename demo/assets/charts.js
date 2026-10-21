/* Tiny dependency-free SVG charts — blueprint/indigo institutional style. */
window.CM_CHARTS = {
  spark(data, w = 560, h = 170) {
    if (!data || !data.length) return '<div class="mesh" style="height:170px"></div>';
    const pad = 10;
    const max = Math.max(1, ...data.map((d) => d.count));
    const stepX = (w - pad * 2) / Math.max(1, data.length - 1);
    const pts = data.map((d, i) => [pad + i * stepX, h - pad - (d.count / max) * (h - pad * 2 - 16)]);
    const line = pts.map((p, i) => `${i ? "L" : "M"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const area = `${line} L ${pts[pts.length - 1][0]} ${h - pad} L ${pts[0][0]} ${h - pad} Z`;
    const labels = data
      .map((d, i) => `<text x="${pad + i * stepX}" y="${h - 2}" font-size="9" fill="var(--muted)" text-anchor="middle" font-family="JetBrains Mono">${d.day}</text>`)
      .join("");
    const dots = pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="#4f46e5"/>`).join("");
    return `<div class="mesh" style="padding:6px">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:170px" preserveAspectRatio="none">
        <defs><linearGradient id="cmfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4f46e5" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#4f46e5" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#cmfill)"/>
        <path d="${line}" fill="none" stroke="#4f46e5" stroke-width="1.6"/>
        ${dots}${labels}
      </svg></div>`;
  },
  bars(items) {
    const max = Math.max(1, ...items.map((i) => i.count));
    return `<div class="stack" style="gap:10px">${items
      .map(
        (i) => `<div class="row" style="align-items:center;gap:12px">
          <span style="width:170px" class="">${i.label}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(i.count / max) * 100}%"></div></div>
          <span class="mono" style="width:36px;text-align:right">${i.count}</span>
        </div>`,
      )
      .join("")}</div>`;
  },
  donut(pct, label) {
    const r = 42, c = 2 * Math.PI * r, off = c * (1 - pct);
    return `<svg viewBox="0 0 110 110" style="width:120px;height:120px">
      <circle cx="55" cy="55" r="${r}" fill="none" stroke="var(--muted-bg)" stroke-width="12"/>
      <circle cx="55" cy="55" r="${r}" fill="none" stroke="#4f46e5" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 55 55)"/>
      <text x="55" y="52" text-anchor="middle" font-size="20" font-weight="700" fill="var(--fg)">${Math.round(pct * 100)}%</text>
      <text x="55" y="70" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="JetBrains Mono">${label}</text>
    </svg>`;
  },
};
