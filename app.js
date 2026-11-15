'use strict';
/* Stats-Zor — everything runs in the browser from the JSON files in data/.
   No server, no AI. Data is refreshed nightly by .github/workflows/update-data.yml. */

// ------------------------------------------------------------------ helpers
const grpOf = pos => pos === 'D' ? 'D' : 'F';
const GRP_NAME = { D: 'defensemen', F: 'forwards' };
const BASE_GPG = 6.0;
const MAJOR = ['Hart', 'Norris', 'Selke', 'Art Ross', 'Richard', 'Lindsay', 'Calder', 'Conn Smythe'];

// ------------------------------------------------------------------ state
const S = {
  idx: null, byId: new Map(), seasons: {}, lines: {}, careers: null, mpc: null, cache: {},
  A: null, B: null, season: null,
  pool: 'reg', w: { d: 40, o: 40, c: 20 }, extra: [], removed: new Set(), sortKey: null, showPct: false,
  boardMode: 'top', cmode: 'age', arcMetric: 'adj82', arcSel: [], swapTeam: null, swapOut: null,
};

// ------------------------------------------------------------------ metrics
const MET = {
  toi: { l: 'TOI/GP', f: fmin, role: 1 }, ev: { l: '5v5 TOI/GP', f: fmin }, pk: { l: 'PK TOI/GP', f: fmin, role: 1 }, pp: { l: 'PP TOI/GP', f: fmin },
  dzs: { l: 'Own-zone start %', f: f1, role: 1 }, off_xgf_pct: { l: 'Team xGF% w/o him', f: f1, lo: 1, role: 1 },
  xga60: { l: 'xGA/60', f: f2, lo: 1 }, rel_xga60: { l: 'Rel xGA/60', f: s2, lo: 1 }, hdxga60: { l: 'HD xGA/60', f: f2, lo: 1 },
  ca60: { l: 'CA/60', f: f1, lo: 1 }, pk_xga60: { l: 'PK xGA/60', f: f2, lo: 1 },
  blk60: { l: 'Blocks/60', f: f2 }, tk60: { l: 'Takeaways/60', f: f2 }, hits60: { l: 'Hits/60', f: f2 },
  dzgv60: { l: 'DZ giveaways/60', f: f2, lo: 1 }, gv60: { l: 'Giveaways/60', f: f2, lo: 1 },
  xgf60: { l: 'xGF/60', f: f2 }, rel_xgf60: { l: 'Rel xGF/60', f: s2 }, ixg60: { l: 'ixG/60', f: f2 }, ig60: { l: 'Goals/60', f: f2 },
  ipts60: { l: 'Pts/60', f: f2 }, ia1_60: { l: 'Primary A/60', f: f2 }, isa60: { l: 'Shot att./60', f: f1 }, ihd60: { l: 'HD shots/60', f: f2 },
  pp_pts60: { l: 'PP pts/60', f: f2 }, pp_xgf60: { l: 'PP xGF/60', f: f2 }, gax82: { l: 'Goals above exp. /82', f: s1 },
  xgf_pct: { l: 'xGF%', f: f1 }, cf_pct: { l: 'CF%', f: f1 }, gf_pct: { l: 'GF%', f: f1 }, rel_xgf_pct: { l: 'Rel xGF%', f: s1 },
  gs: { l: 'GameScore/GP', f: f2 }, fo_pct: { l: 'Faceoff %', f: f1 }, pdiff60: { l: 'Pen. drawn − taken /60', f: s2 },
};
const COLS = {
  D: [['Role', ['toi', 'pk', 'dzs', 'off_xgf_pct']], ['Suppression · 5v5', ['xga60', 'rel_xga60', 'hdxga60', 'ca60', 'pk_xga60']],
    ['Defensive actions', ['blk60', 'tk60', 'hits60', 'dzgv60']], ['Offense', ['xgf60', 'rel_xgf60', 'ixg60', 'ipts60', 'pp_pts60']],
    ['Overall', ['xgf_pct', 'rel_xgf_pct', 'gf_pct', 'gs']]],
  F: [['Role', ['toi', 'pk', 'dzs', 'off_xgf_pct', 'fo_pct']], ['Scoring', ['ig60', 'ipts60', 'ia1_60', 'pp_pts60', 'gax82']],
    ['Shooting', ['isa60', 'ixg60', 'ihd60']], ['Play driving', ['xgf60', 'rel_xgf60', 'cf_pct', 'xgf_pct', 'rel_xgf_pct']],
    ['Defense', ['xga60', 'rel_xga60', 'hdxga60', 'pk_xga60', 'tk60', 'gv60']], ['Physical · discipline', ['hits60', 'blk60', 'pdiff60']]],
};
const COMP = {
  D: { d: [[0.75, ['xga60', 'rel_xga60', 'hdxga60', 'ca60', 'pk_xga60']], [0.25, ['blk60', 'tk60', 'dzgv60', 'hits60']]],
    o: [[1, ['xgf60', 'rel_xgf60', 'ixg60', 'ipts60', 'pp_pts60']]], c: [[1, ['toi', 'pk', 'dzs', 'off_xgf_pct']]] },
  F: { d: [[0.8, ['xga60', 'rel_xga60', 'hdxga60', 'pk_xga60']], [0.2, ['tk60', 'gv60']]],
    o: [[1, ['ig60', 'ipts60', 'ixg60', 'xgf60', 'rel_xgf60', 'pp_pts60']]], c: [[1, ['toi', 'pk', 'dzs', 'off_xgf_pct', 'fo_pct']]] },
};
const RADAR = {
  D: [['toi', 'Ice time'], ['dzs', 'Own-zone starts'], ['xga60', 'xGA/60'], ['rel_xga60', 'Rel xGA/60'], ['pk_xga60', 'PK xGA/60'], ['_bt', 'Blocks + takeaways'], ['rel_xgf60', 'Rel xGF/60'], ['ipts60', 'Pts/60']],
  F: [['toi', 'Ice time'], ['ig60', 'Goals/60'], ['ipts60', 'Pts/60'], ['ixg60', 'ixG/60'], ['rel_xgf60', 'Rel xGF/60'], ['rel_xga60', 'Rel xGA/60'], ['pk_xga60', 'PK xGA/60'], ['_fo', 'Faceoffs (C) / takeaways']],
};
const POOLS = { reg: { l: 'Regulars', D: 16, F: 12 }, top: { l: 'Top-pair D / top-six F', D: 20, F: 16 } };
const PRESETS = [['Balanced', 40, 40, 20], ['Defense first', 55, 25, 20], ['Points-driven ballot', 15, 75, 10], ['Even D/O, no context', 50, 50, 0]];

function derive(p) {
  p.grp = grpOf(p.pos);
  p.xgf_pct = share(p.xgf60, p.xga60); p.cf_pct = share(p.cf60, p.ca60); p.gf_pct = share(p.gf5, p.ga5);
  p.off_xgf_pct = share(p.off_xgf60, p.off_xga60); p.rel_xgf_pct = sub(p.xgf_pct, p.off_xgf_pct);
  p.rel_xgf60 = sub(p.xgf60, p.off_xgf60); p.rel_xga60 = sub(p.xga60, p.off_xga60);
  p.fo_pct = (p.fow + p.fol) >= 100 ? 100 * p.fow / (p.fow + p.fol) : null;
  p.pdiff60 = sub(p.pend60, p.pen60);
  p.gax82 = p.gp ? p.gax / p.gp * 82 : null;
  return p;
}

// ------------------------------------------------------------------ data loading
async function loadSeason(y) {
  if (S.seasons[y]) return S.seasons[y];
  const j = await getJSON(`data/seasons/${y}.json`);
  const players = j.players.map(r => { const o = {}; j.fields.forEach((k, i) => { o[k] = r[i]; }); return derive(o); });
  const sd = { y, gpmax: j.gpmax, teams: j.teams, updated: j.updated, players, byId: new Map(players.map(p => [p.id, p])) };
  S.seasons[y] = sd;
  return sd;
}
async function loadLines(y) {
  if (S.lines[y]) return S.lines[y];
  try { S.lines[y] = await getJSON(`data/lines/${y}.json`); } catch (e) { S.lines[y] = { lines: [] }; }
  return S.lines[y];
}
function pool(sd, grp, key = S.pool) {
  const ck = `${sd.y}|${grp}|${key}`;
  if (S.cache[ck]) return S.cache[ck];
  const minGp = Math.max(5, Math.round(0.35 * sd.gpmax));
  const thr = POOLS[key][grp];
  const list = sd.players.filter(p => p.grp === grp && p.gp >= minGp && p.toi >= thr);
  const out = { list, sorted: {} };
  S.cache[ck] = out;
  return out;
}
function pctl(sd, grp, k, v) {
  if (!nz(v)) return null;
  const P = pool(sd, grp);
  let arr = P.sorted[k];
  if (!arr) {
    const src = k === 'fo_pct' ? P.list.filter(p => p.pos === 'C') : P.list;
    arr = P.sorted[k] = src.map(p => p[k]).filter(nz).sort((a, b) => a - b);
  }
  if (!arr.length) return null;
  let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  let eq = lo; while (eq < arr.length && arr[eq] === v) eq++;
  const below = lo, equal = eq - lo, above = arr.length - eq;
  const raw = (below + equal / 2) / arr.length * 100;
  return Math.round(MET[k] && MET[k].lo ? 100 - raw : raw);
  void above;
}
function pk(sd, p, k) {
  if (k === '_bt') return avg([pctl(sd, p.grp, 'blk60', p.blk60), pctl(sd, p.grp, 'tk60', p.tk60)]);
  if (k === '_fo') return p.pos === 'C' && nz(p.fo_pct) ? pctl(sd, p.grp, 'fo_pct', p.fo_pct) : pctl(sd, p.grp, 'tk60', p.tk60);
  if (k === 'fo_pct' && p.pos !== 'C') return null;
  return pctl(sd, p.grp, k, p[k]);
}
function scores(sd, p) {
  const ck = `sc|${sd.y}|${S.pool}|${p.id}`;
  if (S.cache[ck]) return S.cache[ck];
  const part = parts => { let t = 0, w = 0; for (const [wt, keys] of parts) { const v = avg(keys.map(k => pk(sd, p, k))); if (nz(v)) { t += wt * v; w += wt; } } return w ? t / w : null; };
  const C = COMP[p.grp];
  const o = { d: part(C.d), o: part(C.o), c: part(C.c) };
  S.cache[ck] = o;
  return o;
}
function composite(sc) {
  const { d, o, c } = S.w; const t = (d + o + c) || 1;
  return ((sc.d ?? 50) * d + (sc.o ?? 50) * o + (sc.c ?? 50) * c) / t;
}

// ------------------------------------------------------------------ careers
let CAR = null;
function careerOf(id) {
  if (!CAR) return null;
  if (CAR.memo.has(id)) return CAR.memo.get(id);
  const bio = CAR.players[id];
  const rows = CAR.rowsBy.get(id) || [];
  if (!bio && !rows.length) { CAR.memo.set(id, null); return null; }
  const aw = CAR.awards[id] || [];
  const mp = CAR.mpBy.get(id) || [];
  const cur = S.idx.current;
  const seasons = rows.map(r => {
    const lg = CAR.league[r.y] || { gpg: BASE_GPG, sched: 82 };
    const fct = BASE_GPG / (lg.gpg || BASE_GPG);
    const sched = r.y === cur ? 82 : (lg.sched || 82);
    const m = mp.find(x => x.y === r.y);
    return {
      ...r, adjPts: r.pts * fct, adjG: r.g * fct, adj82: r.gp ? r.pts * fct / r.gp * 82 : null, adjg82: r.gp ? r.g * fct / r.gp * 82 : null,
      full: r.gp >= 0.4 * sched && r.y !== cur, partial: r.y === cur, aw: aw.filter(a => a[1] === r.y).map(a => a[0]),
      rel_xgf_pct: m ? m.rel_xgf_pct : null, rel_xga60: m ? m.rel_xga60 : null, xgf_pct: m ? m.xgf_pct : null, mpgp: m ? m.gp : 0,
    };
  });
  const c = { id, name: bio ? bio[0] : (S.byId.get(id) || {}).name, pos: bio ? bio[1] : (S.byId.get(id) || {}).pos, shoots: bio && bio[2], birth: bio && bio[3], ht: bio && bio[4], wt: bio && bio[5], hof: bio && bio[6], awards: aw, S: seasons };
  c.grp = grpOf(c.pos);
  CAR.memo.set(id, c);
  return c;
}
function ctot(Ss) {
  const gp = Ss.reduce((a, s) => a + s.gp, 0);
  const t = k => Ss.reduce((a, s) => a + (s[k] || 0), 0);
  const ts = Ss.filter(s => nz(s.toi)); const tg = ts.reduce((a, s) => a + s.gp, 0);
  const mp = Ss.filter(s => nz(s.rel_xgf_pct)); const mg = mp.reduce((a, s) => a + s.mpgp, 0);
  const wavg = k => mg ? mp.reduce((a, s) => a + s[k] * s.mpgp, 0) / mg : null;
  const aw = Ss.flatMap(s => s.aw);
  return {
    n: Ss.length, gp, g: t('g'), a: t('a'), pts: t('pts'), adj: t('adjPts'), adjG: t('adjG'),
    adj82: gp ? t('adjPts') / gp * 82 : null, adjg82: gp ? t('adjG') / gp * 82 : null,
    toi: tg ? ts.reduce((a, s) => a + s.toi * s.gp, 0) / tg : null, toiCover: gp ? tg / gp : 0,
    rel_xgf_pct: wavg('rel_xgf_pct'), rel_xga60: wavg('rel_xga60'), mpgp: mg,
    major: aw.filter(a => MAJOR.includes(a)).length, cups: aw.filter(a => a === 'Cup').length, aw,
  };
}

async function loadCareers() {
  if (CAR) return CAR;
  const [c, m] = await Promise.all([getJSON('data/careers.json'), getJSON('data/mp_careers.json').catch(() => ({ fields: [], rows: [] }))]);
  const rowsBy = new Map();
  for (const r of c.seasons) { const o = {}; c.fields.forEach((k, i) => { o[k] = r[i]; }); if (!rowsBy.has(o.id)) rowsBy.set(o.id, []); rowsBy.get(o.id).push(o); }
  const mpBy = new Map();
  for (const r of m.rows) { const o = {}; m.fields.forEach((k, i) => { o[k] = r[i]; }); if (!mpBy.has(o.id)) mpBy.set(o.id, []); mpBy.get(o.id).push(o); }
  const players = {}; for (const [k, v] of Object.entries(c.players)) players[+k] = v;
  const awards = {}; for (const [k, v] of Object.entries(c.awards || {})) awards[+k] = v;
  const league = {}; for (const [k, v] of Object.entries(c.league)) league[+k] = v;
  CAR = { players, rowsBy, mpBy, awards, league, memo: new Map() };
  return CAR;
}

