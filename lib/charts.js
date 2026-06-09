'use strict';
// Inline-SVG chart helpers. Pure (depend only on esc for text escaping).
const { esc } = require('./format');

// Catmull-Rom → cubic Bezier path. Produces a smooth TradingView-style
// curve through the points. `tension` 0..1; 0.5 looks great for sparklines.
function smoothPath(xs, ys, tension) {
  const t = (typeof tension === 'number' ? tension : 0.5);
  const n = xs.length;
  if (n === 0) return '';
  if (n === 1) return `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  let d = `M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = i > 0 ? xs[i - 1] : xs[i];
    const y0 = i > 0 ? ys[i - 1] : ys[i];
    const x1 = xs[i],     y1 = ys[i];
    const x2 = xs[i + 1], y2 = ys[i + 1];
    const x3 = i + 2 < n ? xs[i + 2] : xs[i + 1];
    const y3 = i + 2 < n ? ys[i + 2] : ys[i + 1];
    const cp1x = x1 + (x2 - x0) * (t / 3);
    const cp1y = y1 + (y2 - y0) * (t / 3);
    const cp2x = x2 - (x3 - x1) * (t / 3);
    const cp2y = y2 - (y3 - y1) * (t / 3);
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return d;
}

function sparkline(points) {
  if (!points.length) return '<p class="muted-text">No data yet.</p>';
  const W = 560, H = 200, P = 28;
  const xs = points.map((_, i) => P + (i * (W - P * 2)) / Math.max(1, points.length - 1));
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const yScale = (v) => H - P - ((v - min) / Math.max(1, max - min)) * (H - P * 2);
  const ys = points.map((p) => yScale(p.value));
  const line = smoothPath(xs, ys, 0.55);
  const area = `${line} L ${xs[xs.length - 1].toFixed(1)} ${H - P} L ${xs[0].toFixed(1)} ${H - P} Z`;
  const dots = xs.map((x, i) =>
    `<circle class="dot" cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3.5"></circle>`).join('');
  const xLabels = points.map((p, i) =>
    `<text x="${xs[i].toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>`).join('');
  const yMax = `<text x="6" y="${(P + 4).toFixed(1)}">${max}</text>`;
  const yMin = `<text x="6" y="${(H - P + 4).toFixed(1)}">${min}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path class="area" d="${area}"></path>
    <path class="line" d="${line}"></path>
    ${dots}${xLabels}${yMax}${yMin}
  </svg>`;
}

// Tiny inline sparkline for stat cards (no axes). `color` is a CSS color string.
// Renders as a smooth filled area (TradingView-style) — no straight segments.
function miniSpark(values, color) {
  const v = (values && values.length) ? values : [0, 0];
  const W = 120, H = 56, P = 3;
  const max = Math.max(...v, 1), min = Math.min(...v, 0);
  const xs = v.map((_, i) => P + (i * (W - 2 * P)) / Math.max(1, v.length - 1));
  const ys = v.map((val) => H - P - ((val - min) / Math.max(1, max - min)) * (H - 2 * P));
  const line = smoothPath(xs, ys, 0.6);
  const area = `${line} L ${xs[xs.length - 1].toFixed(1)} ${H - P} L ${xs[0].toFixed(1)} ${H - P} Z`;
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="--c:${color}">
    <path class="mini-area" d="${area}"></path><path class="mini-line" d="${line}"></path></svg>`;
}

// Donut chart. segments: [{label, value, color}]. Renders ring + centred caption.
function donut(segments, centerTop, centerBig) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const cx = 80, cy = 80, R = 60, sw = 24, C = 2 * Math.PI * R;
  let off = 0;
  const rings = total > 0 ? segments.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"></circle>`;
    off += len;
    return seg;
  }).join('') : `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--soft)" stroke-width="${sw}"></circle>`;
  return `<svg class="donut" viewBox="0 0 160 160">
    ${rings}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-top">${esc(centerTop)}</text>
    <text x="${cx}" y="${cy + 20}" text-anchor="middle" class="donut-big">${esc(String(centerBig))}</text>
  </svg>`;
}

// Build a 'YYYY-MM' array for the last n months (oldest first).
function lastMonths(n) {
  const out = [], now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
// Map grouped {ym, v} rows onto a months[] array → number[].
function seriesOn(months, rows) {
  const m = new Map(rows.map((r) => [r.ym, Number(r.v) || 0]));
  return months.map((ym) => m.get(ym) || 0);
}

module.exports = { sparkline, miniSpark, donut, lastMonths, seriesOn };
