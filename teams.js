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

const TP = { team: 'DET', y: null, win: 10, view: 'ev', span: 'all', idx: null, caps: {} };  // caps: cap hits typed on this page only, never saved
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
function renderTrend(G, CR, prev) {
  if (!G) { $('trend').innerHTML = ''; $('trend-sub').textContent = ''; return; }
  const gs = G.games, n = gs.length, N = TP.win;
  // until the window is full, borrow the end of last season (same franchise); with no last season, use the season so far
  const carry = prev && prev.length ? prev.slice(-(N - 1)) : [];
  const early = carry.length ? `Until game ${N}, the window reaches back into the end of last season (lighter line, shaded), so the early points mix both seasons; rosters change over the summer, so read them loosely.` : `Until game ${N} there aren't ${N} games yet, so the lighter line in the shaded area is the season so far, which swings a lot on so few games.`;
  $('trend-sub').innerHTML = `The team's share of five-on-five expected goals over its last ${N} games, game by game. Above 50% means it created more good chances than it allowed. Goals (dotted) swing more with shooting and goaltending luck. ${early} The dashed line is the season average.`;
  if (n < 2) { $('trend').innerHTML = '<p class="empty">Not enough games yet.</p>'; return; }
  const win = i => i >= N - 1 ? gs.slice(i - N + 1, i + 1) : carry.slice(carry.length - Math.min(carry.length, N - 1 - i)).concat(gs.slice(0, i + 1));
  const roll = (a, b) => gs.map((g, i) => { const w = win(i); return !carry.length && i < 2 ? null : sumShare(w, a, b); });
  const xr = roll('xgf', 'xga'), gr = roll('gf', 'ga');
  const part = (arr, early) => arr.map((v, i) => (early ? i <= N - 1 : i >= N - 1) ? v : null);
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
  const shade = N - 1 < n ? `<rect x="${m.l}" y="${m.t}" width="${Math.max(0, X(N - 1) - m.l)}" height="${H - m.t - m.b}" fill="var(--line)" opacity=".25"/><text x="${m.l + 6}" y="${H - m.b - 6}" class="axl">${carry.length ? 'includes end of last season' : 'season so far'}</text>` : '';
  const hits = gs.map(g => { const x0 = X(g.i) - (W - m.l - m.r) / n / 2; const lbl = g.i < N - 1 ? (carry.length ? `last ${N} incl. end of last season` : `season so far`) : `last ${N}`; return `<rect x="${x0.toFixed(1)}" y="${m.t}" width="${((W - m.l - m.r) / n).toFixed(1)}" height="${H - m.t - m.b}" fill="transparent"><title>Game ${g.i + 1} · ${gdate(g.date)} ${g.home ? 'vs' : 'at'} ${g.opp} · that night ${f1(share(g.xgf, g.xga))}% xG, goals ${g.gf}-${g.ga} at 5v5${nz(xr[g.i]) ? ` · ${lbl}: ${f1(xr[g.i])}%` : ''}</title></rect>`; }).join('');
  const marks = CR && CR.runs.length > 1 ? CR.runs.slice(1).map(r => `<line x1="${X(r.from - 0.5)}" x2="${X(r.from - 0.5)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink)" stroke-dasharray="3 3" opacity=".6"/><text x="${X(r.from - 0.5) + 4}" y="${m.t + 12}" class="axl" style="fill:var(--ink)">New coach: ${esc(r.name)}</text>`).join('') : '';
  $('trend').innerHTML = `<div class="scroll"><svg class="tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rolling ${N}-game five-on-five expected goal share">
    ${shade}${yt}
    <line x1="${m.l}" x2="${W - m.r}" y1="${Y(50)}" y2="${Y(50)}" stroke="var(--muted)" stroke-width="1"/>
    ${nz(season) ? `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(season)}" y2="${Y(season)}" stroke="var(--c1)" stroke-dasharray="5 4" opacity=".7"/>` : ''}
    <path d="${path(part(gr, true))}" fill="none" stroke="var(--c2)" stroke-width="1.25" stroke-dasharray="2 3" opacity=".5"/>
    <path d="${path(part(xr, true))}" fill="none" stroke="var(--c1)" stroke-width="2" opacity=".45"/>
    <path d="${path(part(gr, false))}" fill="none" stroke="var(--c2)" stroke-width="1.5" stroke-dasharray="2 3"/>
    <path d="${path(part(xr, false))}" fill="none" stroke="var(--c1)" stroke-width="2.5"/>
    ${xt}${marks}${hits}</svg></div>
    <p class="tkey"><span><i style="background:var(--c1)"></i>Expected goals, last ${N}</span><span><i class="dot2" style="border-color:var(--c2)"></i>Actual goals, last ${N}</span><span><i style="background:var(--c1);opacity:.45"></i>${carry.length ? 'Lighter: window includes last season' : 'Lighter: season so far'}</span><span><i class="dash" style="border-color:var(--c1)"></i>Season average ${f1(season)}%</span><span class="lab">x-axis: game number</span></p>`;
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
// regulars and their fit for one team-season (shared by the table and the history's "used well" button)
async function deployData(G, sd, y, N) {
  const U = await loadUsage(y);
  await Promise.all([y - 1, y - 2].filter(z => S.idx.mp_seasons.includes(z)).map(z => loadSeason(z).catch(() => null)).concat([loadValue().catch(() => null)]));
  if (!U) return null;
  const n = G.games.length, minG = Math.max(5, Math.round(0.25 * n));
  return stripRows(G, sd).filter(r => r.n >= minG).map(r => {
    const P = profile(U, sd, r.id);
    const rec = avgSlotOf(r.s.slice(n - N));
    return P ? { r, P, rec } : null;
  }).filter(Boolean);
}
const fitCounts = rows => { const up = rows.filter(x => x.P.allFit[0] === 'up').length, down = rows.filter(x => x.P.allFit[0] === 'down').length; return { ok: rows.length - up - down, up, down, n: rows.length }; };
async function renderDeploy(G, sd) {
  if (!G || !sd) { $('deploy').innerHTML = ''; return; }
  const y = TP.y;
  const n = G.games.length, N = Math.min(TP.win, n);
  const minG = Math.max(5, Math.round(0.25 * n));
  const rows0 = await deployData(G, sd, y, N);
  if (y !== TP.y) return;
  $('deploy-sub').innerHTML = `Regulars with ${minG}+ games for ${esc(TP.team)}. <strong>Used as</strong> is his average slot with this team; <strong>Last ${N}</strong> is the same over the team's last ${N} games (arrows mark a move up or down, a description of his recent role only: it never changes his value or fit). The fit columns are the same as the team card on the skater page: what his 5v5 results and his overall value say he could handle, over up to three seasons, most recent counting most.`;
  if (!rows0) { $('deploy').innerHTML = `<p class="empty">Deployment data for ${sLabel(y)} hasn't been built yet.</p>`; setFitTile(null); return; }
  const rows = rows0;
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
  const { up, down } = fitCounts(rows);
  el.querySelector('b').textContent = `${rows.length - up - down} of ${rows.length}`;
  el.querySelector('small').innerHTML = `used about right · <span class="pos">${up} could do more</span> · <span class="neg">${down} above value</span>`;
}

