// Tiny dependency-free canvas charts (works offline, no CDN needed).

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
export function zoneColors() {
  return [1, 2, 3, 4, 5].map((z) => cssVar(`--z${z}`));
}

function setup(canvas) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.round(rect.width));
  const h = Math.max(10, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const font = getComputedStyle(document.body).fontFamily;
  const base = parseFloat(canvas.dataset.font || '') || (w > 900 ? 14 : 11);
  return { ctx, w, h, font, base };
}

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function hexA(color, alpha) {
  // accepts #rrggbb or rgb(); returns rgba
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * Heart-rate line chart with zone bands, lap markers and gaps.
 * opts: { points:[{x:sec, y:bpm}], xMin, xMax, bounds:[z2,z3,z4,z5], laps:[sec], gaps:[{from,to}], minimal }
 */
export function drawHrChart(canvas, opts) {
  const { ctx, w, h, font, base } = setup(canvas);
  const colors = zoneColors();
  const text2 = cssVar('--text-2'); const grid = cssVar('--line');
  const pts = opts.points || [];
  const ys = pts.map((p) => p.y).filter(Boolean);
  const bounds = opts.bounds || [114, 133, 152, 171];
  let yMin = Math.min(...ys, bounds[0] - 10); let yMax = Math.max(...ys, bounds[3] + 6);
  yMin = Math.max(30, Math.floor((yMin - 5) / 10) * 10); yMax = Math.ceil((yMax + 5) / 10) * 10;
  const xMin = opts.xMin ?? (pts[0]?.x ?? 0); const xMax = Math.max(opts.xMax ?? (pts[pts.length - 1]?.x ?? 60), xMin + 10);
  const padL = base * 3.2, padR = base * 0.8, padT = base * 0.8, padB = base * 2.2;
  const X = (x) => padL + ((x - xMin) / (xMax - xMin)) * (w - padL - padR);
  const Y = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (h - padT - padB);

  // zone bands
  const edges = [yMin, ...bounds, yMax];
  for (let z = 0; z < 5; z++) {
    const lo = Math.max(yMin, edges[z]), hi = Math.min(yMax, edges[z + 1]);
    if (hi <= lo) continue;
    ctx.fillStyle = hexA(colors[z], 0.09);
    ctx.fillRect(padL, Y(hi), w - padL - padR, Y(lo) - Y(hi));
  }
  ctx.font = `${base}px ${font}`;
  ctx.fillStyle = text2; ctx.strokeStyle = grid; ctx.lineWidth = 1;
  // y grid
  const ys2 = niceStep(yMax - yMin, h > 300 ? 6 : 4);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let y = Math.ceil(yMin / ys2) * ys2; y <= yMax; y += ys2) {
    ctx.beginPath(); ctx.moveTo(padL, Y(y) + 0.5); ctx.lineTo(w - padR, Y(y) + 0.5); ctx.stroke();
    ctx.fillText(String(y), padL - base * 0.4, Y(y));
  }
  // x labels
  const xs = niceStep(xMax - xMin, w > 700 ? 8 : 4);
  const xStep = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => s >= xs) || 3600;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
    edgeText(ctx, opts.xLabel ? opts.xLabel(x) : fmtClock(x), X(x), h - padB + base * 0.5, w);
  }
  // gaps
  for (const g of opts.gaps || []) {
    const a = X(Math.max(xMin, g.from)), b = X(Math.min(xMax, g.to));
    if (b > a) {
      ctx.fillStyle = hexA(cssVar('--text-1') || '#888888', 0.06);
      ctx.fillRect(a, padT, b - a, h - padT - padB);
    }
  }
  // laps
  ctx.setLineDash([4, 4]); ctx.strokeStyle = text2;
  (opts.laps || []).forEach((lx, i) => {
    if (lx < xMin || lx > xMax) return;
    ctx.beginPath(); ctx.moveTo(X(lx) + 0.5, padT); ctx.lineTo(X(lx) + 0.5, h - padB); ctx.stroke();
    ctx.fillStyle = text2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`L${i + 2}`, X(lx) + 3, padT + 2);
  });
  ctx.setLineDash([]);
  // line, colored per zone
  ctx.lineWidth = opts.lineWidth || (w > 900 ? 3 : 2); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!a.y || !b.y || b.x - a.x > 6 || b.x < xMin) continue;
    const z = zoneIdx(b.y, bounds);
    ctx.strokeStyle = colors[z];
    ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); ctx.stroke();
  }
  // live dot
  const last = pts[pts.length - 1];
  if (opts.live && last?.y) {
    ctx.fillStyle = colors[zoneIdx(last.y, bounds)];
    ctx.beginPath(); ctx.arc(X(last.x), Y(last.y), ctx.lineWidth * 2, 0, Math.PI * 2); ctx.fill();
  }
  if (!pts.length) {
    ctx.fillStyle = text2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(opts.empty || 'Waiting for heart rate…', w / 2, h / 2);
  }
}

