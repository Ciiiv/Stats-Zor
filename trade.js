'use strict';
/* Stats-Zor trade machine. Runs in the browser from data/value.json, rosters.json, prospects.json. */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nz = v => v !== null && v !== undefined && !Number.isNaN(v);
const money = v => nz(v) ? (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2) + 'M' : '—';
const f1 = v => nz(v) ? v.toFixed(1) : '—';
const getJSON = async u => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u); return r.json(); };
const sLabel = y => `${y}-${String(y + 1).slice(2)}`;
// cap hits are in $ millions; a number typed in dollars (8700000) is converted to millions (8.7)
const toM = v => !nz(v) ? null : v >= 1000 ? Math.round(v / 1e4) / 100 : v;

// Expected wins over a pick's cost-controlled years, by overall pick number.
const pickWins = n => 6 * Math.exp(-0.045 * (n - 1)) + 0.15;
const SLOTS = { early: 4, mid: 16, late: 28 };
const FUTURE_DISCOUNT = 0.9;   // per year a pick is further away
const PROSPECT_DECAY = 0.85;   // per year since a prospect was drafted without becoming a regular

const D = { cur: null, nextDraft: null, perWin: null, progress: 1, proj: {}, rows: new Map(), rosters: {}, prospects: [], teams: [] };
const T = { team: [null, null], assets: [[], []], mode: ['neutral', 'neutral'], pk: [{ year: null, round: 1, slot: 'mid' }, { year: null, round: 1, slot: 'mid' }] };