// ------------------------------------------------------------------ search

// ------------------------------------------------------------------ svg helpers


// ------------------------------------------------------------------ NHL EDGE tracking (2021-22 on)
const EDGE = {};
async function loadEdge(y) {
  if (EDGE[y] !== undefined) return EDGE[y];
  try { const j = await getJSON(`data/edge/${y}.json`); const m = new Map(); j.rows.forEach(r => { const o = {}; j.fields.forEach((k, i) => { o[k] = r[i]; }); m.set(o.id, o); }); EDGE[y] = m; }
  catch (e) { EDGE[y] = null; }
  return EDGE[y];
}
async function loadAllEdge() { const ys = (S.idx.mp_seasons || []).filter(y => y >= 2021); await Promise.all(ys.map(loadEdge)); }
const edgeOf = (y, id) => EDGE[y] ? EDGE[y].get(id) || null : null;
const pctTxt = v => nz(v) ? ord(Math.round(v * 100)) : '—';
function toolsHTML(id, y) {
  const e = edgeOf(y, id);
  if (!e) return y >= 2021 && EDGE[y] === undefined ? '' : (y < 2021 ? '' : `<p class="sub small" style="margin-top:10px">No NHL EDGE tracking data for this player in ${sLabel(y)}.</p>`);
  const perGame = e.gp ? e.bursts20 / e.gp : null;
  const T = [[nz(e.speed_mph) ? e.speed_mph.toFixed(1) + ' mph' : '—', 'Top skating speed', e.speed_pct],
    [f0(e.bursts20), '20+ mph bursts', e.bursts20_pct],
    [nz(e.shot_mph) ? e.shot_mph.toFixed(1) + ' mph' : '—', 'Hardest shot', e.shot_pct],
    [nz(e.dist_mi) && e.gp ? (e.dist_mi / e.gp).toFixed(2) + ' mi' : '—', 'Skated per game', e.dist_pct],
    [nz(e.oz_ev_pct) ? (100 * e.oz_ev_pct).toFixed(1) + '%' : '—', 'Offensive-zone time at 5v5', e.oz_ev_pctile]];
  // trend against his best earlier EDGE season
  let trend = '';
  const prev = Object.keys(EDGE).map(Number).filter(z => z < y && EDGE[z]).map(z => [z, edgeOf(z, id)]).filter(x => x[1] && x[1].gp >= 20);
  if (prev.length && e.gp >= 10) {
    const bestSp = prev.reduce((b, x) => (x[1].speed_mph ?? 0) > (b[1].speed_mph ?? 0) ? x : b);
    const bestBu = prev.reduce((b, x) => (x[1].bursts20 / x[1].gp) > (b[1].bursts20 / b[1].gp) ? x : b);
    const ds = nz(e.speed_mph) && nz(bestSp[1].speed_mph) ? e.speed_mph - bestSp[1].speed_mph : null;
    const db = nz(perGame) ? 100 * (perGame / (bestBu[1].bursts20 / bestBu[1].gp) - 1) : null;
    const parts = [];
    if (nz(ds)) parts.push(`top speed ${ds >= 0 ? '+' : '−'}${Math.abs(ds).toFixed(1)} mph vs. his ${sLabel(bestSp[0])} best`);
    if (nz(db) && Number.isFinite(db)) parts.push(`20+ mph bursts per game ${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(0)}% vs. ${sLabel(bestBu[0])}`);
    const warn = (nz(ds) && ds <= -0.5) || (nz(db) && db <= -25);
    if (parts.length) trend = `<p class="sub small" style="margin-top:6px">${warn ? '<b class="neg">Slowing:</b> ' : 'Trend: '}${parts.join('; ')}.${warn ? ' Speed usually fades before scoring does.' : ''}</p>`;
  }
  return `<p class="minihead" style="margin-top:12px">Tools · NHL EDGE tracking · percentile vs. his position</p><div class="tiles">${T.map(([b, l, p]) => `<div class="tile"><b style="font-size:21px">${b}</b><span>${l}${nz(p) ? ` · ${pctTxt(p)}` : ''}</span></div>`).join('')}</div>${trend}`;
}

// ------------------------------------------------------------------ rendering: profile
function seasonOf(id) { const sd = S.seasons[S.season]; return sd ? sd.byId.get(id) : null; }
function renderProfile() {
  const card = (id, cls) => {
    if (!id) return `<div class="pcard ${cls}"><p class="empty">Pick a second player in the search box above to compare.</p></div>`;
    const ix = S.byId.get(id) || {};
    const c = careerOf(id);
    const p = seasonOf(id);
    const sd = S.seasons[S.season];
    const pos = (p && p.pos) || (c && c.pos) || ix.pos || '';
    const age = c && c.birth ? ageNow(c.birth, S.season) : null;
    const meta = [p ? p.team : ix.team, pos, c && c.shoots ? `Shoots ${c.shoots}` : '', age ? `Age ${age}` : '', c ? [htFmt(c.ht), c.wt ? c.wt + ' lb' : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ');
    let tiles = '';
    if (p) {
      const sc = scores(sd, p);
      const T = [[`${p.g}-${p.a1 + p.a2}-${p.pts}`, `G-A-P in ${p.gp} GP`], [fmin(p.toi), 'TOI per game'], [f1(p.xgf_pct), 'xGF% at 5v5'], [s1(p.rel_xgf_pct), 'Rel xGF%'],
        [f0(sc.d), 'Defense score'], [f0(sc.o), 'Offense score'], [f0(sc.c), 'Role difficulty']];
      tiles = `<p class="minihead">${sLabel(S.season)} · scores are percentiles vs ${GRP_NAME[p.grp]}</p><div class="tiles">${T.map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join('')}</div>`;
    } else {
      tiles = `<p class="empty">No ${sLabel(S.season)} MoneyPuck data for ${esc(ix.name || '')}. ${ix.mask ? 'Pick one of his seasons in the Season box.' : 'Advanced stats start in 2008-09; the career sections below still work.'}</p>`;
    }
    let badges = '';
    if (c) {
      const t = ctot(c.S);
      const bs = [`${t.gp} GP · ${t.pts} pts`, ...Object.entries(c.awards.reduce((o, a) => { o[a[0]] = (o[a[0]] || 0) + 1; return o; }, {})).map(([k, v]) => `<span class="badge gold">${esc(k)}${v > 1 ? ' ×' + v : ''}</span>`)];
      if (c.hof) bs.push('<span class="badge gold">Hall of Fame</span>');
      badges = `<div class="badges">${bs.map(b => b.startsWith('<') ? b : `<span class="badge">${b}</span>`).join('')}</div>`;
    }
    return `<div class="pcard ${cls}"><h1>${esc(ix.name || (c && c.name) || id)}</h1><p class="meta">${esc(meta)}</p>${tiles}${toolsHTML(id, S.season)}${badges}</div>`;
  };
  $('sec-profile').innerHTML = `<div class="prof">${card(S.A, 'a')}${card(S.B, 'b')}</div>`;
}

// ------------------------------------------------------------------ ranking
function renderRank() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A); const grp = A ? A.grp : 'D';
  const P = pool(sd, grp);
  $('rank-sub').textContent = `Each score averages percentile ranks against ${P.list.length} ${GRP_NAME[grp]} (${POOLS[S.pool].l.toLowerCase()}: ${POOLS[S.pool][grp]}+ min a night, ${Math.max(5, Math.round(0.35 * sd.gpmax))}+ games) in ${sLabel(S.season)}. Drag the weights to reorder.`;
  $('rank-ctl').innerHTML = `<span class="lbl">Pool</span><span class="toggle">${Object.entries(POOLS).map(([k, v]) => `<button type="button" data-pool="${k}" aria-pressed="${S.pool === k}">${v.l}</button>`).join('')}</span>
    <span class="lbl">Presets</span><span class="toggle">${PRESETS.map((p, i) => `<button type="button" data-pre="${i}" aria-pressed="${S.w.d === p[1] && S.w.o === p[2] && S.w.c === p[3]}">${p[0]}</button>`).join('')}</span>`;
  const t = (S.w.d + S.w.o + S.w.c) || 1;
  $('weights').innerHTML = [['d', 'Defense'], ['o', 'Offense'], ['c', 'Role difficulty']].map(([k, l]) =>
    `<div><label for="w${k}">${l} <span class="mono">${Math.round(S.w[k] / t * 100)}%</span></label><input type="range" id="w${k}" data-w="${k}" min="0" max="100" value="${S.w[k]}"></div>`).join('');
  const list = P.list.map(p => { const sc = scores(sd, p); return { p, sc, s: composite(sc) }; }).sort((a, b) => b.s - a.s);
  const extra = [S.A, S.B].map(id => sd.byId.get(id)).filter(p => p && p.grp === grp && !P.list.includes(p)).map(p => { const sc = scores(sd, p); return { p, sc, s: composite(sc), out: 1 }; });
  const top = 25; const rows = [];
  list.forEach((r, i) => { if (i < top || r.p.id === S.A || r.p.id === S.B) rows.push([i + 1, r]); });
  const html = []; let prev = 0;
  for (const [rk, r] of rows) {
    if (rk - prev > 1 && prev >= top) html.push(`<div class="rrow gap">· · ·</div>`);
    html.push(rrow(rk, r, t)); prev = rk;
  }
  extra.forEach(r => html.push(`<div class="rrow gap">Below the pool's minutes or games cutoff:</div>` + rrow('—', r, t)));
  $('rank').innerHTML = html.join('');
}
function rrow(rk, r, t) {
  const { p, sc } = r; const w = S.w;
  const cls = p.id === S.A ? 'isA' : p.id === S.B ? 'isB' : '';
  const d = (sc.d ?? 50) * w.d / t, o = (sc.o ?? 50) * w.o / t, c = (sc.c ?? 50) * w.c / t;
  return `<div class="rrow ${cls}"><span class="mono">${rk}</span><span class="nm" data-id="${p.id}" title="Make ${esc(p.name)} the main player">${esc(p.name)}<small>${p.team} · ${p.pos}</small></span>
    <div class="bar" title="Defense ${f0(sc.d)} · Offense ${f0(sc.o)} · Role ${f0(sc.c)}"><i class="seg-d" style="width:${d}%"></i><i class="seg-o" style="width:${o}%"></i><i class="seg-c" style="width:${c}%"></i></div><b class="mono">${f1(r.s)}</b></div>`;
}

// ------------------------------------------------------------------ stat board
function similarity(sd, grp) {
  const A = sd.byId.get(S.A); const ck = `sim|${sd.y}|${S.pool}|${S.A}|${EDGE[sd.y] ? 'e' : ''}`;
  if (S.cache[ck]) return S.cache[ck];
  const keys = COLS[grp].flatMap(c => c[1]);
  const pa = keys.map(k => pk(sd, A, k));
  const out = new Map();
  for (const p of pool(sd, grp).list) {
    if (p.id === S.A) continue;
    let sum = 0, n = 0;
    keys.forEach((k, i) => { const v = pk(sd, p, k); if (nz(v) && nz(pa[i])) { sum += (v - pa[i]) ** 2; n++; } });
    if (n < keys.length * 0.6) continue;
    // style: NHL EDGE skating speed, bursts and shot speed, half weight each, when both players have them
    const ea = edgeOf(sd.y, S.A), eb = edgeOf(sd.y, p.id);
    if (ea && eb) ['speed_pct', 'bursts20_pct', 'shot_pct'].forEach(k => { if (nz(ea[k]) && nz(eb[k])) { sum += 0.5 * (100 * (ea[k] - eb[k])) ** 2; n += 0.5; } });
    out.set(p.id, Math.max(0, 100 - Math.sqrt(sum / n)));
  }
  S.cache[ck] = out;
  return out;
}
function boardIds(sd, grp) {
  const P = pool(sd, grp);
  const A = sd.byId.get(S.A);
  const auto = S.boardMode === 'sim' && A && A.grp === grp
    ? [...similarity(sd, grp).entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])
    : P.list.map(p => [composite(scores(sd, p)), p.id]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const ids = [];
  const add = id => { if (id && !ids.includes(id) && sd.byId.get(id) && sd.byId.get(id).grp === grp) ids.push(id); };
  add(S.A); add(S.B); S.extra.forEach(add);
  for (const id of auto) { if (ids.length >= 12 + S.extra.length) break; if (!S.removed.has(id)) add(id); }
  return ids;
}
function renderMatrix() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A); const grp = A ? A.grp : 'D';
  const cols = COLS[grp]; const flat = cols.flatMap(c => c[1]);
  let ids = boardIds(sd, grp);
  let ps = ids.map(id => sd.byId.get(id));
  if (S.sortKey && flat.includes(S.sortKey)) ps.sort((a, b) => (pk(sd, b, S.sortKey) ?? -1) - (pk(sd, a, S.sortKey) ?? -1));
  const simMap = S.boardMode === 'sim' ? similarity(sd, grp) : null;
  $('mtoggle').innerHTML = `<button type="button" data-mode="top" aria-pressed="${S.boardMode !== 'sim'}">Fill with top-ranked</button><button type="button" data-mode="sim" aria-pressed="${S.boardMode === 'sim'}">Fill with most similar</button><button type="button" id="mv" aria-pressed="${S.showPct}">Show percentiles</button>${S.sortKey ? '<button type="button" id="ms">Clear sort</button>' : ''}`;
  let h = `<thead><tr><th></th>${cols.map(g => `<th class="grp" colspan="${g[1].length}">${g[0]}</th>`).join('')}</tr><tr><th style="text-align:left">Player · GP</th>${flat.map(k => `<th><button type="button" data-sort="${k}">${MET[k].l}${S.sortKey === k ? ' ▾' : ''}</button></th>`).join('')}</tr></thead><tbody>`;
  h += ps.map(p => {
    const cls = p.id === S.A ? 'isA' : p.id === S.B ? 'isB' : '';
    const rm = p.id === S.A ? '' : `<button type="button" data-rm="${p.id}" title="Remove from board">×</button>`;
    return `<tr class="${cls}"><td class="pn">${esc(p.name)} <span class="mono" style="color:var(--muted);font-weight:400">${p.team} ${p.gp}</span>${simMap && simMap.has(p.id) ? `<span class="mono" style="color:var(--b);font-weight:600;font-size:11px" title="Profile match: 100 means identical percentiles across every column"> ${Math.round(simMap.get(p.id))}% match</span>` : ''}${rm}</td>` + flat.map(k => {
      const pc = pk(sd, p, k);
      return `<td style="background:${heat(pc)}">${S.showPct ? (pc ?? '—') : MET[k].f(p[k])}${!S.showPct && nz(pc) ? `<small>${pc}</small>` : ''}</td>`;
    }).join('') + '</tr>';
  }).join('');
  const B = seasonOf(S.B);
  const note = B && B.grp !== grp ? `<p class="sub small">${esc(B.name)} plays a different position, so he isn't on this board. Boards compare within a position.</p>` : '';
  $('matrix').innerHTML = h + '</tbody>';
  const wrap = $('matrix').parentElement; wrap.querySelectorAll('p.sub').forEach(x => x.remove()); if (note) wrap.insertAdjacentHTML('beforeend', note);
}

