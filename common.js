'use strict';
/* Stats-Zor shared helpers, loaded by index.html and goalies.html before the page script. */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nz = v => v !== null && v !== undefined && !Number.isNaN(v);
const sub = (a, b) => nz(a) && nz(b) ? a - b : null;
const share = (f, a) => nz(f) && nz(a) && f + a > 0 ? 100 * f / (f + a) : null;
const avg = a => { const v = a.filter(nz); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const f0 = v => nz(v) ? Math.round(v).toLocaleString() : '—';
const f1 = v => nz(v) ? v.toFixed(1) : '—';
const f2 = v => nz(v) ? v.toFixed(2) : '—';
const s1 = v => nz(v) ? (v > 0 ? '+' : '') + v.toFixed(1) : '—';
const s2 = v => nz(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '—';
const fmin = v => { if (!nz(v)) return '—'; let m = Math.floor(v), s = Math.round((v - m) * 60); if (s === 60) { m++; s = 0; } return m + ':' + String(s).padStart(2, '0'); };
const sLabel = y => `${y}-${String(y + 1).slice(2)}`;
const last = n => (n || '').split(' ').slice(-1)[0];
const ord = n => !nz(n) ? '—' : n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const getJSON = async url => { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };
function safe(id, fn) { try { fn(); } catch (e) { console.error(id, e); const el = $(id); if (el) el.insertAdjacentHTML('beforeend', `<p class="empty">This section hit an error: ${esc(e.message)}</p>`); } }
const awardLine = list => { const c = {}; list.forEach(a => { c[a] = (c[a] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => v > 1 ? `${k} ×${v}` : k).join(', ') || '—'; };
const ageNow = (birth, y) => { if (!birth) return null; const b = new Date(birth + 'T00:00:00'); const ref = new Date(y + 1, 1, 1); let a = ref.getFullYear() - b.getFullYear(); if (ref < new Date(ref.getFullYear(), b.getMonth(), b.getDate())) a--; return a; };
const htFmt = h => nz(h) && h ? `${Math.floor(h / 12)}'${h % 12}"` : '';
function makeSearch(inputId, onPick, opts = {}) {
  const inp = $(inputId), ul = inp.parentElement.querySelector('.sugg');
  let items = [], sel = -1;
  const close = () => { ul.hidden = true; sel = -1; };
  const show = () => {
    const q = norm(inp.value.trim());
    if (q.length < 2) { close(); return; }
    const toks = q.split(/\s+/);
    const res = [];
    for (const p of (opts.list ? opts.list() : S.idx.list)) {
      if (opts.filter && !opts.filter(p)) continue;
      const n = p.n;
      if (toks.every(t => n.includes(t))) {
        let sc = p.gp; if (n.startsWith(q)) sc += 1e6; else if (n.split(' ').some(w => w.startsWith(toks[0]))) sc += 5e5;
        res.push([sc, p]);
      }
    }
    res.sort((a, b) => b[0] - a[0]);
    items = res.slice(0, 12).map(r => r[1]);
    ul.innerHTML = items.length ? items.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">${esc(p.name)}<small>${p.pos === 'G' ? 'Goalie' : p.pos} · ${p.first}–${String(p.last + 1).slice(2)} · ${esc(p.team)}</small></li>`).join('') : '<li class="empty">No match</li>';
    ul.hidden = false;
  };
  inp.addEventListener('input', () => { sel = -1; show(); });
  inp.addEventListener('focus', () => { if (inp.value.trim().length >= 2) show(); });
  inp.addEventListener('keydown', e => {
    if (ul.hidden) return;
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { const p = items[Math.max(0, sel)]; if (p) { pick(p); } e.preventDefault(); return; }
    else if (e.key === 'Escape') { close(); return; }
    else return;
    ul.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', i === sel));
  });
  ul.addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(items[+li.dataset.i]); } });
  inp.addEventListener('blur', () => setTimeout(close, 150));
  function pick(p) { close(); inp.value = opts.keep ? p.name : ''; inp.blur(); const url = opts.cross && opts.cross(p); if (url) { location.href = url; return; } onPick(p.id); }
}
function axes(W, H, m, xd, yd, xt, yt, xl, yl, xf, yf) {
  const X = v => m.l + (v - xd[0]) / (xd[1] - xd[0]) * (W - m.l - m.r);
  const Y = v => H - m.b - (v - yd[0]) / (yd[1] - yd[0]) * (H - m.t - m.b);
  let s = '';
  xt.forEach(v => { s += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}" class="ax" stroke-dasharray="2 4"/><text x="${X(v)}" y="${H - m.b + 15}" text-anchor="middle" class="lab">${xf ? xf(v) : v}</text>`; });
  yt.forEach(v => { s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="ax" stroke-dasharray="2 4"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="lab">${yf ? yf(v) : v}</text>`; });
  if (xl) s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle" font-size="12" font-weight="600">${esc(xl)}</text>`;
  if (yl) s += `<text transform="translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="600">${esc(yl)}</text>`;
  return { X, Y, s };
}
function niceStep(range, target = 6) { const raw = range / target; const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
function ticks(a, b, st) { const o = []; for (let v = Math.ceil(a / st - 1e-9) * st; v <= b + 1e-9; v += st) o.push(+v.toFixed(6)); return o; }
function extent(vals, pad = 0.06) { const v = vals.filter(nz); if (!v.length) return [0, 1]; let lo = Math.min(...v), hi = Math.max(...v); if (lo === hi) { lo -= 1; hi += 1; } const p = (hi - lo) * pad; return [lo - p, hi + p]; }
function placeLabels(svg) {
  const labs = [...svg.querySelectorAll('text[data-l]')].sort((a, b) => +a.getAttribute('y') - +b.getAttribute('y'));
  const placed = [];
  for (const t of labs) {
    const x = +t.getAttribute('x'); let y = +t.getAttribute('y');
    for (let k = 0; k < 6; k++) { const hit = placed.find(q => Math.abs(q[0] - x) < 70 && Math.abs(q[1] - y) < 12); if (!hit) break; y = hit[1] + 13; }
    t.setAttribute('y', y); placed.push([x, y]);
  }
}
function heat(v) {
  if (!nz(v)) return 'transparent';
  return v < 50 ? `color-mix(in srgb, var(--mid) ${v * 2}%, var(--lo))` : `color-mix(in srgb, var(--hi) ${(v - 50) * 2}%, var(--mid))`;
}
const median = a => { const v = a.filter(nz).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
const money = v => nz(v) ? '$' + v.toFixed(v >= 10 ? 1 : 2) + 'M' : '—';
// players on the other page: goalies live on goalies.html, skaters on index.html
const crossTo = isGoaliePage => p => (p.pos === 'G') === isGoaliePage ? null : `${isGoaliePage ? './' : 'goalies.html'}#a=${p.id}`;

// ------------------------------------------------------------------ smoothed shot maps
// The shot files hold 5 x 5 ft cells. For the smoothed view each quantity is averaged over nearby cells
// with a Gaussian weight (SMOOTH_SIGMA feet), sampled every 1.25 ft into a small canvas, and placed as an
// <image> inside the rink SVG (clipped to the rink like the cells).
const SMOOTH_SIGMA = 7;
function cssRGB(name) {
  const el = document.createElement('i'); el.style.color = `var(${name})`; el.style.display = 'none';
  document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove();
  const m = c.match(/[\d.]+/g) || [128, 128, 128]; return m.slice(0, 3).map(Number);
}
// layers: arrays of per-cell values (index cy * nx + cx); combine(avgs) returns [t in -1..1, alpha 0..1]
function smoothHeat(G, k, layers, combine, posVar, negVar) {
  const s = 4, cw = G.ny * s, ch = G.nx * s, sg = SMOOTH_SIGMA, R = 3 * sg, two = 2 * sg * sg;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d'); if (!ctx) return '';
  const img = ctx.createImageData(cw, ch);
  const pos = cssRGB(posVar), neg = cssRGB(negVar), mid = cssRGB('--mid');
  const L = layers.length, acc = new Float64Array(L);
  for (let py = 0; py < ch; py++) {
    const x = G.x1 - (py + 0.5) * G.cell / s;
    const cx0 = Math.max(0, Math.floor((x - R - G.x0) / G.cell)), cx1 = Math.min(G.nx - 1, Math.floor((x + R - G.x0) / G.cell));
    for (let px = 0; px < cw; px++) {
      const y = G.y0 + (px + 0.5) * G.cell / s;
      const cy0 = Math.max(0, Math.floor((y - R - G.y0) / G.cell)), cy1 = Math.min(G.ny - 1, Math.floor((y + R - G.y0) / G.cell));
      acc.fill(0); let ws = 0;
      for (let cy = cy0; cy <= cy1; cy++) {
        const dy = G.y0 + (cy + 0.5) * G.cell - y;
        for (let cx = cx0; cx <= cx1; cx++) {
          const dx = G.x0 + (cx + 0.5) * G.cell - x; const w = Math.exp(-(dx * dx + dy * dy) / two);
          const c = cy * G.nx + cx; ws += w;
          for (let l = 0; l < L; l++) acc[l] += w * layers[l][c];
        }
      }
      for (let l = 0; l < L; l++) acc[l] /= ws || 1;
      const [t0, a0] = combine(acc); const t = Math.max(-1, Math.min(1, t0 || 0)), a = Math.max(0, Math.min(1, a0 || 0));
      const to = t >= 0 ? pos : neg, f = Math.abs(t), i = (py * cw + px) * 4;
      img.data[i] = mid[0] + (to[0] - mid[0]) * f; img.data[i + 1] = mid[1] + (to[1] - mid[1]) * f; img.data[i + 2] = mid[2] + (to[2] - mid[2]) * f; img.data[i + 3] = 255 * a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return `<image href="${cv.toDataURL()}" x="0" y="0" width="${G.ny * G.cell * k}" height="${G.nx * G.cell * k}" preserveAspectRatio="none"/>`;
}
// per-cell arrays from a Map of cells {n, g, xg}
function cellArrays(G, m) {
  const N = G.nx * G.ny, n = new Float64Array(N), g = new Float64Array(N), xg = new Float64Array(N);
  for (const [c, v] of m) { if (c < N) { n[c] = v.n; g[c] = v.g; xg[c] = v.xg; } }
  return { n, g, xg };
}
// redraw when the theme changes (toggle or device setting)
(function () {
  const fire = () => window.dispatchEvent(new Event('themechange'));
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fire); } catch (e) { /* old browsers */ }
  new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