/** Centered label that is nudged inward when it would be clipped at either edge. */
function edgeText(ctx, text, x, y, w) {
  const half = ctx.measureText(text).width / 2;
  ctx.textAlign = 'center';
  ctx.fillText(text, Math.min(w - half - 1, Math.max(half + 1, x)), y);
}

function zoneIdx(y, bounds) {
  let z = 0;
  for (let i = 0; i < bounds.length; i++) if (y >= bounds[i]) z = i + 1;
  return z;
}

/**
 * Bar chart. opts: { labels:[], series:[{values:[], color}], stacked, yFmt, yLabel }
 */
export function drawBars(canvas, opts) {
  const { ctx, w, h, font, base } = setup(canvas);
  const text2 = cssVar('--text-2'); const grid = cssVar('--line');
  const n = opts.labels.length;
  const totals = opts.labels.map((_, i) => opts.stacked
    ? opts.series.reduce((a, s) => a + (s.values[i] || 0), 0)
    : Math.max(...opts.series.map((s) => s.values[i] || 0)));
  const maxV = Math.max(1, ...totals);
  const step = niceStep(maxV, 4); const top = Math.ceil(maxV / step) * step;
  const padL = base * 3.2, padR = base * 0.5, padT = base * 0.8, padB = base * 2.2;
  const Y = (v) => padT + (1 - v / top) * (h - padT - padB);
  ctx.font = `${base}px ${font}`; ctx.strokeStyle = grid; ctx.fillStyle = text2;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= top + 1e-9; v += step) {
    ctx.beginPath(); ctx.moveTo(padL, Y(v) + 0.5); ctx.lineTo(w - padR, Y(v) + 0.5); ctx.stroke();
    ctx.fillText(opts.yFmt ? opts.yFmt(v) : String(Math.round(v)), padL - base * 0.4, Y(v));
  }
  const slot = (w - padL - padR) / Math.max(1, n);
  const bw = Math.max(2, Math.min(slot * 0.62, 48));
  const every = Math.ceil(n / Math.max(1, Math.floor((w - padL) / (base * 4.5))));
  for (let i = 0; i < n; i++) {
    const cx = padL + slot * (i + 0.5);
    let acc = 0;
    opts.series.forEach((s, si) => {
      const v = s.values[i] || 0;
      if (!v) return;
      const x = opts.stacked ? cx - bw / 2 : cx - bw / 2 + (bw / opts.series.length) * si;
      const bwi = opts.stacked ? bw : bw / opts.series.length;
      const y0 = opts.stacked ? Y(acc + v) : Y(v); const y1 = opts.stacked ? Y(acc) : Y(0);
      ctx.fillStyle = s.color;
      roundRect(ctx, x, y0, bwi, Math.max(1, y1 - y0), opts.stacked ? 2 : 4);
      if (opts.stacked) acc += v;
    });
    if (i % every === 0) {
      ctx.fillStyle = text2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(opts.labels[i], cx, h - padB + base * 0.5);
    }
  }
}