// ---- team control: an estimate of the CBA rule. A player can't become an unrestricted free agent
// until he's 27 (as of June 30 when his deal ends) or has 7 accrued seasons; until then his team keeps
// his rights as a restricted free agent. Accrued season ~ 40+ NHL games (25+ for goalies).
const UFA_AGE = 27, UFA_ACC = 7;
function ageOnJune30(birth, year) { const b = new Date(birth + 'T00:00:00'); return year - b.getFullYear() - (b.getMonth() > 5 ? 1 : 0); }
function ufaAfter(P) {
  // seasons after this one before he's UFA-eligible (his team controls them), or null if his age is unknown
  if (!P || !P.birth) return null;
  for (let t = 0; t < 7; t++) { const end = D.cur + t + 1; if (ageOnJune30(P.birth, end) >= UFA_AGE || (P.acc || 0) + t + 1 >= UFA_ACC) return t; }
  return 7;
}
function control(a) {
  const P = D.proj[a.id];
  const contract = nz(a.after) ? a.after : 0;
  const ufa = ufaAfter(P);
  const canAdd = nz(ufa) && ufa > contract;
  const rfaOn = canAdd && (a.rfa === undefined ? true : a.rfa);
  const seasons = rfaOn ? ufa : contract;       // seasons after this one his team controls
  return { P, contract, ufa, canAdd, rfaOn, seasons, rfaSeasons: seasons - contract, endAge: P && P.birth ? ageOnJune30(P.birth, D.cur + seasons + 1) : null };
}
function playerValue(a) {
  const C = control(a); const P = C.P;
  const base = P ? P.base_war82 : 0;
  const frac = Math.max(0, 1 - D.progress);
  const fut = P ? P.years.slice(0, C.seasons) : [];
  const wins = base * frac + fut.reduce((s, r) => s + r[2], 0);
  const worthNow = D.minNow + Math.max(0, base) * (P && P.g ? D.perWinG : D.perWin);
  const worth = worthNow * frac + fut.reduce((s, r) => s + r[3], 0);
  // salary: his cap hit for the rest of this season and his contract (real salary), plus RFA seasons
  // assumed paid his fair value (unknown salary, so they add wins but no surplus)
  const contractCost = nz(a.cap) ? a.cap * (frac + C.contract) : null;
  const rfaCost = fut.slice(C.contract).reduce((s, r) => s + r[3], 0);
  const cost = nz(a.cap) ? contractCost + rfaCost : null;
  const ws = [base * frac, ...fut.map(r => r[2])]; // wins by season: this season, then each season after
  return { wins, worth, cost, contractCost, rfaCost, surplus: nz(cost) ? worth - cost : null, base, hasProj: !!P, C, ws };
}
function pickValue(a) {
  const overall = SLOTS[a.slot] + (a.round - 1) * 32;
  const wins = pickWins(overall) * Math.pow(FUTURE_DISCOUNT, a.year - D.nextDraft);
  return { wins, worth: wins * D.perWin, cost: 0, contractCost: 0, surplus: wins * D.perWin, overall, ws: spread(wins, a.year + 2) };
}
const NHL_BLEND_MIN = 40;  // NHL games before a prospect's own record counts; full weight at 100
function prospectValue(a) {
  const wins = pickWins(a.overall) * Math.pow(PROSPECT_DECAY, Math.max(0, D.nextDraft - 1 - a.draft_year));
  const draft = { wins, worth: wins * D.perWin, ws: spread(wins, Math.max(D.cur + 1, a.draft_year + 3)) };
  if (!(a.id && D.proj[a.id] && a.nhl_gp >= NHL_BLEND_MIN)) return { ...draft, cost: 0, contractCost: 0, surplus: draft.worth };
  // blend his own NHL projection (over the seasons his team controls) with the draft-slot value
  const w = Math.min(1, a.nhl_gp / 100);
  const nhl = playerValue(a);
  const worth = w * nhl.worth + (1 - w) * draft.worth;
  const cost = nz(a.cap) ? nhl.cost : 0;
  const ws = Array.from({ length: 8 }, (_, k) => w * (nhl.ws[k] || 0) + (1 - w) * (draft.ws[k] || 0));
  return { wins: w * nhl.wins + (1 - w) * draft.wins, worth, cost, contractCost: nz(a.cap) ? nhl.contractCost : 0, rfaCost: nhl.rfaCost, surplus: worth - cost, w, nhl, draft, base: nhl.base, C: nhl.C, ws };
}
// ---- timing: when each asset's wins arrive, and how a team weighs them by its plans
// A draft pick or a prospect without NHL games is assumed to help over three seasons starting two
// seasons after his draft (three for an already-drafted prospect), or next season at the earliest.
function spread(wins, firstSeason) { const ws = Array(8).fill(0); const k0 = Math.max(1, firstSeason - D.cur); for (let k = k0; k < k0 + 3 && k < 8; k++) ws[k] = wins / 3; return ws; }
// weight of a win by season: this season, next season, then each season after
const decay = r => [1, 1, ...[1, 2, 3, 4, 5, 6].map(k => +Math.pow(r, k).toFixed(3))];
const MODES = {
  neutral: { l: 'No preference', w: [1, 1, 1, 1, 1, 1, 1, 1] },       // pure value: every win counts the same
  contend: { l: 'Contending', w: decay(0.85) },                       // next two seasons fully, then −15% a season
  bubble: { l: 'Bubble team', w: decay(0.925) },                      // next two seasons fully, then −7.5% a season
  rebuild: { l: 'Rebuilding', w: [0.5, 0.8, 1, 1, 1, 1, 1, 1] },      // this season half, next 80%, later fully
};
const timed = (v, mode) => (v.ws || []).reduce((s, x, k) => s + x * MODES[mode].w[Math.min(k, 7)], 0);
const valueOf = a => a.type === 'player' ? playerValue(a) : a.type === 'pick' ? pickValue(a) : prospectValue(a);

