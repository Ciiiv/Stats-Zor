'use strict';
/* Stats-Zor goalie page. Runs in the browser from data/goalies/ and data/value.json.
   Shared helpers ($, esc, formatters, svg axes, search) come from common.js. */

const fsv = v => nz(v) ? v.toFixed(3).replace(/^0/, '') : '—';
const f3 = v => nz(v) ? v.toFixed(3) : '—';
const BASE_GAA = 3.0;   // era adjustment: goals against per team per game in a 6.0-goal league
const GMAJOR = ['Vezina', 'Hart', 'Jennings', 'Conn Smythe', 'Calder', 'Lindsay'];

// ------------------------------------------------------------------ state
const S = {
  idx: null, byId: new Map(), seasons: {}, games: {}, shots: {}, cache: {},
  A: null, B: null, season: null,
  pool: 'reg', w: { d: 50, o: 30, c: 20 }, extra: [], removed: new Set(), sortKey: null, showPct: false,
  boardMode: 'top', cmode: 'age', arcMetric: 'svp', arcSel: [], swapTeam: null, swapOut: null, lineupTeam: null,
  sh: { sit: 'all', view: 'freq', smooth: true },
};

// ------------------------------------------------------------------ metrics
const MET = {
  gp: { l: 'GP', f: f0, role: 1 }, gs: { l: 'Starts', f: f0, role: 1 }, sa60: { l: 'Shots/60 faced', f: f1, role: 1 },
  xga60: { l: 'xGA/60 faced', f: f2, role: 1 }, xgps: { l: 'xG per shot', f: f3, role: 1 },
  sv: { l: 'Save %', f: fsv }, gaa: { l: 'GAA', f: f2, lo: 1 }, gsax: { l: 'GSAx', f: s1 }, gsax60: { l: 'GSAx/60', f: s2 },
  dsv: { l: 'Sv% vs exp.', f: s2 },
  hd_dsv: { l: 'High-danger sv% vs exp.', f: s1 }, md_dsv: { l: 'Mid-danger sv% vs exp.', f: s1 }, ld_dsv: { l: 'Low-danger sv% vs exp.', f: s1 },
  gsax5_60: { l: '5v5 GSAx/60', f: s2 }, pk_gsax60: { l: 'PK GSAx/60', f: s2 },
  reb60: { l: 'Rebounds vs exp. /60', f: s2, lo: 1 }, frz60: { l: 'Freezes vs exp. /60', f: s2 },
  w: { l: 'Wins', f: f0 }, so: { l: 'Shutouts', f: f0 },
};
const COLS = [['Workload', ['gp', 'gs', 'sa60', 'xga60', 'xgps']], ['Results', ['sv', 'gaa', 'gsax', 'gsax60', 'dsv']],
  ['By shot danger', ['hd_dsv', 'md_dsv', 'ld_dsv']], ['By situation', ['gsax5_60', 'pk_gsax60']], ['Puck control', ['reb60', 'frz60']], ['Record', ['w', 'so']]];
const SIMKEYS = ['gs', 'sa60', 'xga60', 'xgps', 'sv', 'gsax60', 'dsv', 'hd_dsv', 'md_dsv', 'ld_dsv', 'gsax5_60', 'pk_gsax60', 'reb60', 'frz60'];
const COMP = { d: ['gsax60', 'dsv', 'gsax5_60'], o: ['hd_dsv', 'md_dsv', 'ld_dsv', 'pk_gsax60', 'reb60'], c: ['gs', 'sa60', 'xga60'] };
const RADAR = [['gsax60', 'GSAx/60'], ['gsax5_60', '5v5 GSAx/60'], ['hd_dsv', 'High danger'], ['md_dsv', 'Mid danger'], ['ld_dsv', 'Low danger'], ['pk_gsax60', 'Penalty kill'], ['reb60', 'Rebound control'], ['gs', 'Workload']];
const POOLS = { reg: { l: 'Regulars' }, st: { l: 'Starters' } };
const PRESETS = [['Balanced', 50, 30, 20], ['Pure saves', 60, 40, 0], ['Workhorse', 35, 25, 40]];

function derive(p) {
  const h = p.toi / 60;
  p.h = h;
  p.sv = p.sa ? 1 - p.ga / p.sa : null;
  p.xsv = p.sa ? 1 - p.xga / p.sa : null;
  p.dsv = p.sa ? 100 * (p.xga - p.ga) / p.sa : null;
  p.gsax = p.xga - p.ga;
  p.gsax60 = h ? p.gsax / h : null;
  p.gaa = h ? p.ga / h : null;
  p.sa60 = h ? p.sa / h : null;
  p.xga60 = h ? p.xga / h : null;
  p.xgps = p.fa ? p.xga / p.fa : null;
  p.gsax5_60 = p.t5 >= 60 ? (p.xga5 - p.ga5) / (p.t5 / 60) : null;
  p.pk_gsax60 = p.tpk >= 60 ? (p.xgapk - p.gapk) / (p.tpk / 60) : null;
  const dz = (n, x, g) => n >= 15 ? 100 * (x - g) / n : null;
  p.hd_dsv = dz(p.hd_n, p.hd_x, p.hd_g); p.md_dsv = dz(p.md_n, p.md_x, p.md_g); p.ld_dsv = dz(p.ld_n, p.ld_x, p.ld_g);
  p.reb60 = h >= 1 ? (p.reb - p.xreb) / h : null;
  p.frz60 = h >= 1 ? (p.frz - p.xfrz) / h : null;
  if (!nz(p.gs)) p.gs = p.gp;
  p.pos = 'G';
  return p;
}

// ------------------------------------------------------------------ data
async function loadSeason(y) {
  if (S.seasons[y]) return S.seasons[y];
  const j = await getJSON(`data/goalies/seasons/${y}.json`);
  const players = j.players.map(r => { const o = {}; j.fields.forEach((k, i) => { o[k] = r[i]; }); return derive(o); });
  players.forEach(p => { const ix = S.byId.get(p.id); if (ix && ix.name) p.name = ix.name; });  // index names keep accents
  const sd = { y, gpmax: j.team_gp || j.gpmax, teams: j.teams, players, byId: new Map(players.map(p => [p.id, p])) };
  S.seasons[y] = sd;
  return sd;
}
async function loadGames(y) {
  if (S.games[y] !== undefined) return S.games[y];
  try {
    const j = await getJSON(`data/goalies/games/${y}.json`);
    const by = new Map();
    for (const [id, rows] of Object.entries(j.players)) by.set(+id, rows.map(r => { const o = {}; j.fields.forEach((k, i) => { o[k] = r[i]; }); return o; }));
    S.games[y] = { by, teamDates: j.team_dates || null, teamGames: j.team_games || {} };
  } catch (e) { S.games[y] = null; }
  return S.games[y];
}
async function loadShots(y) {
  if (S.shots[y] !== undefined) return S.shots[y];
  try { S.shots[y] = await getJSON(`data/goalies/shots/${y}.json`); } catch (e) { S.shots[y] = null; }
  return S.shots[y];
}
const minGp = sd => Math.max(5, Math.round(0.25 * sd.gpmax));
function pool(sd, key = S.pool) {
  const ck = `${sd.y}|${key}`;
  if (S.cache[ck]) return S.cache[ck];
  const list = sd.players.filter(p => p.gp >= minGp(sd) && (key !== 'st' || p.gs >= Math.round(0.45 * sd.gpmax)));
  return (S.cache[ck] = { list, sorted: {} });
}
function pctl(sd, k, v) {
  if (!nz(v)) return null;
  const P = pool(sd);
  const arr = P.sorted[k] || (P.sorted[k] = P.list.map(p => p[k]).filter(nz).sort((a, b) => a - b));
  if (!arr.length) return null;
  let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  let eq = lo; while (eq < arr.length && arr[eq] === v) eq++;
  const raw = (lo + (eq - lo) / 2) / arr.length * 100;
  return Math.round(MET[k] && MET[k].lo ? 100 - raw : raw);
}
const pk = (sd, p, k) => pctl(sd, k, p[k]);
function scores(sd, p) {
  const ck = `sc|${sd.y}|${S.pool}|${p.id}`;
  if (S.cache[ck]) return S.cache[ck];
  const part = keys => avg(keys.map(k => pk(sd, p, k)));
  return (S.cache[ck] = { d: part(COMP.d), o: part(COMP.o), c: part(COMP.c) });
}
function composite(sc) { const { d, o, c } = S.w; const t = (d + o + c) || 1; return ((sc.d ?? 50) * d + (sc.o ?? 50) * o + (sc.c ?? 50) * c) / t; }
const seasonOf = id => { const sd = S.seasons[S.season]; return sd ? sd.byId.get(id) : null; };
const nameOf = id => (S.byId.get(id) || {}).name || String(id);

// ------------------------------------------------------------------ careers (NHL since 1917-18)
let CAR = null;
async function loadCareers() {
  if (CAR) return CAR;
  const [c, m] = await Promise.all([getJSON('data/goalies/careers.json'), getJSON('data/goalies/mp_careers.json').catch(() => ({ fields: [], rows: [] }))]);
  const rowsBy = new Map();
  for (const r of c.seasons) { const o = {}; c.fields.forEach((k, i) => { o[k] = r[i]; }); if (!rowsBy.has(o.id)) rowsBy.set(o.id, []); rowsBy.get(o.id).push(o); }
  const mpBy = new Map();
  for (const r of m.rows) { const o = {}; m.fields.forEach((k, i) => { o[k] = r[i]; }); if (!mpBy.has(o.id)) mpBy.set(o.id, new Map()); mpBy.get(o.id).set(o.y, o); }
  const players = {}; for (const [k, v] of Object.entries(c.players)) players[+k] = v;
  const awards = {}; for (const [k, v] of Object.entries(c.awards || {})) awards[+k] = v;
  const league = {}; for (const [k, v] of Object.entries(c.league)) league[+k] = v;
  CAR = { players, rowsBy, mpBy, awards, league, memo: new Map() };
  return CAR;
}
function careerOf(id) {
  if (!CAR) return null;
  if (CAR.memo.has(id)) return CAR.memo.get(id);
  const bio = CAR.players[id]; const rows = CAR.rowsBy.get(id) || [];
  if (!bio && !rows.length) { CAR.memo.set(id, null); return null; }
  const aw = CAR.awards[id] || []; const mp = CAR.mpBy.get(id) || new Map(); const cur = S.idx.current;
  const Ss = rows.map(r => {
    const lg = CAR.league[r.y] || {};
    const sv = r.sa ? 1 - r.ga / r.sa : null;
    const gaa = r.toi ? r.ga / r.toi * 60 : null;
    const m = mp.get(r.y);
    return {
      ...r, sv, gaa, lgsv: lg.sv, svp: nz(sv) && lg.sv ? 1000 * (sv - lg.sv) : null, gsaa: r.sa && lg.sv ? r.sa * (1 - lg.sv) - r.ga : null,
      egaa: nz(gaa) && lg.gaa ? gaa * BASE_GAA / lg.gaa : null, full: r.gp >= 20 && r.y !== cur, partial: r.y === cur,
      aw: aw.filter(a => a[1] === r.y).map(a => a[0]), gsax: m ? m.xga - m.ga : null, mptoi: m ? m.toi : 0,
    };
  });
  const c = { id, name: bio ? bio[0] : nameOf(id), catches: bio && bio[2], birth: bio && bio[3], ht: bio && bio[4], wt: bio && bio[5], hof: bio && bio[6], awards: aw, S: Ss };
  CAR.memo.set(id, c);
  return c;
}
function ctot(Ss) {
  const t = k => Ss.reduce((a, s) => a + (s[k] || 0), 0);
  const withSa = Ss.filter(s => s.sa && nz(s.gsaa));
  const sa = withSa.reduce((a, s) => a + s.sa, 0), gsaa = withSa.reduce((a, s) => a + s.gsaa, 0), gaSa = withSa.reduce((a, s) => a + s.ga, 0);
  const et = Ss.filter(s => nz(s.egaa) && s.toi); const etoi = et.reduce((a, s) => a + s.toi, 0);
  const mp = Ss.filter(s => nz(s.gsax)); const mtoi = mp.reduce((a, s) => a + s.mptoi, 0);
  const aw = Ss.flatMap(s => s.aw);
  const gp = t('gp'), w = t('w'), dec = w + t('l') + t('t') + t('otl');
  return {
    n: Ss.length, gp, gs: t('gs'), w, l: t('l'), tie: t('t'), otl: t('otl'), so: t('so'), ga: t('ga'), toi: t('toi'),
    wpct: dec ? w / dec : null, sv: sa ? 1 - gaSa / sa : null, svp: sa ? 1000 * gsaa / sa : null, gsaa: sa ? gsaa : null, saCover: gp ? withSa.reduce((a, s) => a + s.gp, 0) / gp : 0,
    gaa: t('toi') ? t('ga') / t('toi') * 60 : null, egaa: etoi ? et.reduce((a, s) => a + s.egaa * s.toi, 0) / etoi : null,
    gsax: mp.length ? mp.reduce((a, s) => a + s.gsax, 0) : null, gsax60: mtoi ? mp.reduce((a, s) => a + s.gsax, 0) / mtoi * 60 : null, mptoi: mtoi,
    major: aw.filter(a => GMAJOR.includes(a)).length, vez: aw.filter(a => a === 'Vezina').length, cups: aw.filter(a => a === 'Cup').length, aw,
  };
}

