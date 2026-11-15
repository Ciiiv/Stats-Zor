'use strict';
/* Stats-Zor trade machine. Runs in the browser from data/value.json, rosters.json, prospects.json. */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nz = v => v !== null && v !== undefined && !Number.isNaN(v);
const money = v => nz(v) ? (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2) + 'M' : '—';
const f1 = v => nz(v) ? v.toFixed(1) : '—';
const getJSON = async u => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u); return r.json(); };
const sLabel = y => `${y}-${String(y + 1).slice(2)}`;

// Expected wins over a pick's cost-controlled years, by overall pick number.
const pickWins = n => 6 * Math.exp(-0.045 * (n - 1)) + 0.15;
const SLOTS = { early: 4, mid: 16, late: 28 };
const FUTURE_DISCOUNT = 0.9;   // per year a pick is further away
const PROSPECT_DECAY = 0.85;   // per year since a prospect was drafted without becoming a regular

const D = { cur: null, nextDraft: null, perWin: null, progress: 1, proj: {}, rows: new Map(), rosters: {}, prospects: [], teams: [] };
const T = { team: [null, null], assets: [[], []] };

function playerValue(a) {
  const P = D.proj[a.id];
  const base = P ? P.base_war82 : 0;
  const frac = Math.max(0, 1 - D.progress);
  const n = Math.max(1, a.years || 1);
  const fut = P ? P.years.slice(0, n - 1) : [];
  const wins = base * frac + fut.reduce((s, r) => s + r[2], 0);
  const worthNow = D.minNow + Math.max(0, base) * (P && P.g ? D.perWinG : D.perWin);
  const worth = worthNow * frac + fut.reduce((s, r) => s + r[3], 0);
  const cost = nz(a.cap) ? a.cap * (frac + (n - 1)) : null;
  return { wins, worth, cost, surplus: nz(cost) ? worth - cost : null, base, hasProj: !!P };
}
function pickValue(a) {
  const overall = SLOTS[a.slot] + (a.round - 1) * 32;
  const wins = pickWins(overall) * Math.pow(FUTURE_DISCOUNT, a.year - D.nextDraft);
  return { wins, worth: wins * D.perWin, cost: 0, surplus: wins * D.perWin, overall };
}
function prospectValue(a) {
  const wins = pickWins(a.overall) * Math.pow(PROSPECT_DECAY, Math.max(0, D.nextDraft - 1 - a.draft_year));
  return { wins, worth: wins * D.perWin, cost: 0, surplus: wins * D.perWin };
}
const valueOf = a => a.type === 'player' ? playerValue(a) : a.type === 'pick' ? pickValue(a) : prospectValue(a);