function contractHTML(a, v, i, k) {
  const C = v.C;
  const rfa = !C ? '' : C.canAdd
    ? `<label><input type="checkbox" data-i="${i}" data-k="${k}" data-f="rfa"${C.rfaOn ? ' checked' : ''}> Team keeps his rights after this deal (RFA)</label><span>${C.rfaOn ? `adds ${C.rfaSeasons} RFA season${C.rfaSeasons > 1 ? 's' : ''}, through age ${C.endAge}` : `would add ${C.ufa - C.contract} RFA season${C.ufa - C.contract > 1 ? 's' : ''}`}</span>`
    : `<span>${nz(C.ufa) ? 'Unrestricted free agent when this deal ends' : 'Age unknown: team control not estimated'}</span>`;
  return `<label>Years left on contract after this one <input type="number" min="0" max="7" step="1" placeholder="add" value="${nz(a.after) ? a.after : ''}" data-i="${i}" data-k="${k}" data-f="after"></label>
    <label>Cap hit ($M) <input type="number" min="0" step="0.05" placeholder="e.g. 8.7" value="${nz(a.cap) ? a.cap : ''}" data-i="${i}" data-k="${k}" data-f="cap"></label>${rfa}
    <span>Worth ${money(v.worth)} in total over the seasons counted${nz(a.cap) ? ` · paid ${money(v.contractCost)} in salary (${money(a.cap)} a year for the rest of this season${C.contract ? ` and ${C.contract} more` : ''})${C.rfaSeasons && v.rfaCost ? ` + about ${money(v.rfaCost)} assumed for ${C.rfaSeasons} RFA season${C.rfaSeasons > 1 ? 's' : ''} (~${money(v.rfaCost / C.rfaSeasons)} a year, his fair value)` : ''} · surplus <b class="${v.surplus >= 0 ? 'pos' : 'neg'}">${money(v.surplus)}</b>` : ''}</span>`;
}
function sideHTML(i) {
  const team = T.team[i]; const cls = i ? 'b' : '';
  const roster = (D.rosters[team] || []).map(r => ({ id: r[0], name: r[1], pos: r[2], off: r[4] === 1, base: D.proj[r[0]] ? D.proj[r[0]].base_war82 : null }))
    .filter(r => !T.assets[i].some(a => a.type === 'player' && a.id === r.id)).sort((a, b) => (b.base ?? -9) - (a.base ?? -9));
  const pros = D.prospects.filter(p => p.drafted_by === team && !T.assets[i].some(a => a.type === 'prospect' && a.name === p.name)).sort((a, b) => a.overall - b.overall);
  const years = [0, 1, 2].map(k => D.nextDraft + k);
  const assets = T.assets[i].map((a, k) => {
    const v = valueOf(a);
    let nm = '', det = '';
    if (a.type === 'player') {
      nm = `${esc(a.name)}<small>${a.pos}${a.off ? ' · not on active roster' : ''} · ${v.hasProj ? f1(v.base) + (D.proj[a.id].per === 'season' ? ' wins/season' : ' wins/82') : 'no recent NHL data'}</small>`;
      det = contractHTML(a, v, i, k);
    } else if (a.type === 'pick') {
      nm = `${a.year} ${['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'][a.round - 1]}-round pick<small>${esc(a.from)} · projected ${a.slot} (around #${v.overall})</small>`;
      det = `<span>Expected value from a pick at that slot${a.year > D.nextDraft ? `, discounted ${a.year - D.nextDraft} year${a.year - D.nextDraft > 1 ? 's' : ''} out` : ''} · worth ${money(v.worth)}</span>`;
    } else {
      nm = `${esc(a.name)}<small>${a.pos} prospect · #${a.overall} in ${a.draft_year} by ${esc(a.drafted_by)}${a.nhl_gp ? ` · ${a.nhl_gp} NHL GP` : ''}</small>`;
      det = v.nhl
        ? `<span>Blends his NHL record (${a.nhl_gp} games, ${Math.round(100 * v.w)}%: ${f1(v.base)} wins/82 over the seasons his team controls) with his draft slot (${Math.round(100 * (1 - v.w))}%)</span>` + contractHTML(a, v, i, k)
        : `<span>Value from his draft slot, reduced for each year since the draft he hasn't stuck in the NHL${a.nhl_gp ? ` (his own record counts from ${NHL_BLEND_MIN} NHL games)` : ''} · worth ${money(v.worth)}</span>`;
    }
    return `<div class="asset"><div class="nm">${nm}</div><div style="display:flex;gap:10px;align-items:center"><span class="val">${f1(v.wins)} W</span><button type="button" data-rm="${i}:${k}" aria-label="Remove">×</button></div><div class="det">${det}</div></div>`;
  }).join('');
  return `<div class="side ${cls}"><h2><span>${i ? 'Team B' : 'Team A'}</span><select data-team="${i}" aria-label="${i ? 'Team B' : 'Team A'}">${D.teams.map(t => `<option${t === team ? ' selected' : ''}>${t}</option>`).join('')}</select><span style="font-size:16px;color:var(--muted)">sends</span><select data-mode="${i}" aria-label="${team} plans" title="How ${team} weighs wins now against wins later" style="width:auto;font:600 13px var(--f-body);margin-left:auto">${Object.entries(MODES).map(([k, m]) => `<option value="${k}"${T.mode[i] === k ? ' selected' : ''}>${m.l}</option>`).join('')}</select></h2>
    <div class="adders">
      <div class="row"><select data-addp="${i}" aria-label="Add a player"><option value="">+ Add a player</option>${roster.map(r => `<option value="${r.id}">${esc(r.name)} · ${r.pos}${r.off ? ' · not on active roster' : ''}${nz(r.base) ? ' · ' + f1(r.base) + (D.proj[r.id].per === 'season' ? ' W/season' : ' W/82') : ''}</option>`).join('')}</select></div>
      <div class="row"><select data-addq="${i}" aria-label="Add a prospect"><option value="">+ Add a prospect (${pros.length})</option>${pros.map(p => `<option value="${esc(p.name)}">${esc(p.name)} · ${p.pos} · #${p.overall} in ${p.draft_year}</option>`).join('')}</select></div>
      <div class="row"><select data-pky="${i}" aria-label="Pick year">${years.map(y => `<option${(T.pk[i].year || years[0]) === y ? ' selected' : ''}>${y}</option>`).join('')}</select>
        <select data-pkr="${i}" aria-label="Round">${[1, 2, 3, 4, 5, 6, 7].map(r => `<option value="${r}"${T.pk[i].round === r ? ' selected' : ''}>Round ${r}</option>`).join('')}</select>
        <select data-pks="${i}" aria-label="Projected slot">${[['early', 'Early (top 8)'], ['mid', 'Middle'], ['late', 'Late (playoff team)']].map(([k, l]) => `<option value="${k}"${T.pk[i].slot === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button type="button" data-addk="${i}">+ Add pick</button></div>
    </div>
    ${assets || `<p class="empty-side">Nothing added yet.</p>`}</div>`;
}
function summary() {
  const tot = T.assets.map(list => list.map(valueOf));
  const sum = (l, k) => l.reduce((s, v) => s + (v[k] || 0), 0);
  const players = T.assets.flat().filter(a => a.type === 'player');
  const salaryMode = players.length > 0 && players.every(a => nz(a.cap));
  const side = k => { const sent = tot.map(l => sum(l, k)); return { getA: sent[1], getB: sent[0], diff: sent[1] - sent[0] }; }; // Team A receives what B sends
  const W = side('wins'), M = salaryMode ? side('surplus') : null;
  const H = M || W; const unit = M ? money : (v => f1(v) + ' wins');
  const total = Math.abs(H.getA) + Math.abs(H.getB) || 1;
  const isClose = (d, tot, s) => Math.abs(d) < (s ? 1.5 : 0.4) || Math.abs(d) / (tot || 1) < 0.08;
  const winner = (d, tot, s) => isClose(d, tot, s) ? 'about even' : `${d > 0 ? T.team[0] : T.team[1]} comes out ahead`;
  const verdict = !T.assets[0].length && !T.assets[1].length ? 'Add assets to both sides to see who wins.'
    : isClose(H.diff, total, !!M) ? 'About even' : `${H.diff > 0 ? T.team[0] : T.team[1]} wins this trade`;
  const capA = sum(tot[1], 'contractCost') - sum(tot[0], 'contractCost');
  const capNote = salaryMode ? `<p class="sub small">Cap change for the rest of the deals: ${T.team[0]} ${capA >= 0 ? 'takes on' : 'sheds'} ${money(Math.abs(capA))} in total contract salary (cap hits you entered, over the years left you entered; assumed RFA pay isn't included); ${T.team[1]} the opposite. Cap space and roster limits aren't checked.</p>`
    : players.length ? `<p class="sub small">Enter every player's cap hit (in millions, like 8.7) to add surplus value (worth minus salary) and base the verdict on it. Right now it compares on-ice value only, so an overpaid player still counts as a plus.</p>` : '';
  const noYears = players.filter(a => !nz(a.after) && !playerValue(a).C.rfaOn);
  const yearsNote = noYears.length ? `<p class="sub small"><b class="neg">Years left missing</b> for ${noYears.map(a => esc(a.name)).join(', ')}: counting only the rest of this season for ${noYears.length > 1 ? 'them' : 'him'}. Add years left on the contract after this one (0 for a rental) to count the rest of the deal. Young players whose team keeps their rights already count those seasons.</p>` : '';
  const wA = Math.max(0, H.getA) / (Math.max(0, H.getA) + Math.max(0, H.getB) || 1) * 100;
  const sgn = (v, f) => `<strong class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : '−'}${f(Math.abs(v))}</strong>`;
  const wf = v => f1(v) + ' wins';
  const rows = [['Wins above replacement', W, wf, 'On the ice']].concat(M ? [['Surplus value (worth − salary)', M, money, 'With salary']] : []);
  const anyMode = T.mode.some(m => m !== 'neutral');
  const tw = i => { const gets = tot[1 - i].reduce((s, v) => s + timed(v, T.mode[i]), 0), gives = tot[i].reduce((s, v) => s + timed(v, T.mode[i]), 0); return gets - gives; };
  const tA = tw(0), tB = tw(1);
  const both = tA > 0.2 && tB > 0.2;
  const timeRow = anyMode ? `<tr><td>Wins by each team's plans<br><small class="lab">${T.team[0]}: ${MODES[T.mode[0]].l.toLowerCase()} · ${T.team[1]}: ${MODES[T.mode[1]].l.toLowerCase()}</small></td><td colspan="2"></td><td>${sgn(tA, wf)}</td><td>${sgn(tB, wf)}</td><td>${both ? 'Works for both sides' : tA > tB ? `${T.team[0]} comes out ahead` : `${T.team[1]} comes out ahead`}</td></tr>` : '';
  const timeNote = anyMode ? `<p class="sub small">By each team's plans, every team weighs wins by when they arrive: contending teams count this season and next fully and each later season 15% less than the one before, bubble teams 7.5% less, and rebuilding teams count this season at half and next season at 80%. Each team judges what it gets and gives on its own scale, so both can come out ahead. Picks are assumed to help over three seasons starting two years after their draft.</p>` : '';
  const table = `<div class="scroll"><table class="tbl" style="margin-top:10px"><thead><tr><th></th><th>${T.team[0]} gets</th><th>${T.team[0]} gives</th><th>${T.team[0]} net</th><th>${T.team[1]} net</th><th>Verdict</th></tr></thead><tbody>` +
    rows.map(([l, x, f, short]) => `<tr><td>${l}</td><td>${f(x.getA)}</td><td>${f(x.getB)}</td><td>${sgn(x.diff, f)}</td><td>${sgn(-x.diff, f)}</td><td>${short}: ${winner(x.diff, Math.abs(x.getA) + Math.abs(x.getB), f === money)}</td></tr>`).join('') + timeRow + '</tbody></table></div>';
  $('summary').innerHTML = `<div class="head"><h2>${esc(verdict)}</h2><p class="sub">Verdict on ${M ? 'surplus value: projected worth minus salary over each contract. Wins above replacement are shown too' : 'projected wins above replacement over the years each asset is controlled'}. Prospects and picks count their projected wins, and their worth with no salary against it.</p></div>
    <div class="meter"><i style="width:${wA}%;background:var(--a)">${wA > 12 ? T.team[0] + ' gets ' + unit(H.getA) : ''}</i><i style="width:${100 - wA}%;background:var(--b)">${100 - wA > 12 ? T.team[1] + ' gets ' + unit(H.getB) : ''}</i></div>
    ${table}${timeNote}${yearsNote}${capNote}`;
}
function render() {
  $('tm').innerHTML = sideHTML(0) + sideHTML(1);
  summary();
}
function wire() {
  const tm = $('tm');
  tm.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.pky) { T.pk[+t.dataset.pky].year = +t.value; return; }
    if (t.dataset.pkr) { T.pk[+t.dataset.pkr].round = +t.value; return; }
    if (t.dataset.pks) { T.pk[+t.dataset.pks].slot = t.value; return; }
    if (t.dataset.mode) { T.mode[+t.dataset.mode] = t.value; summary(); return; }
    if (t.dataset.team) { const i = +t.dataset.team; T.team[i] = t.value; T.assets[i] = []; render(); return; }
    if (t.dataset.addp) { const i = +t.dataset.addp; const r = (D.rosters[T.team[i]] || []).find(x => String(x[0]) === t.value); if (r) T.assets[i].push({ type: 'player', id: r[0], name: r[1], pos: r[2], off: r[4] === 1, after: null, cap: null }); render(); return; }
    if (t.dataset.f === 'rfa') { T.assets[+t.dataset.i][+t.dataset.k].rfa = t.checked; render(); return; }
    if (t.dataset.addq) { const i = +t.dataset.addq; const p = D.prospects.find(x => x.name === t.value && x.drafted_by === T.team[i]); if (p) T.assets[i].push({ type: 'prospect', ...p }); render(); return; }
  });
  tm.addEventListener('input', e => {
    const t = e.target; if (!t.dataset.f) return;
    const a = T.assets[+t.dataset.i][+t.dataset.k];
    if (t.dataset.f === 'after') a.after = t.value === '' ? null : Math.max(0, Math.min(7, Math.round(+t.value || 0)));
    if (t.dataset.f === 'cap') a.cap = t.value === '' ? null : toM(+t.value);
    clearTimeout(wire.t); wire.t = setTimeout(() => { const pos = [t.dataset.i, t.dataset.k, t.dataset.f]; render(); const el = tm.querySelector(`[data-i="${pos[0]}"][data-k="${pos[1]}"][data-f="${pos[2]}"]`); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; } }, 500);
  });
  tm.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rm) { const [i, k] = b.dataset.rm.split(':').map(Number); T.assets[i].splice(k, 1); render(); }
    if (b.dataset.addk) {
      const i = +b.dataset.addk;
      T.assets[i].push({ type: 'pick', year: +tm.querySelector(`[data-pky="${i}"]`).value, round: +tm.querySelector(`[data-pkr="${i}"]`).value, slot: tm.querySelector(`[data-pks="${i}"]`).value, from: T.team[i] });
      render();
    }
  });
}
async function init() {
  try {
    const [v, r, p] = await Promise.all([getJSON('data/value.json'), getJSON('data/rosters.json'), getJSON('data/prospects.json').catch(() => ({ fields: [], prospects: [] }))]);
    D.cur = v.current;
    const cs = v.seasons[String(v.current)] || {};
    const ref = v.seasons[String(v.current - 1)] || cs;
    D.progress = cs.progress ?? 1;
    D.perWin = ref.per_win * (cs.cap || ref.cap) / ref.cap;
    D.minNow = cs.min || ref.min;
    const gs = (v.goalie_seasons || {})[String(v.current)] || {}, gref = (v.goalie_seasons || {})[String(v.current - 1)] || gs;
    D.perWinG = gref.per_win ? gref.per_win * (gs.cap || gref.cap) / gref.cap : D.perWin;
    D.nextDraft = v.current + 1;
    D.proj = v.proj;
    D.rosters = r.teams;
    D.teams = Object.keys(r.teams).sort();
    const onRoster = new Set(Object.values(r.teams).flat().filter(x => x[4] !== 1).map(x => (x[1] || '').toLowerCase()));
    const MOVED = { ARI: 'UTA', PHX: 'UTA' };
    D.prospects = p.prospects.map(x => { const o = {}; p.fields.forEach((k, i) => { o[k] = x[i]; }); o.drafted_by = MOVED[o.drafted_by] || o.drafted_by; return o; })
      .filter(o => !onRoster.has((o.name || '').toLowerCase()));
    // off-roster players who are still prospects are offered as prospects (valued by draft slot) instead
    const prosNames = new Set(D.prospects.map(x => (x.name || '').toLowerCase()));
    for (const t of D.teams) D.rosters[t] = D.rosters[t].filter(x => !(x[4] === 1 && prosNames.has((x[1] || '').toLowerCase())));
    T.team = [D.teams.includes('DET') ? 'DET' : D.teams[0], D.teams.includes('BOS') ? 'BOS' : D.teams[1]];
    $('method').innerHTML = `<p><strong>Players:</strong> his projected wins above replacement for the rest of ${sLabel(D.cur)} (${Math.round((1 - D.progress) * 100)}% of the season left) plus each season left on his contract after this one (you enter it; 0 for a rental), adjusted for age. Until you enter it, only the rest of this season counts. The starting point blends his last three seasons. Dollar worth prices a skater win at about ${money(D.perWin)} and a goalie win at about ${money(D.perWinG)} this season (each from its share of the cap), scaled up with the projected cap in later years. Goalie projections are in wins per season at his own workload, and trust his record in proportion to the shots it rests on (one season as a starter keeps about a third of his edge over an average goalie, three seasons about 60%).</p>
      <p><strong>Team control (RFA):</strong> a player can't become an unrestricted free agent until he's ${UFA_AGE} (as of June 30 when his deal ends) or has ${UFA_ACC} accrued seasons, estimated here as seasons with 40+ NHL games (25+ for goalies). Until then his team keeps his rights. The "Team keeps his rights" box is checked for players who'd still be restricted free agents when their contract ends, and adds his projected seasons up to that point. You can uncheck it. Salary for those seasons isn't known, so they're assumed paid fair value: they add wins, not surplus.</p>
      <p><strong>Prospects with NHL games:</strong> from ${NHL_BLEND_MIN} NHL games, a prospect's own NHL projection (over the seasons his team controls) is blended with his draft-slot value, weighted by games (40 games = 40% his record, 75 = 75%). He also gets the years, cap hit and team-control boxes.</p>
      <p><strong>Team plans:</strong> each team can be set to No preference (every win counts the same, the default), Contending (this season and next count fully, then each later season 15% less than the one before), Bubble team (the same, but 7.5% less a season) or Rebuilding (this season counts half, next season 80%, later seasons fully). The value and surplus verdicts always use No preference; the other plans add a row showing each team's result on its own timeline.</p>
      <p><strong>Not on the active roster:</strong> players who played in the last two seasons, aren't on any team's active roster right now, but whose NHL player record still lists a team (sitting out, unsigned restricted free agents, long-term injury). They're listed with that team and marked.</p>
      <p><strong>Draft picks:</strong> expected value of a pick at that slot over a player's cost-controlled years (about ${f1(pickWins(1))} wins for 1st overall, ${f1(pickWins(16))} for 16th, ${f1(pickWins(32))} for 32nd, ${f1(pickWins(64))} for 64th), discounted ${Math.round((1 - FUTURE_DISCOUNT) * 100)}% for each year further out.</p>
      <p><strong>Prospects:</strong> drafted in the last five drafts, under 100 NHL games, and not on an NHL roster right now (players on a roster are listed as players). Same value as their draft slot, reduced ${Math.round((1 - PROSPECT_DECAY) * 100)}% for each full year since the draft. Listed under the team that drafted them, so a prospect who has since been traded shows under his old team.</p>
      <p><strong>Not modeled:</strong> cap space and roster limits, retained salary, no-trade clauses, team needs, and the value of picks to a rebuilding team versus a contender. Treat the verdict as a starting point for debate.</p>`;
    wire(); $('status').hidden = true; render();
  } catch (e) {
    console.error(e);
    $('status').textContent = 'Could not load trade data yet. It is built by the nightly update; check back after the next run.';
    $('status').classList.add('err');
  }
}
init();
