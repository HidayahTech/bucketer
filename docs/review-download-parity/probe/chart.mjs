// Minimal dependency-free SVG chart generator, written to be adapted into doclab.
//
// WHY NOT MERMAID: doclab renders diagrams through Mermaid, whose xychart support is
// limited and whose default labels are foreignObject elements that WeasyPrint does not
// render at all. Emitting plain SVG with real <text> nodes sidesteps both problems and
// gives exact control over type size, which is what the print-legibility gate cares about.
//
// PRINT LEGIBILITY: effective printed type size = fontSize x (printed width / svg width).
// At doclab's 6.7in content width, a 900px-wide chart scales by about 0.71, so 15px type
// prints at roughly 10.5pt — comfortably above the 9pt floor. Keep charts <= 900px wide and
// type >= 14px and the gate is satisfied by construction.
//
// USAGE
//   lineChart({ width, height, series, xTicks, xLabel, yLabel, xScale, title })
//   barChart({ width, height, groups, series, yLabel, title })
// Both return an SVG string. No runtime dependencies.

const PALETTE = ['#0892a3', '#6b21a8', '#b45309', '#166534'];
const INK = '#20202a';
const MUTED = '#5b5b66';
const GRID = '#d8d8e0';
const FONT = 'IBM Plex Sans, system-ui, sans-serif';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

function frame({ width, height, pad, yMax, yLabel, xLabel, title, yTicks = 5 }) {
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const y = v => pad.t + plotH - (v / yMax) * plotH;
  let s = '';

  if (title) {
    s += `<text x="${pad.l}" y="${pad.t - 26}" font-family="${FONT}" font-size="17" `
       + `font-weight="600" fill="${INK}">${esc(title)}</text>`;
  }

  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax / yTicks) * i;
    s += `<line x1="${pad.l}" y1="${y(v)}" x2="${pad.l + plotW}" y2="${y(v)}" `
       + `stroke="${GRID}" stroke-width="1"/>`
       + `<text x="${pad.l - 10}" y="${y(v) + 5}" text-anchor="end" font-family="${FONT}" `
       + `font-size="14" fill="${MUTED}">${Math.round(v)}</text>`;
  }

  if (yLabel) {
    s += `<text x="18" y="${pad.t + plotH / 2}" font-family="${FONT}" font-size="14" `
       + `fill="${MUTED}" transform="rotate(-90 18 ${pad.t + plotH / 2})" `
       + `text-anchor="middle">${esc(yLabel)}</text>`;
  }
  if (xLabel) {
    s += `<text x="${pad.l + plotW / 2}" y="${height - 12}" text-anchor="middle" `
       + `font-family="${FONT}" font-size="14" fill="${MUTED}">${esc(xLabel)}</text>`;
  }
  return { s, plotW, plotH, y };
}

function legend(series, x, yTop) {
  let s = '';
  series.forEach((ser, i) => {
    const yy = yTop + i * 22;
    s += `<line x1="${x}" y1="${yy}" x2="${x + 26}" y2="${yy}" stroke="${ser.color || PALETTE[i % PALETTE.length]}" stroke-width="3"/>`
       + `<text x="${x + 34}" y="${yy + 5}" font-family="${FONT}" font-size="14" fill="${INK}">${esc(ser.name)}</text>`;
  });
  return s;
}

// series: [{ name, color?, points: [[x, y], ...] }]
// xScale: 'log2' spaces powers of two evenly, which is what a size sweep wants.
export function lineChart({ width = 880, height = 460, series, xTicks, xLabel, yLabel,
                            xScale = 'log2', title }) {
  const pad = { l: 74, r: 196, t: 52, b: 54 };
  const allY = series.flatMap(s => s.points.map(p => p[1]));
  const yMax = niceCeil(Math.max(...allY, 1) * 1.08);

  const xs = xTicks;
  const pos = v => (xScale === 'log2'
    ? (Math.log2(v) - Math.log2(xs[0])) / (Math.log2(xs[xs.length - 1]) - Math.log2(xs[0]))
    : (v - xs[0]) / (xs[xs.length - 1] - xs[0]));

  const f = frame({ width, height, pad, yMax, yLabel, xLabel, title });
  const x = v => pad.l + pos(v) * f.plotW;

  let s = f.s;
  for (const v of xs) {
    s += `<text x="${x(v)}" y="${pad.t + f.plotH + 22}" text-anchor="middle" `
       + `font-family="${FONT}" font-size="14" fill="${MUTED}">${esc(v)}</text>`;
  }

  series.forEach((ser, i) => {
    const color = ser.color || PALETTE[i % PALETTE.length];
    const d = ser.points.map((p, j) => `${j ? 'L' : 'M'}${x(p[0]).toFixed(1)},${f.y(p[1]).toFixed(1)}`).join(' ');
    s += `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" `
       + `stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of ser.points) {
      s += `<circle cx="${x(p[0]).toFixed(1)}" cy="${f.y(p[1]).toFixed(1)}" r="4.5" `
         + `fill="#fff" stroke="${color}" stroke-width="2.5"/>`;
    }
  });

  s += legend(series, pad.l + f.plotW + 26, pad.t + 6);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
       + `viewBox="0 0 ${width} ${height}" role="img">`
       + `<rect width="${width}" height="${height}" fill="#fff"/>${s}</svg>`;
}

// groups: ['Chromium', ...]; series: [{ name, color?, values: [byGroup] }]
export function barChart({ width = 880, height = 420, groups, series, yLabel, title }) {
  const pad = { l: 74, r: 196, t: 52, b: 54 };
  const yMax = niceCeil(Math.max(...series.flatMap(s => s.values), 1) * 1.08);
  const f = frame({ width, height, pad, yMax, yLabel, title });

  const gw = f.plotW / groups.length;
  const bw = Math.min(46, (gw * 0.74) / series.length);
  let s = f.s;

  groups.forEach((g, gi) => {
    const cx = pad.l + gw * (gi + 0.5);
    s += `<text x="${cx}" y="${pad.t + f.plotH + 22}" text-anchor="middle" `
       + `font-family="${FONT}" font-size="14" fill="${MUTED}">${esc(g)}</text>`;
    series.forEach((ser, si) => {
      const v = ser.values[gi];
      if (v == null) return;
      const bx = cx - (series.length * bw) / 2 + si * bw;
      const by = f.y(v);
      s += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 4).toFixed(1)}" `
         + `height="${(pad.t + f.plotH - by).toFixed(1)}" fill="${ser.color || PALETTE[si % PALETTE.length]}"/>`
         + `<text x="${(bx + (bw - 4) / 2).toFixed(1)}" y="${(by - 7).toFixed(1)}" text-anchor="middle" `
         + `font-family="${FONT}" font-size="13" fill="${INK}">${Math.round(v)}</text>`;
    });
  });

  s += legend(series, pad.l + f.plotW + 26, pad.t + 6);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
       + `viewBox="0 0 ${width} ${height}" role="img">`
       + `<rect width="${width}" height="${height}" fill="#fff"/>${s}</svg>`;
}