// ------------------------------------------------------------------ profile
function renderProfile() {
  const card = (id, cls) => {
    if (!id) return `<div class="pcard ${cls}"><p class="empty">Pick a second goalie in the search box above to compare.</p></div>`;
    const ix = S.byId.get(id) || {}; const c = careerOf(id); const p = seasonOf(id); const sd = S.seasons[S.season];
    const age = c && c.birth ? ageNow(c.birth, S.season) : null;
    const meta = [p ? p.team : ix.team, 'G', c && c.catches ? `Catches ${c.catches}` : '', age ? `Age ${age}` : '', c ? [htFmt(c.ht), c.wt ? c.wt + ' lb' : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ');
    let tiles;
    if (p) {
      const sc = scores(sd, p);
      const rec = nz(p.w) ? `${p.w}-${p.l}-${p.otl}` : '—';
      const T = [[rec, `W-L-OTL in ${p.gp} GP, ${p.gs} starts`], [fsv(p.sv), 'Save %'], [f2(p.gaa), 'Goals-against avg.'], [s1(p.gsax), 'Goals saved above expected'],
        [s2(p.dsv), 'Sv% above expected (pts)'], [f0(sc.d), 'Stopping score'], [f0(sc.o), 'Danger & situations'], [f0(sc.c), 'Workload score']];
      tiles = `<p class="minihead">${sLabel(S.season)} · scores are percentiles vs goalies</p><div class="tiles">${T.map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join('')}</div>`;
    } else {
      tiles = `<p class="empty">No ${sLabel(S.season)} MoneyPuck data for ${esc(ix.name || '')}. ${ix.mask ? 'Pick one of his seasons in the Season box.' : 'Expected-goal stats start in 2008-09; the career sections below still work.'}</p>`;
    }
    let badges = '';
    if (c) {
      const t = ctot(c.S);
      const bs = [`${t.gp} GP · ${t.w} W · ${t.so} SO`, ...Object.entries(c.awards.reduce((o, a) => { o[a[0]] = (o[a[0]] || 0) + 1; return o; }, {})).map(([k, v]) => `<span class="badge gold">${esc(k)}${v > 1 ? ' ×' + v : ''}</span>`)];
      if (c.hof) bs.push('<span class="badge gold">Hall of Fame</span>');
      badges = `<div class="badges">${bs.map(b => b.startsWith('<') ? b : `<span class="badge">${b}</span>`).join('')}</div>`;
    }
    const team = p ? p.team : ix.team; const tc = teamColor(team); const num = jerseyNum(id, team);
    const meta2 = ['G', c && c.catches ? `Catches ${c.catches}` : '', age ? `Age ${age}` : '', c ? [htFmt(c.ht), c.wt ? c.wt + ' lb' : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ');
    return `<div class="pcard ${cls}${tc ? ' tc' : ''}"${tc ? ` style="--tc:${tc}"` : ''}>${nz(num) ? `<span class="jnum" aria-hidden="true">${num}</span>` : ''}<h1>${esc(ix.name || (c && c.name) || id)}</h1><p class="meta">${teamBadge(team)}${nz(num) ? `#${num} · ` : ''}${esc(meta2)}${nowLine(id, team)}</p>${tiles}${badges}</div>`;
  };
  $('sec-profile').innerHTML = `<div class="prof">${card(S.A, 'a')}${card(S.B, 'b')}</div>`;
}

// ------------------------------------------------------------------ ranking
function renderRank() {
  const sd = S.seasons[S.season]; const P = pool(sd);
  $('rank-sub').textContent = `Each score averages percentile ranks against ${P.list.length} goalies (${S.pool === 'st' ? `starters: ${Math.round(0.45 * sd.gpmax)}+ starts` : `regulars: ${minGp(sd)}+ games`}) in ${sLabel(S.season)}. Stopping is overall goals saved above expected; Danger & situations splits it by shot danger, the penalty kill and rebound control; Workload rewards carrying a heavy, hard load. Drag the weights to reorder.`;
  $('rank-ctl').innerHTML = `<span class="lbl">Pool</span><span class="toggle">${Object.entries(POOLS).map(([k, v]) => `<button type="button" data-pool="${k}" aria-pressed="${S.pool === k}">${v.l}</button>`).join('')}</span>
    <span class="lbl">Presets</span><span class="toggle">${PRESETS.map((p, i) => `<button type="button" data-pre="${i}" aria-pressed="${S.w.d === p[1] && S.w.o === p[2] && S.w.c === p[3]}">${p[0]}</button>`).join('')}</span>`;
  const t = (S.w.d + S.w.o + S.w.c) || 1;
  $('weights').innerHTML = [['d', 'Stopping'], ['o', 'Danger & situations'], ['c', 'Workload']].map(([k, l]) =>
    `<div><label for="w${k}">${l} <span class="mono">${Math.round(S.w[k] / t * 100)}%</span></label><input type="range" id="w${k}" data-w="${k}" min="0" max="100" value="${S.w[k]}"></div>`).join('');
  const list = P.list.map(p => { const sc = scores(sd, p); return { p, sc, s: composite(sc) }; }).sort((a, b) => b.s - a.s);
  const extra = [S.A, S.B].map(id => sd.byId.get(id)).filter(p => p && !P.list.includes(p)).map(p => { const sc = scores(sd, p); return { p, sc, s: composite(sc) }; });
  const top = 20; const html = []; let prev = 0;
  list.forEach((r, i) => {
    if (!(i < top || r.p.id === S.A || r.p.id === S.B)) return;
    if (i + 1 - prev > 1 && prev >= top) html.push('<div class="rrow gap">· · ·</div>');
    html.push(rrow(i + 1, r, t)); prev = i + 1;
  });
  extra.forEach(r => html.push(`<div class="rrow gap">Below the pool's games cutoff:</div>` + rrow('—', r, t)));
  $('rank').innerHTML = html.join('');
}
function rrow(rk, r, t) {
  const { p, sc } = r; const w = S.w; const cls = p.id === S.A ? 'isA' : p.id === S.B ? 'isB' : '';
  const d = (sc.d ?? 50) * w.d / t, o = (sc.o ?? 50) * w.o / t, c = (sc.c ?? 50) * w.c / t;
  return `<div class="rrow ${cls}"><span class="mono">${rk}</span><span class="nm" data-id="${p.id}" title="Make ${esc(p.name)} the main goalie">${esc(p.name)}<small>${p.team} · ${p.gp} GP · ${fsv(p.sv)} · ${s1(p.gsax)} GSAx</small></span>
    <div class="bar" title="Stopping ${f0(sc.d)} · Danger ${f0(sc.o)} · Workload ${f0(sc.c)}"><i class="seg-d" style="width:${d}%"></i><i class="seg-o" style="width:${o}%"></i><i class="seg-c" style="width:${c}%"></i></div><b class="mono">${f1(r.s)}</b></div>`;
}

// ------------------------------------------------------------------ stat board
function similarity(sd) {
  const ck = `sim|${sd.y}|${S.pool}|${S.A}`;
  if (S.cache[ck]) return S.cache[ck];
  const A = sd.byId.get(S.A); const pa = SIMKEYS.map(k => pk(sd, A, k)); const out = new Map();
  for (const p of pool(sd).list) {
    if (p.id === S.A) continue;
    let sum = 0, n = 0;
    SIMKEYS.forEach((k, i) => { const v = pk(sd, p, k); if (nz(v) && nz(pa[i])) { sum += (v - pa[i]) ** 2; n++; } });
    if (n >= SIMKEYS.length * 0.6) out.set(p.id, Math.max(0, 100 - Math.sqrt(sum / n)));
  }
  return (S.cache[ck] = out);
}
function boardIds(sd) {
  const auto = S.boardMode === 'sim' && sd.byId.get(S.A)
    ? [...similarity(sd).entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])
    : pool(sd).list.map(p => [composite(scores(sd, p)), p.id]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const ids = []; const add = id => { if (id && !ids.includes(id) && sd.byId.get(id)) ids.push(id); };
  add(S.A); add(S.B); S.extra.forEach(add);
  for (const id of auto) { if (ids.length >= 12 + S.extra.length) break; if (!S.removed.has(id)) add(id); }
  return ids;
}
function renderMatrix() {
  const sd = S.seasons[S.season]; const flat = COLS.flatMap(c => c[1]);
  const ps = boardIds(sd).map(id => sd.byId.get(id));
  if (S.sortKey) ps.sort((a, b) => (pk(sd, b, S.sortKey) ?? -1) - (pk(sd, a, S.sortKey) ?? -1));
  const simMap = S.boardMode === 'sim' ? similarity(sd) : null;
  $('mtoggle').innerHTML = `<button type="button" data-mode="top" aria-pressed="${S.boardMode !== 'sim'}">Fill with top-ranked</button><button type="button" data-mode="sim" aria-pressed="${S.boardMode === 'sim'}">Fill with most similar</button><button type="button" id="mv" aria-pressed="${S.showPct}">Show percentiles</button>${S.sortKey ? '<button type="button" id="ms">Clear sort</button>' : ''}`;
  let h = `<thead><tr><th></th>${COLS.map(g => `<th class="grp" colspan="${g[1].length}">${g[0]}</th>`).join('')}</tr><tr><th style="text-align:left">Goalie · team</th>${flat.map(k => `<th><button type="button" data-sort="${k}">${MET[k].l}${S.sortKey === k ? ' ▾' : ''}</button></th>`).join('')}</tr></thead><tbody>`;
  h += ps.map(p => {
    const cls = p.id === S.A ? 'isA' : p.id === S.B ? 'isB' : '';
    const rm = p.id === S.A ? '' : `<button type="button" data-rm="${p.id}" title="Remove from board">×</button>`;
    return `<tr class="${cls}"><td class="pn">${esc(p.name)} <span class="mono" style="color:var(--muted);font-weight:400">${p.team}</span>${simMap && simMap.has(p.id) ? `<span class="mono" style="color:var(--b);font-weight:600;font-size:11px" title="Profile match: 100 means identical percentiles"> ${Math.round(simMap.get(p.id))}% match</span>` : ''}${rm}</td>` +
      flat.map(k => { const pc = pk(sd, p, k); return `<td style="background:${heat(pc)}">${S.showPct ? (pc ?? '—') : MET[k].f(p[k])}${!S.showPct && nz(pc) ? `<small>${pc}</small>` : ''}</td>`; }).join('') + '</tr>';
  }).join('');
  $('matrix').innerHTML = h + '</tbody>';
}

// ------------------------------------------------------------------ head to head
function renderH2H() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A); const B = seasonOf(S.B);
  const cx = 230, cy = 215, R = 150, n = RADAR.length;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
  let s = '';
  [25, 50, 75, 100].forEach(r => { s += `<polygon points="${RADAR.map((_, i) => pt(i, r).join(',')).join(' ')}" fill="none" class="ax"/>`; });
  s += `<text x="${cx + 4}" y="${cy - R * 0.5 - 3}" class="lab">50th</text><text x="${cx + 4}" y="${cy - R - 3}" class="lab">100th</text>`;
  RADAR.forEach((a, i) => { const [x, y] = pt(i, 100), [lx, ly] = pt(i, 118); s += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="ax"/><text x="${lx}" y="${ly + 4}" text-anchor="${Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end'}" font-size="12" font-weight="600">${esc(a[1])}</text>`; });
  const poly = (p, col) => { const v = RADAR.map(a => pk(sd, p, a[0]) ?? 0); return `<polygon points="${v.map((x, i) => pt(i, x).join(',')).join(' ')}" fill="${col}" fill-opacity=".15" stroke="${col}" stroke-width="2.4"/>` + v.map((x, i) => { const [px, py] = pt(i, x); return `<circle cx="${px}" cy="${py}" r="3.4" fill="${col}"><title>${esc(p.name)} · ${esc(RADAR[i][1])}: ${Math.round(x)}th percentile</title></circle>`; }).join(''); };
  if (B) s += poly(B, 'var(--b)');
  s += poly(A, 'var(--a)');
  $('radar').innerHTML = s;
  // [label, value getter (for comparing; null = descriptive only), display, lower is better]
  const rows = [['Games · starts', null, p => `${p.gp} · ${p.gs}`], ['Record', null, p => nz(p.w) ? `${p.w}-${p.l}-${p.otl}` : '—'],
    ['Save %', p => p.sv, p => fsv(p.sv)], ['Expected save %', null, p => fsv(p.xsv)], ['GAA', p => p.gaa, p => f2(p.gaa), 1],
    ['GSAx', p => p.gsax, p => s1(p.gsax)], ['GSAx/60', p => p.gsax60, p => s2(p.gsax60)], ['High-danger sv% vs exp.', p => p.hd_dsv, p => s1(p.hd_dsv)],
    ['5v5 GSAx/60', p => p.gsax5_60, p => s2(p.gsax5_60)], ['PK GSAx/60', p => p.pk_gsax60, p => s2(p.pk_gsax60)], ['xGA/60 faced', null, p => f2(p.xga60)],
    ['Shutouts', p => p.so, p => f0(p.so)], ['Stopping score', p => scores(sd, p).d, p => f0(scores(sd, p).d)], ['Composite', p => composite(scores(sd, p)), p => f1(composite(scores(sd, p)))]];
  const cell = (row, p, q) => { const get = row[1]; const v = get ? get(p) : null, w = get && q ? get(q) : null; const win = q && nz(v) && nz(w) && v !== w && (row[3] ? v < w : v > w); return `<td class="${win ? 'win' : ''}">${row[2](p)}</td>`; };
  $('h2h-table').innerHTML = `<table class="tape"><thead><tr><th>${sLabel(S.season)}</th><th class="a">${esc(last(A.name))}</th><th class="b">${B ? esc(last(B.name)) : '—'}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td>${cell(r, A, B)}${B ? cell(r, B, A) : '<td>—</td>'}</tr>`).join('')}</tbody></table><p class="sub small">● marks the better value in each row. Expected save % and xGA/60 describe the shots he faced, not how he did.</p>`;
}

// ------------------------------------------------------------------ shot environment
function scatter(svgId, xk, yk, xl, yl, notes, refs) {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A);
  const P = pool(sd).list.filter(p => nz(p[xk]) && nz(p[yk]));
  const board = boardIds(sd).map(id => sd.byId.get(id)).filter(p => p && nz(p[xk]) && nz(p[yk]));
  const B = seasonOf(S.B);
  const all = [...P, ...board, ...(B && nz(B[xk]) && nz(B[yk]) ? [B] : []), ...(nz(A[xk]) && nz(A[yk]) ? [A] : [])];
  const W = 520, H = 440, m = { l: 56, r: 16, t: 18, b: 46 };
  const xd = extent(all.map(p => p[xk])), yd = extent(all.map(p => p[yk]));
  const xs = niceStep(xd[1] - xd[0]), ys = niceStep(yd[1] - yd[0]);
  const fmt = st => v => Math.abs(st) < 1 ? v.toFixed(st < 0.01 ? 3 : st < 0.1 ? 2 : 1) : v;
  const g = axes(W, H, m, xd, yd, ticks(xd[0], xd[1], xs), ticks(yd[0], yd[1], ys), xl, yl, fmt(xs), fmt(ys));
  let s = g.s;
  if (refs) { const [rx, ry] = refs(P); if (nz(rx)) s += `<line x1="${g.X(rx)}" x2="${g.X(rx)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)"/>`; if (nz(ry)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(ry)}" y2="${g.Y(ry)}" stroke="var(--muted)"/>`; }
  s += notes(g, W, H, m);
  const bset = new Set(board.map(p => p.id));
  P.forEach(p => { if (!bset.has(p.id)) s += `<circle cx="${g.X(p[xk])}" cy="${g.Y(p[yk])}" r="3" fill="var(--dot)"><title>${esc(p.name)}</title></circle>`; });
  const mark = (p, col, r, big) => { const x = g.X(p[xk]), y = g.Y(p[yk]); const end = x > W - m.r - 80; return `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}" stroke="var(--panel)" stroke-width="1.5"><title>${esc(p.name)}: ${MET[xk].f(p[xk])}, ${MET[yk].f(p[yk])}</title></circle><text data-l="1" x="${end ? x - 8 : x + 8}" y="${y - 8}" text-anchor="${end ? 'end' : 'start'}" font-size="${big ? 13 : 11}" font-weight="${big ? 700 : 600}" fill="${col}">${esc(last(p.name))}</text>`; };
  board.forEach(p => { if (p.id !== S.A && p.id !== S.B) s += mark(p, 'var(--board)', 4.5, false); });
  if (B && nz(B[xk]) && nz(B[yk])) s += mark(B, 'var(--b)', 6.5, true);
  if (nz(A[xk]) && nz(A[yk])) s += mark(A, 'var(--a)', 7, true);
  const el = $(svgId); el.innerHTML = s; placeLabels(el);
}
function renderEnv() {
  scatter('sc1', 'xga60', 'gsax60', 'xGA/60 faced (harder →  right)', 'Goals saved above expected per 60', (g, W, H, m) => `<text x="${W - m.r - 4}" y="${m.t + 12}" text-anchor="end" class="lab">Hard shots, still saving</text><text x="${m.l + 6}" y="${H - m.b - 8}" class="lab">Easy shots, still leaking</text>`, P => [median(P.map(p => p.xga60)), 0]);
  scatter('sc2', 'sa60', 'xgps', 'Shots on goal per 60 faced (busier →  right)', 'Expected goals per unblocked shot', (g, W, H, m) => `<text x="${W - m.r - 4}" y="${m.t + 12}" text-anchor="end" class="lab">Busy and dangerous</text><text x="${m.l + 6}" y="${H - m.b - 8}" class="lab">Quiet nights, low danger</text>`, P => [median(P.map(p => p.sa60)), median(P.map(p => p.xgps))]);
}

// ------------------------------------------------------------------ shot maps
const cellsOf = list => { const m = new Map(); (list || []).forEach(([c, n, g, x]) => m.set(c, { n, g, xg: x / 100 })); return m; };
const totalsOf = m => { let n = 0, g = 0, xg = 0; for (const v of m.values()) { n += v.n; g += v.g; xg += v.xg; } return { n, g, xg }; };
function rinkSVG(d, m, lg, title, col) {
  const G = d.grid, k = 5, W = (G.y1 - G.y0) * k, H = (G.x1 - G.x0) * k;
  const px = y => (y - G.y0) * k, py = x => (G.x1 - x) * k;
  const tot = totalsOf(m), ltot = totalsOf(lg);
  const id = 'clip' + Math.random().toString(36).slice(2, 8); const r = 28 * k;
  const shape = `M0,${H} L0,${r} Q0,0 ${r},0 L${W - r},0 Q${W},0 ${W},${r} L${W},${H} Z`;
  const col2 = t => t >= 0 ? `color-mix(in srgb, var(--hi) ${Math.round(t * 100)}%, var(--mid))` : `color-mix(in srgb, var(--lo) ${Math.round(-t * 100)}%, var(--mid))`;
  let cells = '';
  if (S.sh.smooth) {
    const P = cellArrays(G, m), Lg = cellArrays(G, lg);
    cells += S.sh.view === 'freq'
      ? smoothHeat(G, k, [P.n.map(v => v / tot.n), Lg.n.map(v => v / ltot.n)], ([sp, ls]) => [(sp - ls) * 100 / 0.25, Math.max(sp, ls) / 0.0025], '--lo', '--hi')
      : smoothHeat(G, k, [P.n, P.g, P.xg], ([n, g, xg]) => [n ? (xg - g) / n / 0.06 : 0, n / 1.5], '--hi', '--lo');
  }
  for (let cy = 0; cy < G.ny; cy++) for (let cx = 0; cx < G.nx; cx++) {
    const c = cy * G.nx + cx; const v = m.get(c); const l = lg.get(c);
    const x0 = G.x0 + cx * G.cell, y0 = G.y0 + cy * G.cell; let fill, tip;
    if (S.sh.view === 'freq') {
      const sp = v ? v.n / tot.n : 0, ls = l ? l.n / ltot.n : 0;
      if (!v && ls < 0.002) continue;
      const t = Math.max(-1, Math.min(1, (sp - ls) * 100 / 1.2));
      fill = t >= 0 ? `color-mix(in srgb, var(--lo) ${Math.round(t * 100)}%, var(--mid))` : `color-mix(in srgb, var(--hi) ${Math.round(-t * 100)}%, var(--mid))`;
      tip = `${v ? v.n : 0} shots faced (${(sp * 100).toFixed(1)}% of his) vs league goalies ${(ls * 100).toFixed(1)}%`;
    } else {
      if (!v || v.n < 5) continue;
      const sax = v.xg - v.g; const t = Math.max(-1, Math.min(1, sax / 2.5));
      fill = col2(t);
      tip = `${v.n} shots, ${v.g} goals against, ${v.xg.toFixed(1)} expected (${sax >= 0 ? '+' : ''}${sax.toFixed(1)} saved above expected)`;
    }
    cells += `<rect x="${px(y0)}" y="${py(x0 + G.cell)}" width="${G.cell * k}" height="${G.cell * k}" fill="${S.sh.smooth ? 'transparent' : fill}"><title>${tip}</title></rect>`;
    if (S.sh.view === 'freq' && v && v.g) cells += `<circle cx="${px(y0 + G.cell / 2)}" cy="${py(x0 + G.cell / 2)}" r="${Math.min(9, 2 + v.g / 2)}" fill="none" stroke="var(--ink)" stroke-width="1.4"><title>${v.g} goals against</title></circle>`;
  }
  const line = (x, c, w) => `<line x1="0" x2="${W}" y1="${py(x)}" y2="${py(x)}" stroke="${c}" stroke-width="${w}"/>`;
  const circ = (x, y, rr, st) => `<circle cx="${px(y)}" cy="${py(x)}" r="${rr * k}" fill="none" stroke="${st}" stroke-width="1.5"/>`;
  const marks = line(89, 'var(--a)', 2) + line(25.5, 'var(--b)', 6) + `<path d="M${px(-6)},${py(89)} A${6 * k},${6 * k} 0 0 0 ${px(6)},${py(89)}" fill="none" stroke="var(--a)" stroke-width="1.5"/>` +
    `<rect x="${px(-3)}" y="${py(92.5)}" width="${6 * k}" height="${3.5 * k}" fill="none" stroke="var(--ink)" stroke-width="2"/>` + circ(69, -22, 15, 'var(--a)') + circ(69, 22, 15, 'var(--a)');
  return `<svg viewBox="-10 -34 ${W + 20} ${H + 44}" role="img" aria-label="Shots faced by ${esc(title)}"><defs><clipPath id="${id}"><path d="${shape}"/></clipPath></defs><text x="${W / 2}" y="-14" text-anchor="middle" font-size="15" font-weight="700" fill="${col}">${esc(title)}</text>
    <path d="${shape}" fill="var(--panel)" stroke="var(--ink)" stroke-width="2"/><g clip-path="url(#${id})">${cells}${marks}</g><path d="${shape}" fill="none" stroke="var(--ink)" stroke-width="2"/></svg>`;
}
async function renderShots() {
  const y = S.season; const A = seasonOf(S.A); const box = $('shots');
  if (!A) { box.innerHTML = ''; $('shots-sub').textContent = `No ${sLabel(y)} shot data for this goalie.`; return; }
  const d = await loadShots(y);
  if (y !== S.season) return;
  if (!d) { box.innerHTML = ''; $('shots-sub').textContent = `Shot maps for ${sLabel(y)} haven't been built yet. They're added by the nightly update.`; return; }
  $('shots-sub').innerHTML = `Unblocked shots he faced (on goal, missed and goals) in his defensive zone, ${sLabel(y)} regular season, in 5 × 5 ft cells, drawn with his net at the top. <strong>Where shots came from:</strong> orange cells are spots he faced shots from more often than the average goalie, blue less often; rings mark goals against. <strong>Saves vs expected:</strong> expected goals minus goals allowed; blue means he stopped more than an average goalie would from there. <strong>Smoothed</strong> blends each spot with its neighbours (within about 7 ft); <strong>Cells</strong> shows the raw 5 × 5 ft counts (hover a cell for numbers).`;
  const B = seasonOf(S.B); const sit = S.sh.sit;
  const ctl = `<div class="ctl"><span class="lbl">Situation</span><span class="toggle" id="shsit">${[['all', 'All'], ['ev', '5v5'], ['pk', 'Penalty kill']].map(([k, l]) => `<button type="button" data-sit="${k}" aria-pressed="${sit === k}">${l}</button>`).join('')}</span>
    <span class="lbl">View</span><span class="toggle">${[['freq', 'Where shots came from'], ['fin', 'Saves vs expected']].map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${S.sh.view === k}">${l}</button>`).join('')}</span>
    <span class="lbl">Draw</span><span class="toggle">${[[1, 'Smoothed'], [0, 'Cells']].map(([k, l]) => `<button type="button" data-smooth="${k}" aria-pressed="${S.sh.smooth === !!k}">${l}</button>`).join('')}</span></div>`;
  const lg = cellsOf((d.league || {})[sit]);
  const maps = [A, B].filter(Boolean).map((p, i) => { const m = cellsOf((d.players[p.id] || {})[sit]); return { p, m, t: totalsOf(m), col: i ? 'var(--b)' : 'var(--a)' }; });
  const slot = x => { let n = 0; for (const [c, v] of x.m) { const cx = c % d.grid.nx, cy = Math.floor(c / d.grid.nx); const xx = d.grid.x0 + (cx + 0.5) * d.grid.cell, yy = d.grid.y0 + (cy + 0.5) * d.grid.cell; if (xx >= 69 && xx <= 89 && Math.abs(yy) <= 10) n += v.n; } return x.t.n ? 100 * n / x.t.n : null; };
  const lt = totalsOf(lg);
  const rows = [['Unblocked shots faced', x => f0(x.t.n)], ['Goals against', x => f0(x.t.g)], ['Expected goals against', x => f1(x.t.xg)], ['Saved above expected', x => s1(x.t.xg - x.t.g)],
    ['xG per shot', x => x.t.n ? (x.t.xg / x.t.n).toFixed(3) : '—'], ['Share from the slot', x => nz(slot(x)) ? slot(x).toFixed(1) + '%' : '—']];
  const tbl = `<table class="tape"><thead><tr><th>${sit === 'all' ? 'All situations' : sit === 'ev' ? '5v5' : 'Penalty kill'}</th>${maps.map((x, i) => `<th class="${i ? 'b' : 'a'}">${esc(last(x.p.name))}</th>`).join('')}<th>League goalie avg</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td>${maps.map(x => `<td>${r[1](x)}</td>`).join('')}<td>${r[0] === 'xG per shot' && lt.n ? (lt.xg / lt.n).toFixed(3) : r[0] === 'Share from the slot' ? (nz(slot({ m: lg, t: lt })) ? slot({ m: lg, t: lt }).toFixed(1) + '%' : '—') : ''}</td></tr>`).join('')}</tbody></table>`;
  box.innerHTML = ctl + `<div class="two">${maps.map(x => `<div>${x.t.n ? rinkSVG(d, x.m, lg, x.p.name, x.col) : `<p class="empty">${esc(x.p.name)} has no shots faced in this situation.</p>`}</div>`).join('')}</div><div class="legend">${S.sh.view === 'freq'
    ? '<span><i style="background:var(--lo)"></i>Faced shots from here more often than the average goalie</span><span><i style="background:var(--hi)"></i>Less often</span><span>Mostly his team\'s defense, not his play · ○ = goal against</span>'
    : '<span><i style="background:var(--hi)"></i>Stopped more than expected from here</span><span><i style="background:var(--lo)"></i>Stopped fewer than expected</span>'}</div><div class="scroll" style="margin-top:16px;max-width:640px">${tbl}</div>`;
}

// ------------------------------------------------------------------ goalie swap
function renderSwap() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A);
  const teams = sd.teams.filter(t => t !== A.team);
  if (!teams.includes(S.swapTeam)) S.swapTeam = teams[0];
  $('swapTeam').innerHTML = teams.map(t => `<option${t === S.swapTeam ? ' selected' : ''}>${t}</option>`).join('');
  const cands = sd.players.filter(p => p.team === S.swapTeam && p.xga >= 5).sort((a, b) => b.toi - a.toi);
  if (!cands.find(p => p.id === S.swapOut)) S.swapOut = cands[0] ? cands[0].id : null;
  $('swapOut').innerHTML = cands.map(p => `<option value="${p.id}"${p.id === S.swapOut ? ' selected' : ''}>${esc(p.name)} (${p.gp} GP)</option>`).join('');
  const R = sd.byId.get(S.swapOut);
  if (!R || A.xga < 5) { $('swap').innerHTML = '<p class="empty">Not enough shots for this swap.</p>'; return; }
  const rate = p => (p.xga - p.ga) / p.xga; // goals saved per expected goal
  const ra = rate(A), rr = rate(R);
  const gaA_onR = R.xga * (1 - ra), gaR_onA = A.xga * (1 - rr);
  const d1 = R.ga - gaA_onR, d2 = A.ga - gaR_onA;
  const word = v => v >= 0 ? 'better' : 'worse';
  $('swap').innerHTML = `<div class="swapgrid">
    <div class="v a"><b>${S.swapTeam} gets ${word(d1)}</b><p>Behind ${S.swapTeam}'s defense in ${esc(R.name)}'s ${f0(R.toi)} minutes (${f1(R.xga)} expected goals against), ${esc(A.name)} projects to allow ${f1(gaA_onR)} goals instead of ${R.ga}: ${s1(d1)} goals, about ${s1(d1 / 6)} wins.</p></div>
    <div class="v b"><b>${A.team} gets ${word(d2)}</b><p>Behind ${A.team}'s defense in ${esc(A.name)}'s ${f0(A.toi)} minutes (${f1(A.xga)} expected), ${esc(R.name)} projects to allow ${f1(gaR_onA)} instead of ${A.ga}: ${s1(d2)} goals, about ${s1(d2 / 6)} wins.</p></div></div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Scenario</th><th>Minutes</th><th>xGA faced</th><th>Goals against</th><th>Save %</th><th>Goals saved vs actual</th></tr></thead><tbody>
    ${[[`${A.name} on ${A.team} (actual)`, A.toi, A.xga, A.ga, A.sa, 0], [`${R.name} on ${A.team} (swap)`, A.toi, A.xga, gaR_onA, A.sa, d2], [`${R.name} on ${S.swapTeam} (actual)`, R.toi, R.xga, R.ga, R.sa, 0], [`${A.name} on ${S.swapTeam} (swap)`, R.toi, R.xga, gaA_onR, R.sa, d1]]
      .map(([n, t, x, ga, sa, dd]) => `<tr><td>${esc(n)}</td><td>${f0(t)}</td><td>${f1(x)}</td><td>${f1(ga)}</td><td>${sa ? fsv(1 - ga / sa) : '—'}</td><td class="${dd > 0 ? 'pos' : dd < 0 ? 'neg' : ''}">${dd ? s1(dd) : '—'}</td></tr>`).join('')}
    </tbody></table></div><p class="sub small">Each goalie's rate is goals saved above expected per expected goal against this season (${esc(last(A.name))} ${s1(100 * ra)}%, ${esc(last(R.name))} ${s1(100 * rr)}%). It assumes his save talent travels and the team in front of him plays the same; a common rule of thumb is about 6 goals per win.</p>`;
}