// ------------------------------------------------------------------ Phase 2: roster value by age
let BIOS = null;
async function loadBios() {
  if (BIOS) return BIOS;
  const [c, g] = await Promise.all([getJSON('data/careers.json').catch(() => null), getJSON('data/goalies/careers.json').catch(() => null)]);
  BIOS = new Map();
  [c, g].forEach(j => { if (j && j.players) for (const [k, v] of Object.entries(j.players)) BIOS.set(+k, { name: v[0], pos: v[1], birth: v[3] }); });
  return BIOS;
}
const GGAMES = {};
async function loadGoalieGames(y) { if (GGAMES[y] !== undefined) return GGAMES[y]; try { GGAMES[y] = await getJSON(`data/goalies/games/${y}.json`); } catch (e) { GGAMES[y] = null; } return GGAMES[y]; }
// every goalie's appearances for one team: {id: [row objects]}
function goalieRowsFor(GG, team) {
  const out = {}; if (!GG) return out;
  const f = GG.fields;
  for (const [id, rows] of Object.entries(GG.players)) for (const r of rows) {
    if (r[f.indexOf('team')] !== team) continue;
    const o = {}; f.forEach((k, i) => { o[k] = r[i]; }); (out[id] = out[id] || []).push(o);
  }
  return out;
}
// wins above replacement for one team, each player's season split by his games with this team
function teamWins(TD, GG, team, y) {
  const V = VAL && VAL.seasons[y]; if (!V) return null;
  const G = teamGames(TD, team); if (!G) return null;
  const items = [];
  for (const [id, s] of Object.entries(G.slots)) {
    const r = V.map.get(+id); const n = [...s].filter(c => c !== '.').length;
    if (!r || !n) continue;
    const sh = Math.min(1, n / Math.max(1, r.gp));
    items.push({ id: +id, grp: grpOf(r.pos), gp: n, war: r.war * sh, worth: r.worth });
  }
  const gs = VAL.goalie_seasons && VAL.goalie_seasons[y];
  if (gs && GG) {
    const gf = VAL.goalie_fields, rows = goalieRowsFor(GG, team);
    const gmap = new Map(gs.rows.map(r => [r[0], r]));
    for (const [id, apps] of Object.entries(rows)) {
      const r = gmap.get(+id); if (!r) continue;
      const gp = r[gf.indexOf('gp')], sh = Math.min(1, apps.length / Math.max(1, gp));
      items.push({ id: +id, grp: 'G', gp: apps.length, war: r[gf.indexOf('war')] * sh, worth: r[gf.indexOf('worth')] });
    }
  }
  return items;
}
async function renderRoster(TD, G) {
  const el = $('roster'); if (!G) { el.innerHTML = ''; return; }
  const y = TP.y;
  el.innerHTML = '<p class="sub small">Loading players and ages…</p>';
  const [, GG, bios] = await Promise.all([loadValue().catch(() => null), loadGoalieGames(y), loadBios()]);
  if (y !== TP.y) return;
  if (!VAL || !VAL.seasons[y]) { el.innerHTML = `<p class="empty">Value numbers for ${sLabel(y)} aren't built yet.</p>`; return; }
  const items = teamWins(TD, GG, TP.team, y) || [];
  items.forEach(it => { const b = bios.get(it.id) || {}; const ix = S.byId.get(it.id) || {}; it.name = b.name || ix.name || `#${it.id}`; it.age = b.birth ? ageNow(b.birth, y) : null; });
  const pos = items.filter(i => i.war > 0);
  const tot = items.reduce((a, i) => a + i.war, 0), posTot = pos.reduce((a, i) => a + i.war, 0);
  const young = pos.filter(i => nz(i.age) && i.age <= 25).reduce((a, i) => a + i.war, 0);
  const top3 = pos.slice().sort((a, b) => b.war - a.war).slice(0, 3).reduce((a, i) => a + i.war, 0);
  const aged = items.filter(i => nz(i.age)), avgAge = aged.reduce((a, i) => a + i.age * i.gp, 0) / Math.max(1, aged.reduce((a, i) => a + i.gp, 0));
  // league ranks, same split for every team
  const league = Object.keys(TD.teams).map(t => { const its = teamWins(TD, GG, t, y) || []; const p2 = its.filter(i => i.war > 0); return { t, war: its.reduce((a, i) => a + i.war, 0), yng: p2.length ? p2.filter(i => { const b = bios.get(i.id); const a = b && b.birth ? ageNow(b.birth, y) : null; return nz(a) && a <= 25; }).reduce((a, i) => a + i.war, 0) / p2.reduce((a, i) => a + i.war, 0) : 0 }; });
  const rk = (k, hi = true) => { const a = league.slice().sort((x, z) => hi ? z[k] - x[k] : x[k] - z[k]); return a.findIndex(r => r.t === TP.team) + 1; };
  const tile = (l, v, sm) => `<div class="ttile"><span class="lbl">${l}</span><b>${v}</b><small>${sm}</small></div>`;
  const yPct = posTot > 0 ? 100 * young / posTot : 0;
  // age-by-wins chart
  const W = 900, H = 300, m = { l: 48, r: 16, t: 16, b: 36 };
  const ages = aged.map(i => i.age); const aLo = Math.min(19, ...ages), aHi = Math.max(36, ...ages);
  const wv = items.map(i => i.war); let wLo = Math.min(-0.5, ...wv), wHi = Math.max(1, ...wv); const pad = (wHi - wLo) * 0.08; wLo -= pad; wHi += pad;
  const X = a => m.l + (a - aLo) / (aHi - aLo) * (W - m.l - m.r), Y = v => m.t + (wHi - v) / (wHi - wLo) * (H - m.t - m.b);
  const col = { F: 'var(--c1)', D: 'var(--c3)', G: 'var(--c5)' };
  const st = niceStep(wHi - wLo, 5);
  const yt = ticks(wLo, wHi, st).map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="axl">${+v.toFixed(1)}</text>`).join('');
  const xt = ticks(aLo, aHi, aHi - aLo > 16 ? 4 : 2).map(a => `<text x="${X(a)}" y="${H - 14}" text-anchor="middle" class="axl">${a}</text>`).join('');
  const band = `<rect x="${m.l}" y="${m.t}" width="${Math.max(0, X(25.5) - m.l)}" height="${H - m.t - m.b}" fill="var(--line)" opacity=".25"/><text x="${m.l + 6}" y="${m.t + 12}" class="axl">25 and under</text>`;
  const lab = new Set(pos.slice().sort((a, b) => b.war - a.war).slice(0, 8).map(i => i.id));
  // jitter same-age dots a little so they don't sit on top of each other
  const seen = {};
  const dots = aged.sort((a, b) => a.war - b.war).map(i => { const k = i.age; seen[k] = (seen[k] || 0) + 1; const jx = ((seen[k] % 3) - 1) * 0.18; const r = 3 + 6 * Math.min(1, i.gp / 82); const cx = X(i.age + jx), cy = Y(i.war);
    return `<a href="${i.grp === 'G' ? 'goalies.html' : './'}#a=${i.id}&s=${y}"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${col[i.grp]}" fill-opacity=".85" stroke="var(--panel)" stroke-width="1"><title>${esc(i.name)} · ${i.grp === 'G' ? 'goalie' : i.grp === 'D' ? 'defenseman' : 'forward'} · age ${i.age} · ${i.gp} games · ${s1(i.war)} wins</title></circle>${lab.has(i.id) ? `<text x="${(cx + r + 3).toFixed(1)}" y="${(cy + 4).toFixed(1)}" class="sname" style="font-size:11.5px">${esc(last(i.name))}</text>` : ''}</a>`; }).join('');
  const caps = TP.caps;
  const rowsT = items.slice().sort((a, b) => b.war - a.war);
  el.innerHTML = `<div class="ttiles">
      ${tile('Wins above replacement', s1(tot), `${ord(rk('war'))} of ${league.length} teams`)}
      ${tile('From players 25 and under', Math.round(yPct) + '%', `of positive wins · ${ord(rk('yng'))} youngest core`)}
      ${tile('Top 3 players', posTot > 0 ? Math.round(100 * top3 / posTot) + '%' : '—', 'share of positive wins')}
      ${tile('Average age', nz(avgAge) ? avgAge.toFixed(1) : '—', 'weighted by games played')}
    </div>
    <div class="scroll" style="margin-top:12px"><svg class="tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each player's wins above replacement by age">${band}${yt}<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)"/>${xt}<text x="${(m.l + W - m.r) / 2}" y="${H - 2}" text-anchor="middle" class="axl">age (Feb 1 of the season)</text>${dots}</svg></div>
    <p class="tkey"><span><i style="background:var(--c1)"></i>Forward</span><span><i style="background:var(--c3)"></i>Defenseman</span><span><i style="background:var(--c5)"></i>Goalie</span><span class="lab">dot size = games with ${esc(TP.team)} · up = more wins · names: top 8</span></p>
    <details class="lim" style="margin-top:12px"${Object.keys(caps).length ? ' open' : ''}><summary>Pay vs. value: type cap hits (this page only)</summary>
      <p class="sub small">Type any player's cap hit in $M (or dollars) to see what he's paid against what the value model says a full season at his rate this year is worth (the same figure as his player page; with few games it's shaky). Cap hits here stay on this page only and clear when you refresh; they don't read or change the ones on player pages or in the trade machine. The model prices every win the same, so stars often look underpaid against the market.</p>
      <div class="scroll"><table class="tbl" id="paytbl"><thead><tr><th>Player</th><th>Age</th><th>GP</th><th>Wins</th><th>Value a season</th><th>Cap hit ($M)</th><th>Pay vs. value</th></tr></thead><tbody>
      ${rowsT.map(i => `<tr><td><a href="${i.grp === 'G' ? 'goalies.html' : './'}#a=${i.id}&s=${y}">${esc(i.name)}</a> <span class="lab">${i.grp}</span></td><td>${nz(i.age) ? i.age : '—'}</td><td>${i.gp}</td><td class="${dcls(i.war)}">${s1(i.war)}</td><td>${money(i.worth)}</td>
        <td><input type="number" step="0.05" min="0" inputmode="decimal" class="capin" data-cap="${i.id}" data-worth="${i.worth}" value="${nz(caps[i.id]) ? caps[i.id] : ''}" aria-label="Cap hit for ${esc(i.name)}" style="width:86px"></td><td id="pv-${i.id}">${payDiff(i.worth, caps[i.id])}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="7" id="paytot">${payTotal(rowsT)}</td></tr></tfoot></table></div>
    </details>
    <p class="sub small">Wins above replacement are the value model's, for the selected season. A player traded mid-season counts only for his share of games with this team. Ranks split every team's players the same way.</p>`;
  el.oninput = e => {
    const t = e.target; if (!t.dataset.cap) return;
    let v = t.value === '' ? null : +t.value; if (nz(v) && v >= 1000) v = Math.round(v / 1e4) / 100;
    if (nz(v)) TP.caps[t.dataset.cap] = v; else delete TP.caps[t.dataset.cap];
    $('pv-' + t.dataset.cap).innerHTML = payDiff(+t.dataset.worth, v);
    $('paytot').innerHTML = payTotal(rowsT);
  };
}
function payDiff(worth, cap) { if (!nz(cap) || !nz(worth)) return '<span class="lab">—</span>'; const d = worth - cap; return `<b class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? 'Value above pay' : 'Pay above value'} by ${money(Math.abs(d))}</b>`; }
function payTotal(rows) {
  const en = rows.filter(i => nz(TP.caps[i.id])); if (!en.length) return '<span class="lab">No cap hits entered yet.</span>';
  const pay = en.reduce((a, i) => a + TP.caps[i.id], 0), val = en.reduce((a, i) => a + i.worth, 0);
  return `${en.length} of ${rows.length} entered: paid ${money(pay)}, worth ${money(val)} · ${payDiff(val, pay)}`;
}

// ------------------------------------------------------------------ Phase 2: goalie usage
async function renderGoalies(G) {
  const el = $('goalies'); if (!G) { el.innerHTML = ''; return; }
  const y = TP.y;
  const [GG, gsea] = await Promise.all([loadGoalieGames(y), getJSON(`data/goalies/seasons/${y}.json`).catch(() => null)]);
  if (y !== TP.y) return;
  const rows = goalieRowsFor(GG, TP.team);
  if (!Object.keys(rows).length) { el.innerHTML = '<p class="empty">No goalie game data for this season.</p>'; return; }
  const names = new Map(); if (gsea) { const f = gsea.fields; gsea.players.forEach(r => names.set(r[f.indexOf('id')], r[f.indexOf('name')])); }
  const idx = new Map(G.games.map((g, i) => [String(g.game), i]));
  const n = G.games.length, N = Math.min(TP.win, n);
  const b2b = new Set(); Object.values(rows).forEach(l => l.forEach(r => { if (r.b2b) b2b.add(String(r.game)); }));
  const list = Object.entries(rows).map(([id, apps]) => {
    const st = apps.filter(r => r.start);
    const by = new Map(apps.map(r => [String(r.game), r]));
    const cells = G.games.map(g => { const r = by.get(String(g.game)); return r ? (r.start ? 'S' : 'R') : '.'; });
    const dec = k => apps.filter(r => r.dec === k).length;
    const sa = apps.reduce((a, r) => a + r.sa, 0), ga = apps.reduce((a, r) => a + r.ga, 0), xga = apps.reduce((a, r) => a + r.xga, 0);
    const lastN = new Set(G.games.slice(n - N).map(g => String(g.game)));
    return { id: +id, name: names.get(+id) || (S.byId.get(+id) || {}).name || `#${id}`, gp: apps.length, starts: st.length, w: dec('W'), l: dec('L'), o: dec('O'), sv: sa ? 1 - ga / sa : null, gsax: xga - ga, sa, b2bS: st.filter(r => r.b2b).length, recent: st.filter(r => lastN.has(String(r.game))).length, cells };
  }).sort((a, b) => b.starts - a.starts || b.gp - a.gp);
  const cw = 10, rh = 18, nameW = 150, top = 22, Wd = nameW + n * cw + 4;
  let y0 = top, body = '';
  list.forEach(gl => {
    body += `<a href="goalies.html#a=${gl.id}&s=${y}"><text x="${nameW - 8}" y="${y0 + 13}" text-anchor="end" class="sname">${esc(last(gl.name))}</text></a>`;
    gl.cells.forEach((c, j) => { const g = G.games[j], x = nameW + j * cw; const t = `${esc(gl.name)} · game ${j + 1}, ${gdate(g.date)} ${g.home ? 'vs' : 'at'} ${g.opp}`;
      if (c === 'S') body += `<rect x="${x}" y="${y0 + 2}" width="${cw - 1.5}" height="${rh - 4}" rx="1.5" fill="var(--c5)"><title>${t} · started</title></rect>`;
      else if (c === 'R') body += `<rect x="${x}" y="${y0 + 2}" width="${cw - 1.5}" height="${rh - 4}" rx="1.5" fill="var(--c5)" fill-opacity=".35"><title>${t} · came in relief</title></rect>`;
      else body += `<rect x="${x + 3}" y="${y0 + rh / 2 - 1}" width="${cw - 7.5}" height="1.5" fill="var(--line)"/>`; });
    y0 += rh;
  });
  let axis = ''; G.games.forEach((g, j) => { if ((j + 1) % 10 === 0 || j === 0) axis += `<text x="${nameW + j * cw + cw / 2}" y="${top - 8}" text-anchor="middle" class="axl">${j + 1}</text>`; });
  el.innerHTML = `<div class="scroll stripwrap"><svg class="strip" width="${Wd}" height="${y0 + 6}" viewBox="0 0 ${Wd} ${y0 + 6}" role="img" aria-label="Which goalie started each game">${axis}${body}</svg></div>
    <p class="tkey"><span><i style="background:var(--c5)"></i>Started</span><span><i style="background:var(--c5);opacity:.35"></i>Came in relief</span><span class="lab">numbers on top: game number</span></p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Goalie</th><th>Starts</th><th>GP</th><th>Record</th><th>Save %</th><th>Saves above expected</th><th>Back-to-back starts</th><th>Starts, last ${N} games</th></tr></thead><tbody>
    ${list.map(gl => `<tr><td><a href="goalies.html#a=${gl.id}&s=${y}">${esc(gl.name)}</a></td><td>${gl.starts}</td><td>${gl.gp}</td><td>${gl.w}-${gl.l}-${gl.o}</td><td>${nz(gl.sv) ? gl.sv.toFixed(3).replace(/^0/, '') : '—'}</td><td class="${dcls(gl.gsax)}">${s1(gl.gsax)}</td><td>${gl.b2bS} of ${b2b.size}</td><td>${gl.recent} of ${N}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="sub small">Saves above expected = expected goals against minus goals against, all situations: what happened this season, not a rating (a goalie season is roughly half luck; the goalie page shows his three-season picture). Back-to-back starts count the second game of the team's back-to-backs.</p>`;
}

