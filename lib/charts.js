'use strict';
// Inline-SVG chart helpers. Pure (depend only on esc for text escaping).
const { esc } = require('./format');

function sparkline(points) {
  if (!points.length) return '<p class="muted-text">No data yet.</p>';
  const W = 560, H = 200, P = 28;
  const xs = points.map((_, i) => P + (i * (W - P * 2)) / Math.max(1, points.length - 1));
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const yScale = (v) => H - P - ((v - min) / Math.max(1, max - min)) * (H - P * 2);
  const ys = points.map((p) => yScale(p.value));
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
  const area = `M ${xs[0]} ${H - P} L ${xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' L ')} L ${xs[xs.length - 1]} ${H - P} Z`;
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
function miniSpark(values, color) {
  const v = (values && values.length) ? values : [0, 0];
  const W = 96, H = 44, P = 3;
  const max = Math.max(...v, 1), min = Math.min(...v, 0);
  const xs = v.map((_, i) => P + (i * (W - 2 * P)) / Math.max(1, v.length - 1));
  const ys = v.map((val) => H - P - ((val - min) / Math.max(1, max - min)) * (H - 2 * P));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
  const area = `M${xs[0].toFixed(1)} ${H - P} L${xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' L')} L${xs[xs.length - 1].toFixed(1)} ${H - P} Z`;
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