// ------------------------------------------------------------------ head to head
function renderH2H() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A); const B = seasonOf(S.B);
  const ax = RADAR[A.grp];
  const cx = 230, cy = 215, R = 150, n = ax.length;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
  let s = '';
  [25, 50, 75, 100].forEach(r => { s += `<polygon points="${ax.map((_, i) => pt(i, r).join(',')).join(' ')}" fill="none" class="ax"/>`; });
  s += `<text x="${cx + 4}" y="${cy - R * 0.5 - 3}" class="lab">50th</text><text x="${cx + 4}" y="${cy - R - 3}" class="lab">100th</text>`;
  ax.forEach((a, i) => { const [x, y] = pt(i, 100), [lx, ly] = pt(i, 118); s += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="ax"/><text x="${lx}" y="${ly + 4}" text-anchor="${Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end'}" font-size="12" font-weight="600">${esc(a[1])}</text>`; });
  const poly = (p, col) => { const v = ax.map(a => pk(sd, p, a[0]) ?? 0); return `<polygon points="${v.map((x, i) => pt(i, x).join(',')).join(' ')}" fill="${col}" fill-opacity=".15" stroke="${col}" stroke-width="2.4"/>` + v.map((x, i) => { const [px, py] = pt(i, x); return `<circle cx="${px}" cy="${py}" r="3.4" fill="${col}"><title>${esc(p.name)} · ${esc(ax[i][1])}: ${Math.round(x)}th percentile</title></circle>`; }).join(''); };
  if (B) s += poly(B, 'var(--b)');
  s += poly(A, 'var(--a)');
  $('radar').innerHTML = s;
  const rows = [['Games', p => p.gp, f0], ['TOI/GP', p => p.toi, fmin], ['Goals', p => p.g, f0], ['Points', p => p.pts, f0], ['Pts/60 (5v5)', p => p.ipts60, f2],
    ['xGF%', p => p.xgf_pct, f1], ['Rel xGF%', p => p.rel_xgf_pct, s1], ['Rel xGA/60', p => p.rel_xga60, s2], ['Own-zone starts', p => p.dzs, f1],
    ['Defense score', p => scores(sd, p).d, f0], ['Offense score', p => scores(sd, p).o, f0], ['Role difficulty', p => scores(sd, p).c, f0], ['Composite', p => composite(scores(sd, p)), f1]];
  const lo = new Set(['Rel xGA/60']);
  const cell = (row, p, q) => { const v = row[1](p), w = q ? row[1](q) : null; const win = q && nz(v) && nz(w) && v !== w && (lo.has(row[0]) ? v < w : v > w); return `<td class="${win ? 'win' : ''}">${row[2](v)}</td>`; };
  $('h2h-table').innerHTML = `<table class="tape"><thead><tr><th>${sLabel(S.season)}</th><th class="a">${esc(last(A.name))}</th><th class="b">${B ? esc(last(B.name)) : '—'}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td>${cell(r, A, B)}${B ? cell(r, B, A) : '<td>—</td>'}</tr>`).join('')}</tbody></table>
    ${B && B.grp !== A.grp ? `<p class="sub small">Different positions: each player's percentiles are against his own position group.</p>` : ''}<p class="sub small">● marks the better value in each row.</p>`;
}

// ------------------------------------------------------------------ scatters
function scatter(svgId, xk, yk, xl, yl, notes, refs) {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A); const grp = A.grp;
  const P = pool(sd, grp).list.filter(p => nz(p[xk]) && nz(p[yk]));
  const board = boardIds(sd, grp).map(id => sd.byId.get(id)).filter(p => p && nz(p[xk]) && nz(p[yk]));
  const B = seasonOf(S.B);
  const all = [...P, ...board, ...(B && nz(B[xk]) && nz(B[yk]) ? [B] : [])];
  const W = 520, H = 440, m = { l: 52, r: 16, t: 18, b: 46 };
  const xd = extent(all.map(p => p[xk])), yd = extent(all.map(p => p[yk]));
  const xs = niceStep(xd[1] - xd[0]), ys = niceStep(yd[1] - yd[0]);
  const xf = v => Math.abs(xs) < 1 ? v.toFixed(xs < 0.1 ? 2 : 1) : v, yf = v => Math.abs(ys) < 1 ? v.toFixed(ys < 0.1 ? 2 : 1) : v;
  const g = axes(W, H, m, xd, yd, ticks(xd[0], xd[1], xs), ticks(yd[0], yd[1], ys), xl, yl, xf, yf);
  let s = g.s;
  if (refs) { const [rx, ry] = refs(P); if (nz(rx)) s += `<line x1="${g.X(rx)}" x2="${g.X(rx)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-width="1"/>`; if (nz(ry)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(ry)}" y2="${g.Y(ry)}" stroke="var(--muted)" stroke-width="1"/>`; }
  s += notes(g, W, H, m);
  const bset = new Set(board.map(p => p.id));
  P.forEach(p => { if (!bset.has(p.id)) s += `<circle cx="${g.X(p[xk])}" cy="${g.Y(p[yk])}" r="3" fill="var(--dot)"><title>${esc(p.name)}</title></circle>`; });
  const mark = (p, col, r, big) => {
    const x = g.X(p[xk]), y = g.Y(p[yk]); const anchor = x > W - m.r - 80 ? 'end' : 'start';
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}" stroke="var(--panel)" stroke-width="1.5"><title>${esc(p.name)}: ${MET[xk] ? MET[xk].f(p[xk]) : p[xk]}, ${MET[yk] ? MET[yk].f(p[yk]) : p[yk]}</title></circle><text data-l="1" x="${anchor === 'end' ? x - 8 : x + 8}" y="${y - 8}" text-anchor="${anchor}" font-size="${big ? 13 : 11}" font-weight="${big ? 700 : 600}" fill="${col}">${esc(last(p.name))}</text>`;
  };
  board.forEach(p => { if (p.id !== S.A && p.id !== S.B) s += mark(p, 'var(--board)', 4.5, false); });
  if (B && nz(B[xk]) && nz(B[yk])) s += mark(B, 'var(--b)', 6.5, true);
  s += mark(A, 'var(--a)', 7, true);
  const el = $(svgId); el.innerHTML = s; placeLabels(el);
}
function renderEnv() {
  scatter('sc1', 'xga60', 'xgf60', 'xGA/60 at 5v5 (fewer is better →  left)', 'xGF/60 at 5v5', (g, W, H, m) => `<text x="${m.l + 6}" y="${m.t + 12}" class="lab">Drives play, suppresses</text><text x="${W - m.r - 4}" y="${H - m.b - 8}" text-anchor="end" class="lab">Bleeds chances, little offense</text>`, P => [median(P.map(p => p.xga60)), median(P.map(p => p.xgf60))]);
  scatter('sc2', 'dzs', 'rel_xgf_pct', 'Own-zone start % at 5v5 (tougher →  right)', 'Rel xGF% (team with him minus without)', (g, W, H, m) => `<text x="${W - m.r - 4}" y="${m.t + 12}" text-anchor="end" class="lab">Hard minutes, still lifts the team</text><text x="${m.l + 6}" y="${m.t + 12}" class="lab">Sheltered, lifts the team</text>`, P => [median(P.map(p => p.dzs)), 0]);
}

// ------------------------------------------------------------------ linemates
async function renderMates() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A);
  const L = await loadLines(S.season);
  if (S.A !== A.id || sd !== S.seasons[S.season]) return;
  const kind = A.grp === 'D' ? 'P' : 'L';
  const mine = (L.lines || []).filter(r => r[2] === kind && r[0].includes(A.id));
  $('mates-sub').textContent = A.grp === 'D'
    ? `${A.name}'s 5v5 results with and without each defense partner in ${sLabel(S.season)}. "Without" is everything else he played, which comes mostly with other partners.`
    : `${A.name}'s 5v5 results with and without each linemate in ${sLabel(S.season)}, built from MoneyPuck's forward-line data.`;
  if (!mine.length) { $('mates').innerHTML = ''; $('combos').innerHTML = `<p class="empty">No ${kind === 'P' ? 'pairing' : 'line'} data for this player and season.</p>`; return; }
  const tog = new Map();
  for (const r of mine) for (const id of r[0]) { if (id === A.id) continue; const t = tog.get(id) || { t: 0, xgf: 0, xga: 0, gf: 0, ga: 0 }; t.t += r[3]; t.xgf += r[4]; t.xga += r[5]; t.gf += r[8]; t.ga += r[9]; tog.set(id, t); }
  const tot = p => ({ t: p.t5, xgf: p.xgf5, xga: p.xga5, gf: p.gf5, ga: p.ga5 });
  const minus = (a, b) => ({ t: a.t - b.t, xgf: a.xgf - b.xgf, xga: a.xga - b.xga, gf: a.gf - b.gf, ga: a.ga - b.ga });
  const xp = o => o.t >= 600 ? f1(share(o.xgf, o.xga)) : '—';
  const mn = o => f0(Math.max(0, o.t) / 60);
  const rows = [...tog.entries()].filter(([, t]) => t.t >= 1800).sort((a, b) => b[1].t - a[1].t).slice(0, 10);
  const At = tot(A);
  $('mates').innerHTML = `<thead><tr><th>${kind === 'P' ? 'Partner' : 'Linemate'}</th><th>Min together</th><th>xGF% together</th><th>Goals together</th><th>${esc(last(A.name))} without · min</th><th>xGF%</th><th>Partner without ${esc(last(A.name))} · min</th><th>xGF%</th></tr></thead><tbody>` +
    rows.map(([id, t]) => {
      const T = sd.byId.get(id); const aw = minus(At, t); const tw = T ? minus(tot(T), t) : null;
      const xt = share(t.xgf, t.xga), xa = aw.t >= 600 ? share(aw.xgf, aw.xga) : null, xb = tw && tw.t >= 600 ? share(tw.xgf, tw.xga) : null;
      const c = (v, ref) => nz(v) && nz(ref) ? (v > ref ? 'pos' : v < ref ? 'neg' : '') : '';
      return `<tr><td>${esc(T ? T.name : id)}</td><td>${mn(t)}</td><td>${f1(xt)}</td><td>${t.gf}-${t.ga}</td><td>${mn(aw)}</td><td class="${c(xa, xt)}">${xp(aw)}</td><td>${tw ? mn(tw) : '—'}</td><td class="${c(xb, xt)}">${tw ? xp(tw) : '—'}</td></tr>`;
    }).join('') + '</tbody>';
  const combos = mine.slice().sort((a, b) => b[3] - a[3]).slice(0, 6);
  $('combos').innerHTML = `<p class="minihead" style="margin-top:16px">Most-used ${kind === 'P' ? 'pairs' : 'lines'}</p><div class="scroll"><table class="tbl"><thead><tr><th>${kind === 'P' ? 'Pair' : 'Line'}</th><th>Min</th><th>xGF%</th><th>CF%</th><th>Goals</th></tr></thead><tbody>` +
    combos.map(r => `<tr><td>${r[0].map(id => esc(last((sd.byId.get(id) || {}).name || id))).join(' – ')}</td><td>${f0(r[3] / 60)}</td><td>${f1(share(r[4], r[5]))}</td><td>${f1(share(r[6], r[7]))}</td><td>${r[8]}-${r[9]}</td></tr>`).join('') + '</tbody></table></div><p class="sub small">Green and red show whether a player did better or worse apart than together. Samples under 10 minutes are left blank.</p>';
}

// ------------------------------------------------------------------ team swap
function renderSwap() {
  const sd = S.seasons[S.season]; const A = seasonOf(S.A);
  const teams = sd.teams.filter(t => t !== A.team);
  if (!teams.includes(S.swapTeam)) S.swapTeam = teams[0];
  $('swapTeam').innerHTML = teams.map(t => `<option${t === S.swapTeam ? ' selected' : ''}>${t}</option>`).join('');
  const cands = sd.players.filter(p => p.team === S.swapTeam && p.grp === A.grp && p.t5 >= 3600 && nz(p.off_xgf60)).sort((a, b) => b.t5 - a.t5);
  if (!cands.find(p => p.id === S.swapOut)) S.swapOut = cands[0] ? cands[0].id : null;
  $('swapOut').innerHTML = cands.map(p => `<option value="${p.id}"${p.id === S.swapOut ? ' selected' : ''}>${esc(p.name)} (${fmin(p.ev)} 5v5/gp)</option>`).join('');
  const R = sd.byId.get(S.swapOut);
  if (!R || !nz(A.off_xgf60)) { $('swap').innerHTML = '<p class="empty">Not enough 5v5 data for this swap.</p>'; return; }
  const rel = p => ({ f: p.xgf60 - p.off_xgf60, a: p.xga60 - p.off_xga60 });
  const off = p => ({ f: p.off_xgf60, a: p.off_xga60 });
  const ra = rel(A), rr = rel(R);
  const S1 = { f: off(R).f + ra.f, a: off(R).a + ra.a }; // A on R's team
  const S2 = { f: off(A).f + rr.f, a: off(A).a + rr.a }; // R on A's team
  const actA = { f: A.xgf60, a: A.xga60 }, actR = { f: R.xgf60, a: R.xga60 };
  const minA = A.ev * 82, minR = R.ev * 82;
  const diff = (o, mins) => (o.f - o.a) * mins / 60;
  const sw1 = diff(S1, minA) - diff(actR, minR), sw2 = diff(S2, minR) - diff(actA, minA);
  const pc = o => share(o.f, o.a);
  const word = v => v >= 0 ? 'better' : 'worse';
  $('swap').innerHTML = `<div class="swapgrid">
    <div class="v a"><b>${S.swapTeam} gets ${word(sw1)}</b><p>With ${esc(A.name)} instead of ${esc(R.name)}, ${S.swapTeam} projects to ${f1(pc(S1))}% of 5v5 expected goals with him on the ice, against ${f1(pc(actR))}% with ${esc(last(R.name))}. Over a full season that's ${s1(sw1)} expected-goal differential, about ${s1(sw1 / 6)} wins.</p></div>
    <div class="v b"><b>${A.team} gets ${word(sw2)}</b><p>With ${esc(R.name)} instead, ${A.team} projects to ${f1(pc(S2))}%, against ${f1(pc(actA))}% with ${esc(last(A.name))}: ${s1(sw2)} expected goals, about ${s1(sw2 / 6)} wins.</p></div></div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Scenario</th><th>xGF/60</th><th>xGA/60</th><th>xGF%</th><th>xG diff per 82 games</th></tr></thead><tbody>
    ${[[`${A.name} on ${A.team} (actual)`, actA, minA], [`${R.name} on ${A.team} (swap)`, S2, minR], [`${A.team} with neither`, off(A), minA], [`${R.name} on ${S.swapTeam} (actual)`, actR, minR], [`${A.name} on ${S.swapTeam} (swap)`, S1, minA], [`${S.swapTeam} with neither`, off(R), minR]]
      .map(([n, o, mi]) => { const d = diff(o, mi); return `<tr><td>${esc(n)}</td><td>${f2(o.f)}</td><td>${f2(o.a)}</td><td>${f1(pc(o))}</td><td class="${d >= 0 ? 'pos' : 'neg'}">${s1(d)}</td></tr>`; }).join('')}
    </tbody></table></div><p class="sub small">Uses each player's own 5v5 minutes per game, scaled to 82 games. A common rule of thumb is about 6 goals of differential per win. The model assumes a player's impact moves with him intact; new partners, coaches and systems all change that in reality.</p>`;
}