// ------------------------------------------------------------------ Phase 2: season-by-season history
let HIST = null;
async function loadHistory() { if (HIST !== null) return HIST; try { HIST = await getJSON('data/teams/history.json'); } catch (e) { HIST = false; } return HIST; }
async function renderHistory() {
  const el = $('history');
  const [H] = await Promise.all([loadHistory(), loadValue().catch(() => null)]);
  if (!H) { el.innerHTML = '<p class="empty">The history summary hasn\'t been built yet. It\'s added by the nightly update.</p>'; return; }
  const f = H.fields, ix = k => f.indexOf(k);
  const seasons = Object.keys(H.seasons).map(Number).sort((a, b) => a - b);
  const rows = [];
  for (const y of seasons) {
    const S2 = H.seasons[y]; const code = Object.keys(S2).find(t => sameFranchise(t, TP.team)); if (!code) continue;
    const r = S2[code]; const share2 = t => { const q = S2[t]; return share(q[ix('xgf')], q[ix('xga')]); };
    const rk = Object.keys(S2).map(t => ({ t, v: share2(t) })).sort((a, b) => b.v - a.v).findIndex(o => o.t === code) + 1;
    let mvp = null;
    if (VAL) {
      const V = VAL.seasons[y]; if (V) for (const o of V.map.values()) if (o.team === code && (!mvp || o.war > mvp.war)) mvp = { id: o.id, war: o.war, g: false };
      const gs = VAL.goalie_seasons && VAL.goalie_seasons[y]; if (gs) { const gf = VAL.goalie_fields; gs.rows.forEach(q => { if (q[gf.indexOf('team')] === code && (!mvp || q[gf.indexOf('war')] > mvp.war)) mvp = { id: q[0], war: q[gf.indexOf('war')], g: true }; }); }
    }
    rows.push({ y, code, gp: r[ix('gp')], xp: share(r[ix('xgf')], r[ix('xga')]), gp2: share(r[ix('gf')], r[ix('ga')]), rk, nT: Object.keys(S2).length, coaches: (r[ix('coaches')] || '').split('|').filter(Boolean), mvp });
  }
  if (!rows.length) { el.innerHTML = '<p class="empty">No history for this team.</p>'; return; }
  // chart with coaching eras (by the coach who finished each season)
  const W = 900, Hh = 250, m = { l: 44, r: 16, t: 26, b: 30 };
  const vals = rows.map(r => r.xp).concat([50]); let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const X = i => m.l + (rows.length === 1 ? 0.5 : i / (rows.length - 1)) * (W - m.l - m.r), Y = v => m.t + (hi - v) / (hi - lo) * (Hh - m.t - m.b);
  const eras = []; rows.forEach((r, i) => { const c = r.coaches[r.coaches.length - 1] || '?'; const e = eras[eras.length - 1]; if (e && e.c === c) e.to = i; else eras.push({ c, from: i, to: i }); });
  const step = rows.length > 1 ? (W - m.l - m.r) / (rows.length - 1) : 0;
  const bands = eras.map((e, k) => { const x0 = Math.max(m.l, X(e.from) - step / 2), x1 = Math.min(W - m.r, X(e.to) + step / 2); return `${k % 2 ? '' : `<rect x="${x0}" y="${m.t}" width="${x1 - x0}" height="${Hh - m.t - m.b}" fill="var(--line)" opacity=".25"/>`}<text x="${(x0 + x1) / 2}" y="${m.t - 8}" text-anchor="middle" class="axl">${esc(last(e.c))}</text>`; }).join('');
  const st = niceStep(hi - lo, 5);
  const yt = ticks(lo, hi, st).map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="axl">${v}%</text>`).join('');
  const pts = rows.map((r, i) => `${X(i).toFixed(1)},${Y(r.xp).toFixed(1)}`).join(' ');
  const xt = rows.map((r, i) => (i % (rows.length > 12 ? 2 : 1) === 0 || i === rows.length - 1) ? `<text x="${X(i)}" y="${Hh - 10}" text-anchor="middle" class="axl">${String(r.y).slice(2)}-${String(r.y + 1).slice(2)}</text>` : '').join('');
  const dots = rows.map((r, i) => `<circle cx="${X(i)}" cy="${Y(r.xp)}" r="${r.y === TP.y ? 6 : 3.5}" fill="var(--c1)" ${r.y === TP.y ? 'stroke="var(--ink)" stroke-width="2"' : ''} style="cursor:pointer" data-hy="${r.y}"><title>${sLabel(r.y)}${r.code !== TP.team ? ` (${r.code})` : ''} · ${f1(r.xp)}% · ${ord(r.rk)} of ${r.nT} · ${esc(r.coaches.join(', then ') || 'coach unknown')}</title></circle>`).join('');
  const name = id => (S.byId.get(id) || {}).name || (BIOS && BIOS.get(id) || {}).name || `#${id}`;
  el.innerHTML = `<div class="scroll"><svg class="tchart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Five-on-five expected goal share by season">${bands}${yt}<line x1="${m.l}" x2="${W - m.r}" y1="${Y(50)}" y2="${Y(50)}" stroke="var(--muted)"/><polyline points="${pts}" fill="none" stroke="var(--c1)" stroke-width="2.5"/>${dots}${xt}</svg></div>
    <p class="tkey"><span class="lab">Shaded and labeled by the coach who finished each season · click a dot or a season to open it</span></p>
    <div class="scroll"><table class="tbl" id="histtbl"><thead><tr><th>Season</th><th>GP</th><th>5v5 xGF%</th><th>Rank</th><th>5v5 GF%</th><th>Head coach</th><th>Most valuable</th><th>Used about right</th></tr></thead><tbody>
    ${rows.slice().reverse().map(r => `<tr${r.y === TP.y ? ' class="isA"' : ''}><td><a href="#t=${encodeURIComponent(r.code)}&s=${r.y}" data-hy="${r.y}">${sLabel(r.y)}</a>${r.code !== TP.team ? ` <span class="lab">${esc(r.code)}</span>` : ''}</td><td>${r.gp}</td><td>${f1(r.xp)}%</td><td>${ord(r.rk)}</td><td>${f1(r.gp2)}%</td><td>${esc(r.coaches.join(', then ')) || '<span class="lab">unknown</span>'}</td>
      <td>${r.mvp ? `<a href="${r.mvp.g ? 'goalies.html' : './'}#a=${r.mvp.id}&s=${r.y}">${esc(name(r.mvp.id))}</a> <span class="lab">${s1(r.mvp.war)} wins</span>` : '—'}</td><td id="uw-${r.y}"><span class="lab">—</span></td></tr>`).join('')}
    </tbody></table></div>
    <p style="margin:10px 0 0"><button type="button" id="uwbtn" class="btn">Show players used well for every season</button> <span class="sub small" id="uwnote">Downloads about 30 MB (three seasons of player data for each season), so it can take a while, especially on a phone.</span></p>`;
  el.onclick = e => { const t = e.target.closest('[data-hy]'); if (t) { e.preventDefault(); const r = rows.find(q => q.y === +t.dataset.hy); if (!r) return; TP.y = r.y; TP.team = r.code; $('tSeason').value = TP.y; renderTeams(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  $('uwbtn').onclick = () => fillUsedWell(rows);
}
async function fillUsedWell(rows) {
  const btn = $('uwbtn'), note = $('uwnote'); btn.disabled = true;
  const team = TP.team, y0 = TP.y; let k = 0;
  for (const r of rows.slice().reverse()) {
    if (TP.team !== team || TP.y !== y0) return;
    note.textContent = `Loading ${sLabel(r.y)} (${++k} of ${rows.length})…`;
    try {
      const [sd, TD] = await Promise.all([loadSeason(r.y), loadTeams(r.y)]);
      const G = TD && teamGames(TD, r.code); if (!G) continue;
      const d = await deployData(G, sd, r.y, Math.min(TP.win, G.games.length));
      const cell = $('uw-' + r.y); if (!cell) return;
      if (!d || !d.length) { cell.innerHTML = '<span class="lab">no data</span>'; continue; }
      const c = fitCounts(d);
      cell.innerHTML = `${c.ok} of ${c.n} <span class="lab"><span class="pos">${c.up} more</span> · <span class="neg">${c.down} less</span></span>`;
    } catch (e) { console.error(e); const cell = $('uw-' + r.y); if (cell) cell.innerHTML = '<span class="lab">error</span>'; }
  }
  note.textContent = '"More" = could handle a bigger role; "less" = used above his overall value. Same rule as the table above.';
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
  let prev = null;
  if (G && S.idx.mp_seasons.includes(y - 1)) {
    const TDp = await loadTeams(y - 1);
    if (y !== TP.y) return;
    const pt = TDp && Object.keys(TDp.teams).find(t => sameFranchise(t, TP.team));
    if (pt) prev = teamGames(TDp, pt).games;
  }
  safe('sec-trend', () => renderTrend(G, CR, prev));
  safe('sec-strip', () => renderStrip(G, sd));
  try { await renderDeploy(G, sd); } catch (e) { console.error(e); $('deploy').innerHTML = `<p class="empty">This section hit an error: ${esc(e.message)}</p>`; }
  const sec = async (id, fn) => { try { await fn(); } catch (e) { console.error(e); $(id).insertAdjacentHTML('beforeend', `<p class="empty">This section hit an error: ${esc(e.message)}</p>`); } };
  await sec('sec-roster', () => renderRoster(TD, G));
  await sec('sec-goalies', () => renderGoalies(G));
  await sec('sec-history', () => renderHistory());
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
