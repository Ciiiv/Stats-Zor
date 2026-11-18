'use strict';
/* Stats-Zor teams page: how a team used its players, game by game (data/teams/{y}.json from build_usage.py),
   plus the deployment fit from the skater page (profile() in app.js, loaded on this page without its init). */

const TEAM_NAMES = {
  ANA: 'Anaheim Ducks', ARI: 'Arizona Coyotes', PHX: 'Phoenix Coyotes', ATL: 'Atlanta Thrashers', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres',
  CAR: 'Carolina Hurricanes', CBJ: 'Columbus Blue Jackets', CGY: 'Calgary Flames', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche',
  DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings', 'L.A': 'Los Angeles Kings',
  MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NJD: 'New Jersey Devils', 'N.J': 'New Jersey Devils', NSH: 'Nashville Predators',
  NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins',
  SEA: 'Seattle Kraken', SJS: 'San Jose Sharks', 'S.J': 'San Jose Sharks', STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', 'T.B': 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WPG: 'Winnipeg Jets', WSH: 'Washington Capitals',
};
// the same franchise under another code, so changing seasons keeps the team picked
const FRANCHISE = { 'L.A': 'LAK', 'N.J': 'NJD', 'S.J': 'SJS', 'T.B': 'TBL', PHX: 'ARI', ATL: 'WPG', ARI: 'UTA' };
const sameFranchise = (a, b) => { const c = x => { let k = x, n = 0; while (FRANCHISE[k] && n++ < 3) k = FRANCHISE[k]; return k; }; return c(a) === c(b); };

const TP = { team: 'DET', y: null, win: 10, view: 'ev', span: 'all', idx: null };
const TEAMDATA = {}, COACHES = {};
async function loadCoaches(y) { if (COACHES[y] !== undefined) return COACHES[y]; try { COACHES[y] = await getJSON(`data/teams/coaches/${y}.json`); } catch (e) { COACHES[y] = null; } return COACHES[y]; }
// head coach of each game for this team, as runs: [{name, from, to}] (game indexes); null if unknown
function coachRuns(G, C) {
  if (!G || !C) return null;
  const names = G.games.map(g => { const c = C[g.game]; return c ? c[g.home ? 1 : 0] : undefined; });
  const known = names.filter(x => x).length;
  if (known < Math.min(5, G.games.length)) return null;
  const runs = [];
  names.forEach((nm, i) => { if (!nm) { if (runs.length) runs[runs.length - 1].to = i; return; } const r = runs[runs.length - 1]; if (r && r.name === nm) r.to = i; else runs.push({ name: nm, from: i, to: i }); });
  // drop one-game blips (an assistant behind the bench for a night) into the run around them
  const out = [];
  runs.forEach(r => { if (r.to - r.from < 2 && out.length) out[out.length - 1].to = r.to; else if (out.length && out[out.length - 1].name === r.name) out[out.length - 1].to = r.to; else out.push({ ...r }); });
  return { runs: out, complete: known === G.games.length };
}
async function loadTeams(y) { if (TEAMDATA[y] !== undefined) return TEAMDATA[y]; try { TEAMDATA[y] = await getJSON(`data/teams/${y}.json`); } catch (e) { TEAMDATA[y] = null; } return TEAMDATA[y]; }