// ------------------------------------------------------------------ careers
function careerRows(c, mode, ref) {
  if (mode === 'age') return c.S.filter(s => nz(s.age) && s.age <= ref);
  const full = c.S.filter(s => s.full).slice(0, ref); const lastY = full.length ? full[full.length - 1].y : -1; return c.S.filter(s => s.y <= lastY);
}
function renderCareer() {
  const a = careerOf(S.A), b = S.B ? careerOf(S.B) : null;
  if (!a) { $('tape').innerHTML = ''; $('atsame').innerHTML = ''; $('cumu').innerHTML = ''; $('seas').innerHTML = ''; $('tape').insertAdjacentHTML('afterend', ''); return; }
  const ta = ctot(a.S), tb = b ? ctot(b.S) : null;
  const head = `<thead><tr><th></th><th class="a">${esc(last(a.name))}</th><th class="b">${b ? esc(last(b.name)) : '—'}</th></tr></thead>`;
  const row = (l, va, vb, f, better) => { let wa = '', wb = ''; if (better && nz(va) && nz(vb) && va !== vb) { const aw = better === 'hi' ? va > vb : va < vb; wa = aw ? 'win' : ''; wb = aw ? '' : 'win'; } return `<tr><td>${l}</td><td class="${wa}">${f(va)}</td><td class="${wb}">${b ? f(vb) : '—'}</td></tr>`; };
  const yrs = c => c.S.length ? `${sLabel(c.S[0].y)} to ${sLabel(c.S[c.S.length - 1].y)}` : '—';
  const status = c => c.hof ? 'Hall of Fame' : (c.S.length && c.S[c.S.length - 1].y >= S.idx.current - 1 ? 'Active' : '—');
  const trophies = c => awardLine(c.awards.map(x => x[0]).filter(x => x !== 'Cup'));
  const txt = (l, x, y) => `<tr><td>${l}</td><td>${x}</td><td>${b ? y : '—'}</td></tr>`;
  $('tape').innerHTML = head + '<tbody>' +
    txt('Position · shoots · size', `${a.pos || ''} · ${a.shoots || '?'} · ${htFmt(a.ht)} ${a.wt || ''}`, b ? `${b.pos || ''} · ${b.shoots || '?'} · ${htFmt(b.ht)} ${b.wt || ''}` : '') +
    txt('Seasons', `${ta.n}<br><small>${yrs(a)}</small>`, b ? `${tb.n}<br><small>${yrs(b)}</small>` : '') +
    row('Games', ta.gp, tb && tb.gp, f0) + row('Goals', ta.g, tb && tb.g, f0) + row('Points', ta.pts, tb && tb.pts, f0) +
    row('Era-adj. points', ta.adj, tb && tb.adj, f0) + row('Era-adj. pts / 82', ta.adj82, tb && tb.adj82, f1, 'hi') + row('Era-adj. goals / 82', ta.adjg82, tb && tb.adjg82, f1, 'hi') +
    row('Avg TOI (tracked years)', ta.toi, tb && tb.toi, fmin, 'hi') + row('Rel xGF% (2008+)', ta.rel_xgf_pct, tb && tb.rel_xgf_pct, s1, 'hi') + row('Rel xGA/60 (2008+)', ta.rel_xga60, tb && tb.rel_xga60, s2, 'lo') +
    txt('Trophies', trophies(a), b ? trophies(b) : '') + row('Stanley Cups', ta.cups, tb && tb.cups, f0, 'hi') + txt('Status', status(a), b ? status(b) : '') + '</tbody>';
  // same point
  let ra, rb, lab;
  if (S.cmode === 'age') { const mx = Math.max(...a.S.filter(s => !s.partial).map(s => s.age).filter(nz), ...(a.S.every(s => s.partial) ? a.S.map(s => s.age).filter(nz) : [])); ra = careerRows(a, 'age', mx); rb = b ? careerRows(b, 'age', mx) : []; lab = `through age ${mx}`; }
  else { const n = a.S.filter(s => s.full).length || a.S.length; ra = careerRows(a, 'stage', n); rb = b ? careerRows(b, 'stage', n) : []; lab = `first ${n} full seasons`; }
  const x = ctot(ra), y = ctot(rb);
  const span = r => r.length ? `ages ${r[0].age ?? '?'}–${r[r.length - 1].age ?? '?'}` : '—';
  $('atlab').textContent = 'At the same point · ' + lab;
  $('atsame').innerHTML = head + '<tbody>' + txt('Span', span(ra), span(rb)) + row('Games', x.gp, b && y.gp, f0) + row('Points', x.pts, b && y.pts, f0) +
    row('Era-adj. points', x.adj, b && y.adj, f0, 'hi') + row('Era-adj. pts / 82', x.adj82, b && y.adj82, f1, 'hi') + row('Era-adj. goals / 82', x.adjg82, b && y.adjg82, f1, 'hi') +
    row('Avg TOI (tracked years)', x.toi, b && y.toi, fmin, 'hi') + row('Rel xGF% (2008+)', x.rel_xgf_pct, b && y.rel_xgf_pct, s1, 'hi') + row('Major awards by then', x.major, b && y.major, f0, 'hi') + row('Cups by then', x.cups, b && y.cups, f0, 'hi') + '</tbody>';
  drawCumu(a, b); drawSeas(a, b);
}
function drawCumu(a, b) {
  const W = 540, H = 300, m = { l: 48, r: 16, t: 14, b: 36 };
  const cum = c => { let t = 0; return c.S.filter(s => nz(s.age)).map(s => { t += s.adjPts; return [s.age, t]; }); };
  const da = cum(a), db = b ? cum(b) : [];
  const all = [...da, ...db]; if (!all.length) { $('cumu').innerHTML = ''; return; }
  const x0 = Math.min(...all.map(d => d[0])), x1 = Math.max(...all.map(d => d[0])) || x0 + 1;
  const ymax = Math.max(...all.map(d => d[1])) * 1.08 || 10;
  const g = axes(W, H, m, [x0, Math.max(x1, x0 + 1)], [0, ymax], ticks(x0, x1, x1 - x0 > 12 ? 4 : 2), ticks(0, ymax, niceStep(ymax, 5)), 'Age', null);
  const path = (d, c, w) => `<polyline points="${d.map(([x, y]) => g.X(x) + ',' + g.Y(y)).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"/>` + d.map(([x, y]) => `<circle cx="${g.X(x)}" cy="${g.Y(y)}" r="2.6" fill="${c}"/>`).join('');
  let s = g.s;
  if (db.length) s += path(db, 'var(--b)', 2);
  s += path(da, 'var(--a)', 3);
  const ea = da[da.length - 1];
  s += `<text data-l="1" x="${g.X(ea[0]) + 6}" y="${g.Y(ea[1]) + 4}" font-size="12" font-weight="700" fill="var(--a)">${esc(last(a.name))} ${f0(ea[1])}</text>`;
  if (db.length) { const eb = db[db.length - 1]; s += `<text data-l="1" x="${Math.min(g.X(eb[0]) + 6, W - 90)}" y="${g.Y(eb[1]) - 6}" font-size="12" font-weight="700" fill="var(--b)">${esc(last(b.name))} ${f0(eb[1])}</text>`; }
  $('cumu').innerHTML = s; placeLabels($('cumu'));
}
function drawSeas(a, b) {
  const W = 540, H = 300, m = { l: 40, r: 12, t: 14, b: 36 };
  const pa = a.S.filter(s => s.full && nz(s.age)), pb = b ? b.S.filter(s => s.full && nz(s.age)) : [];
  const all = [...pa, ...pb]; if (!all.length) { $('seas').innerHTML = ''; return; }
  const x0 = Math.min(...all.map(s => s.age)), x1 = Math.max(...all.map(s => s.age));
  const ymax = Math.max(...all.map(s => s.adj82)) * 1.12 || 10;
  const g = axes(W, H, m, [x0 - 0.5, x1 + 0.5], [0, ymax], ticks(x0, x1, x1 - x0 > 12 ? 4 : 2), ticks(0, ymax, niceStep(ymax, 5)), 'Age · seasons under 40% of the schedule left out', null);
  const bw = Math.max(2, Math.min(12, (W - m.l - m.r) / (x1 - x0 + 1) / (b ? 2 : 1) - 1));
  let s = g.s;
  const bars = (c, Ss, col, off) => Ss.map(x => { const star = x.aw.some(t => MAJOR.includes(t) && t !== 'Calder'); return `<rect x="${g.X(x.age) + off}" y="${g.Y(x.adj82)}" width="${bw}" height="${g.Y(0) - g.Y(x.adj82)}" fill="${col}"><title>${esc(c.name)} ${sLabel(x.y)} (${esc(x.team)}): ${f1(x.adj82)} era-adj pts/82${x.aw.length ? ' · ' + x.aw.join(', ') : ''}</title></rect>` + (star ? `<text x="${g.X(x.age) + off + bw / 2}" y="${g.Y(x.adj82) - 4}" text-anchor="middle" font-size="10" fill="${col}">★</text>` : ''); }).join('');
  if (b) s += bars(b, pb, 'var(--b)', 0);
  s += bars(a, pa, 'var(--a)', b ? -bw : -bw / 2);
  s += `<text x="${W - m.r}" y="${m.t + 10}" text-anchor="end" class="lab">★ Hart, Norris, Selke, Art Ross, Richard, Lindsay or Conn Smythe</text>`;
  $('seas').innerHTML = s;
}

