"""Check: does the value model line up with real standings? (docs/CHECKS.md, check 2)
Same season: team wins above replacement (each player split by his games with the team) vs. points per 82.
Next season: this season's roster valued on last season's numbers vs. last season's goal differential and points.
Reads data/value.json, data/teams, data/goalies/games and data/checks/standings.json. Prints only; changes nothing."""
import json, os, sys, math
R = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
D = os.path.join(R, 'data')
V = json.load(open(os.path.join(D, 'value.json')))
ST = json.load(open(os.path.join(D, 'checks', 'standings.json')))
ALIAS = {'PHX': 'ARI'}
fi = {k: i for i, k in enumerate(V['fields'])}; gfi = {k: i for i, k in enumerate(V['goalie_fields'])}

def team_parts(y):
    """team -> {sk, g: war split by games with team; gp: team games; gd...} plus per-player per-team games"""
    tf = json.load(open(os.path.join(D, 'teams', f'{y}.json')))
    gg = json.load(open(os.path.join(D, 'goalies', 'games', f'{y}.json')))
    S = {r[0]: r for r in V['seasons'][str(y)]['rows']}
    G = {r[0]: r for r in V['goalie_seasons'][str(y)]['rows']}
    gf = gg['fields']; ti = gf.index('team')
    out, games = {}, {}  # games[(id, team)] = n
    for t, d in tf['teams'].items():
        o = out.setdefault(t, {'sk': 0.0, 'g': 0.0, 'gp': len(d['games']), 'gf': sum(g[7] for g in d['games']), 'ga': sum(g[8] for g in d['games'])})
        for pid, s in d['slots'].items():
            n = sum(c != '.' for c in s); r = S.get(int(pid))
            if not n: continue
            games[(int(pid), t)] = n
            if r: o['sk'] += r[fi['war']] * min(1, n / max(1, r[fi['gp']]))
    for pid, rows in gg['players'].items():
        cnt = {}
        for r in rows: cnt[r[ti]] = cnt.get(r[ti], 0) + 1
        g = G.get(int(pid))
        for t, n in cnt.items():
            games[(int(pid), t)] = n
            if g and t in out: out[t]['g'] += g[gfi['war']] * min(1, n / max(1, g[gfi['gp']]))
    return out, games, S, G