const gdate = d => { if (!d || d.length < 8) return ''; const m = +d.slice(4, 6), day = +d.slice(6, 8); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${day}`; };
const tName = t => TEAM_NAMES[t] || t;
// one team's games as objects
function teamGames(TD, team) {
  const T = TD && TD.teams[team]; if (!T) return null;
  const f = TD.game_fields;
  const games = T.games.map((r, i) => { const o = { i }; f.forEach((k, j) => { o[k] = r[j]; }); return o; });
  return { games, slots: T.slots, pp: T.pp };
}
const sumShare = (gs, a, b) => { let x = 0, y = 0; gs.forEach(g => { x += g[a]; y += g[b]; }); return x + y > 0 ? 100 * x / (x + y) : null; };
// average slot over a run of characters ("1".."4", "." = not dressed)
function avgSlotOf(str) { let s = 0, n = 0; for (const c of str) if (c !== '.') { s += +c; n++; } return n ? { avg: s / n, n } : { avg: null, n: 0 }; }

function setHashT() { const h = `#t=${TP.team}&s=${TP.y}`; if (location.hash !== h) history.replaceState(null, '', h); }

// ------------------------------------------------------------------ team card
function coachLine(CR) {
  if (!CR) return `<p class="sub small" style="margin:6px 0 0">Head coach: not looked up yet for this season (added a few seasons a night).</p>`;
  const r = CR.runs;
  if (r.length === 1) return `<p class="sub small" style="margin:6px 0 0">Head coach: <strong>${esc(r[0].name)}</strong>${CR.complete ? '' : ' (some games still being looked up)'}</p>`;
  return `<p class="sub small" style="margin:6px 0 0">Head coaches: ${r.map(x => `<strong>${esc(x.name)}</strong> (games ${x.from + 1}–${x.to + 1})`).join(', then ')}. Usage below covers the whole season, both coaches together.</p>`;
}
function renderTCard(sd, TD, G, CR) {
  const c = teamColor(TP.team) || 'var(--line)';
  const el = $('sec-tcard');
  el.style.borderLeft = `5px solid ${c}`;
  if (!G) { el.innerHTML = `<h1 class="tname">${esc(tName(TP.team))}</h1><p class="empty">No game-by-game data for ${esc(TP.team)} in ${sLabel(TP.y)} yet. It's added by the nightly update.</p>`; return; }
  const gs = G.games, n = gs.length;
  const xp = sumShare(gs, 'xgf', 'xga'), gp = sumShare(gs, 'gf', 'ga');
  const all = Object.keys(TD.teams).map(t => ({ t, v: sumShare(teamGames(TD, t).games, 'xgf', 'xga') })).filter(r => nz(r.v)).sort((a, b) => b.v - a.v);
  const rk = all.findIndex(r => r.t === TP.team) + 1;
  const W = Math.min(TP.win, n), recent = gs.slice(n - W), rx = sumShare(recent, 'xgf', 'xga');
  const diff = nz(rx) && nz(xp) ? rx - xp : null;
  const used = Object.values(G.slots).filter(s => [...s].some(ch => ch !== '.')).length;
  const tile = (l, v, s, cls = '') => `<div class="ttile"><span class="lbl">${l}</span><b>${v}</b><small class="${cls}">${s}</small></div>`;
  el.innerHTML = `<div class="tcard-h"><h1 class="tname">${esc(tName(TP.team))}</h1>${teamBadge(TP.team)}<span class="sub" style="margin:0">${sLabel(TP.y)} · ${n} games</span></div>${coachLine(CR)}
    <div class="ttiles">
      ${tile('5v5 expected-goal share', f1(xp) + '%', rk ? `${ord(rk)} of ${all.length} teams` : '')}
      ${tile(`Last ${W} games`, f1(rx) + '%', nz(diff) ? `${diff >= 0 ? 'up' : 'down'} ${Math.abs(diff).toFixed(1)} on the season` : '', nz(diff) ? (diff >= 1 ? 'pos' : diff <= -1 ? 'neg' : '') : '')}
      ${tile('5v5 goal share', f1(gp) + '%', 'actual goals, more luck')}
      ${tile('Skaters used', used, 'dressed at least once')}
      <div class="ttile" id="tile-fit"><span class="lbl">Usage flags</span><b>…</b><small></small></div>
    </div>`;
}

// ------------------------------------------------------------------ season trend
function renderTrend(G, CR) {
  if (!G) { $('trend').innerHTML = ''; $('trend-sub').textContent = ''; return; }
  const gs = G.games, n = gs.length, N = TP.win;
  $('trend-sub').innerHTML = `The team's share of five-on-five expected goals over its last ${N} games, game by game. Above 50% means it created more good chances than it allowed. Goals (dotted) swing more with shooting and goaltending luck. The first ${N - 1} games are shaded: too few to read a trend. The dashed line is the season average.`;
  if (n < 2) { $('trend').innerHTML = '<p class="empty">Not enough games yet.</p>'; return; }
  const roll = (a, b) => gs.map((g, i) => i < N - 1 ? null : sumShare(gs.slice(i - N + 1, i + 1), a, b));
  const xr = roll('xgf', 'xga'), gr = roll('gf', 'ga');
  const season = sumShare(gs, 'xgf', 'xga');
  const W = 900, H = 260, m = { l: 44, r: 16, t: 14, b: 30 };
  const vals = xr.concat(gr, [50, season]).filter(nz);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max(1, (hi - lo) * 0.08); lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  const X = i => m.l + (n === 1 ? 0 : i / (n - 1)) * (W - m.l - m.r), Y = v => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
  const path = arr => { let d = '', on = false; arr.forEach((v, i) => { if (!nz(v)) { on = false; return; } d += `${on ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; on = true; }); return d; };
  const st = niceStep(hi - lo, 5);
  const yt = ticks(lo, hi, st).map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="axl">${v}%</text>`).join('');
  const gstep = n > 60 ? 10 : n > 25 ? 5 : n > 10 ? 2 : 1;
  const xt = gs.filter((g, i) => (i + 1) % gstep === 0 || i === 0).map(g => `<text x="${X(g.i)}" y="${H - 10}" text-anchor="middle" class="axl">${g.i + 1}</text>`).join('');
  const shade = N - 1 < n ? `<rect x="${m.l}" y="${m.t}" width="${Math.max(0, X(N - 1) - m.l)}" height="${H - m.t - m.b}" fill="var(--line)" opacity=".35"/>` : '';
  const hits = gs.map(g => { const x0 = X(g.i) - (W - m.l - m.r) / n / 2; return `<rect x="${x0.toFixed(1)}" y="${m.t}" width="${((W - m.l - m.r) / n).toFixed(1)}" height="${H - m.t - m.b}" fill="transparent"><title>Game ${g.i + 1} · ${gdate(g.date)} ${g.home ? 'vs' : 'at'} ${g.opp} · that night ${f1(share(g.xgf, g.xga))}% xG, goals ${g.gf}-${g.ga} at 5v5${nz(xr[g.i]) ? ` · last ${N}: ${f1(xr[g.i])}%` : ''}</title></rect>`; }).join('');
  const marks = CR && CR.runs.length > 1 ? CR.runs.slice(1).map(r => `<line x1="${X(r.from - 0.5)}" x2="${X(r.from - 0.5)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink)" stroke-dasharray="3 3" opacity=".6"/><text x="${X(r.from - 0.5) + 4}" y="${m.t + 12}" class="axl" style="fill:var(--ink)">New coach: ${esc(r.name)}</text>`).join('') : '';
  $('trend').innerHTML = `<div class="scroll"><svg class="tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rolling ${N}-game five-on-five expected goal share">
    ${shade}${yt}
    <line x1="${m.l}" x2="${W - m.r}" y1="${Y(50)}" y2="${Y(50)}" stroke="var(--muted)" stroke-width="1"/>
    ${nz(season) ? `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(season)}" y2="${Y(season)}" stroke="var(--c1)" stroke-dasharray="5 4" opacity=".7"/>` : ''}
    <path d="${path(gr)}" fill="none" stroke="var(--c2)" stroke-width="1.5" stroke-dasharray="2 3"/>
    <path d="${path(xr)}" fill="none" stroke="var(--c1)" stroke-width="2.5"/>
    ${xt}${marks}${hits}</svg></div>
    <p class="tkey"><span><i style="background:var(--c1)"></i>Expected goals, last ${N}</span><span><i class="dot2" style="border-color:var(--c2)"></i>Actual goals, last ${N}</span><span><i class="dash" style="border-color:var(--c1)"></i>Season average ${f1(season)}%</span><span class="lab">x-axis: game number</span></p>`;
}

// ------------------------------------------------------------------ lineup strip
function stripRows(G, sd) {
  const rows = [];
  for (const [id, s] of Object.entries(G.slots)) {
    const p = sd && sd.byId.get(+id); const pos = p ? p.pos : '';
    const grp = p ? p.grp : null;
    const a = avgSlotOf(s); if (!a.n) continue;
    rows.push({ id: +id, name: p ? p.name : `#${id}`, pos, grp: grp || 'F', s, pp: G.pp[id] || '.'.repeat(s.length), avg: a.avg, n: a.n });
  }
  rows.sort((a, b) => (a.grp === b.grp ? 0 : a.grp === 'F' ? -1 : 1) || a.avg - b.avg || b.n - a.n);
  return rows;
}
const SLOT_OP = [1, 0.68, 0.42, 0.22];
function renderStrip(G, sd) {
  if (!G) { $('strip').innerHTML = ''; $('strip-sub').textContent = ''; return; }
  const n = G.games.length;
  const start = TP.span === 'all' ? 0 : Math.max(0, n - (+TP.span));
  const gs = G.games.slice(start);
  const rows = stripRows(G, sd);
  const isPP = TP.view === 'pp';
  $('strip-sub').innerHTML = isPP
    ? `Each square is one game. Darker = first power-play unit, lighter = second, gray = dressed but not on a unit, blank = not in the lineup. Units are set by that night's 5-on-4 ice time.`
    : `Each square is one game, placed by that night's five-on-five ice time: forwards by line (blue, darker = higher), defensemen by pair (green). Blank = not in the lineup. A penalty-filled night or a blowout can shuffle one game, so read the pattern, not a single square.`;
  const cw = 10, rh = 16, nameW = 150, top = 22;
  const W = nameW + gs.length * cw + 4, H = top + rows.length * rh + 6;
  const fCol = 'var(--c1)', dCol = 'var(--c3)', ppCol = 'var(--c5)';
  let body = '';
  let prevGrp = null, y = top;
  rows.forEach(r => {
    if (prevGrp && r.grp !== prevGrp) y += 6;
    prevGrp = r.grp;
    body += `<a href="./#a=${r.id}&s=${TP.y}"><text x="${nameW - 8}" y="${y + 12}" text-anchor="end" class="sname">${esc(last(r.name))}<title>${esc(r.name)} · ${r.n} games · usual ${slotName(r.grp, r.avg)} (${r.avg.toFixed(1)})</title></text></a>`;
    for (let j = 0; j < gs.length; j++) {
      const k = start + j, ch = r.s[k], g = gs[j];
      const x = nameW + j * cw;
      let fill = null, op = 1, lab;
      if (isPP) {
        const u = r.pp[k];
        if (ch === '.') { lab = 'not in the lineup'; }
        else if (u === '1' || u === '2') { fill = ppCol; op = u === '1' ? 1 : 0.45; lab = `PP${u}`; }
        else { fill = 'var(--line)'; op = 0.9; lab = 'no PP unit'; }
      } else if (ch !== '.') { fill = r.grp === 'D' ? dCol : fCol; op = SLOT_OP[+ch - 1]; lab = SLOT[r.grp][+ch - 1]; }
      else lab = 'not in the lineup';
      if (fill) body += `<rect x="${x}" y="${y + 1}" width="${cw - 1.5}" height="${rh - 3}" rx="1.5" fill="${fill}" fill-opacity="${op}"><title>${esc(r.name)} · game ${k + 1}, ${gdate(g.date)} ${g.home ? 'vs' : 'at'} ${g.opp} · ${lab}</title></rect>`;
      else body += `<rect x="${x + 3}" y="${y + rh / 2 - 1}" width="${cw - 7.5}" height="1.5" fill="var(--line)"><title>${esc(r.name)} · game ${k + 1}, ${gdate(g.date)} · ${lab}</title></rect>`;
    }
    y += rh;
  });
  let axis = '';
  gs.forEach((g, j) => { const k = start + j; if ((k + 1) % 10 === 0 || j === 0) axis += `<text x="${nameW + j * cw + cw / 2}" y="${top - 8}" text-anchor="middle" class="axl">${k + 1}</text>`; if ((k + 1) % 10 === 0) axis += `<line x1="${nameW + (j + 1) * cw - 0.75}" x2="${nameW + (j + 1) * cw - 0.75}" y1="${top - 4}" y2="${y}" stroke="var(--line)"/>`; });
  const key = isPP
    ? `<span><i style="background:var(--c5)"></i>PP1</span><span><i style="background:var(--c5);opacity:.45"></i>PP2</span><span><i style="background:var(--line)"></i>No unit</span>`
    : [0, 1, 2, 3].map(i => `<span><i style="background:var(--c1);opacity:${SLOT_OP[i]}"></i>${SLOT.F[i]}</span>`).join('') + [0, 1, 2].map(i => `<span><i style="background:var(--c3);opacity:${SLOT_OP[i]}"></i>${SLOT.D[i]}</span>`).join('');
  $('strip').innerHTML = rows.length ? `<div class="scroll stripwrap"><svg class="strip" width="${W}" height="${y + 6}" viewBox="0 0 ${W} ${y + 6}" role="img" aria-label="Lineup slot for each player in each game">${axis}${body}</svg></div><p class="tkey">${key}<span class="lab">numbers on top: game number</span></p>` : '<p class="empty">No lineup data.</p>';
  void H;
}

// ------------------------------------------------------------------ deployment (fit from the skater page)
async function renderDeploy(G, sd) {
  if (!G || !sd) { $('deploy').innerHTML = ''; return; }
  const y = TP.y;
  const U = await loadUsage(y);
  await Promise.all([y - 1, y - 2].filter(z => S.idx.mp_seasons.includes(z)).map(z => loadSeason(z).catch(() => null)).concat([loadValue().catch(() => null)]));
  if (y !== TP.y) return;
  const n = G.games.length, N = Math.min(TP.win, n);
  const minG = Math.max(5, Math.round(0.25 * n));
  $('deploy-sub').innerHTML = `Regulars with ${minG}+ games for ${esc(TP.team)}. <strong>Used as</strong> is his average slot with this team; <strong>Last ${N}</strong> is the same over the team's last ${N} games (arrows mark a move up or down, a description of his recent role only: it never changes his value or fit). The fit columns are the same as the team card on the skater page: what his 5v5 results and his overall value say he could handle, over up to three seasons, most recent counting most.`;
  if (!U) { $('deploy').innerHTML = `<p class="empty">Deployment data for ${sLabel(y)} hasn't been built yet.</p>`; setFitTile(null); return; }
  const rows = stripRows(G, sd).filter(r => r.n >= minG).map(r => {
    const P = profile(U, sd, r.id);
    const rec = avgSlotOf(r.s.slice(n - N));
    return P ? { r, P, rec } : null;
  }).filter(Boolean);
  const mv = (r, rec) => { if (!nz(rec.avg) || rec.n < 3) return ''; const d = rec.avg - r.avg; return d <= -0.75 ? '<span class="pos" title="Moved up lately">↑</span>' : d >= 0.75 ? '<span class="neg" title="Moved down lately">↓</span>' : ''; };
  const tbl = grp => {
    const rs = rows.filter(x => x.r.grp === grp);
    if (!rs.length) return '';
    return `<p class="minihead" style="margin-top:12px">${grp === 'F' ? 'Forwards' : 'Defensemen'}</p><div class="scroll"><table class="tbl"><thead><tr><th>Player</th><th>GP</th><th>Used as</th><th>Last ${N}</th><th>5v5 fit (3 yr)</th><th>Overall fit</th><th>Vs. role</th><th>Even strength</th><th>PP use</th><th>PK use</th></tr></thead><tbody>` +
      rs.map(({ r, P, rec }) => `<tr><td><a href="./#a=${r.id}&s=${y}">${esc(r.name)}</a> <span class="lab">${esc(r.pos)}</span></td><td>${r.n}</td>
        <td style="white-space:nowrap">${slotName(grp, r.avg)} <span class="lab">${r.avg.toFixed(1)}</span></td>
        <td style="white-space:nowrap">${rec.n >= 3 ? `${slotName(grp, rec.avg)} <span class="lab">${rec.avg.toFixed(1)}</span> ${mv(r, rec)}` : `<span class="lab">${rec.n ? 'few games' : 'out'}</span>`}</td>
        <td style="white-space:nowrap">${P.enough ? slotName(grp, P.eq) + ` <span class="lab">${P.eq.toFixed(1)}</span>` : '—'}</td>
        <td style="white-space:nowrap">${nz(P.eqAll) ? slotName(grp, P.eqAll) + ` <span class="lab">${P.eqAll.toFixed(1)}</span>` : '—'}</td>
        <td class="${P.enough ? dcls(P.vsRole) : ''}">${P.enough ? s1(P.vsRole) : '—'}</td><td>${flag(P.allFit)}</td><td style="white-space:nowrap">${P.ppL}</td><td style="white-space:nowrap">${P.pkL}</td></tr>`).join('') + '</tbody></table></div>';
  };
  $('deploy').innerHTML = rows.length ? tbl('F') + tbl('D') + `<p class="sub small">A player traded mid-season: his slots and games here are with ${esc(TP.team)} only, while the fit columns use his whole season. The fit compares usage with results; it is evidence, not a verdict on the coach (injuries, matchups and linemates all play a part).</p>` : '<p class="empty">No regulars yet.</p>';
  setFitTile(rows);
}
function setFitTile(rows) {
  const el = $('tile-fit'); if (!el) return;
  if (!rows) { el.querySelector('b').textContent = '—'; return; }
  const up = rows.filter(x => x.P.allFit[0] === 'up').length, down = rows.filter(x => x.P.allFit[0] === 'down').length;
  el.querySelector('b').textContent = `${rows.length - up - down} of ${rows.length}`;
  el.querySelector('small').innerHTML = `used about right · <span class="pos">${up} could do more</span> · <span class="neg">${down} above value</span>`;
}

// ------------------------------------------------------------------ page
async function renderTeams() {
  const y = TP.y;
  const [sd, TD, C] = await Promise.all([loadSeason(y).catch(() => null), loadTeams(y), loadCoaches(y)]);
  if (y !== TP.y) return;
  const teams = TD ? Object.keys(TD.teams).sort() : (sd ? sd.teams : []);
  if (!teams.includes(TP.team)) TP.team = teams.find(t => sameFranchise(t, TP.team)) || teams[0];
  $('tTeam').innerHTML = teams.map(t => `<option value="${t}"${t === TP.team ? ' selected' : ''}>${esc(tName(t))}</option>`).join('');
  setHashT();
  document.title = `${tName(TP.team)} ${sLabel(y)} · Stats-Zor`;
  const G = TD ? teamGames(TD, TP.team) : null;
  const CR = coachRuns(G, C);
  safe('sec-tcard', () => renderTCard(sd, TD, G, CR));
  if (!TD) $('sec-tcard').insertAdjacentHTML('beforeend', `<p class="empty">Game-by-game team data for ${sLabel(y)} hasn't been built yet. It's added by the nightly update.</p>`);
  safe('sec-trend', () => renderTrend(G, CR));
  safe('sec-strip', () => renderStrip(G, sd));
  try { await renderDeploy(G, sd); } catch (e) { console.error(e); $('deploy').innerHTML = `<p class="empty">This section hit an error: ${esc(e.message)}</p>`; }
}

async function initTeams() {
  try {
    const idx = await getJSON('data/index.json');
    const f = idx.fields;
    idx.list = idx.players.map(r => { const o = {}; f.forEach((k, i) => { o[k] = r[i]; }); o.mask = o.mp_mask; return o; });
    S.idx = idx; idx.list.forEach(p => S.byId.set(p.id, p));
    $('updated').textContent = `Data updated ${idx.updated.replace('T', ' ').replace('Z', ' UTC')}.`;
    const h = readHash();
    const seasons = idx.mp_seasons.slice().reverse();
    TP.y = seasons.includes(+h.s) ? +h.s : seasons[0];
    if (!h.s) { const cur = await loadSeason(TP.y).catch(() => null); if (cur && cur.gpmax < 41 && seasons.includes(TP.y - 1)) TP.y -= 1; }
    if (h.t) TP.team = decodeURIComponent(h.t);
    if (window.matchMedia('(max-width: 700px)').matches) { TP.span = '20'; $('tSpan').value = '20'; }
    $('tSeason').innerHTML = seasons.map(s => `<option value="${s}"${s === TP.y ? ' selected' : ''}>${sLabel(s)}</option>`).join('');
    $('tTeam').addEventListener('change', e => { TP.team = e.target.value; renderTeams(); });
    $('tSeason').addEventListener('change', e => { TP.y = +e.target.value; renderTeams(); });
    $('tWin').addEventListener('change', e => { TP.win = +e.target.value; renderTeams(); });
    $('tView').addEventListener('change', e => { TP.view = e.target.value; const TD = TEAMDATA[TP.y]; safe('sec-strip', () => renderStrip(TD && teamGames(TD, TP.team), S.seasons[TP.y])); });
    $('tSpan').addEventListener('change', e => { TP.span = e.target.value; const TD = TEAMDATA[TP.y]; safe('sec-strip', () => renderStrip(TD && teamGames(TD, TP.team), S.seasons[TP.y])); });
    window.addEventListener('hashchange', () => { const q = readHash(); let ch = false; if (q.t && q.t !== TP.team) { TP.team = q.t; ch = true; } if (+q.s && +q.s !== TP.y && seasons.includes(+q.s)) { TP.y = +q.s; $('tSeason').value = TP.y; ch = true; } if (ch) renderTeams(); });
    $('status').hidden = true;
    await renderTeams();
  } catch (e) {
    console.error(e);
    $('status').textContent = 'Could not load the data files.';
    $('status').classList.add('err');
  }
}
initTeams();