// ------------------------------------------------------------------ arcs + comps
const AMET = [
  { k: 'adj82', l: 'Era-adj. pts / 82', f: s => s.full ? s.adj82 : null, fmt: f1, note: 'Era-adjusted points per 82 games. Seasons under 40% of the schedule are left out.' },
  { k: 'adjg82', l: 'Era-adj. goals / 82', f: s => s.full ? s.adjg82 : null, fmt: f1, note: 'Era-adjusted goals per 82 games.' },
  { k: 'toi', l: 'Ice time', f: s => s.full ? s.toi : null, fmt: fmin, note: 'Average ice time per game. The NHL only tracked it from 1997-98 on.' },
  { k: 'gp', l: 'Games played', f: s => s.partial ? null : s.gp, fmt: f0, note: 'Games played each season. Short seasons (lockouts, 2019-20, 2020-21) show as dips.' },
  { k: 'rel_xgf_pct', l: 'Rel xGF% (2008+)', f: s => s.mpgp >= 20 ? s.rel_xgf_pct : null, fmt: s1, note: "MoneyPuck's relative xGF%: the team's share of 5v5 expected goals with him on the ice minus with him off. 2008-09 on." },
  { k: 'rel_xga60', l: 'Rel xGA/60 (2008+)', f: s => s.mpgp >= 20 ? s.rel_xga60 : null, fmt: s2, note: 'Chances against per 60 with him on the ice minus with him off. Lower is better, so the axis is flipped: up is better.', flip: true },
];
const PAL = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
function arcPlayers() { const ids = []; [S.B, ...S.arcSel].forEach(id => { if (id && id !== S.A && !ids.includes(id)) ids.push(id); }); return ids.slice(0, 6); }
function renderArcs() {
  const M = AMET.find(m => m.k === S.arcMetric);
  $('ametric').innerHTML = AMET.map(m => `<button type="button" data-am="${m.k}" aria-pressed="${m.k === S.arcMetric}">${m.l}</button>`).join('');
  const others = arcPlayers();
  $('achips').innerHTML = [S.A, ...others].map((id, i) => { const c = careerOf(id); const col = i === 0 ? 'var(--a)' : PAL[i - 1]; return `<button type="button" ${i ? `data-rmarc="${id}"` : ''} title="${i ? 'Remove' : 'Main player'}"><i style="background:${col}"></i>${esc(c ? c.name : id)}${i ? '<b>×</b>' : ''}</button>`; }).join('');
  $('arcnote').textContent = M.note;
  const series = [S.A, ...others].map((id, i) => ({ c: careerOf(id), col: i === 0 ? 'var(--a)' : PAL[i - 1], main: i === 0 })).filter(x => x.c);
  const pts = series.flatMap(x => x.c.S.map(s => [s.age, M.f(s)]).filter(d => nz(d[0]) && nz(d[1])));
  const W = 1080, H = 400, m = { l: 56, r: 110, t: 16, b: 40 };
  if (!pts.length) { $('arc').innerHTML = `<text x="20" y="40" class="lab">No data for this measure.</text>`; return; }
  const x0 = Math.min(18, ...pts.map(d => d[0])), x1 = Math.max(36, ...pts.map(d => d[0]));
  let yd = extent(pts.map(d => d[1]), 0.08); if (M.k === 'adj82' || M.k === 'adjg82' || M.k === 'gp') yd[0] = 0;
  if (M.flip) yd = [yd[1], yd[0]];
  const st = niceStep(Math.abs(yd[1] - yd[0]), 6);
  const g = axes(W, H, m, [x0, x1], yd, ticks(x0, x1, 2), ticks(Math.min(...yd), Math.max(...yd), st), 'Age', M.l, null, M.k === 'toi' ? (v => v + ':00') : (v => +v.toFixed(2)));
  let s = g.s;
  if (M.k.startsWith('rel')) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  const draw = x => {
    const d = x.c.S.map(sn => ({ s: sn, v: M.f(sn) })).filter(o => nz(o.v) && nz(o.s.age));
    if (!d.length) return '';
    const segs = [[d[0]]]; for (let i = 1; i < d.length; i++) { if (d[i].s.age - d[i - 1].s.age > 2) segs.push([]); segs[segs.length - 1].push(d[i]); }
    let o = segs.map(sg => `<polyline points="${sg.map(p => g.X(p.s.age) + ',' + g.Y(p.v)).join(' ')}" fill="none" stroke="${x.col}" stroke-width="${x.main ? 3.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
    o += d.map(p => `<circle cx="${g.X(p.s.age)}" cy="${g.Y(p.v)}" r="${x.main ? 4 : 3}" fill="${x.col}"><title>${esc(x.c.name)} · ${sLabel(p.s.y)} (${esc(p.s.team)}, age ${p.s.age}): ${M.fmt(p.v)}${p.s.aw.length ? ' · ' + p.s.aw.join(', ') : ''}</title></circle>`).join('');
    const e = d[d.length - 1];
    return o + `<text data-l="1" x="${g.X(e.s.age) + 7}" y="${g.Y(e.v) + 4}" font-size="${x.main ? 13 : 12}" font-weight="700" fill="${x.col}">${esc(last(x.c.name))}</text>`;
  };
  series.slice().reverse().forEach(x => { s += draw(x); });
  $('arc').innerHTML = s; placeLabels($('arc'));
  renderComps();
}
function renderComps() {
  const a = careerOf(S.A); if (!a || !a.S.length) { $('comps').innerHTML = ''; return; }
  const X = Math.max(...a.S.filter(s => !s.partial).map(s => s.age).filter(nz));
  if (!Number.isFinite(X)) { $('comps').innerHTML = ''; $('comps-sub').textContent = 'Not enough games yet to find comps.'; return; }
  const me = ctot(a.S.filter(s => s.age <= X && !s.partial));
  if (me.gp < 40) { $('comps-h').textContent = 'Closest comps'; $('comps-sub').textContent = 'Not enough games yet to find comps.'; $('comps').innerHTML = ''; return; }
  const minGp = Math.max(100, Math.round(me.gp * 0.5));
  const cands = [];
  for (const id of CAR.rowsBy.keys()) {
    if (id === a.id) continue;
    const bio = CAR.players[id]; if (!bio || grpOf(bio[1]) !== a.grp) continue;
    const c = careerOf(id); if (!c) continue;
    const thru = c.S.filter(s => nz(s.age) && s.age <= X && !s.partial);
    const t = ctot(thru); if (t.gp < minGp) continue;
    cands.push({ c, t, after: ctot(c.S) });
  }
  const feats = [['adj82', 1], ['adjg82', 0.6]];
  if (me.toiCover > 0.6) feats.push(['toi', 1]);
  if (me.mpgp >= 100) feats.push(['rel_xgf_pct', 1], ['rel_xga60', 1]);
  const sd = {}; feats.forEach(([k]) => { const v = cands.map(x => x.t[k]).filter(nz); const mu = avg(v); sd[k] = Math.sqrt(avg(v.map(x => (x - mu) ** 2))) || 1; });
  cands.forEach(x => { let sum = 0, w = 0; feats.forEach(([k, wt]) => { if (k === 'toi' && x.t.toiCover < 0.6) return; if (k.startsWith('rel') && x.t.mpgp < 100) return; if (!nz(x.t[k]) || !nz(me[k])) return; sum += wt * ((x.t[k] - me[k]) / sd[k]) ** 2; w += wt; }); x.d = w >= 1.5 ? Math.sqrt(sum / w) : Infinity; });
  const top = cands.filter(x => Number.isFinite(x.d)).sort((p, q) => p.d - q.d).slice(0, 12);
  const maxD = Math.max(1, ...top.map(x => x.d));
  $('comps-h').textContent = `Who looked most like ${a.name} through age ${X}, and how their careers turned out`;
  $('comps-sub').textContent = `Closeness compares era-adjusted points and goals per 82${feats.some(f => f[0] === 'toi') ? ', ice time' : ''}${feats.some(f => f[0].startsWith('rel')) ? ', and relative xGF% and xGA/60 where both have 2008+ data' : ''}, against ${GRP_NAME[a.grp]} with ${minGp}+ games by that age. Production and on-ice impact only; it doesn't capture size or style. Click a name to add it to the chart.`;
  $('comps').innerHTML = `<thead><tr><th>Player</th><th>Years</th><th>GP to ${X}</th><th>Adj pts/82</th><th>Adj G/82</th><th>TOI</th><th>Rel xGF%</th><th style="min-width:110px">Closeness</th><th>Career trophies</th><th>Cups</th><th>Status</th></tr></thead><tbody>` +
    `<tr class="isA"><td>${esc(a.name)}</td><td>${a.S[0] ? a.S[0].y : ''}–</td><td>${me.gp}</td><td>${f1(me.adj82)}</td><td>${f1(me.adjg82)}</td><td>${fmin(me.toi)}</td><td>${s1(me.rel_xgf_pct)}</td><td class="lab">reference</td><td>${esc(awardLine(a.awards.map(x => x[0]).filter(x => x !== 'Cup')))}</td><td>${a.awards.filter(x => x[0] === 'Cup').length}</td><td>—</td></tr>` +
    top.map(x => { const c = x.c; const cl = Math.round(100 * (1 - x.d / (maxD * 1.15))); return `<tr><td><a href="#" data-addarc="${c.id}">${esc(c.name)}</a></td><td>${c.S[0].y}–${c.S[c.S.length - 1].y + 1}</td><td>${x.t.gp}</td><td>${f1(x.t.adj82)}</td><td>${f1(x.t.adjg82)}</td><td>${fmin(x.t.toi)}</td><td>${s1(x.t.rel_xgf_pct)}</td><td><div class="cl" title="${cl}"><i style="width:${cl}%"></i></div></td><td>${esc(awardLine(c.awards.map(z => z[0]).filter(z => z !== 'Cup')))}</td><td>${x.after.cups}</td><td>${c.hof ? 'HOF' : c.S[c.S.length - 1].y >= S.idx.current - 1 ? 'Active' : ''}</td></tr>`; }).join('') + '</tbody>';
}


// ------------------------------------------------------------------ shot maps
const SHOTS = {};
const SH = { sit: 'all', view: 'freq' };
async function loadShots(y) {
  if (SHOTS[y] !== undefined) return SHOTS[y];
  try { SHOTS[y] = await getJSON(`data/shots/${y}.json`); } catch (e) { SHOTS[y] = null; }
  return SHOTS[y];
}
function shotCells(list) { const m = new Map(); (list || []).forEach(([c, n, g, x]) => m.set(c, { n, g, xg: x / 100 })); return m; }
function shotTotals(m) { let n = 0, g = 0, xg = 0, slot = 0; for (const [c, v] of m) { n += v.n; g += v.g; xg += v.xg; } return { n, g, xg }; }
function rinkSVG(d, m, lg, title, col) {
  const G = d.grid, k = 5, W = (G.y1 - G.y0) * k, H = (G.x1 - G.x0) * k;
  const px = y => (y - G.y0) * k, py = x => (G.x1 - x) * k;
  const tot = shotTotals(m), ltot = shotTotals(lg);
  const id = 'clip' + Math.random().toString(36).slice(2, 8);
  const r = 28 * k;
  const shape = `M0,${H} L0,${r} Q0,0 ${r},0 L${W - r},0 Q${W},0 ${W},${r} L${W},${H} Z`;
  let cells = '';
  for (let cy = 0; cy < G.ny; cy++) for (let cx = 0; cx < G.nx; cx++) {
    const c = cy * G.nx + cx; const v = m.get(c); const l = lg.get(c);
    let fill = null, tip = '';
    const x0 = G.x0 + cx * G.cell, y0 = G.y0 + cy * G.cell;
    if (SH.view === 'freq') {
      const sp = v ? v.n / tot.n : 0, ls = l ? l.n / ltot.n : 0;
      if (!v && ls < 0.002) continue;
      const diff = (sp - ls) * 100; // percentage points
      const t = Math.max(-1, Math.min(1, diff / 1.2));
      fill = t >= 0 ? `color-mix(in srgb, var(--hi) ${Math.round(t * 100)}%, var(--mid))` : `color-mix(in srgb, var(--lo) ${Math.round(-t * 100)}%, var(--mid))`;
      tip = `${v ? v.n : 0} attempts (${(sp * 100).toFixed(1)}% of his) vs league ${(ls * 100).toFixed(1)}%`;
    } else {
      if (!v || v.n < 3) continue;
      const gax = v.g - v.xg; const t = Math.max(-1, Math.min(1, gax / 2.5));
      fill = t >= 0 ? `color-mix(in srgb, var(--hi) ${Math.round(t * 100)}%, var(--mid))` : `color-mix(in srgb, var(--lo) ${Math.round(-t * 100)}%, var(--mid))`;
      tip = `${v.n} attempts, ${v.g} goals, ${v.xg.toFixed(1)} expected (${gax >= 0 ? '+' : ''}${gax.toFixed(1)})`;
    }
    cells += `<rect x="${px(y0)}" y="${py(x0 + G.cell)}" width="${G.cell * k}" height="${G.cell * k}" fill="${fill}"><title>${tip}</title></rect>`;
    if (SH.view === 'freq' && v && v.g) cells += `<circle cx="${px(y0 + G.cell / 2)}" cy="${py(x0 + G.cell / 2)}" r="${Math.min(9, 2 + v.g)}" fill="none" stroke="var(--ink)" stroke-width="1.4"><title>${v.g} goals</title></circle>`;
  }
  const line = (x, cls, w) => `<line x1="0" x2="${W}" y1="${py(x)}" y2="${py(x)}" stroke="${cls}" stroke-width="${w}"/>`;
  const circ = (x, y, rr, st) => `<circle cx="${px(y)}" cy="${py(x)}" r="${rr * k}" fill="none" stroke="${st}" stroke-width="1.5"/>`;
  const marks = line(89, 'var(--a)', 2) + line(25.5, 'var(--b)', 6) +
    `<path d="M${px(-6)},${py(89)} A${6 * k},${6 * k} 0 0 0 ${px(6)},${py(89)}" fill="none" stroke="var(--a)" stroke-width="1.5"/>` +
    `<rect x="${px(-3)}" y="${py(92.5)}" width="${6 * k}" height="${3.5 * k}" fill="none" stroke="var(--ink)" stroke-width="2"/>` +
    circ(69, -22, 15, 'var(--a)') + circ(69, 22, 15, 'var(--a)') +
    `<circle cx="${px(-22)}" cy="${py(69)}" r="4" fill="var(--a)"/><circle cx="${px(22)}" cy="${py(69)}" r="4" fill="var(--a)"/>`;
  const hdr = `<text x="${W / 2}" y="-14" text-anchor="middle" font-size="15" font-weight="700" fill="${col}">${esc(title)}</text>`;
  return `<svg viewBox="-10 -34 ${W + 20} ${H + 44}" role="img" aria-label="Shot map for ${esc(title)}"><defs><clipPath id="${id}"><path d="${shape}"/></clipPath></defs>${hdr}
    <path d="${shape}" fill="var(--panel)" stroke="var(--ink)" stroke-width="2"/><g clip-path="url(#${id})">${cells}${marks}</g><path d="${shape}" fill="none" stroke="var(--ink)" stroke-width="2"/></svg>`;
}
async function renderShots() {
  const y = S.season; const sd = S.seasons[y]; const A = seasonOf(S.A);
  const box = $('shots');
  if (!A) { box.innerHTML = ''; $('shots-sub').textContent = `No ${sLabel(y)} shot data for this player. Shot maps cover 2008-09 on; pick a season he played.`; return; }
  const d = await loadShots(y);
  if (y !== S.season) return;
  if (!d) { $('shots-sub').textContent = `Shot maps for ${sLabel(y)} haven't been built yet. They're added by the nightly update.`; box.innerHTML = ''; return; }
  $('shots-sub').innerHTML = `Unblocked shot attempts (shots on goal, misses and goals) in the offensive zone, ${sLabel(y)} regular season, in 5 × 5 ft cells; empty-net shots are left out. <strong>Where he shoots:</strong> blue cells are spots he shoots from more often than the average ${'${grp}'}, orange less often; rings mark goals. <strong>Finishing:</strong> goals minus expected goals in each cell with 3+ attempts; blue means he scored more than an average shooter would from there.`.replace('${grp}', A.grp === 'D' ? 'defenseman' : 'forward');
  const B = seasonOf(S.B);
  const ctl = `<div class="ctl"><span class="lbl">Situation</span><span class="toggle" id="shsit">${[['all', 'All'], ['ev', '5v5'], ['pp', 'Power play']].map(([k, l]) => `<button type="button" data-sit="${k}" aria-pressed="${SH.sit === k}">${l}</button>`).join('')}</span>
    <span class="lbl">View</span><span class="toggle" id="shview">${[['freq', 'Where he shoots'], ['fin', 'Finishing']].map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${SH.view === k}">${l}</button>`).join('')}</span></div>`;
  const ps = [A, B].filter(Boolean);
  const maps = ps.map((p, i) => { const m = shotCells((d.players[p.id] || {})[SH.sit]); const lg = shotCells((d.league[p.grp] || {})[SH.sit]); return { p, m, lg, t: shotTotals(m), col: i ? 'var(--b)' : 'var(--a)' }; });
  const svgs = maps.map(x => x.t.n ? rinkSVG(d, x.m, x.lg, x.p.name, x.col) : `<p class="empty">${esc(x.p.name)} has no attempts in this situation.</p>`);
  const rows = [['Attempts', x => x.t.n, f0], ['Goals', x => x.t.g, f0], ['Expected goals', x => x.t.xg, f1], ['Goals − expected', x => x.t.g - x.t.xg, s1], ['Shooting % (unblocked)', x => x.t.n ? 100 * x.t.g / x.t.n : null, f1], ['xG per attempt', x => x.t.n ? x.t.xg / x.t.n : null, v => nz(v) ? v.toFixed(3) : '—'],
    ['Attempts from the slot', x => { let n = 0; for (const [c, v] of x.m) { const cx = c % d.grid.nx, cy = Math.floor(c / d.grid.nx); const xx = d.grid.x0 + (cx + 0.5) * d.grid.cell, yy = d.grid.y0 + (cy + 0.5) * d.grid.cell; if (xx >= 69 && xx <= 89 && Math.abs(yy) <= 10) n += v.n; } return x.t.n ? 100 * n / x.t.n : null; }, v => nz(v) ? v.toFixed(1) + '%' : '—']];
  const tbl = `<table class="tape"><thead><tr><th>${SH.sit === 'all' ? 'All situations' : SH.sit === 'ev' ? '5v5' : 'Power play'}</th>${maps.map((x, i) => `<th class="${i ? 'b' : 'a'}">${esc(last(x.p.name))}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td>${maps.map(x => `<td>${r[2](r[1](x))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  box.innerHTML = ctl + `<div class="two">${svgs.map(s => `<div>${s}</div>`).join('')}</div><div style="margin-top:16px;max-width:560px">${tbl}</div>`;
}


// ------------------------------------------------------------------ deployment
const USAGE = {};
async function loadUsage(y) { if (USAGE[y] !== undefined) return USAGE[y]; try { USAGE[y] = await getJSON(`data/usage/${y}.json`); } catch (e) { USAGE[y] = null; } return USAGE[y]; }
const SLOT = { F: ['1st line', '2nd line', '3rd line', '4th line'], D: ['1st pair', '2nd pair', '3rd pair'] };
const SLOTC = ['var(--c1)', 'var(--c3)', 'var(--c2)', 'var(--c5)'];
function evo(a) { const o = { g: a[0], t: a[1], xgf: a[2], xga: a[3], gf: a[4], ga: a[5], cf: a[6], ca: a[7], pts: a[8], ixg: a[9] }; const h = o.t / 3600; o.xp = share(o.xgf, o.xga); o.xga60 = h ? o.xga / h : null; o.xgf60 = h ? o.xgf / h : null; o.pts60 = h ? o.pts / h : null; return o; }
function evsum(list) { const z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; list.forEach(o => { [o.g, o.t, o.xgf, o.xga, o.gf, o.ga, o.cf, o.ca, o.pts, o.ixg].forEach((v, i) => { z[i] += v; }); }); return evo(z); }
function profile(U, sd, id) {
  const u = U && U.players[id]; const p = sd.byId.get(id);
  if (!u || !p) return null;
  const grp = u.g, n = SLOT[grp].length;
  const slots = u.ev.map(evo), base = U.baselines.ev[grp].map(evo);
  const G = slots.reduce((a, s) => a + s.g, 0);
  const avgSlot = slots.reduce((a, s, k) => a + s.g * (k + 1), 0) / (G || 1);
  const all = evsum(slots);
  // 5v5 results fit: where his 5v5 results rank among regulars at his position, mapped onto the lineup
  // (top quarter of forwards = 1st line ... bottom quarter = 4th line; thirds for defensemen).
  // Blended over up to three seasons, most recent weighted 3-2-1 times games played.
  const RES_W = grp === 'F' ? [['xgf_pct', 0.35], ['rel_xgf_pct', 0.25], ['ipts60', 0.4]] : [['xgf_pct', 0.35], ['rel_xgf_pct', 0.25], ['rel_xga60', 0.25], ['ipts60', 0.15]];
  const res1 = (sdx, px) => { let ws = 0, wt = 0; RES_W.forEach(([k, w]) => { const v = pk(sdx, px, k); if (nz(v)) { ws += v * w; wt += w; } }); return wt ? ws / wt : null; };
  const hist = [[sd, p]];
  [1, 2].forEach(d => { const s2 = S.seasons[sd.y - d]; const p2 = s2 && s2.byId.get(id); if (p2 && grpOf(p2.pos) === grp && p2.gp >= 10) hist.push([s2, p2]); });
  let bs = 0, bw = 0; const per = [];
  hist.forEach(([sx, px], i) => { const r = res1(sx, px); if (nz(r)) { const w = (3 - i) * px.gp; bs += r * w; bw += w; per.push([sx.y, Math.round(r)]); } });
  const resPct1 = res1(sd, p) ?? 50;
  const resPct = bw ? bs / bw : resPct1;
  const toSlot = pc => Math.max(1, Math.min(n, n + 0.5 - n * pc / 100));
  const eq = toSlot(resPct), eq1 = toSlot(resPct1);
  // overall fit: the all-situations value model (5v5, power play, penalty kill, finishing, penalties), blended the same way
  let os = 0, ow = 0;
  hist.forEach(([sx, px], i) => { const pc = warPct(sx.y, id, grp); if (nz(pc)) { const w = (3 - i) * px.gp; os += pc * w; ow += w; } });
  const ovPct = ow ? os / ow : null;
  const eqAll = nz(ovPct) ? toSlot(ovPct) : null;
  const usual = slots.reduce((b, s, k) => s.g > slots[b].g ? k : b, 0);
  // against his role: his 5v5 xGF% vs the league average for the slots he actually played, minutes-weighted
  const exAll = all.t ? slots.reduce((a, s, k) => a + (s.t ? s.t * base[k].xp : 0), 0) / all.t : null;
  const vsRole = nz(all.xp) && nz(exAll) ? all.xp - exAll : null;
  const bucket = ks => { const ss = ks.map(k => slots[k]).filter(s => s.g); const e = evsum(ss); const t = ss.reduce((a, s) => a + s.t, 0); const ex = t ? ks.reduce((a, k) => a + (slots[k].t ? slots[k].t * base[k].xp : 0), 0) / t : null; const ep = t ? ks.reduce((a, k) => a + (slots[k].t ? slots[k].t * base[k].pts60 : 0), 0) / t : null; return { e, ex, ep }; };
  const range = (a, b) => { const o = []; for (let k = a; k <= b; k++) o.push(k); return o; };
  const splits = [['Moved up', range(0, usual - 1)], [`Usual role (${SLOT[grp][usual]})`, [usual]], ['Moved down', range(usual + 1, n - 1)]].map(([l, ks]) => ({ l, ...bucket(ks) }));
  const zone = u.zone.map(evo);
  const pp = u.pp.map(a => ({ g: a[0], t: a[1], xgf60: a[1] ? a[2] / a[1] * 3600 : null, pts60: a[1] ? a[3] / a[1] * 3600 : null, pts: a[3] }));
  const pkd = u.pk.map(a => ({ g: a[0], t: a[1], xga60: a[1] ? a[2] / a[1] * 3600 : null }));
  const bpp = U.baselines.pp.map(a => ({ xgf60: a[1] ? a[2] / a[1] * 3600 : null, pts60: a[1] ? a[3] / a[1] * 3600 / 5 : null }));
  const bpk = U.baselines.pk[grp].map(a => ({ xga60: a[1] ? a[2] / a[1] * 3600 : null }));
  // role labels
  const ppL = pp[0].g / G >= 0.5 ? 'PP1' : (pp[0].g + pp[1].g) / G >= 0.5 ? (pp[0].g >= pp[1].g ? 'PP1/PP2' : 'PP2') : (pp[0].g + pp[1].g) / G >= 0.15 ? 'Spot PP' : 'No PP';
  const pkL = pkd[0].g / G >= 0.5 ? 'PK1' : (pkd[0].g + pkd[1].g) / G >= 0.5 ? 'PK2' : (pkd[0].g + pkd[1].g) / G >= 0.15 ? 'Spot PK' : 'No PK';
  const zs = (zone[0].g - zone[2].g) / (G || 1);
  const zL = zs >= 0.15 ? 'Sheltered (offensive-zone starts)' : zs <= -0.15 ? 'Defensive-zone starts' : 'Balanced starts';
  // fits
  const enough = all.t >= 6000;
  const gap = avgSlot - eq;
  const evFit = !enough ? ['ok', 'Too few minutes to judge'] : gap >= 0.6 ? ['up', '5v5 results fit a bigger role'] : gap <= -0.6 ? ['down', 'Used above his 5v5 results'] : ['ok', 'Used about right at 5v5'];
  const gapAll = nz(eqAll) ? avgSlot - eqAll : null;
  const allFit = !nz(gapAll) ? ['ok', 'No value data'] : gapAll >= 0.6 ? ['up', 'Overall value fits a bigger role'] : gapAll <= -0.6 ? ['down', 'Used above his overall value'] : ['ok', 'Used about right overall'];
  const roleFit = !enough || !nz(vsRole) ? ['ok', 'Too few minutes'] : vsRole >= 1.5 ? ['up', 'Beats his role\'s average'] : vsRole <= -1.5 ? ['down', 'Below his role\'s average'] : ['ok', 'In line with his role'];
  const pctPP = pk(sd, p, 'pp_pts60'), pctOff = pk(sd, p, 'ipts60');
  const ppFit = nz(p.pp_pts60) && p.pp >= 0.75
    ? (pctPP >= 70 ? ['up', 'PP1 production'] : pctPP >= 40 ? ['ok', 'PP2 production'] : ['down', 'Weak PP production'])
    : (pctOff >= 70 ? ['up', 'Untested, worth a PP look'] : ['ok', 'Not a PP option']);
  const pctPK = pk(sd, p, 'pk_xga60'), pctRel = pk(sd, p, 'rel_xga60');
  const pkFit = nz(p.pk_xga60) && p.pk >= 0.75
    ? (pctPK >= 65 ? ['up', 'PK1 results'] : pctPK >= 40 ? ['ok', 'PK2 results'] : ['down', 'Struggles on the PK'])
    : (pctRel >= 70 ? ['up', 'Untested, PK candidate'] : ['ok', 'Not a PK option']);
  const sc = scores(sd, p);
  const ozx = zone[0].t >= 3000 ? zone[0].xp : null, dzx = zone[2].t >= 3000 ? zone[2].xp : null;
  const zFit = nz(dzx) && sc.d >= 60 && (!nz(ozx) || ozx - dzx <= 4) ? ['up', 'Can take own-zone starts']
    : sc.o >= 60 && sc.d < 45 ? ['ok', 'Best sheltered: offensive-zone starts'] : nz(dzx) && nz(ozx) && ozx - dzx > 8 ? ['down', 'Struggles on own-zone nights'] : ['ok', 'Neutral starts'];
  return { p, u, grp, n, slots, base, G, avgSlot, all, eq, eq1, resPct, resPct1, per, ovPct, eqAll, allFit, vsRole, exAll, roleFit, gap, usual, splits, zone, pp, pk: pkd, bpp, bpk, ppL, pkL, zL, evFit, ppFit, pkFit, zFit, enough };
}
function warPct(y, id, grp) {
  if (!VAL || !VAL.seasons[y] || !S.seasons[y]) return null;
  const ck = `war|${y}|${grp}`;
  let arr = S.cache[ck];
  if (!arr) { const gpm = S.seasons[y].gpmax; arr = S.cache[ck] = [...VAL.seasons[y].map.values()].filter(r => grpOf(r.pos) === grp && r.gp >= 0.35 * gpm).map(r => r.war82).sort((a, b) => a - b); }
  const r = VAL.seasons[y].map.get(id); if (!r || !arr.length) return null;
  let below = 0, eq = 0; for (const v of arr) { if (v < r.war82) below++; else if (v === r.war82) eq++; }
  return 100 * (below + eq / 2) / arr.length;
}
const slotName = (grp, x) => SLOT[grp][Math.max(0, Math.min(SLOT[grp].length - 1, Math.round(x) - 1))];
const flag = f => `<span class="flag ${f[0]}">${esc(f[1])}</span>`;
const dcls = v => nz(v) ? (v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : '') : '';
function roleCard(P, col) {
  const { p, grp } = P;
  const bar = P.slots.map((s, k) => s.g ? `<i style="width:${100 * s.g / P.G}%;background:${SLOTC[k]}" title="${SLOT[grp][k]}: ${s.g} games">${s.g / P.G > 0.1 ? SLOT[grp][k].replace(' line', 'L').replace(' pair', 'P').replace('st', '').replace('nd', '').replace('rd', '').replace('th', '') : ''}</i>` : '').join('');
  const sum = `5v5 results fit a <strong>${slotName(grp, P.eq)}</strong> (${P.eq.toFixed(1)})${nz(P.eqAll) ? `; overall value fits a <strong>${slotName(grp, P.eqAll)}</strong> (${P.eqAll.toFixed(1)})` : ''}. Used as a <strong>${slotName(grp, P.avgSlot)}</strong> (${P.avgSlot.toFixed(1)}), ${P.ppL}, ${P.pkL}, ${P.zL.toLowerCase()}.`;
  const perTxt = P.per.map(([y, r]) => `${sLabel(y)}: ${ord(r)}`).join(', ');
  const v = (t, f, txt) => `<div class="v"><b>${t}</b>${flag(f)}<p>${txt}</p></div>`;
  const ppU = P.pp[0].g + P.pp[1].g, pkU = P.pk[0].g + P.pk[1].g;
  const verdicts = `<div class="verdict">
    ${v('5v5 results', P.evFit, `Blended rank among regular ${grp === 'F' ? 'forwards' : 'defensemen'}: ${ord(Math.round(P.resPct))} percentile, a ${slotName(grp, P.eq)}${P.per.length > 1 ? ` (${perTxt})` : ''}. This season alone: ${slotName(grp, P.eq1)}.`)}
    ${v('Overall value', P.allFit, nz(P.ovPct) ? `Adding power play, penalty kill, finishing and penalties (the Part 3 value model), he ranks in the ${ord(Math.round(P.ovPct))} percentile, a ${slotName(grp, P.eqAll)}.` : 'Value data not available for this season.')}
    ${v('Against his role', P.roleFit, nz(P.vsRole) ? `${f1(P.all.xp)}% 5v5 xGF against ${f1(P.exAll)}% for the average player in the same slots (${s1(P.vsRole)}). The closest stand-in for facing similar competition.` : 'Not enough 5v5 minutes.')}
    ${v('Power play', P.ppFit, ppU ? `On a PP unit in ${ppU} of ${P.G} games; ${f2(p.pp_pts60)} PP pts/60.` : `Not used on the PP. 5v5 scoring ranks in the ${ord(pk(S.seasons[S.season], p, 'ipts60'))} percentile.`)}
    ${v('Penalty kill', P.pkFit, pkU ? `On a PK unit in ${pkU} of ${P.G} games; ${f2(p.pk_xga60)} xGA/60 shorthanded.` : `Not used on the PK. 5v5 chance suppression ranks in the ${ord(pk(S.seasons[S.season], p, 'rel_xga60'))} percentile.`)}
    ${v('Zone starts', P.zFit, `${P.zone[0].g} offensive-zone-heavy nights, ${P.zone[2].g} defensive-zone-heavy. xGF% ${f1(P.zone[0].xp)} vs ${f1(P.zone[2].xp)}.`)}
  </div>`;
  const byRole = `<p class="minihead">By role, against the league average for that role</p><div class="scroll"><table class="tbl"><thead><tr><th>Role</th><th>GP</th><th>5v5 min</th><th>xGF%</th><th>Role avg</th><th>Pts/60</th><th>Role avg</th><th>xGA/60</th><th>Role avg</th></tr></thead><tbody>` +
    P.slots.map((s, k) => s.g ? `<tr><td>${SLOT[grp][k]}</td><td>${s.g}</td><td>${f0(s.t / 60)}</td><td class="${s.t >= 1800 ? dcls(s.xp - P.base[k].xp) : ''}">${s.t >= 1800 ? f1(s.xp) : '—'}</td><td>${f1(P.base[k].xp)}</td><td class="${s.t >= 1800 ? dcls(s.pts60 - P.base[k].pts60) : ''}">${s.t >= 1800 ? f2(s.pts60) : '—'}</td><td>${f2(P.base[k].pts60)}</td><td class="${s.t >= 1800 ? dcls(P.base[k].xga60 - s.xga60) : ''}">${s.t >= 1800 ? f2(s.xga60) : '—'}</td><td>${f2(P.base[k].xga60)}</td></tr>` : '').join('') + '</tbody></table></div>';
  const splits = `<p class="minihead" style="margin-top:14px">Moved up, usual role, moved down</p><div class="scroll"><table class="tbl"><thead><tr><th></th><th>GP</th><th>5v5 min</th><th>xGF%</th><th>Expected for those roles</th><th>Difference</th><th>Pts/60</th></tr></thead><tbody>` +
    P.splits.map(x => x.e.g ? `<tr><td>${esc(x.l)}</td><td>${x.e.g}</td><td>${f0(x.e.t / 60)}</td><td>${x.e.t >= 1800 ? f1(x.e.xp) : '—'}</td><td>${f1(x.ex)}</td><td class="${x.e.t >= 1800 ? dcls(x.e.xp - x.ex) : ''}">${x.e.t >= 1800 ? s1(x.e.xp - x.ex) : '—'}</td><td>${x.e.t >= 1800 ? f2(x.e.pts60) : '—'}</td></tr>` : `<tr><td>${esc(x.l)}</td><td>0</td><td colspan="5" style="text-align:left;color:var(--muted)">Not used in this role</td></tr>`).join('') + '</tbody></table></div>';
  const zone = `<p class="minihead" style="margin-top:14px">By zone starts that night</p><div class="scroll"><table class="tbl"><thead><tr><th></th><th>GP</th><th>5v5 min</th><th>xGF%</th><th>xGA/60</th><th>Pts/60</th></tr></thead><tbody>` +
    [['Offensive-zone-heavy', 0], ['Balanced', 1], ['Defensive-zone-heavy', 2]].map(([l, i]) => { const z = P.zone[i]; return `<tr><td>${l}</td><td>${z.g}</td><td>${f0(z.t / 60)}</td><td>${z.t >= 1800 ? f1(z.xp) : '—'}</td><td>${z.t >= 1800 ? f2(z.xga60) : '—'}</td><td>${z.t >= 1800 ? f2(z.pts60) : '—'}</td></tr>`; }).join('') + '</tbody></table></div>';
  const st = `<p class="minihead" style="margin-top:14px">Special teams by unit</p><div class="scroll"><table class="tbl"><thead><tr><th>Unit</th><th>GP</th><th>Min</th><th>Team xGF/60 or xGA/60</th><th>League avg for unit</th><th>His pts/60</th><th>League avg</th></tr></thead><tbody>` +
    [0, 1].map(i => { const x = P.pp[i]; return x.g ? `<tr><td>PP${i + 1}</td><td>${x.g}</td><td>${f0(x.t / 60)}</td><td class="${x.t >= 1200 ? dcls(x.xgf60 - P.bpp[i].xgf60) : ''}">${x.t >= 1200 ? f2(x.xgf60) : '—'} xGF</td><td>${f2(P.bpp[i].xgf60)}</td><td class="${x.t >= 1200 ? dcls(x.pts60 - P.bpp[i].pts60) : ''}">${x.t >= 1200 ? f2(x.pts60) : '—'}</td><td>${f2(P.bpp[i].pts60)}</td></tr>` : ''; }).join('') +
    [0, 1].map(i => { const x = P.pk[i]; return x.g ? `<tr><td>PK${i + 1}</td><td>${x.g}</td><td>${f0(x.t / 60)}</td><td class="${x.t >= 1200 ? dcls(P.bpk[i].xga60 - x.xga60) : ''}">${x.t >= 1200 ? f2(x.xga60) : '—'} xGA</td><td>${f2(P.bpk[i].xga60)}</td><td>—</td><td>—</td></tr>` : ''; }).join('') + '</tbody></table></div>';
  return `<div class="pcard ${col}" style="border-top-width:4px"><h3 style="font-size:26px">${esc(p.name)}</h3><p class="sub" style="margin-top:4px">${sum}</p>
    <div class="slotbar">${bar}</div><p class="sub small" style="margin:0">Games by even-strength role: ${P.slots.map((s, k) => `${SLOT[grp][k]} ${s.g}`).join(' · ')}</p>${verdicts}${byRole}${splits}${zone}${st}</div>`;
}
async function renderRole() {
  const y = S.season; const sd = S.seasons[y]; const U = await loadUsage(y);
  if (y !== S.season) return;
  if (!U) { $('role-sub').textContent = `Deployment data for ${sLabel(y)} hasn't been built yet. It's added by the nightly update.`; $('role').innerHTML = ''; $('lineup').innerHTML = ''; return; }
  await Promise.all([y - 1, y - 2].filter(z => S.idx.mp_seasons.includes(z)).map(z => loadSeason(z).catch(() => null)).concat([loadValue().catch(() => null)]));
  if (y !== S.season) return;
  const PA = profile(U, sd, S.A), PB = S.B ? profile(U, sd, S.B) : null;
  $('role-sub').innerHTML = `Three ways to judge fit. <strong>5v5 results</strong> ranks his even-strength results (xGF%, relative xGF%, points per 60, and for defensemen relative xGA/60) among regulars at his position and maps that onto the lineup: top quarter of forwards = 1st line, bottom quarter = 4th; thirds for defensemen. <strong>Overall value</strong> does the same with the all-situations value model from Part 3. <strong>Against his role</strong> compares him only to players used in the same slots. The first two blend the last three seasons, most recent counting most. In the tables, green and red mark results better or worse than the league average for that role; samples under 30 minutes are left blank.`;
  const lim = `<details class="lim" open><summary>What these numbers can and can't see</summary><ul>
    <li><strong>Competition isn't in the public data.</strong> Top-line players face the other team's best every night, so their raw 5v5 numbers look worse than the same play would against depth lines. That biases the 5v5 fit against first-liners and top-pair defensemen. "Against his role" is the best available correction, since it compares him only with others in the same slot.</li>
    <li><strong>The 5v5 fit is even strength only.</strong> A power-play specialist or elite finisher can read low there. Check "Overall value," which counts special teams and finishing.</li>
    <li><strong>One season is noisy.</strong> Shooting luck, injuries and linemates swing a single year, which is why the fits blend three. This season alone is shown too.</li>
    <li><strong>Usage isn't only ability.</strong> Coaches move players for form, injuries and matchups, and moving up usually brings better linemates. The moved up/down splits are evidence, not proof.</li>
    <li><strong>Team quality still leaks in.</strong> Relative stats remove some of it, but on a weak team even good players' on-ice numbers sag.</li></ul></details>`;
  $('role').innerHTML = PA ? lim + `<div class="rolegrid">${roleCard(PA, 'a')}${PB ? roleCard(PB, 'b') : ''}</div>` : '<p class="empty">No game-by-game data for this player and season.</p>';
  renderLineup(U, sd);
}
function renderLineup(U, sd) {
  const A = sd.byId.get(S.A);
  if (!S.lineupTeam || !sd.teams.includes(S.lineupTeam)) S.lineupTeam = A ? A.team : sd.teams[0];
  $('lineupTeam').innerHTML = sd.teams.map(t => `<option${t === S.lineupTeam ? ' selected' : ''}>${t}</option>`).join('');
  const minG = Math.max(5, Math.round(0.25 * sd.gpmax));
  const rows = sd.players.filter(p => p.team === S.lineupTeam && p.gp >= minG).map(p => profile(U, sd, p.id)).filter(Boolean);
  const tbl = grp => {
    const rs = rows.filter(r => r.grp === grp).sort((a, b) => a.avgSlot - b.avgSlot);
    if (!rs.length) return '';
    return `<p class="minihead" style="margin-top:12px">${grp === 'F' ? 'Forwards' : 'Defensemen'}</p><div class="scroll"><table class="tbl"><thead><tr><th>Player</th><th>GP</th><th>Used as</th><th>5v5 fit (3 yr)</th><th>Overall fit</th><th>Vs. role</th><th>Even strength</th><th>PP use</th><th>PP fit</th><th>PK use</th><th>PK fit</th><th>Zone starts</th></tr></thead><tbody>` +
      rs.map(r => `<tr class="${r.p.id === S.A ? 'isA' : ''}"><td><a href="#" data-seta="${r.p.id}">${esc(r.p.name)}</a> <span class="lab">${r.p.pos}</span></td><td>${r.G}</td><td style="white-space:nowrap">${slotName(grp, r.avgSlot)} <span class="lab">${r.avgSlot.toFixed(1)}</span></td><td style="white-space:nowrap">${r.enough ? slotName(grp, r.eq) + ` <span class="lab">${r.eq.toFixed(1)}</span>` : '—'}</td><td style="white-space:nowrap">${nz(r.eqAll) ? slotName(grp, r.eqAll) + ` <span class="lab">${r.eqAll.toFixed(1)}</span>` : '—'}</td><td class="${r.enough ? dcls(r.vsRole) : ''}">${r.enough ? s1(r.vsRole) : '—'}</td><td>${flag(r.allFit)}</td><td style="white-space:nowrap">${r.ppL}</td><td>${flag(r.ppFit)}</td><td style="white-space:nowrap">${r.pkL}</td><td>${flag(r.pkFit)}</td><td>${flag(r.zFit)}</td></tr>`).join('') + '</tbody></table></div>';
  };
  $('lineup').innerHTML = rows.length ? tbl('F') + tbl('D') + `<p class="sub small">Regulars with ${minG}+ games for ${S.lineupTeam} in ${sLabel(S.season)}. A player traded mid-season shows his whole season, including games for his other team.</p>` : '<p class="empty">No deployment data for this team.</p>';
}


// ------------------------------------------------------------------ nav: highlight the part and section in view
function initNav() {
  const links = [...document.querySelectorAll('#nav a')];
  const groups = [...document.querySelectorAll('#nav .ng')];
  let ticking = false;
  const update = () => {
    ticking = false;
    const head = document.querySelector('.top');
    const off = Math.max((getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0) + 60, window.innerHeight * 0.25);
    let cur = links[0];
    for (const a of links) { const el = document.querySelector(a.getAttribute('href')); if (el && !el.hidden && el.getBoundingClientRect().top - off <= 0) cur = a; }
    links.forEach(a => a.classList.toggle('cur', a === cur));
    const g = cur.closest('.ng'); const part = g.dataset.part || '1';
    groups.forEach(x => x.classList.toggle('on', x.dataset.part === part));
    if (window.innerWidth < 900) { const nav = $('nav'); const r = cur.getBoundingClientRect(), nr = nav.getBoundingClientRect(); if (r.left < nr.left || r.right > nr.right) nav.scrollLeft += r.left - nr.left - 40; }
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  update();
}


// ------------------------------------------------------------------ value (part three)
let VAL = null;
async function loadValue() {
  if (VAL) return VAL;
  const v = await getJSON('data/value.json');
  const f = v.fields; const by = new Map(); const seasons = {};
  for (const [y, sd] of Object.entries(v.seasons)) {
    const m = new Map();
    for (const r of sd.rows) { const o = { y: +y }; f.forEach((k, i) => { o[k] = r[i]; }); m.set(o.id, o); if (!by.has(o.id)) by.set(o.id, []); by.get(o.id).push(o); }
    seasons[+y] = { ...sd, map: m };
  }
  by.forEach(l => l.sort((a, b) => a.y - b.y));
  VAL = { ...v, seasons, by };
  return VAL;
}
const COMPS = [['ev_off', '5v5 offense'], ['ev_def', '5v5 defense'], ['finishing', 'Finishing'], ['pp', 'Power play'], ['pk', 'Penalty kill'], ['penalties', 'Penalties']];
function capKey(id) { return `sz-cap-${id}`; }
function getCap(id) { try { const v = localStorage.getItem(capKey(id)); return v ? +v : null; } catch (e) { return null; } }
function setCap(id, v) { try { if (nz(v)) localStorage.setItem(capKey(id), v); else localStorage.removeItem(capKey(id)); } catch (e) { /* storage blocked */ } }
function payLine(worth, capHit) {
  if (!nz(capHit) || !nz(worth)) return '';
  const d = worth - capHit;
  return `<b class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? 'Underpaid' : 'Overpaid'} by about ${money(Math.abs(d))}</b> for this season's value`;
}
async function renderValue() {
  const V = await loadValue().catch(() => null);
  if (!V) { $('value-sub').textContent = 'Value data hasn\'t been built yet. It\'s added by the nightly update.'; $('value').innerHTML = ''; $('deal').innerHTML = ''; return; }
  const y = S.season; const sv = V.seasons[y];
  if (!sv) { $('value').innerHTML = '<p class="empty">No value data for this season.</p>'; return; }
  const partial = sv.progress < 0.99;
  $('value-sub').innerHTML = `${sLabel(y)} cap ${money(sv.cap)}; the model prices one win at about <strong>${money(sv.per_win)}</strong> this season (the league's skater cap money above minimum salaries, divided by all the wins players produced).${partial ? ` ${sLabel(y)} is ${Math.round(sv.progress * 100)}% complete, so worth uses each player's pace over 82 games.` : ''} Replacement level is the 20th percentile at each position, roughly a call-up.`;
  const ids = [S.A, S.B].filter(Boolean);
  const rows = ids.map(id => sv.map.get(id)).filter(Boolean);
  const scale = Math.max(1, ...rows.flatMap(r => COMPS.map(([k]) => Math.abs(r[k]))));
  const sd = S.seasons[y];
  const rankOf = r => { const grp = grpOf(r.pos); const minG = Math.max(5, 0.25 * (sd ? sd.gpmax : 82)); const list = [...sv.map.values()].filter(x => grpOf(x.pos) === grp && x.gp >= minG).sort((a, b) => b.war - a.war); const i = list.findIndex(x => x.id === r.id); return i >= 0 ? `${i + 1} of ${list.length}` : '—'; };
  const card = (r, i) => {
    const name = (S.byId.get(r.id) || {}).name || r.id; const col = i ? 'b' : 'a';
    const cap = getCap(r.id);
    const comps = COMPS.map(([k, l]) => { const v = r[k]; const w = Math.abs(v) / scale * 50; return `<span>${l}</span><div class="trk"><b></b><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--hi)` : `left:${50 - w}%;width:${w}%;background:var(--lo)`}"></i></div><span class="mono" style="text-align:right">${s1(v)}</span>`; }).join('');
    return `<div class="pcard ${col}"><h3 style="font-size:24px">${esc(name)}</h3>
      <div class="tiles" style="margin-top:8px">
        <div class="tile"><b>${f1(r.war)}</b><span>Wins above replacement${partial ? ' so far' : ''}</span></div>
        <div class="tile"><b>${f1(r.war82)}</b><span>Per 82 games</span></div>
        <div class="tile"><b>${money(r.worth)}</b><span>Worth (${f1(r.worth_pct)}% of cap)</span></div>
        <div class="tile"><b>${rankOf(r)}</b><span>Rank at position</span></div></div>
      <p class="minihead" style="margin-top:14px">Where the value comes from · goals above replacement</p><div class="comp">${comps}</div>
      <div class="capin"><label for="cap-${r.id}">His cap hit ($M)</label><input id="cap-${r.id}" data-capid="${r.id}" type="number" step="0.05" min="0" placeholder="e.g. 8.55" value="${nz(cap) ? cap : ''}"><span id="pay-${r.id}">${payLine(r.worth, cap)}</span></div>
      <p class="sub small">Type his cap hit from <a href="https://puckpedia.com" rel="noopener">PuckPedia</a> or his team to compare. It stays in your browser only.</p></div>`;
  };
  const hist = drawValueHistory(V, ids);
  $('value').innerHTML = rows.length ? `<div class="valgrid">${rows.map(card).join('')}</div><p class="minihead" style="margin-top:20px">Wins above replacement per 82 games, by season</p>${hist}` : '<p class="empty">No value data for this player and season.</p>';
  renderDeal(V, ids);
}
function drawValueHistory(V, ids) {
  const W = 1080, H = 260, m = { l: 48, r: 110, t: 14, b: 34 };
  const series = ids.map((id, i) => ({ id, col: i ? 'var(--b)' : 'var(--a)', pts: (V.by.get(id) || []).filter(r => r.gp >= 20).map(r => [r.y, r.war82]) })).filter(s => s.pts.length);
  if (!series.length) return '';
  const all = series.flatMap(s => s.pts);
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(x0 + 1, ...all.map(p => p[0]));
  const yd = extent(all.map(p => p[1]).concat([0]), 0.1);
  const g = axes(W, H, m, [x0, x1], yd, ticks(x0, x1, x1 - x0 > 10 ? 2 : 1), ticks(yd[0], yd[1], niceStep(yd[1] - yd[0], 5)), null, null, v => sLabel(v), v => +v.toFixed(1));
  let s = g.s + `<line x1="${m.l}" x2="${W - m.r}" y1="${g.Y(0)}" y2="${g.Y(0)}" stroke="var(--muted)"/>`;
  series.forEach(sr => { s += `<polyline points="${sr.pts.map(([x, y]) => g.X(x) + ',' + g.Y(y)).join(' ')}" fill="none" stroke="${sr.col}" stroke-width="2.6"/>` + sr.pts.map(([x, y]) => `<circle cx="${g.X(x)}" cy="${g.Y(y)}" r="3.5" fill="${sr.col}"><title>${sLabel(x)}: ${y.toFixed(2)} wins per 82</title></circle>`).join(''); const e = sr.pts[sr.pts.length - 1]; s += `<text data-l="1" x="${g.X(e[0]) + 7}" y="${g.Y(e[1]) + 4}" font-size="12" font-weight="700" fill="${sr.col}">${esc(last((S.byId.get(sr.id) || {}).name || ''))}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Value by season">${s}</svg>`;
}
function renderDeal(V, ids) {
  const cards = ids.map((id, i) => {
    const P = V.proj[id]; const name = (S.byId.get(id) || {}).name || id;
    if (!P) return `<div class="pcard ${i ? 'b' : 'a'}"><h3 style="font-size:22px">${esc(name)}</h3><p class="empty">No projection: he needs recent NHL games.</p></div>`;
    const yrs = P.years.map(r => ({ y: r[0], age: r[1], war: r[2], worth: r[3], cap: r[4] }));
    const rows = [1, 2, 3, 4, 5, 6, 7].map(n => { const span = yrs.slice(0, n); const aav = avg(span.map(x => x.worth)); return `<tr><td style="white-space:nowrap">${n} yr</td><td style="white-space:nowrap">${n > 1 ? `${sLabel(span[0].y)} – ${sLabel(span[n - 1].y)}` : sLabel(span[0].y)}</td><td style="white-space:nowrap">${n > 1 ? `${span[0].age ?? '?'}–${span[n - 1].age ?? '?'}` : (span[0].age ?? '?')}</td><td>${money(aav)}</td><td>${f1(100 * aav / span[0].cap)}%</td><td>${f2(avg(span.map(x => x.war)))}</td></tr>`; }).join('');
    return `<div class="pcard ${i ? 'b' : 'a'}"><h3 style="font-size:22px">${esc(name)}</h3><p class="sub small">Starting point: ${f2(P.base_war82)} wins per 82 games, a weighted blend of his last three seasons (most recent counts most)${nz(P.age) ? `; age ${P.age} this season` : ''}.</p>
      <div class="scroll"><table class="tbl" style="min-width:560px"><thead><tr><th>Term</th><th>Seasons</th><th>Ages</th><th>Fair AAV</th><th>% of first-year cap</th><th>Avg wins / yr</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  });
  $('deal-sub').innerHTML = `What a new contract starting next season would be worth if it paid exactly his projected value. Each year's value is adjusted for age (rising into the mid-20s, flat to 28, then declining) and priced at that year's projected cap. ${esc(V.cap_assumption)} New CBA limits: 7 years to re-sign with his own team, 6 as a free agent. This is fair value under the model, not a prediction of what he'll sign for. It doesn't know about RFA rights, arbitration, or market quirks.`;
  $('deal').innerHTML = `<div class="valgrid">${cards.join('')}</div>`;
}

// ------------------------------------------------------------------ orchestration
function setHash() { const h = `#a=${S.A || ''}${S.B ? '&b=' + S.B : ''}&s=${S.season}`; if (location.hash !== h) history.replaceState(null, '', h); }
function readHash() { const o = {}; location.hash.replace(/^#/, '').split('&').forEach(kv => { const [k, v] = kv.split('='); if (k) o[k] = v; }); return o; }
function hasSeason(id, y) { const p = S.byId.get(id); return p && p.mask && (p.mask >> (y - S.idx.mp_first)) & 1; }
function bestSeason(id) {
  if (hasSeason(id, S.season)) return S.season;
  const p = S.byId.get(id); if (!p || !p.mask) return S.season;
  for (let y = S.idx.current; y >= S.idx.mp_first; y--) if (hasSeason(id, y)) { const cur = y === S.idx.current; if (cur && hasSeason(id, y - 1) && S.season < S.idx.current) return y - 1; return y; }
  return S.season;
}
function renderSeasonSelect() {
  const ys = S.idx.mp_seasons.slice().reverse();
  $('season').innerHTML = ys.map(y => `<option value="${y}"${y === S.season ? ' selected' : ''}>${sLabel(y)}${hasSeason(S.A, y) ? '' : ' ·'}</option>`).join('');
}
async function render() {
  setHash(); renderSeasonSelect();
  const sd = await loadSeason(S.season).catch(() => null);
  const A = sd ? sd.byId.get(S.A) : null;
  const pa = S.byId.get(S.A) || {};
  safe('sec-profile', renderProfile);
  $('part1-h').textContent = A ? `${pa.name}'s ${sLabel(S.season)}` : 'The season';
  const seasonSecs = ['sec-rank', 'sec-matrix', 'sec-h2h', 'sec-env', 'sec-mates', 'sec-swap', 'sec-role', 'sec-lineup'];
  seasonSecs.forEach(id => { const el = $(id); el.querySelectorAll(':scope > .nodata').forEach(x => x.remove()); [...el.children].forEach(ch => { if (!ch.classList.contains('head') && !ch.classList.contains('nodata')) ch.hidden = !A; }); if (!A) el.insertAdjacentHTML('beforeend', `<p class="empty nodata">No ${sLabel(S.season)} MoneyPuck data for ${esc(pa.name || 'this player')}.${pa.mask ? ' Pick one of his seasons in the Season box.' : ' Advanced stats start in 2008-09.'}</p>`); });
  if (A) {
    safe('sec-rank', renderRank); safe('sec-matrix', renderMatrix); safe('sec-h2h', renderH2H); safe('sec-env', renderEnv); safe('sec-swap', renderSwap);
    renderMates().catch(e => console.error(e));
    if (S.shotsSeen) renderShots().catch(e => console.error(e));
    renderRole().catch(e => console.error(e));
  }
  renderValue().catch(e => console.error(e));
  if (S.season >= 2021) loadAllEdge().then(() => { safe('sec-profile', renderProfile); if (S.boardMode === 'sim' && A) { safe('sec-matrix', renderMatrix); safe('sec-env', renderEnv); } }).catch(() => {});
  if (CAR) { safe('sec-career', renderCareer); safe('sec-arcs', renderArcs); }
}
function setA(id) { if (!id) return; if (id === S.B) S.B = S.A; S.A = id; S.extra = []; S.removed.clear(); S.sortKey = null; S.season = bestSeason(id); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function setB(id) { if (!id || id === S.A) return; S.B = id; if (!hasSeason(S.A, S.season) && hasSeason(id, S.season)) { /* keep */ } render(); }

function wire() {
  makeSearch('qA', setA, { cross: crossTo(false) }); makeSearch('qB', setB, { filter: p => p.pos !== 'G' });
  makeSearch('qBoard', id => { if (!S.extra.includes(id)) S.extra.push(id); S.removed.delete(id); safe('sec-matrix', renderMatrix); safe('sec-env', renderEnv); }, { filter: p => p.pos !== 'G' && hasSeason(p.id, S.season) });
  makeSearch('qArc', id => { if (!S.arcSel.includes(id) && id !== S.A) { S.arcSel.push(id); if (arcPlayers().length > 6) S.arcSel.shift(); } safe('sec-arcs', renderArcs); }, { filter: p => p.pos !== 'G' });
  $('season').addEventListener('change', e => { S.season = +e.target.value; render(); });
  $('rank-ctl').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.pool) { S.pool = b.dataset.pool; S.cache = {}; } if (b.dataset.pre) { const p = PRESETS[+b.dataset.pre]; S.w = { d: p[1], o: p[2], c: p[3] }; } render(); });
  $('weights').addEventListener('input', e => { const k = e.target.dataset.w; if (!k) return; S.w[k] = +e.target.value; safe('sec-rank', renderRank); });
  $('weights').addEventListener('change', () => { safe('sec-profile', renderProfile); safe('sec-matrix', renderMatrix); safe('sec-h2h', renderH2H); });
  $('rank').addEventListener('click', e => { const n = e.target.closest('[data-id]'); if (n) setA(+n.dataset.id); });
  $('matrix').addEventListener('click', e => { const s = e.target.closest('[data-sort]'); if (s) { S.sortKey = s.dataset.sort; safe('sec-matrix', renderMatrix); return; } const r = e.target.closest('[data-rm]'); if (r) { const id = +r.dataset.rm; S.extra = S.extra.filter(x => x !== id); S.removed.add(id); if (id === S.B) S.B = null; render(); } });
  $('mtoggle').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.mode) { S.boardMode = b.dataset.mode; S.removed.clear(); safe('sec-matrix', renderMatrix); safe('sec-env', renderEnv); return; } if (b.id === 'mv') S.showPct = !S.showPct; if (b.id === 'ms') S.sortKey = null; safe('sec-matrix', renderMatrix); });
  $('swapTeam').addEventListener('change', e => { S.swapTeam = e.target.value; S.swapOut = null; safe('sec-swap', renderSwap); });
  $('swapOut').addEventListener('change', e => { S.swapOut = +e.target.value; safe('sec-swap', renderSwap); });
  $('cmode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.cmode = b.dataset.m; $('cmode').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); safe('sec-career', renderCareer); });
  $('ametric').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.arcMetric = b.dataset.am; safe('sec-arcs', renderArcs); });
  $('achips').addEventListener('click', e => { const b = e.target.closest('[data-rmarc]'); if (!b) return; const id = +b.dataset.rmarc; S.arcSel = S.arcSel.filter(x => x !== id); if (id === S.B) S.B = null; render(); });
  $('comps').addEventListener('click', e => { const a = e.target.closest('[data-addarc]'); if (!a) return; e.preventDefault(); const id = +a.dataset.addarc; if (!S.arcSel.includes(id)) { S.arcSel.push(id); if (arcPlayers().length > 6) S.arcSel.shift(); } safe('sec-arcs', renderArcs); });
  $('shots').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.sit) SH.sit = b.dataset.sit; if (b.dataset.view) SH.view = b.dataset.view; renderShots(); });
  new IntersectionObserver(es => { if (es.some(x => x.isIntersecting) && !S.shotsSeen) { S.shotsSeen = true; renderShots().catch(e => console.error(e)); } }, { rootMargin: '600px' }).observe($('sec-shots'));
  $('lineupTeam').addEventListener('change', e => { S.lineupTeam = e.target.value; const U = USAGE[S.season]; if (U) renderLineup(U, S.seasons[S.season]); });
  $('lineup').addEventListener('click', e => { const a = e.target.closest('[data-seta]'); if (!a) return; e.preventDefault(); setA(+a.dataset.seta); });
  $('value').addEventListener('change', e => { const id = e.target.dataset.capid; if (!id) return; const v = getCap(+id); if (nz(v) && +e.target.value !== v) e.target.value = v; });
  $('value').addEventListener('input', e => { const id = e.target.dataset.capid; if (!id) return; let v = e.target.value === '' ? null : +e.target.value; if (nz(v) && v >= 1000) v = Math.round(v / 1e4) / 100; setCap(+id, v); const r = VAL && VAL.seasons[S.season] && VAL.seasons[S.season].map.get(+id); $('pay-' + id).innerHTML = r ? payLine(r.worth, v) : ''; });
  window.addEventListener('hashchange', () => { const h = readHash(); const a = +h.a, b = +h.b, s = +h.s; let ch = false; if (a && a !== S.A && S.byId.has(a)) { S.A = a; ch = true; } if (b && b !== S.B && S.byId.has(b)) { S.B = b; ch = true; } if (s && s !== S.season && S.idx.mp_seasons.includes(s)) { S.season = s; ch = true; } if (ch) render(); });
}

async function init() {
  try {
    const idx = await getJSON('data/index.json');
    const f = idx.fields;
    idx.list = idx.players.map(r => { const o = {}; f.forEach((k, i) => { o[k] = r[i]; }); o.mask = o.mp_mask; o.n = norm(o.name); return o; });
    S.idx = idx; idx.list.forEach(p => S.byId.set(p.id, p));
    $('updated').textContent = `Data updated ${idx.updated.replace('T', ' ').replace('Z', ' UTC')}.`;
    const h = readHash();
    const top = idx.list.filter(p => p.mask && p.pos !== 'G').sort((a, b) => b.gp - a.gp)[0];
    if (S.byId.has(+h.a) && S.byId.get(+h.a).pos === 'G') { location.replace('goalies.html' + location.hash); return; }
    S.A = S.byId.has(+h.a) ? +h.a : S.byId.has(8481542) ? 8481542 : top.id;
    S.B = h.b === undefined ? (S.byId.has(8480069) && S.A !== 8480069 ? 8480069 : null) : (S.byId.has(+h.b) ? +h.b : null);
    S.season = idx.mp_seasons.includes(+h.s) ? +h.s : idx.mp_seasons[idx.mp_seasons.length - 1];
    if (!h.s) {
      // until the current season is half over, open on the last complete season
      const cur = await loadSeason(S.season).catch(() => null);
      if (cur && cur.gpmax < 41 && idx.mp_seasons.includes(S.season - 1)) S.season -= 1;
      S.season = bestSeason(S.A);
    }
    wire();
    initNav();
    $('status').hidden = true;
    S.shotsSeen = true;
    await render();
    loadCareers().then(() => render()).catch(e => { console.error(e); $('sec-career').insertAdjacentHTML('beforeend', '<p class="empty">Career data could not be loaded.</p>'); });
  } catch (e) {
    console.error(e);
    $('status').textContent = 'Could not load the data files. If this is a new site, the first data build may still be running; check the Actions tab on GitHub.';
    $('status').classList.add('err');
  }
}
init();