// ------------------------------------------------------------------ workload and fit (part two)
const ROLE = [[0.65, 'Workhorse starter', 1], [0.5, 'Starter', 1], [0.4, '1A in a tandem', 2], [0.28, '1B in a tandem', 2], [0.12, 'Backup', 3], [0, 'Spot duty', 3]];
const roleOf = share => ROLE.find(r => share >= r[0]) || ROLE[ROLE.length - 1];
const LEVEL = { 1: 'starter', 2: 'tandem goalie', 3: 'backup' };
const REST = [['Back-to-back (no rest)', r => r === 1], ['1 day rest', r => r === 2], ['2 days rest', r => r === 3], ['3+ days rest', r => r >= 4], ['First start of the season', r => !nz(r)]];
function leagueSv(G) {
  if (G.lgsv !== undefined) return G.lgsv;
  let sa = 0, ga = 0, xga = 0, t = 0; const rest = REST.map(() => ({ n: 0, sa: 0, ga: 0, xga: 0, t: 0 }));
  for (const rows of G.by.values()) for (const g of rows) {
    sa += g.sa; ga += g.ga; xga += g.xga; t += g.toi;
    if (g.start) { const i = REST.findIndex(r => r[1](g.rest)); if (i >= 0) { const b = rest[i]; b.n++; b.sa += g.sa; b.ga += g.ga; b.xga += g.xga; b.t += g.toi; } }
  }
  G.lgsv = sa ? 1 - ga / sa : 0.9; G.lgRest = rest;
  return G.lgsv;
}
function teamSpan(G, rows) {
  // team games while he was with each team he played for (full schedule so far when he played for one team)
  const teams = [...new Set(rows.map(r => r.team))];
  if (!G.teamDates) return teams.reduce((a, t) => a + (G.teamGames[t] || 0), 0);
  if (teams.length === 1) return (G.teamDates[teams[0]] || []).length;
  return teams.reduce((a, t) => { const mine = rows.filter(r => r.team === t).map(r => r.date); const lo = Math.min(...mine), hi = Math.max(...mine); return a + (G.teamDates[t] || []).filter(d => d >= lo && d <= hi).length; }, 0);
}
function blendRate(id) {
  // goals saved above expected per 60, last three seasons weighted 3/2/1 by recency and by minutes
  let num = 0, den = 0, n = 0, mins = 0;
  [S.season, S.season - 1, S.season - 2].forEach((y, i) => { const sd = S.seasons[y]; const p = sd && sd.byId.get(id); if (p && p.toi) { const w = (3 - i) * p.toi; num += p.gsax60 * w; den += w; n++; mins += p.toi; } });
  return mins >= 900 ? { v: num / den, n } : null; // at least 15 games' worth of minutes over the three seasons
}
function fitPct(id) {
  const sd = S.seasons[S.season]; const ck = `fit|${S.season}`;
  const arr = S.cache[ck] || (S.cache[ck] = pool(sd, 'reg').list.map(p => (blendRate(p.id) || {}).v).filter(nz).sort((a, b) => a - b));
  const b = blendRate(id); if (!b || !arr.length) return null;
  let below = 0, eq = 0; for (const v of arr) { if (v < b.v) below++; else if (v === b.v) eq++; }
  return { pct: 100 * (below + eq / 2) / arr.length, v: b.v, n: b.n };
}
function gProfile(G, id) {
  const rows = G.by.get(id); if (!rows || !rows.length) return null;
  const lgsv = leagueSv(G);
  const st = rows.filter(r => r.start), rel = rows.filter(r => !r.start);
  const sum = (l, k) => l.reduce((a, r) => a + (r[k] || 0), 0);
  const tg = teamSpan(G, rows); const share = tg ? st.length / tg : 0; const role = roleOf(share);
  const qs = st.filter(r => r.sa && ((1 - r.ga / r.sa) >= lgsv || (r.sa <= 20 && (1 - r.ga / r.sa) >= 0.885))).length;
  const rbs = st.filter(r => r.sa && (1 - r.ga / r.sa) < 0.85).length;
  const b2bTeam = G.teamDates && [...new Set(rows.map(r => r.team))].length === 1 ? (() => { const ds = new Set(G.teamDates[rows[0].team] || []); let n = 0; for (const d of ds) { const dt = new Date(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100); dt.setDate(dt.getDate() - 1); const p = dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate(); if (ds.has(p)) n++; } return n; })() : null;
  const b2bStarts = st.filter(r => r.b2b).length;
  const bucket = l => { const sa = sum(l, 'sa'), ga = sum(l, 'ga'), xga = sum(l, 'xga'), t = sum(l, 'toi'); return { n: l.length, sa, ga, xga, sv: sa ? 1 - ga / sa : null, xsv: sa ? 1 - xga / sa : null, gsax60: t ? (xga - ga) / t * 3600 : null }; };
  const rest = REST.map(([l, f]) => ({ l, ...bucket(st.filter(r => f(r.rest))) }));
  const home = bucket(st.filter(r => r.home)), road = bucket(st.filter(r => !r.home));
  const all = bucket(rows);
  const fit = fitPct(id);
  const fitLvl = fit ? (fit.pct >= 66.7 ? 1 : fit.pct >= 33.3 ? 2 : 3) : null;
  const flag = !fit ? ['ok', 'Too few games to judge'] : fitLvl < role[2] ? ['up', 'Results earn more starts'] : fitLvl > role[2] ? ['down', 'Starting more than his results support'] : ['ok', 'Usage fits his results'];
  const dec = { W: st.concat(rel).filter(r => r.dec === 'W').length, L: rows.filter(r => r.dec === 'L').length, O: rows.filter(r => r.dec === 'O').length };
  return { id, rows, st, rel, tg, share, role, qs, rbs, b2bTeam, b2bStarts, rest, home, road, all, fit, fitLvl, flag, dec, pulled: st.filter(r => r.pulled).length,
    sa60: all.sa && sum(rows, 'toi') ? all.sa / sum(rows, 'toi') * 3600 : null, xga60: sum(rows, 'toi') ? all.xga / sum(rows, 'toi') * 3600 : null };
}
function roleCard(G, P, col) {
  const p = seasonOf(P.id) || { name: nameOf(P.id) };
  const lg = G.lgRest.map(b => ({ sv: b.sa ? 1 - b.ga / b.sa : null, xsv: b.sa ? 1 - b.xga / b.sa : null, gsax60: b.t ? (b.xga - b.ga) / b.t * 3600 : null }));
  const pctS = Math.round(100 * P.share);
  const bar = `<div class="slotbar"><i style="width:${Math.min(100, pctS)}%;background:var(--c1)" title="Starts">${pctS >= 12 ? pctS + '% of starts' : ''}</i><i style="width:${Math.max(0, 100 - pctS)}%;background:var(--dot)" title="Other goalies"></i></div>`;
  const v = (t, f, txt) => `<div class="v"><b>${t}</b>${flag(f)}<p>${txt}</p></div>`;
  const fitTxt = P.fit ? `Blended goals saved above expected: ${s2(P.fit.v)} per 60 over ${P.fit.n} season${P.fit.n > 1 ? 's' : ''}, ${ord(Math.round(P.fit.pct))} percentile among regular goalies: ${LEVEL[P.fitLvl]} results.` : 'Not enough games over the last three seasons.';
  const qsp = P.st.length ? 100 * P.qs / P.st.length : null;
  const verdicts = `<div class="verdict">
    ${v('Usage vs. results', P.flag, `Used as a <strong>${P.role[1].toLowerCase()}</strong> (${P.st.length} of ${P.tg} team games). ${fitTxt}`)}
    ${v('Quality starts', !P.st.length ? ['ok', 'No starts'] : qsp >= 60 ? ['up', 'Gives his team a chance'] : qsp >= 50 ? ['ok', 'League-average'] : ['down', 'Too many soft nights'], `${P.qs} of ${P.st.length} starts (${f0(qsp)}%) were quality starts; ${P.rbs} were really bad starts (under .850). About 53% is typical for a starter.`)}
    ${v('Back-to-backs', P.rest[0].n < 3 ? ['ok', 'Rarely asked'] : P.rest[0].gsax60 >= (lg[0].gsax60 ?? 0) ? ['up', 'Holds up with no rest'] : ['down', 'Fades with no rest'], `Started both nights of a back-to-back ${P.rest[0].n === 1 ? 'once' : P.rest[0].n + ' times'}${P.rest[0].n ? ` (${s2(P.rest[0].gsax60)} GSAx/60 on the second night, league ${s2(lg[0].gsax60)})` : ''}. ${nz(P.b2bTeam) ? `His team played ${P.b2bTeam} back-to-backs; he started the second night of ${P.b2bStarts}.` : `He started the second night of ${P.b2bStarts} back-to-backs.`}`)}
    ${v('Workload', ['ok', P.role[1]], `${P.st.length} starts, ${P.rel.length} in relief, pulled ${P.pulled} time${P.pulled === 1 ? '' : 's'}. Faced ${f1(P.sa60)} shots on goal and ${f2(P.xga60)} expected goals per 60.`)}
  </div>`;
  const restTbl = `<p class="minihead">Starts by rest since his previous start</p><div class="scroll"><table class="tbl"><thead><tr><th>Rest</th><th>Starts</th><th>Save %</th><th>Expected</th><th>GSAx/60</th><th>League GSAx/60</th></tr></thead><tbody>` +
    P.rest.map((b, i) => b.n ? `<tr><td>${b.l}</td><td>${b.n}</td><td>${fsv(b.sv)}</td><td>${fsv(b.xsv)}</td><td class="${b.n >= 3 && nz(lg[i].gsax60) ? (b.gsax60 > lg[i].gsax60 ? 'pos' : 'neg') : ''}">${b.n >= 3 ? s2(b.gsax60) : '—'}</td><td>${s2(lg[i].gsax60)}</td></tr>` : '').join('') + '</tbody></table></div>';
  const ha = `<p class="minihead" style="margin-top:14px">Home and road starts</p><div class="scroll"><table class="tbl"><thead><tr><th></th><th>Starts</th><th>Save %</th><th>Expected</th><th>GSAx/60</th></tr></thead><tbody>` +
    [['Home', P.home], ['Road', P.road]].map(([l, b]) => `<tr><td>${l}</td><td>${b.n}</td><td>${fsv(b.sv)}</td><td>${fsv(b.xsv)}</td><td>${b.n >= 3 ? s2(b.gsax60) : '—'}</td></tr>`).join('') + '</tbody></table></div>';
  return `<div class="pcard ${col}" style="border-top-width:4px"><h3 style="font-size:26px">${esc(p.name)}</h3><p class="sub" style="margin-top:4px">Started ${P.st.length} of ${P.tg} team games (${pctS}%): <strong>${P.role[1].toLowerCase()}</strong>. Record in his decisions: ${P.dec.W}-${P.dec.L}-${P.dec.O}.</p>${bar}${verdicts}${restTbl}${ha}</div>`;
}
async function renderRole() {
  const y = S.season; const G = await loadGames(y);
  if (y !== S.season) return;
  if (!G) { $('role-sub').textContent = `Game-by-game goalie data for ${sLabel(y)} hasn't been built yet. It's added by the nightly update.`; $('role').innerHTML = ''; $('lineup').innerHTML = ''; $('form').innerHTML = ''; return; }
  await Promise.all([y - 1, y - 2].filter(z => (S.idx.goalie_seasons || []).includes(z)).map(z => loadSeason(z).catch(() => null)));
  if (y !== S.season) return;
  leagueSv(G);
  const PA = gProfile(G, S.A), PB = S.B ? gProfile(G, S.B) : null;
  $('role-sub').innerHTML = `Starts come from the NHL's game logs; expected goals from MoneyPuck. Role is his share of his team's games started: 65%+ workhorse, 50%+ starter, 40–50% 1A, 28–40% 1B, under 28% backup. Results fit is his goals saved above expected per 60, blended over three seasons (most recent counts most) and ranked among regular goalies in thirds. League save % this season: ${fsv(G.lgsv)}.`;
  const lim = `<details class="lim" open><summary>What these numbers can and can't see</summary><ul>
    <li><strong>Goalie seasons are noisy.</strong> Over a season, save percentage is roughly half talent and half luck, so one year of goals saved above expected can mislead. The fit blends three seasons for that reason.</li>
    <li><strong>Expected goals miss some of what makes a shot hard.</strong> MoneyPuck's model knows location, shot type, rebounds and rushes, but not screens or passes right before the shot. Goalies behind teams that allow a lot of those get shortchanged a little.</li>
    <li><strong>Starts aren't only about ability.</strong> Contracts, injuries, schedule and a coach's trust all decide who plays. A backup with great numbers in 15 starts often faced easier nights.</li>
    <li><strong>Rest splits are small samples.</strong> Most goalies start only a handful of back-to-backs, so read those rows as hints.</li></ul></details>`;
  $('role').innerHTML = PA ? lim + `<div class="rolegrid">${roleCard(G, PA, 'a')}${PB ? roleCard(G, PB, 'b') : ''}</div>` : '<p class="empty">No game-by-game data for this goalie and season.</p>';
  drawForm(G, [PA, PB].filter(Boolean));
  renderLineup(G);
}
function drawForm(G, profs) {
  const W = 1080, H = 300, m = { l: 52, r: 110, t: 16, b: 34 };
  const series = profs.map((P, i) => {
    const st = P.st.filter(r => r.date); const pts = [];
    st.forEach((r, k) => { const win = st.slice(Math.max(0, k - 9), k + 1); if (win.length >= 5) pts.push([r.date, win.reduce((a, x) => a + x.xga - x.ga, 0) / win.length, r]); });
    return { id: P.id, col: i ? 'var(--b)' : 'var(--a)', pts, st };
  }).filter(s => s.pts.length);
  if (!series.length) { $('form').innerHTML = `<text x="20" y="40" class="lab">Needs at least five starts.</text>`; return; }
  const day = d => Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) / 864e5;
  const all = series.flatMap(s => s.pts);
  const x0 = Math.min(...series.flatMap(s => s.st.map(r => day(r.date)))), x1 = Math.max(x0 + 1, ...all.map(p => day(p[0])));
  const yd = extent(all.map(p => p[1]).concat([0, 0.5, -0.5]), 0.1);
  const months = []; for (let t = x0; t <= x1; t++) { const d = new Date(t * 864e5); if (d.getUTCDate() === 1) months.push(t); }
  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const g = axes(W, H, m, [x0, x1], yd, months, ticks(yd[0], yd[1], niceStep(yd[1] - yd[0], 5)), null, 'GSAx per start, last 10', t => MN[new Date(t * 864e5).getUTCMonth()], v => (v > 0 ? '+' : '') + (+v.toFixed(2)));
  let s = g.s + `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  series.forEach(sr => {
    s += sr.st.map(r => `<circle cx="${g.X(day(r.date))}" cy="${g.Y(Math.max(yd[0], Math.min(yd[1], r.xga - r.ga)))}" r="2" fill="${sr.col}" opacity=".3"><title>${r.date} vs ${r.opp}: ${r.sa - r.ga} saves on ${r.sa}, ${s2(r.xga - r.ga)} GSAx</title></circle>`).join('');
    s += `<polyline points="${sr.pts.map(p => g.X(day(p[0])) + ',' + g.Y(p[1])).join(' ')}" fill="none" stroke="${sr.col}" stroke-width="2.6" stroke-linejoin="round"/>`;
    const e = sr.pts[sr.pts.length - 1]; s += `<text data-l="1" x="${g.X(day(e[0])) + 7}" y="${g.Y(e[1]) + 4}" font-size="12" font-weight="700" fill="${sr.col}">${esc(last(nameOf(sr.id)))}</text>`;
  });
  $('form').innerHTML = s; placeLabels($('form'));
}
function renderLineup(G) {
  const sd = S.seasons[S.season]; const A = sd.byId.get(S.A);
  if (!S.lineupTeam || !sd.teams.includes(S.lineupTeam)) S.lineupTeam = A ? A.team : sd.teams[0];
  $('lineupTeam').innerHTML = sd.teams.map(t => `<option${t === S.lineupTeam ? ' selected' : ''}>${t}</option>`).join('');
  const ids = [...G.by.entries()].filter(([, rows]) => rows.some(r => r.team === S.lineupTeam)).map(([id]) => id);
  const rows = ids.map(id => ({ P: gProfile(G, id), p: sd.byId.get(id) })).filter(x => x.P).sort((a, b) => b.P.st.length - a.P.st.length);
  $('lineup').innerHTML = rows.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Goalie</th><th>GP</th><th>Starts</th><th>Share</th><th>Used as</th><th>Save %</th><th>GSAx</th><th>GSAx/60</th><th>Quality starts</th><th>Fit (3 yr)</th><th>Flag</th></tr></thead><tbody>` +
    rows.map(({ P, p }) => `<tr class="${P.id === S.A ? 'isA' : ''}"><td><a href="#" data-seta="${P.id}">${esc(nameOf(P.id))}</a></td><td>${P.rows.length}</td><td>${P.st.length}</td><td>${f0(100 * P.share)}%</td><td style="white-space:nowrap">${P.role[1]}</td><td>${fsv(P.all.sv)}</td><td class="${dcls(P.all.xga - P.all.ga)}">${s1(P.all.xga - P.all.ga)}</td><td>${s2(P.all.gsax60)}</td><td>${P.st.length ? f0(100 * P.qs / P.st.length) + '%' : '—'}</td><td style="white-space:nowrap">${P.fit ? `${LEVEL[P.fitLvl]} <span class="lab">${ord(Math.round(P.fit.pct))}</span>` : '—'}</td><td>${flag(P.flag)}</td></tr>`).join('') + '</tbody></table></div>' +
    `<p class="sub small">Every goalie who appeared for ${S.lineupTeam} in ${sLabel(S.season)}. A goalie traded mid-season shows his whole season, with his share counted only while he was on each team.</p>` : '<p class="empty">No goalie data for this team.</p>';
}
const flag = f => `<span class="flag ${f[0]}">${esc(f[1])}</span>`;
const dcls = v => nz(v) ? (v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : '') : '';