def corr(a, b):
    n = len(a); ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a)); sb = math.sqrt(sum((x - mb) ** 2 for x in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)
def fit(xs, y):  # least squares with intercept, xs list of columns
    X = [[1.0] + [c[i] for c in xs] for i in range(len(y))]
    k = len(X[0]); A = [[sum(X[r][i] * X[r][j] for r in range(len(y))) for j in range(k)] for i in range(k)]
    b = [sum(X[r][i] * y[r] for r in range(len(y))) for i in range(k)]
    for i in range(k):  # gauss
        p = A[i][i]
        for j in range(i + 1, k):
            f = A[j][i] / p
            for c in range(i, k): A[j][c] -= f * A[i][c]
            b[j] -= f * b[i]
    w = [0.0] * k
    for i in range(k - 1, -1, -1): w[i] = (b[i] - sum(A[i][j] * w[j] for j in range(i + 1, k))) / A[i][i]
    pred = [sum(w[j] * X[r][j] for j in range(k)) for r in range(len(y))]
    mae = sum(abs(p - t) for p, t in zip(pred, y)) / len(y)
    return w, pred, mae

rows = []
P = {}
for y in range(2008, 2026):
    parts, games, S, G = team_parts(y); P[y] = (parts, games, S, G)
    st = {ALIAS.get(k, k): v for k, v in ST[str(y)].items()}
    for t, o in parts.items():
        s = st.get(t)
        if not s: print('no standings', y, t); continue
        k = 82 / s['gp']
        rows.append({'y': y, 't': t, 'pts': s['pts'] * k, 'war': (o['sk'] + o['g']) * k, 'sk': o['sk'] * k, 'g': o['g'] * k, 'gd': (s['gf'] - s['ga']) * k})
print('team-seasons', len(rows))
pts = [r['pts'] for r in rows]
res = {}
for name, cols in [('war', [[r['war'] for r in rows]]), ('gd', [[r['gd'] for r in rows]]), ('sk+g', [[r['sk'] for r in rows], [r['g'] for r in rows]])]:
    w, pred, mae = fit(cols, pts); res[name] = (w, mae, corr(pred, pts))
    print('SAME', name, 'coef', [round(x, 2) for x in w], 'MAE', round(mae, 1), 'r', round(corr(pred, pts), 3))
w, pred, _ = fit([[r['war'] for r in rows]], pts)
for r, p in zip(rows, pred): r['miss'] = r['pts'] - p
mis = sorted(rows, key=lambda r: -abs(r['miss']))[:12]
for r in mis: print('MISS', r['y'], r['t'], 'pts', round(r['pts']), 'war', round(r['war'], 1), 'sk', round(r['sk'], 1), 'g', round(r['g'], 1), 'gd', round(r['gd']), 'miss', round(r['miss'], 1))
# residual vs goal differential beyond war: luck check
gd_res = fit([[r['war'] for r in rows]], [r['gd'] for r in rows])[1]
# predictive: next season points from (a) this roster valued on last season war82 (games with team next season), (b) last season gd, (c) last season pts
nrows = []
for y in range(2008, 2025):
    parts1, games1, S1, G1 = P[y + 1]; parts0, games0, S0, G0 = P[y]
    st0 = {ALIAS.get(k, k): v for k, v in ST[str(y)].items()}; st1 = {ALIAS.get(k, k): v for k, v in ST[str(y + 1)].items()}
    proj = {}; projg = {}
    for (pid, t), n in games1.items():
        r = S0.get(pid); g = G0.get(pid)
        if r and r[fi['gp']] >= 20: proj[t] = proj.get(t, 0) + r[fi['war82']] * n / 82
        elif g and g[gfi['gp']] >= 10: projg[t] = projg.get(t, 0) + g[gfi['war']] / max(1, g[gfi['gp']]) * n
    for t in parts1:
        if t not in st1 or t not in st0: continue
        k1, k0 = 82 / st1[t]['gp'], 82 / st0[t]['gp']
        nrows.append({'y': y + 1, 't': t, 'pts': st1[t]['pts'] * k1, 'proj': (proj.get(t, 0) + projg.get(t, 0)) * k1, 'psk': proj.get(t, 0) * k1, 'pg': projg.get(t, 0) * k1, 'gd0': (st0[t]['gf'] - st0[t]['ga']) * k0, 'pts0': st0[t]['pts'] * k0})
print('next-season rows', len(nrows))
np_ = [r['pts'] for r in nrows]
for name, cols in [('roster value', [[r['proj'] for r in nrows]]), ('last GD', [[r['gd0'] for r in nrows]]), ('last pts', [[r['pts0'] for r in nrows]]), ('skaters+goalies', [[r['psk'] for r in nrows], [r['pg'] for r in nrows]]), ('roster+GD', [[r['proj'] for r in nrows], [r['gd0'] for r in nrows]])]:
    w, pred, mae = fit(cols, np_)
    print('NEXT', name, 'coef', [round(x, 2) for x in w], 'MAE', round(mae, 1), 'r', round(corr(pred, np_), 3))
# by era
for lo, hi in [(2009, 2016), (2017, 2025)]:
    sub = [r for r in nrows if lo <= r['y'] <= hi]; p = [r['pts'] for r in sub]
    for name, key in [('roster value', 'proj'), ('last GD', 'gd0')]:
        w, pred, mae = fit([[r[key] for r in sub]], p); print('NEXT', lo, hi, name, 'MAE', round(mae, 1), 'r', round(corr(pred, p), 3))

import statistics as stt
print('spread: sd of pts', round(stt.pstdev(pts),1), 'sd of war*2', round(stt.pstdev([r['war']*2 for r in rows]),1))
print('2026 sanity', [ (r['t'], round(r['pts']), round(r['war'],1)) for r in rows if r['y']==2025][:5])