/** Line chart for a per-session series. opts: { points:[{x:index or time, y}], labels:fn, color } */
export function drawLine(canvas, opts) {
  const { ctx, w, h, font, base } = setup(canvas);
  const text2 = cssVar('--text-2'); const grid = cssVar('--line');
  const pts = opts.points.filter((p) => p.y != null);
  ctx.font = `${base}px ${font}`;
  if (!pts.length) { emptyMsg(ctx, w, h, text2, opts.empty); return; }
  let yMin = Math.min(...pts.map((p) => p.y)), yMax = Math.max(...pts.map((p) => p.y));
  const pad = Math.max(5, (yMax - yMin) * 0.15); yMin = Math.floor((yMin - pad) / 5) * 5; yMax = Math.ceil((yMax + pad) / 5) * 5;
  const xMin = pts[0].x, xMax = pts.length > 1 ? pts[pts.length - 1].x : pts[0].x + 1;
  const padL = base * 3.2, padR = base * 0.8, padT = base * 0.8, padB = base * 2.2;
  const X = (x) => padL + ((x - xMin) / ((xMax - xMin) || 1)) * (w - padL - padR);
  const Y = (y) => padT + (1 - (y - yMin) / ((yMax - yMin) || 1)) * (h - padT - padB);
  ctx.strokeStyle = grid; ctx.fillStyle = text2; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const st = niceStep(yMax - yMin, 4);
  for (let y = Math.ceil(yMin / st) * st; y <= yMax; y += st) {
    ctx.beginPath(); ctx.moveTo(padL, Y(y) + 0.5); ctx.lineTo(w - padR, Y(y) + 0.5); ctx.stroke();
    ctx.fillText(String(y), padL - base * 0.4, Y(y));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const every = Math.ceil(pts.length / Math.max(1, Math.floor((w - padL) / (base * 5))));
  pts.forEach((p, i) => { if (i % every === 0 && opts.label) edgeText(ctx, opts.label(p), X(p.x), h - padB + base * 0.5, w); });
  ctx.strokeStyle = opts.color || cssVar('--accent'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)))); ctx.stroke();
  ctx.fillStyle = opts.color || cssVar('--accent');
  pts.forEach((p) => { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2); ctx.fill(); });
}

/** Scatter. opts: { points:[{x,y}], xLabel, yLabel, xMin, xMax } */
export function drawScatter(canvas, opts) {
  const { ctx, w, h, font, base } = setup(canvas);
  const text2 = cssVar('--text-2'); const grid = cssVar('--line');
  ctx.font = `${base}px ${font}`;
  const pts = opts.points;
  if (!pts.length) { emptyMsg(ctx, w, h, text2, opts.empty); return; }
  const xMin = opts.xMin ?? 0, xMax = opts.xMax ?? 10;
  let yMin = Math.min(...pts.map((p) => p.y)), yMax = Math.max(...pts.map((p) => p.y));
  yMin = Math.floor((yMin - 8) / 10) * 10; yMax = Math.ceil((yMax + 8) / 10) * 10;
  const padL = base * 3.2, padR = base * 0.8, padT = base * 0.8, padB = base * 2.6;
  const X = (x) => padL + ((x - xMin) / (xMax - xMin)) * (w - padL - padR);
  const Y = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (h - padT - padB);
  ctx.strokeStyle = grid; ctx.fillStyle = text2; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const st = niceStep(yMax - yMin, 4);
  for (let y = Math.ceil(yMin / st) * st; y <= yMax; y += st) {
    ctx.beginPath(); ctx.moveTo(padL, Y(y) + 0.5); ctx.lineTo(w - padR, Y(y) + 0.5); ctx.stroke();
    ctx.fillText(String(y), padL - base * 0.4, Y(y));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let x = xMin; x <= xMax; x += 2) edgeText(ctx, String(x), X(x), h - padB + base * 0.4, w);
  if (opts.xLabel) ctx.fillText(opts.xLabel, (padL + w) / 2, h - base * 1.2);
  const colors = zoneColors();
  pts.forEach((p) => {
    ctx.fillStyle = hexA(p.color || colors[3], 0.8);
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 5, 0, Math.PI * 2); ctx.fill();
  });
}

function emptyMsg(ctx, w, h, color, msg) {
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(msg || 'No data yet', w / 2, h / 2);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath(); ctx.fill();
}