// ------------------------------------------------------------------ value (part three)
let VAL = null;
async function loadValue() {
  if (VAL) return VAL;
  const v = await getJSON('data/value.json');
  const f = v.goalie_fields || []; const by = new Map(); const seasons = {};
  for (const [y, sd] of Object.entries(v.goalie_seasons || {})) {
    const m = new Map();
    for (const r of sd.rows) { const o = { y: +y }; f.forEach((k, i) => { o[k] = r[i]; }); m.set(o.id, o); if (!by.has(o.id)) by.set(o.id, []); by.get(o.id).push(o); }
    seasons[+y] = { ...sd, map: m };
  }
  by.forEach(l => l.sort((a, b) => a.y - b.y));
  return (VAL = { ...v, seasons, by });
}
const GCOMPS = [['ev', '5v5'], ['pk', 'Penalty kill'], ['other', 'Other situations']];
const capKey = id => `sz-cap-${id}`;
function getCap(id) { try { const v = localStorage.getItem(capKey(id)); return v ? +v : null; } catch (e) { return null; } }
function setCap(id, v) { try { if (nz(v)) localStorage.setItem(capKey(id), v); else localStorage.removeItem(capKey(id)); } catch (e) { /* storage blocked */ } }
function payLine(worth, cap, worth3) {
  if (!nz(cap) || !nz(worth)) return '';
  const part = (w, l) => { const d = w - cap; return `<b class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? 'Underpaid' : 'Overpaid'} by about ${money(Math.abs(d))}</b> ${l}`; };
  return part(worth, "for this season's value") + (nz(worth3) ? ` · ${part(worth3, 'for his last 3 seasons')}` : '');
}
async function renderValue() {
  const V = await loadValue().catch(() => null);
  if (!V || !Object.keys(V.seasons).length) { $('value-sub').textContent = 'Goalie value data hasn\'t been built yet. It\'s added by the nightly update.'; $('value').innerHTML = ''; $('deal').innerHTML = ''; return; }
  const y = S.season; const sv = V.seasons[y];
  if (!sv) { $('value').innerHTML = '<p class="empty">No value data for this season.</p>'; $('deal').innerHTML = ''; return; }
  const partial = sv.progress < 0.99;
  $('value-sub').innerHTML = `${sLabel(y)} cap ${money(sv.cap)}; the model prices one goalie win at about <strong>${money(sv.per_win)}</strong> (the goalie share of the cap above minimum salaries, divided by all the wins goalies produced). Worth uses the wins he actually produced in his games, not a per-82 rate, since no goalie plays every game.${partial ? ` ${sLabel(y)} is ${Math.round(sv.progress * 100)}% complete, so worth projects his wins at this pace to a full season.` : ''} Replacement level is the 20th percentile rate among regular goalies in each situation, roughly a call-up.`;
  const ids = [S.A, S.B].filter(Boolean); const rows = ids.map(id => sv.map.get(id)).filter(Boolean);
  const scale = Math.max(1, ...rows.flatMap(r => GCOMPS.map(([k]) => Math.abs(r[k]))));
  const sd = S.seasons[y];
  const rankOf = r => { const list = [...sv.map.values()].filter(x => x.gp >= (sd ? minGp(sd) : 10)).sort((a, b) => b.war - a.war); const i = list.findIndex(x => x.id === r.id); return i >= 0 ? `${i + 1} of ${list.length}` : '—'; };
  // last 3 seasons: wins per season (unfinished seasons at pace), weights 3, 2, 1 by recency times share of the season played
  const three = id => {
    let num = 0, den = 0; const ys = [];
    [y, y - 1, y - 2].forEach((z, k) => { const s = V.seasons[z]; const r = s && s.map.get(id); const pr = s ? (s.progress || 1) : 1; if (r && r.gp) { const w = (3 - k) * pr; num += (r.war / pr) * w; den += w; ys.push(z); } });
    if (!den || ys.length < 2) return null;
    const wins = num / den;
    return { wins, worth: sv.min + Math.max(0, wins) * sv.per_win, from: Math.min(...ys), to: Math.max(...ys) };
  };
  const card = (r, i) => {
    const cap = getCap(r.id); const t3 = three(r.id);
    const comps = GCOMPS.map(([k, l]) => { const v = r[k]; const w = Math.abs(v) / scale * 50; return `<span>${l}</span><div class="trk"><b></b><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--hi)` : `left:${50 - w}%;width:${w}%;background:var(--lo)`}"></i></div><span class="mono" style="text-align:right">${s1(v)}</span>`; }).join('');
    return `<div class="pcard ${i ? 'b' : 'a'}"><h3 style="font-size:24px">${esc(nameOf(r.id))}</h3>
      <div class="tiles" style="margin-top:8px"><div class="tile"><b>${f1(r.war)}</b><span>Wins above replacement${partial ? ' so far' : ''}</span></div><div class="tile"><b>${f1(r.war82)}</b><span>Per 82 games</span></div>
        <div class="tile"><b>${money(r.worth)}</b><span>Worth this season${partial ? ' at this pace' : ''} (${f1(r.worth_pct)}% of cap)</span></div>
        <div class="tile"><b>${t3 ? money(t3.worth) : '—'}</b><span>${t3 ? `Worth over last 3 seasons (${sLabel(t3.from)} to ${sLabel(t3.to)}, ${f1(t3.wins)} wins a season)` : 'Worth over last 3 seasons (needs 2+ seasons)'}</span></div>
        <div class="tile"><b>${rankOf(r)}</b><span>Rank among goalies</span></div></div>
      <p class="minihead" style="margin-top:14px">Where the value comes from · goals above replacement</p><div class="comp">${comps}</div>
      <div class="capin"><label for="cap-${r.id}">His cap hit ($M)</label><input id="cap-${r.id}" data-capid="${r.id}" type="number" step="0.05" min="0" placeholder="e.g. 5.5" value="${nz(cap) ? cap : ''}"><span id="pay-${r.id}" data-w3="${t3 ? t3.worth : ''}">${payLine(r.worth, cap, t3 && t3.worth)}</span></div>
      <p class="sub small">Type his cap hit from <a href="https://puckpedia.com" rel="noopener">PuckPedia</a> or his team to compare. It stays in your browser only.</p></div>`;
  };
  $('value').innerHTML = rows.length ? `<div class="valgrid">${rows.map(card).join('')}</div><p class="minihead" style="margin-top:20px">Wins above replacement per 82 games, by season</p>${drawValueHistory(V, ids)}` : '<p class="empty">No value data for this goalie and season.</p>';
  renderDeal(V, ids);
}
function drawValueHistory(V, ids) {
  const W = 1080, H = 260, m = { l: 48, r: 110, t: 14, b: 34 };
  const series = ids.map((id, i) => ({ id, col: i ? 'var(--b)' : 'var(--a)', pts: (V.by.get(id) || []).filter(r => r.gp >= 10).map(r => [r.y, r.war82]) })).filter(s => s.pts.length);
  if (!series.length) return '';
  const all = series.flatMap(s => s.pts);
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(x0 + 1, ...all.map(p => p[0]));
  const yd = extent(all.map(p => p[1]).concat([0]), 0.1);
  const g = axes(W, H, m, [x0, x1], yd, ticks(x0, x1, x1 - x0 > 10 ? 2 : 1), ticks(yd[0], yd[1], niceStep(yd[1] - yd[0], 5)), null, null, v => sLabel(v), v => +v.toFixed(1));
  let s = g.s + `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  series.forEach(sr => { s += `<polyline points="${sr.pts.map(([x, y]) => g.X(x) + ',' + g.Y(y)).join(' ')}" fill="none" stroke="${sr.col}" stroke-width="2.6"/>` + sr.pts.map(([x, y]) => `<circle cx="${g.X(x)}" cy="${g.Y(y)}" r="3.5" fill="${sr.col}"><title>${sLabel(x)}: ${y.toFixed(2)} wins per 82</title></circle>`).join(''); const e = sr.pts[sr.pts.length - 1]; s += `<text data-l="1" x="${g.X(e[0]) + 7}" y="${g.Y(e[1]) + 4}" font-size="12" font-weight="700" fill="${sr.col}">${esc(last(nameOf(sr.id)))}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Value by season">${s}</svg>`;
}
function renderDeal(V, ids) {
  const cards = ids.map((id, i) => {
    const P = V.proj[id];
    if (!P || !P.g) return `<div class="pcard ${i ? 'b' : 'a'}"><h3 style="font-size:22px">${esc(nameOf(id))}</h3><p class="empty">No projection: he needs recent NHL games.</p></div>`;
    const yrs = P.years.map(r => ({ y: r[0], age: r[1], war: r[2], worth: r[3], cap: r[4] }));
    const rows = [1, 2, 3, 4, 5, 6, 7].map(n => { const sp = yrs.slice(0, n); const aav = avg(sp.map(x => x.worth)); return `<tr><td>${n} yr</td><td style="white-space:nowrap">${n > 1 ? `${sLabel(sp[0].y)} – ${sLabel(sp[n - 1].y)}` : sLabel(sp[0].y)}</td><td style="white-space:nowrap">${n > 1 ? `${sp[0].age ?? '?'}–${sp[n - 1].age ?? '?'}` : (sp[0].age ?? '?')}</td><td>${money(aav)}</td><td>${f1(100 * aav / sp[0].cap)}%</td><td>${f2(avg(sp.map(x => x.war)))}</td></tr>`; }).join('');
    return `<div class="pcard ${i ? 'b' : 'a'}"><h3 style="font-size:22px">${esc(nameOf(id))}</h3><p class="sub small">Starting point: <strong>${f2(P.base_war82)} wins a season</strong>. His last three seasons blend to ${f2(P.rate)} wins per 82 games; with ${f0(P.shots)} shots faced in them, the model keeps ${f0(100 * P.kept)}% of his gap to the league-average goalie (${f2(P.lg_rate)}), then scales to his workload of about ${f0(P.games)} games a season${nz(P.age) ? `. Age ${P.age} this season` : ''}.</p>
      <div class="scroll"><table class="tbl" style="min-width:560px"><thead><tr><th>Term</th><th>Seasons</th><th>Ages</th><th>Fair AAV</th><th>% of first-year cap</th><th>Avg wins / yr</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  });
  $('deal-sub').innerHTML = `What a new contract starting next season would be worth if it paid exactly his projected value. Goalie seasons swing a lot, so the projection trusts his record in proportion to how many shots it rests on: one season as a starter keeps about a third of his edge over an average goalie, three seasons about 60%. It's valued at his own workload, since no goalie plays 82 games, and goalies age later than skaters in the model: improving to 27, flat to 31, then declining. ${esc(V.cap_assumption || '')} Fair value under the model, not a prediction of what he'll sign for.`;
  $('deal').innerHTML = `<div class="valgrid">${cards.join('')}</div>`;
}

// ------------------------------------------------------------------ careers (part four)
function careerRows(c, mode, ref) {
  if (mode === 'age') return c.S.filter(s => nz(s.age) && s.age <= ref);
  const full = c.S.filter(s => s.full).slice(0, ref); const lastY = full.length ? full[full.length - 1].y : -1; return c.S.filter(s => s.y <= lastY);
}
function renderCareer() {
  const a = careerOf(S.A), b = S.B ? careerOf(S.B) : null;
  if (!a) { ['tape', 'atsame', 'cumu', 'seas'].forEach(id => { $(id).innerHTML = ''; }); return; }
  const ta = ctot(a.S), tb = b ? ctot(b.S) : null;
  const head = `<thead><tr><th></th><th class="a">${esc(last(a.name))}</th><th class="b">${b ? esc(last(b.name)) : '—'}</th></tr></thead>`;
  const row = (l, va, vb, f, better) => { let wa = '', wb = ''; if (better && nz(va) && nz(vb) && va !== vb) { const aw = better === 'hi' ? va > vb : va < vb; wa = aw ? 'win' : ''; wb = aw ? '' : 'win'; } return `<tr><td>${l}</td><td class="${wa}">${f(va)}</td><td class="${wb}">${b ? f(vb) : '—'}</td></tr>`; };
  const txt = (l, x, y) => `<tr><td>${l}</td><td>${x}</td><td>${b ? y : '—'}</td></tr>`;
  const yrs = c => c.S.length ? `${sLabel(c.S[0].y)} to ${sLabel(c.S[c.S.length - 1].y)}` : '—';
  const rec = t => `${t.w}-${t.l}-${t.tie ? t.tie + '-' : ''}${t.otl}`;
  const status = c => c.hof ? 'Hall of Fame' : (c.S.length && c.S[c.S.length - 1].y >= S.idx.current - 1 ? 'Active' : '—');
  const trophies = c => awardLine(c.awards.map(x => x[0]).filter(x => x !== 'Cup'));
  const tv = v => nz(v) ? (v > 0 ? '+' : '') + v.toFixed(1) : '—';
  $('tape').innerHTML = head + '<tbody>' + txt('Catches · size', `${a.catches || '?'} · ${htFmt(a.ht)} ${a.wt || ''}`, b ? `${b.catches || '?'} · ${htFmt(b.ht)} ${b.wt || ''}` : '') +
    txt('Seasons', `${ta.n}<br><small>${yrs(a)}</small>`, b ? `${tb.n}<br><small>${yrs(b)}</small>` : '') + row('Games', ta.gp, tb && tb.gp, f0) + txt('Record (W-L-T-OTL)', rec(ta), b ? rec(tb) : '') +
    row('Win %', ta.wpct, tb && tb.wpct, v => nz(v) ? fsv(v) : '—', 'hi') + row('Shutouts', ta.so, tb && tb.so, f0, 'hi') + row('Save % (1955-56 on)', ta.sv, tb && tb.sv, fsv) +
    row('Save % vs league (×1000)', ta.svp, tb && tb.svp, tv, 'hi') + row('Goals saved above league avg.', ta.gsaa, tb && tb.gsaa, s1, 'hi') + row('GAA', ta.gaa, tb && tb.gaa, f2) + row('Era-adjusted GAA', ta.egaa, tb && tb.egaa, f2, 'lo') +
    row('GSAx (2008-09 on)', ta.gsax, tb && tb.gsax, s1, 'hi') + row('GSAx/60 (2008-09 on)', ta.gsax60, tb && tb.gsax60, s2, 'hi') +
    txt('Trophies', trophies(a), b ? trophies(b) : '') + row('Stanley Cups', ta.cups, tb && tb.cups, f0, 'hi') + txt('Status', status(a), b ? status(b) : '') + '</tbody>';
  let ra, rb, lab;
  if (S.cmode === 'age') { const done = a.S.filter(s => !s.partial).map(s => s.age).filter(nz); const mx = done.length ? Math.max(...done) : Math.max(...a.S.map(s => s.age).filter(nz)); ra = careerRows(a, 'age', mx); rb = b ? careerRows(b, 'age', mx) : []; lab = `through age ${mx}`; }
  else { const n = a.S.filter(s => s.full).length || a.S.length; ra = careerRows(a, 'stage', n); rb = b ? careerRows(b, 'stage', n) : []; lab = `first ${n} seasons of 20+ games`; }
  const x = ctot(ra), y = ctot(rb);
  const span = r => r.length ? `ages ${r[0].age ?? '?'}–${r[r.length - 1].age ?? '?'}` : '—';
  $('atlab').textContent = 'At the same point · ' + lab;
  $('atsame').innerHTML = head + '<tbody>' + txt('Span', span(ra), span(rb)) + row('Games', x.gp, b && y.gp, f0) + row('Wins', x.w, b && y.w, f0, 'hi') + row('Shutouts', x.so, b && y.so, f0, 'hi') +
    row('Save % vs league (×1000)', x.svp, b && y.svp, tv, 'hi') + row('Goals saved above league avg.', x.gsaa, b && y.gsaa, s1, 'hi') + row('Era-adjusted GAA', x.egaa, b && y.egaa, f2, 'lo') +
    row('GSAx (2008-09 on)', x.gsax, b && y.gsax, s1, 'hi') + row('Vezinas by then', x.vez, b && y.vez, f0, 'hi') + row('Cups by then', x.cups, b && y.cups, f0, 'hi') + '</tbody>';
  drawCumu(a, b); drawSeas(a, b);
}
function drawCumu(a, b) {
  const W = 540, H = 300, m = { l: 48, r: 16, t: 14, b: 36 };
  const cum = c => { let t = 0; return c.S.filter(s => nz(s.age) && nz(s.gsaa)).map(s => { t += s.gsaa; return [s.age, t]; }); };
  const da = cum(a), db = b ? cum(b) : []; const all = [...da, ...db];
  if (!all.length) { $('cumu').innerHTML = `<text x="20" y="40" class="lab">Shots weren't counted before 1955-56.</text>`; return; }
  const x0 = Math.min(...all.map(d => d[0])), x1 = Math.max(x0 + 1, ...all.map(d => d[0]));
  const yd = extent(all.map(d => d[1]).concat([0]), 0.08);
  const g = axes(W, H, m, [x0, x1], yd, ticks(x0, x1, x1 - x0 > 12 ? 4 : 2), ticks(yd[0], yd[1], niceStep(yd[1] - yd[0], 5)), 'Age', null);
  const path = (d, c, w) => `<polyline points="${d.map(([x, y]) => g.X(x) + ',' + g.Y(y)).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"/>` + d.map(([x, y]) => `<circle cx="${g.X(x)}" cy="${g.Y(y)}" r="2.6" fill="${c}"/>`).join('');
  let s = g.s + `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  if (db.length) s += path(db, 'var(--b)', 2);
  if (da.length) { s += path(da, 'var(--a)', 3); const e = da[da.length - 1]; s += `<text data-l="1" x="${Math.min(g.X(e[0]) + 6, W - 90)}" y="${g.Y(e[1]) + 4}" font-size="12" font-weight="700" fill="var(--a)">${esc(last(a.name))} ${s1(e[1])}</text>`; }
  if (db.length) { const e = db[db.length - 1]; s += `<text data-l="1" x="${Math.min(g.X(e[0]) + 6, W - 90)}" y="${g.Y(e[1]) - 6}" font-size="12" font-weight="700" fill="var(--b)">${esc(last(b.name))} ${s1(e[1])}</text>`; }
  $('cumu').innerHTML = s; placeLabels($('cumu'));
}
function drawSeas(a, b) {
  const W = 540, H = 300, m = { l: 44, r: 12, t: 14, b: 36 };
  const pa = a.S.filter(s => s.full && nz(s.age) && nz(s.svp)), pb = b ? b.S.filter(s => s.full && nz(s.age) && nz(s.svp)) : [];
  const all = [...pa, ...pb]; if (!all.length) { $('seas').innerHTML = `<text x="20" y="40" class="lab">No seasons with shot counts.</text>`; return; }
  const x0 = Math.min(...all.map(s => s.age)), x1 = Math.max(...all.map(s => s.age));
  const yd = extent(all.map(s => s.svp).concat([0]), 0.12);
  const g = axes(W, H, m, [x0 - 0.5, x1 + 0.5], yd, ticks(x0, x1, x1 - x0 > 12 ? 4 : 2), ticks(yd[0], yd[1], niceStep(yd[1] - yd[0], 5)), 'Age · seasons with 20+ games', null);
  const bw = Math.max(2, Math.min(12, (W - m.l - m.r) / (x1 - x0 + 1) / (b ? 2 : 1) - 1));
  let s = g.s + `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  const bars = (c, Ss, col, off) => Ss.map(x => { const y0 = g.Y(0), y1 = g.Y(x.svp); const star = x.aw.includes('Vezina') || x.aw.includes('Hart'); return `<rect x="${g.X(x.age) + off}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.abs(y0 - y1)}" fill="${col}"><title>${esc(c.name)} ${sLabel(x.y)} (${esc(x.team)}): ${fsv(x.sv)} vs league ${fsv(x.lgsv)}${x.aw.length ? ' · ' + x.aw.join(', ') : ''}</title></rect>` + (star ? `<text x="${g.X(x.age) + off + bw / 2}" y="${Math.min(y0, y1) - 4}" text-anchor="middle" font-size="10" fill="${col}">★</text>` : ''); }).join('');
  if (b) s += bars(b, pb, 'var(--b)', 0);
  s += bars(a, pa, 'var(--a)', b ? -bw : -bw / 2);
  s += `<text x="${W - m.r}" y="${m.t + 10}" text-anchor="end" class="lab">★ Vezina or Hart</text>`;
  $('seas').innerHTML = s;
}
const AMET = [
  { k: 'svp', l: 'Save % vs league', f: s => s.full ? s.svp : null, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1), note: 'Save percentage minus the league average that season, ×1000 (+10 means .010 better). Seasons under 20 games are left out. 1955-56 on.' },
  { k: 'egaa', l: 'Era-adj. GAA', f: s => s.full ? s.egaa : null, fmt: f2, flip: true, note: 'Goals-against average rescaled to a league allowing 3.0 goals per team per game. Lower is better, so the axis is flipped: up is better.' },
  { k: 'gsaa', l: 'Goals saved above avg.', f: s => s.partial ? null : s.gsaa, fmt: s1, note: 'Goals he saved compared with a league-average goalie facing the same number of shots. 1955-56 on.' },
  { k: 'gsax60', l: 'GSAx/60 (2008+)', f: s => s.mptoi >= 600 ? s.gsax / s.mptoi * 60 : null, fmt: s2, note: "MoneyPuck's goals saved above expected per 60 minutes, which also accounts for shot quality. Seasons with 600+ minutes, 2008-09 on." },
  { k: 'gp', l: 'Games played', f: s => s.partial ? null : s.gp, fmt: f0, note: 'Games played each season. Short seasons (lockouts, 2019-20, 2020-21) show as dips.' },
  { k: 'w', l: 'Wins', f: s => s.partial ? null : s.w, fmt: f0, note: 'Wins each season. Wins depend heavily on the team in front of him.' },
];
const PAL = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
function arcPlayers() { const ids = []; [S.B, ...S.arcSel].forEach(id => { if (id && id !== S.A && !ids.includes(id)) ids.push(id); }); return ids.slice(0, 6); }
function renderArcs() {
  const M = AMET.find(x => x.k === S.arcMetric);
  $('ametric').innerHTML = AMET.map(x => `<button type="button" data-am="${x.k}" aria-pressed="${x.k === S.arcMetric}">${x.l}</button>`).join('');
  const others = arcPlayers();
  $('achips').innerHTML = [S.A, ...others].map((id, i) => { const c = careerOf(id); const col = i === 0 ? 'var(--a)' : PAL[i - 1]; return `<button type="button" ${i ? `data-rmarc="${id}"` : ''}><i style="background:${col}"></i>${esc(c ? c.name : nameOf(id))}${i ? '<b>×</b>' : ''}</button>`; }).join('');
  $('arcnote').textContent = M.note;
  const series = [S.A, ...others].map((id, i) => ({ c: careerOf(id), col: i === 0 ? 'var(--a)' : PAL[i - 1], main: i === 0 })).filter(x => x.c);
  const pts = series.flatMap(x => x.c.S.map(s => [s.age, M.f(s)]).filter(d => nz(d[0]) && nz(d[1])));
  const W = 1080, H = 400, m = { l: 56, r: 110, t: 16, b: 40 };
  if (!pts.length) { $('arc').innerHTML = `<text x="20" y="40" class="lab">No data for this measure.</text>`; renderComps(); return; }
  const x0 = Math.min(18, ...pts.map(d => d[0])), x1 = Math.max(38, ...pts.map(d => d[0]));
  let yd = extent(pts.map(d => d[1]).concat(M.k === 'gp' || M.k === 'w' ? [0] : []), 0.12);
  if (M.flip) yd = [yd[1], yd[0]];
  const g = axes(W, H, m, [x0, x1], yd, ticks(x0, x1, 2), ticks(Math.min(...yd), Math.max(...yd), niceStep(Math.abs(yd[1] - yd[0]), 6)), 'Age', M.l, null, v => +v.toFixed(2));
  let s = g.s;
  if (['svp', 'gsaa', 'gsax60'].includes(M.k)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  const draw = x => {
    const d = x.c.S.map(sn => ({ s: sn, v: M.f(sn) })).filter(o => nz(o.v) && nz(o.s.age)); if (!d.length) return '';
    const segs = [[d[0]]]; for (let i = 1; i < d.length; i++) { if (d[i].s.age - d[i - 1].s.age > 2) segs.push([]); segs[segs.length - 1].push(d[i]); }
    let o = segs.map(sg => `<polyline points="${sg.map(p => g.X(p.s.age) + ',' + g.Y(p.v)).join(' ')}" fill="none" stroke="${x.col}" stroke-width="${x.main ? 3.5 : 2}" stroke-linejoin="round"/>`).join('');
    o += d.map(p => `<circle cx="${g.X(p.s.age)}" cy="${g.Y(p.v)}" r="${x.main ? 4 : 3}" fill="${x.col}"><title>${esc(x.c.name)} · ${sLabel(p.s.y)} (${esc(p.s.team)}, age ${p.s.age}): ${M.fmt(p.v)}${p.s.aw.length ? ' · ' + p.s.aw.join(', ') : ''}</title></circle>`).join('');
    const e = d[d.length - 1]; return o + `<text data-l="1" x="${g.X(e.s.age) + 7}" y="${g.Y(e.v) + 4}" font-size="${x.main ? 13 : 12}" font-weight="700" fill="${x.col}">${esc(last(x.c.name))}</text>`;
  };
  series.slice().reverse().forEach(x => { s += draw(x); });
  $('arc').innerHTML = s; placeLabels($('arc'));
  renderComps();
}
function renderComps() {
  const a = careerOf(S.A); if (!a || !a.S.length) { $('comps').innerHTML = ''; return; }
  const done = a.S.filter(s => !s.partial).map(s => s.age).filter(nz);
  if (!done.length) { $('comps').innerHTML = ''; $('comps-sub').textContent = 'Not enough games yet to find comps.'; return; }
  const X = Math.max(...done); const me = ctot(a.S.filter(s => s.age <= X && !s.partial));
  if (me.gp < 30) { $('comps-h').textContent = 'Closest comps'; $('comps-sub').textContent = 'Not enough games yet to find comps.'; $('comps').innerHTML = ''; return; }
  const minG = Math.max(40, Math.round(me.gp * 0.5));
  const cands = [];
  for (const id of CAR.rowsBy.keys()) {
    if (id === a.id) continue; const c = careerOf(id); if (!c) continue;
    const t = ctot(c.S.filter(s => nz(s.age) && s.age <= X && !s.partial)); if (t.gp < minG) continue;
    cands.push({ c, t, after: ctot(c.S) });
  }
  const feats = [['egaa', 0.8], ['gp', 0.6]]; if (me.saCover > 0.6) feats.push(['svp', 1.2]);
  if (me.mptoi >= 3000) feats.push(['gsax60', 1]);
  const sd = {}; feats.forEach(([k]) => { const v = cands.map(x => x.t[k]).filter(nz); const mu = avg(v); sd[k] = Math.sqrt(avg(v.map(x => (x - mu) ** 2))) || 1; });
  cands.forEach(x => { let sum = 0, w = 0; if (feats.some(f => f[0] === 'svp') && x.t.saCover < 0.6) { x.d = Infinity; return; } feats.forEach(([k, wt]) => { if (k === 'gsax60' && x.t.mptoi < 3000) return; if (!nz(x.t[k]) || !nz(me[k])) return; sum += wt * ((x.t[k] - me[k]) / sd[k]) ** 2; w += wt; }); x.d = w >= 1.2 ? Math.sqrt(sum / w) : Infinity; });
  const top = cands.filter(x => Number.isFinite(x.d)).sort((p, q) => p.d - q.d).slice(0, 12);
  const maxD = Math.max(1, ...top.map(x => x.d));
  const tv = v => nz(v) ? (v > 0 ? '+' : '') + v.toFixed(1) : '—';
  $('comps-h').textContent = `Who looked most like ${a.name} through age ${X}, and how their careers turned out`;
  $('comps-sub').textContent = `Closeness compares save % against the league, era-adjusted GAA and games played${feats.some(f => f[0] === 'gsax60') ? ', plus goals saved above expected per 60 where both have 2008+ data' : ''}, against goalies with ${minG}+ games by that age. Click a name to add it to the chart.`;
  $('comps').innerHTML = `<thead><tr><th>Goalie</th><th>Years</th><th>GP to ${X}</th><th>Sv% vs lg</th><th>Era GAA</th><th>GSAx/60</th><th style="min-width:110px">Closeness</th><th>Career GP</th><th>Career trophies</th><th>Cups</th><th>Status</th></tr></thead><tbody>` +
    `<tr class="isA"><td>${esc(a.name)}</td><td>${a.S[0].y}–</td><td>${me.gp}</td><td>${tv(me.svp)}</td><td>${f2(me.egaa)}</td><td>${s2(me.gsax60)}</td><td class="lab">reference</td><td>—</td><td>${esc(awardLine(a.awards.map(x => x[0]).filter(x => x !== 'Cup')))}</td><td>${a.awards.filter(x => x[0] === 'Cup').length}</td><td>—</td></tr>` +
    top.map(x => { const c = x.c; const cl = Math.round(100 * (1 - x.d / (maxD * 1.15))); return `<tr><td><a href="#" data-addarc="${c.id}">${esc(c.name)}</a></td><td>${c.S[0].y}–${c.S[c.S.length - 1].y + 1}</td><td>${x.t.gp}</td><td>${tv(x.t.svp)}</td><td>${f2(x.t.egaa)}</td><td>${s2(x.t.gsax60)}</td><td><div class="cl" title="${cl}"><i style="width:${cl}%"></i></div></td><td>${x.after.gp}</td><td>${esc(awardLine(c.awards.map(z => z[0]).filter(z => z !== 'Cup')))}</td><td>${x.after.cups}</td><td>${c.hof ? 'HOF' : c.S[c.S.length - 1].y >= S.idx.current - 1 ? 'Active' : ''}</td></tr>`; }).join('') + '</tbody>';
}

// ------------------------------------------------------------------ nav
function initNav() {
  const links = [...document.querySelectorAll('#nav a')]; const groups = [...document.querySelectorAll('#nav .ng')]; let ticking = false;
  const update = () => {
    ticking = false;
    const head = document.querySelector('.top');
    const off = Math.max((getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0) + 60, window.innerHeight * 0.25);
    let cur = links[0];
    for (const a of links) { const el = document.querySelector(a.getAttribute('href')); if (el && !el.hidden && el.getBoundingClientRect().top - off <= 0) cur = a; }
    links.forEach(a => a.classList.toggle('cur', a === cur));
    const part = cur.closest('.ng').dataset.part || '1';
    groups.forEach(x => x.classList.toggle('on', x.dataset.part === part));
    if (window.innerWidth < 900) { const nav = $('nav'); const r = cur.getBoundingClientRect(), nr = nav.getBoundingClientRect(); if (r.left < nr.left || r.right > nr.right) nav.scrollLeft += r.left - nr.left - 40; }
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update); update();
}

// ------------------------------------------------------------------ orchestration
const GS = () => S.idx.goalie_seasons || [];
function setHash() { const h = `#a=${S.A || ''}${S.B ? '&b=' + S.B : ''}&s=${S.season}`; if (location.hash !== h) history.replaceState(null, '', h); }
function readHash() { const o = {}; location.hash.replace(/^#/, '').split('&').forEach(kv => { const [k, v] = kv.split('='); if (k) o[k] = v; }); return o; }
function hasSeason(id, y) { const p = S.byId.get(id); return p && p.mask && (p.mask >> (y - S.idx.mp_first)) & 1; }
function bestSeason(id) {
  if (hasSeason(id, S.season)) return S.season;
  for (let y = S.idx.current; y >= S.idx.mp_first; y--) if (hasSeason(id, y)) { if (y === S.idx.current && hasSeason(id, y - 1) && S.season < S.idx.current) return y - 1; return y; }
  return S.season;
}
function renderSeasonSelect() { $('season').innerHTML = GS().slice().reverse().map(y => `<option value="${y}"${y === S.season ? ' selected' : ''}>${sLabel(y)}${hasSeason(S.A, y) ? '' : ' ·'}</option>`).join(''); }
async function render() {
  setHash(); renderSeasonSelect();
  const sd = await loadSeason(S.season).catch(() => null);
  const A = sd ? sd.byId.get(S.A) : null; const pa = S.byId.get(S.A) || {};
  safe('sec-profile', renderProfile);
  $('part1-h').textContent = A ? `${pa.name}'s ${sLabel(S.season)}` : 'The season';
  const secs = ['sec-rank', 'sec-matrix', 'sec-h2h', 'sec-env', 'sec-shots', 'sec-swap', 'sec-role', 'sec-form', 'sec-lineup'];
  secs.forEach(id => { const el = $(id); el.querySelectorAll(':scope > .nodata').forEach(x => x.remove()); [...el.children].forEach(ch => { if (!ch.classList.contains('head')) ch.hidden = !A; }); if (!A) el.insertAdjacentHTML('beforeend', `<p class="empty nodata">No ${sLabel(S.season)} MoneyPuck data for ${esc(pa.name || 'this goalie')}.${pa.mask ? ' Pick one of his seasons in the Season box.' : ' Expected-goal stats start in 2008-09.'}</p>`); });
  if (A) {
    safe('sec-rank', renderRank); safe('sec-matrix', renderMatrix); safe('sec-h2h', renderH2H); safe('sec-env', renderEnv); safe('sec-swap', renderSwap);
    renderShots().catch(e => console.error(e));
    renderRole().catch(e => console.error(e));
  }
  renderValue().catch(e => console.error(e));
  renderGemsGoalies().catch(e => console.error(e));
  if (CAR) { safe('sec-career', renderCareer); safe('sec-arcs', renderArcs); }
}
// ------------------------------------------------------------------ sidebar: scouting lists
// One goalie season is about half luck, so every list needs a shot minimum: GEM_SA shots this season (scaled to
// the share of the season played), GEM_SA3 shots for three-season judgments.
const GEM_SA = 1000, GEM_SA3 = 2500;
const GEM_TABS = [['box', 'Little help'], ['steal', 'Stealing games'], ['danger', 'Danger'], ['break', 'Breakout'], ['bounce', 'Bounce'], ['heavy', 'Heavy workload']];
const GEM_TITLE = { box: 'Doing more than the box score', steal: 'Stealing games', danger: 'Danger specialist', break: 'Breakout goalie', bounce: 'Due for a bounce', heavy: 'Heavy workload, below average' };
const recPct = p => { const d = (p.w || 0) + (p.l || 0) + (p.otl || 0); return d >= 5 ? (2 * (p.w || 0) + (p.otl || 0)) / (2 * d) : null; };
const recStr = p => `${p.w}-${p.l}-${p.otl || 0}`;
const gemG = (p, pct, label, note, meta, chips, sort) => ({ id: p.id, grp: 'G', name: p.name, meta, pct, sort, pctLabel: label, pctNote: note, chips });
// this season's regulars with enough shots
const gPool = sd => { const prog = Math.min(1, (sd.gpmax || 82) / 82); return pool(sd, 'reg').list.filter(p => nz(p.dsv) && (p.sa || 0) >= GEM_SA * prog); };
// three seasons to y summed: shots, goals, expected goals, high-danger
async function three(y) {
  const ss = (await Promise.all([y, y - 1, y - 2].map(z => loadSeason(z).catch(() => null)))).filter(Boolean);
  const T = new Map();
  for (const sd of ss) for (const p of sd.players) {
    const t = T.get(p.id) || { id: p.id, sa: 0, ga: 0, xga: 0, hn: 0, hx: 0, hg: 0, n: 0 };
    t.sa += p.sa || 0; t.ga += p.ga || 0; t.xga += p.xga || 0; t.hn += p.hd_n || 0; t.hx += p.hd_x || 0; t.hg += p.hd_g || 0; t.n++;
    T.set(p.id, t);
  }
  for (const t of T.values()) { t.dsv = t.sa ? 100 * (t.xga - t.ga) / t.sa : null; t.hd = t.hn ? 100 * (t.hx - t.hg) / t.hn : null; }
  return T;
}
const UNIT_PCT = 'The big number is a percentile: 97th means better than 97% of regular goalies that season.';
const GEM_BUILD = {
  // elite saves, little help
  box(y, sd) {
    const L = gPool(sd);
    const pQ = pctOf(L, p => p.dsv), pRec = pctOf(L, recPct), pX = pctOf(L, p => p.xgps), pB = pctOf(L, p => p.sa60);
    const items = [];
    for (const p of L) {
      const q = pQ(p.dsv); if (q < 80) continue;
      const chips = [];
      if (nz(recPct(p)) && pRec(recPct(p)) <= 40) chips.push(['Losing record', 'low']);
      if (pX(p.xgps) >= 80) chips.push(['Tough shots', 'tough']);
      if (pB(p.sa60) >= 80) chips.push(['Busy nights', 'mate']);
      if (chips.length) items.push(gemG(p, q, ord(Math.round(q)), 'saves', `${p.team} · ${recStr(p)} · ${s2(p.dsv)} sv% vs exp.`, chips, q));
    }
    return { items, unit: UNIT_PCT, sub: `Save % above expected in the top 20% of regular goalies in ${sLabel(y)} (${f0(GEM_SA)}+ shots, scaled to the season so far), with a losing record, tough shots or busy nights in front of him.` };
  },
  // winning because of him: elite saves, a decent record, a team that gives up a lot
  steal(y, sd) {
    const L = gPool(sd);
    const pQ = pctOf(L, p => p.dsv), pRec = pctOf(L, recPct), pXa = pctOf(L, p => p.xga60), pX = pctOf(L, p => p.xgps);
    const items = [];
    for (const p of L) {
      const q = pQ(p.dsv), r = pRec(recPct(p)), xa = pXa(p.xga60), x = pX(p.xgps);
      if (q < 80 || !nz(r) || r < 50 || (xa < 67 && x < 67)) continue;
      const chips = [[`${f1(p.gsax)} goals saved above expected`, 'mate']];
      if (xa >= 67) chips.push([`Team allows lots (${ord(Math.round(xa))})`, 'tough']);
      if (x >= 67) chips.push(['Tough shots', 'tough']);
      items.push(gemG(p, q, ord(Math.round(q)), 'saves', `${p.team} · ${recStr(p)} · ${s2(p.dsv)} sv% vs exp.`, chips, q + r + Math.max(xa, x)));
    }
    return { items, unit: UNIT_PCT, sub: `Save % above expected in the top 20% and a record in the top half, on a team that gives up lots of expected goals or dangerous shots (top third). The goalie is the reason they win.` };
  },
  // best on the most dangerous shots over three seasons
  async danger(y, sd) {
    const T = await three(y);
    const L = [...T.values()].filter(t => t.hn >= 300 && nz(t.hd) && sd.byId.has(t.id) && (sd.byId.get(t.id).gp || 0) >= minGp(sd));
    const pH = pctOf(L, t => t.hd);
    const items = [];
    for (const t of L) {
      const h = pH(t.hd); if (h < 80) continue;
      const p = sd.byId.get(t.id);
      items.push(gemG(p, h, ord(Math.round(h)), 'high danger', `${p.team} · ${s2(t.hd)} sv% vs exp. on high-danger shots`, [[`${f0(t.hn)} high-danger shots`, 'low'], [`${f1(t.hx - t.hg)} goals saved on them`, 'mate']], h));
    }
    return { items, unit: UNIT_PCT, sub: `Save % above expected on high-danger shots (from the slot and in tight) in the top 20%, over three seasons to ${sLabel(y)} with 300+ high-danger shots. A regular this season.` };
  },
  // young goalie whose saves jumped
  async break(y, sd) {
    const [car, prev] = await Promise.all([loadCareers().catch(() => null), loadSeason(y - 1).catch(() => null)]);
    if (!car || !prev) return { empty: 'Needs last season\'s data, which isn\'t available.' };
    const L = gPool(sd); const pQ = pctOf(L, p => p.dsv);
    const items = [];
    for (const p of L) {
      const q = prev.byId.get(p.id); const bio = car.players[p.id]; const age = bio ? ageNow(bio[3], y) : null;
      if (!q || !nz(q.dsv) || (q.sa || 0) < 500 || !nz(age) || age > 27) continue;
      const v = pQ(p.dsv), up = p.dsv - q.dsv;
      if (v < 67 || up < 0.8) continue;
      items.push(gemG(p, v, ord(Math.round(v)), 'saves', `${p.team} · age ${age} · ${recStr(p)}`, [[`Up ${s2(up)} sv% vs exp. on last season`, 'tough'], [`${f0(p.sa)} shots`, 'low']], up));
    }
    return { items, unit: UNIT_PCT, sub: `Age 27 or under, save % above expected in the top third in ${sLabel(y)} and up 0.8+ points on the season before (500+ shots then). Goalies develop later than skaters. Biggest jump first.` };
  },
  // proven goalie in a slump
  async bounce(y, sd) {
    const [a, b] = await Promise.all([loadSeason(y - 1).catch(() => null), loadSeason(y - 2).catch(() => null)]);
    if (!a || !b) return { empty: 'Needs the two seasons before, which aren\'t available.' };
    const items = [];
    for (const p of gPool(sd)) {
      if (p.dsv > -0.5) continue;
      const qa = a.byId.get(p.id), qb = b.byId.get(p.id);
      if (!qa || !qb || (qa.sa || 0) < 800 || (qb.sa || 0) < 800) continue;
      const before = 100 * ((qa.xga - qa.ga) + (qb.xga - qb.ga)) / (qa.sa + qb.sa); if (before < 0.3) continue;
      items.push(gemG(p, p.dsv, s2(p.dsv), 'sv% vs exp.', `${p.team} · ${recStr(p)} · ${f0(p.sa)} shots`, [[`${s2(before)} the two seasons before`, 'mate']], -p.dsv));
    }
    return { items, unit: 'The big number is save % compared with expected this season, in percentage points (−1.07 = about one goal more than expected per 100 shots).', sub: `Save % at least 0.5 points below expected in ${sLabel(y)}, after 0.3+ above expected over the two seasons before (800+ shots in each). Goalie slumps swing back more often than not. Furthest below first.` };
  },
  // lots of starts, below expected over three seasons
  async heavy(y, sd) {
    const T = await three(y);
    const L = pool(sd, 'reg').list.filter(p => T.has(p.id) && T.get(p.id).sa >= GEM_SA3);
    const pS = pctOf(L, p => p.gs), pQ3 = pctOf(L, p => T.get(p.id).dsv);
    const items = [];
    for (const p of L) {
      const s = pS(p.gs), q = pQ3(T.get(p.id).dsv);
      if (s < 75 || q > 20) continue;
      items.push(gemG(p, q, ord(Math.round(q)), '3-season saves', `${p.team} · ${p.gs} starts · ${recStr(p)}`, [[`${s2(T.get(p.id).dsv)} sv% vs exp. over 3 seasons`, 'low'], [`Starts ${ord(Math.round(s))}`, 'tough']], s - q));
    }
    return { items, unit: UNIT_PCT, sub: `Starts in the top quarter in ${sLabel(y)}, but save % above expected in the bottom 20% over three seasons (${f0(GEM_SA3)}+ shots). Not a verdict on his contract: add his cap hit on his page to judge that.` };
  },
};
async function renderGemsGoalies() {
  const y = S.season, tab = GEMS.tab in GEM_TITLE ? GEMS.tab : (GEMS.tab = 'box');
  const base = { title: GEM_TITLE[tab], how: 'about.html#m-gems', tabs: GEM_TABS, filters: null, onPick: pickGem, onTab: () => renderGemsGoalies().catch(e => console.error(e)), current: S.A };
  const sd = await loadSeason(y).catch(() => null);
  if (y !== S.season || tab !== GEMS.tab) return;
  if (!sd) { renderGems({ ...base, empty: `No ${sLabel(y)} goalie data yet.` }); return; }
  const r = await GEM_BUILD[tab](y, sd);
  if (y !== S.season || tab !== GEMS.tab) return;
  if (r.items) r.items.sort((a, b) => b.sort - a.sort);
  renderGems({ ...base, ...r });
}
function pickGem(id) {
  if (!id || id === S.A) return;
  if (id === S.B) S.B = S.A;
  S.A = id; S.extra = []; S.removed.clear(); S.sortKey = null;
  if (!hasSeason(id, S.season)) S.season = bestSeason(id);
  render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setA(id) { if (!id) return; if (id === S.B) S.B = S.A; S.A = id; S.extra = []; S.removed.clear(); S.sortKey = null; S.season = bestSeason(id); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function setB(id) { if (!id || id === S.A) return; S.B = id; render(); }
function wire() {
  const isG = p => p.pos === 'G';
  makeSearch('qA', setA, { cross: crossTo(true) });
  makeSearch('qB', setB, { filter: isG });
  makeSearch('qBoard', id => { if (!S.extra.includes(id)) S.extra.push(id); S.removed.delete(id); safe('sec-matrix', renderMatrix); safe('sec-env', renderEnv); }, { filter: p => isG(p) && hasSeason(p.id, S.season) });
  makeSearch('qArc', id => { if (!S.arcSel.includes(id) && id !== S.A) { S.arcSel.push(id); if (arcPlayers().length > 6) S.arcSel.shift(); } safe('sec-arcs', renderArcs); }, { filter: isG });
  $('season').addEventListener('change', e => { S.season = +e.target.value; render(); });
  $('rank-ctl').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.pool) { S.pool = b.dataset.pool; S.cache = {}; } if (b.dataset.pre) { const p = PRESETS[+b.dataset.pre]; S.w = { d: p[1], o: p[2], c: p[3] }; } render(); });
  $('weights').addEventListener('input', e => { const k = e.target.dataset.w; if (!k) return; S.w[k] = +e.target.value; safe('sec-rank', renderRank); });
  $('weights').addEventListener('change', () => { safe('sec-profile', renderProfile); safe('sec-matrix', renderMatrix); safe('sec-h2h', renderH2H); });
  $('rank').addEventListener('click', e => { const n = e.target.closest('[data-id]'); if (n) setA(+n.dataset.id); });
  $('matrix').addEventListener('click', e => { const s = e.target.closest('[data-sort]'); if (s) { S.sortKey = s.dataset.sort; safe('sec-matrix', renderMatrix); return; } const r = e.target.closest('[data-rm]'); if (r) { const id = +r.dataset.rm; S.extra = S.extra.filter(x => x !== id); S.removed.add(id); if (id === S.B) S.B = null; render(); } });
  $('mtoggle').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.mode) { S.boardMode = b.dataset.mode; S.removed.clear(); safe('sec-matrix', renderMatrix); safe('sec-env', renderEnv); return; } if (b.id === 'mv') S.showPct = !S.showPct; if (b.id === 'ms') S.sortKey = null; safe('sec-matrix', renderMatrix); });
  $('swapTeam').addEventListener('change', e => { S.swapTeam = e.target.value; S.swapOut = null; safe('sec-swap', renderSwap); });
  $('swapOut').addEventListener('change', e => { S.swapOut = +e.target.value; safe('sec-swap', renderSwap); });
  $('shots').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.sit) S.sh.sit = b.dataset.sit; if (b.dataset.view) S.sh.view = b.dataset.view; if (b.dataset.smooth) S.sh.smooth = b.dataset.smooth === '1'; renderShots(); });
  window.addEventListener('themechange', () => { if ($('shots').innerHTML) renderShots().catch(e => console.error(e)); });
  $('lineupTeam').addEventListener('change', e => { S.lineupTeam = e.target.value; const G = S.games[S.season]; if (G) renderLineup(G); });
  $('lineup').addEventListener('click', e => { const a = e.target.closest('[data-seta]'); if (!a) return; e.preventDefault(); setA(+a.dataset.seta); });
  $('cmode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.cmode = b.dataset.m; $('cmode').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); safe('sec-career', renderCareer); });
  $('ametric').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.arcMetric = b.dataset.am; safe('sec-arcs', renderArcs); });
  $('achips').addEventListener('click', e => { const b = e.target.closest('[data-rmarc]'); if (!b) return; const id = +b.dataset.rmarc; S.arcSel = S.arcSel.filter(x => x !== id); if (id === S.B) S.B = null; render(); });
  $('comps').addEventListener('click', e => { const a = e.target.closest('[data-addarc]'); if (!a) return; e.preventDefault(); const id = +a.dataset.addarc; if (!S.arcSel.includes(id)) { S.arcSel.push(id); if (arcPlayers().length > 6) S.arcSel.shift(); } safe('sec-arcs', renderArcs); });
  $('value').addEventListener('change', e => { const id = e.target.dataset.capid; if (!id) return; const v = getCap(+id); if (nz(v) && +e.target.value !== v) e.target.value = v; });
  $('value').addEventListener('input', e => { const id = e.target.dataset.capid; if (!id) return; let v = e.target.value === '' ? null : +e.target.value; if (nz(v) && v >= 1000) v = Math.round(v / 1e4) / 100; setCap(+id, v); const r = VAL && VAL.seasons[S.season] && VAL.seasons[S.season].map.get(+id); const el = $('pay-' + id); el.innerHTML = r ? payLine(r.worth, v, el.dataset.w3 === '' ? null : +el.dataset.w3) : ''; });
  window.addEventListener('hashchange', () => { const h = readHash(); const a = +h.a, b = +h.b, s = +h.s; let ch = false; if (a && a !== S.A && S.byId.has(a)) { if (S.byId.get(a).pos !== 'G') { location.href = './' + location.hash; return; } S.A = a; ch = true; } if (b && b !== S.B && S.byId.has(b)) { S.B = b; ch = true; } if (s && s !== S.season && GS().includes(s)) { S.season = s; ch = true; } if (ch) render(); });
}
async function init() {
  try {
    const idx = await getJSON('data/index.json');
    idx.list = idx.players.map(r => { const o = {}; idx.fields.forEach((k, i) => { o[k] = r[i]; }); o.mask = o.mp_mask; o.n = norm(o.name); return o; });
    S.idx = idx; idx.list.forEach(p => S.byId.set(p.id, p));
    if (!GS().length) throw new Error('no goalie seasons yet');
    $('updated').textContent = `Data updated ${idx.updated.replace('T', ' ').replace('Z', ' UTC')}.`;
    const h = readHash();
    if (S.byId.has(+h.a) && S.byId.get(+h.a).pos !== 'G') { location.replace('./' + location.hash); return; }
    S.season = GS().includes(+h.s) ? +h.s : GS()[GS().length - 1];
    const cur = await loadSeason(S.season).catch(() => null);
    if (!h.s && cur && cur.gpmax < 41 && GS().includes(S.season - 1)) S.season -= 1;
    const sd = await loadSeason(S.season);
    // default matchup: Vasilevskiy vs. Shesterkin, falling back to the top starters if either is missing
    const VASY = 8476883, SHESTY = 8478048;
    const top = sd.players.filter(p => p.gs >= 0.5 * sd.gpmax).sort((a, b) => b.gsax - a.gsax);
    S.A = S.byId.has(+h.a) ? +h.a : S.byId.has(VASY) ? VASY : (top[0] || sd.players[0]).id;
    const dflB = S.byId.has(SHESTY) && S.A !== SHESTY ? SHESTY : (top.find(p => p.id !== S.A) || {}).id || null;
    S.B = h.b === undefined ? dflB : (S.byId.has(+h.b) ? +h.b : null);
    if (!h.s) S.season = bestSeason(S.A);
    wire(); initNav(); $('status').hidden = true;
    await render();
    loadRosterNums().then(() => safe('sec-profile', renderProfile)).catch(() => {});
    loadCareers().then(() => render()).catch(e => { console.error(e); $('sec-career').insertAdjacentHTML('beforeend', '<p class="empty">Career data could not be loaded.</p>'); });
  } catch (e) {
    console.error(e);
    $('status').textContent = 'Could not load the goalie data files. The first goalie build may still be running; check the Actions tab on GitHub.';
    $('status').classList.add('err');
  }
}
init();