function sideHTML(i) {
  const team = T.team[i]; const cls = i ? 'b' : '';
  const roster = (D.rosters[team] || []).map(r => ({ id: r[0], name: r[1], pos: r[2], base: D.proj[r[0]] ? D.proj[r[0]].base_war82 : null }))
    .filter(r => !T.assets[i].some(a => a.type === 'player' && a.id === r.id)).sort((a, b) => (b.base ?? -9) - (a.base ?? -9));
  const pros = D.prospects.filter(p => p.drafted_by === team && !T.assets[i].some(a => a.type === 'prospect' && a.name === p.name)).sort((a, b) => a.overall - b.overall);
  const years = [0, 1, 2].map(k => D.nextDraft + k);
  const assets = T.assets[i].map((a, k) => {
    const v = valueOf(a);
    let nm = '', det = '';
    if (a.type === 'player') {
      nm = `${esc(a.name)}<small>${a.pos} · ${v.hasProj ? f1(v.base) + ' wins/82' : 'no recent NHL data'}</small>`;
      det = `<label>Years left incl. this one <input type="number" min="1" max="8" step="1" value="${a.years}" data-i="${i}" data-k="${k}" data-f="years"></label>
        <label>Cap hit $M <input type="number" min="0" step="0.05" placeholder="optional" value="${nz(a.cap) ? a.cap : ''}" data-i="${i}" data-k="${k}" data-f="cap"></label>
        <span>Worth ${money(v.worth)}${nz(v.cost) ? ` · paid ${money(v.cost)} · surplus <b class="${v.surplus >= 0 ? 'pos' : 'neg'}">${money(v.surplus)}</b>` : ''}</span>`;
    } else if (a.type === 'pick') {
      nm = `${a.year} ${['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'][a.round - 1]}-round pick<small>${esc(a.from)} · projected ${a.slot} (around #${v.overall})</small>`;
      det = `<span>Expected value from a pick at that slot${a.year > D.nextDraft ? `, discounted ${a.year - D.nextDraft} year${a.year - D.nextDraft > 1 ? 's' : ''} out` : ''}</span>`;
    } else {
      nm = `${esc(a.name)}<small>${a.pos} prospect · #${a.overall} in ${a.draft_year} by ${esc(a.drafted_by)}${a.nhl_gp ? ` · ${a.nhl_gp} NHL GP` : ''}</small>`;
      det = `<span>Value from his draft slot, reduced for each year since the draft he hasn't stuck in the NHL</span>`;
    }
    return `<div class="asset"><div class="nm">${nm}</div><div style="display:flex;gap:10px;align-items:center"><span class="val">${f1(v.wins)} W</span><button type="button" data-rm="${i}:${k}" aria-label="Remove">×</button></div><div class="det">${det}</div></div>`;
  }).join('');
  return `<div class="side ${cls}"><h2><span>${i ? 'Team B' : 'Team A'}</span><select data-team="${i}" aria-label="${i ? 'Team B' : 'Team A'}">${D.teams.map(t => `<option${t === team ? ' selected' : ''}>${t}</option>`).join('')}</select><span style="font-size:16px;color:var(--muted)">sends</span></h2>
    <div class="adders">
      <div class="row"><select data-addp="${i}" aria-label="Add a player"><option value="">+ Add a player</option>${roster.map(r => `<option value="${r.id}">${esc(r.name)} · ${r.pos}${nz(r.base) ? ' · ' + f1(r.base) + ' W/82' : ''}</option>`).join('')}</select></div>
      <div class="row"><select data-addq="${i}" aria-label="Add a prospect"><option value="">+ Add a prospect (${pros.length})</option>${pros.map(p => `<option value="${esc(p.name)}">${esc(p.name)} · ${p.pos} · #${p.overall} in ${p.draft_year}</option>`).join('')}</select></div>
      <div class="row"><select data-pky="${i}" aria-label="Pick year">${years.map(y => `<option>${y}</option>`).join('')}</select>
        <select data-pkr="${i}" aria-label="Round">${[1, 2, 3, 4, 5, 6, 7].map(r => `<option value="${r}">Round ${r}</option>`).join('')}</select>
        <select data-pks="${i}" aria-label="Projected slot"><option value="early">Early (top 8)</option><option value="mid" selected>Middle</option><option value="late">Late (playoff team)</option></select>
        <button type="button" data-addk="${i}">+ Add pick</button></div>
    </div>
    ${assets || `<p class="empty-side">Nothing added yet.</p>`}</div>`;
}
function summary() {
  const tot = T.assets.map(list => list.map(valueOf));
  const sum = (l, k) => l.reduce((s, v) => s + (v[k] || 0), 0);
  const players = T.assets.flat().filter(a => a.type === 'player');
  const salaryMode = players.length > 0 && players.every(a => nz(a.cap));
  const key = salaryMode ? 'surplus' : 'wins';
  const sent = tot.map(l => sum(l, key));
  // Team A receives what B sends
  const getA = sent[1], getB = sent[0];
  const unit = salaryMode ? money : (v => f1(v) + ' wins');
  const diff = getA - getB;
  const total = Math.abs(getA) + Math.abs(getB) || 1;
  const close = Math.abs(diff) < (salaryMode ? 1.5 : 0.4) || Math.abs(diff) / total < 0.08;
  const verdict = !T.assets[0].length && !T.assets[1].length ? 'Add assets to both sides to see who wins.'
    : close ? 'About even' : `${diff > 0 ? T.team[0] : T.team[1]} wins this trade`;
  const capA = sum(tot[1], 'cost') - sum(tot[0], 'cost');
  const capNote = salaryMode ? `<p class="sub small">Cap change for the rest of the deals: ${T.team[0]} ${capA >= 0 ? 'takes on' : 'sheds'} ${money(Math.abs(capA))} in total salary; ${T.team[1]} the opposite. Cap space and roster limits aren't checked.</p>`
    : players.length ? `<p class="sub small">Enter every player's cap hit to switch the verdict to surplus value (worth minus salary). Right now it compares on-ice value only, so an overpaid player still counts as a plus.</p>` : '';
  const wA = Math.max(0, getA) / (Math.max(0, getA) + Math.max(0, getB) || 1) * 100;
  $('summary').innerHTML = `<div class="head"><h2>${esc(verdict)}</h2><p class="sub">Compared on ${salaryMode ? 'surplus value: projected worth minus salary over each contract' : 'projected wins above replacement over the years each asset is controlled'}.</p></div>
    <div class="meter"><i style="width:${wA}%;background:var(--a)">${wA > 12 ? T.team[0] + ' gets ' + unit(getA) : ''}</i><i style="width:${100 - wA}%;background:var(--b)">${100 - wA > 12 ? T.team[1] + ' gets ' + unit(getB) : ''}</i></div>
    <div class="sumgrid"><div class="v a"><b>${T.team[0]}</b><p>Gets ${unit(getA)}, gives ${unit(getB)}: net <strong class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${unit(Math.abs(diff))}</strong></p></div>
    <div class="v b"><b>${T.team[1]}</b><p>Gets ${unit(getB)}, gives ${unit(getA)}: net <strong class="${-diff >= 0 ? 'pos' : 'neg'}">${-diff >= 0 ? '+' : '−'}${unit(Math.abs(diff))}</strong></p></div></div>${capNote}`;
}
function render() {
  $('tm').innerHTML = sideHTML(0) + sideHTML(1);
  summary();
}
function wire() {
  const tm = $('tm');
  tm.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.team) { const i = +t.dataset.team; T.team[i] = t.value; T.assets[i] = []; render(); return; }
    if (t.dataset.addp) { const i = +t.dataset.addp; const r = (D.rosters[T.team[i]] || []).find(x => String(x[0]) === t.value); if (r) T.assets[i].push({ type: 'player', id: r[0], name: r[1], pos: r[2], years: 2, cap: null }); render(); return; }
    if (t.dataset.addq) { const i = +t.dataset.addq; const p = D.prospects.find(x => x.name === t.value && x.drafted_by === T.team[i]); if (p) T.assets[i].push({ type: 'prospect', ...p }); render(); return; }
  });
  tm.addEventListener('input', e => {
    const t = e.target; if (!t.dataset.f) return;
    const a = T.assets[+t.dataset.i][+t.dataset.k];
    if (t.dataset.f === 'years') a.years = Math.max(1, Math.min(8, Math.round(+t.value || 1)));
    if (t.dataset.f === 'cap') a.cap = t.value === '' ? null : +t.value;
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
    const onRoster = new Set(Object.values(r.teams).flat().map(x => (x[1] || '').toLowerCase()));
    const MOVED = { ARI: 'UTA', PHX: 'UTA' };
    D.prospects = p.prospects.map(x => { const o = {}; p.fields.forEach((k, i) => { o[k] = x[i]; }); o.drafted_by = MOVED[o.drafted_by] || o.drafted_by; return o; })
      .filter(o => !onRoster.has((o.name || '').toLowerCase()));
    T.team = [D.teams.includes('DET') ? 'DET' : D.teams[0], D.teams.includes('BOS') ? 'BOS' : D.teams[1]];
    $('method').innerHTML = `<p><strong>Players:</strong> his projected wins above replacement for the rest of ${sLabel(D.cur)} (${Math.round((1 - D.progress) * 100)}% of the season left) plus each future season you count, adjusted for age. The starting point blends his last three seasons. Dollar worth prices a skater win at about ${money(D.perWin)} and a goalie win at about ${money(D.perWinG)} this season (each from its share of the cap), scaled up with the projected cap in later years. Goalie projections are pulled 30% toward an average goalie, since goalie seasons swing so much.</p>
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
