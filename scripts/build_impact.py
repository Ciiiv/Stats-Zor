#!/usr/bin/env python3
"""Isolated 5v5 impact (RAPM-style regression) for every skater.

What it estimates
  For each skater, his own effect on his team's expected goals for (offense) and against
  (defense) per 60 minutes at 5v5, with his teammates, his opponents, zone starts, score
  and home ice accounted for. "Regularized adjusted plus-minus" in the analytics literature.

Data (all free, no keys)
  - NHL shift charts: who was on the ice, second by second.
      https://api.nhle.com/stats/rest/en/shiftcharts?cayenneExp=gameId={gid}
  - NHL play-by-play: faceoff zones, goals (score), and each roster's positions (to find goalies).
      https://api-web.nhle.com/v1/gamecenter/{gid}/play-by-play
  - MoneyPuck shot data: expected goals for every unblocked shot (the same file build_shots.py reads).

Method
  1. Each game is cut into "stints": stretches with the same ten skaters and both goalies on
     the ice at 5v5. Each stint gives two rows: home attacking and away attacking.
  2. Row target = attacking team's expected goals per 60 in that stint; weight = stint hours.
     Columns: +1 for each attacking skater's offense, +1 for each defending skater's defense,
     plus context: home ice, offensive/defensive-zone faceoff start, and score state.
  3. Weighted ridge regression (penalty LAMBDA on skater columns only), solved with conjugate
     gradients on the sparse normal equations, so plain Python handles a full season quickly.
  4. Single-season and three-season (that season and the two before) estimates.

Outputs
  data/impact/{y}.json   per skater: 5v5 minutes, offense and defense per 60 (single season and
                         three seasons), plus the context coefficients and the league average.
  data/impact/test.json  forecast test: how well each 5v5 measure predicts next season.

Raw game data is cached between runs in .cache/impact (GitHub Actions cache), not committed.
Default run: refreshes the current season and fills in at most MAX_BACKFILL missing seasons.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import random
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, current_season, fetch, fetch_json, log, read_json, write_json  # noqa: E402

FIRST = 2010            # first season with usable shift charts (checked by the probe); earlier are skipped
MAX_BACKFILL = 5        # past seasons built per run, so one nightly run never runs too long
LAMBDA = 20.0           # ridge penalty in on-ice hours (best of 5-120 on a 20% game holdout of 2024-25, see choose_lambda)
MIN_STINT = 1           # seconds
CACHE = os.environ.get("STATSZOR_IMPACT_CACHE", os.path.join(os.path.dirname(DATA), ".cache", "impact"))
OUT = os.path.join(DATA, "impact")
SHIFT_URL = "https://api.nhle.com/stats/rest/en/shiftcharts?cayenneExp=gameId={gid}"
PBP_URL = "https://api-web.nhle.com/v1/gamecenter/{gid}/play-by-play"
SHOTS_URL = "https://peter-tanner.com/moneypuck/downloads/shots_{y}.zip"
WEIGHTS = (0, 0.25, 0.5, 0.67, 0.75, 1)  # isolated share of the blend in the forecast test
CONTEXT = ["intercept", "home", "oz_start", "dz_start", "lead1", "lead2", "trail1", "trail2"]


def mmss(s):
    try:
        m, sec = str(s).split(":")
        return int(m) * 60 + int(sec)
    except (ValueError, AttributeError):
        return None


# ------------------------------------------------------------------ shots (MoneyPuck)
def load_shots(y):
    """{full game id: [(period, sec_in_period, home_attacking, xg)]} for 5v5, non-empty-net, regular season."""
    raw = fetch(SHOTS_URL.format(y=y))
    zf = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    out = {}
    with zf.open(name) as fh:
        rd = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"))
        first = True
        for r in rd:
            if first:
                need = ["game_id", "period", "time", "isHomeTeam", "xGoal", "homeSkatersOnIce", "awaySkatersOnIce"]
                miss = [k for k in need if k not in r]
                if miss:
                    raise RuntimeError(f"shot file missing columns {miss}")
                first = False
            if r.get("isPlayoffGame") in ("1", "1.0"):
                continue
            if r.get("shotOnEmptyNet") in ("1", "1.0") or r.get("homeEmptyNet") in ("1", "1.0") or r.get("awayEmptyNet") in ("1", "1.0"):
                continue
            try:
                hs, as_ = int(float(r["homeSkatersOnIce"])), int(float(r["awaySkatersOnIce"]))
                if hs != 5 or as_ != 5:
                    continue
                g = int(float(r["game_id"]))
                gid = g if g > 1_000_000 else y * 1_000_000 + g
                per = int(float(r["period"]))
                t = int(float(r["time"])) - (per - 1) * 1200
                out.setdefault(gid, []).append((per, t, 1 if r["isHomeTeam"] in ("1", "1.0") else 0, float(r["xGoal"] or 0)))
            except (ValueError, KeyError):
                continue
    return out


# ------------------------------------------------------------------ one game (NHL)
def fetch_game(gid):
    """Compact record of one game: shifts, goalies, faceoff zones (home view) and goals."""
    try:
        sh = fetch_json(SHIFT_URL.format(gid=gid))
        pbp = fetch_json(PBP_URL.format(gid=gid))
    except Exception as e:  # noqa: BLE001
        return gid, None, str(e)
    home, away = pbp["homeTeam"]["id"], pbp["awayTeam"]["id"]
    goalies = sorted({r["playerId"] for r in pbp.get("rosterSpots", []) if r.get("positionCode") == "G"})
    shifts = []
    for s in sh.get("data", []):
        if s.get("typeCode") != 517 or s.get("period", 0) > 4:
            continue
        a, b = mmss(s.get("startTime")), mmss(s.get("endTime"))
        if a is None or b is None or b <= a:
            continue
        shifts.append([s["playerId"], 1 if s.get("teamId") == home else 0, s["period"], a, b])
    fo, goals = [], []
    for p in pbp.get("plays", []):
        per = (p.get("periodDescriptor") or {}).get("number", 0)
        if per > 4:
            continue
        t = mmss(p.get("timeInPeriod"))
        d = p.get("details") or {}
        if p.get("typeDescKey") == "faceoff" and t is not None:
            z = d.get("zoneCode", "N")
            if d.get("eventOwnerTeamId") != home:  # zone is from the winner's side; store it from home's side
                z = {"O": "D", "D": "O"}.get(z, z)
            fo.append([per, t, z])
        elif p.get("typeDescKey") == "goal" and t is not None:
            goals.append([per, t, 1 if d.get("eventOwnerTeamId") == home else 0])
    if len(shifts) < 200:
        return gid, None, f"only {len(shifts)} shifts"
    return gid, {"g": goalies, "s": shifts, "f": fo, "goals": goals}, None


def stints(game, shots):
    """Yield (home_skaters, away_skaters, seconds, xg_home, xg_away, home_zone, home_score_diff)."""
    goalies = set(game["g"])
    fo = {(p, t): z for p, t, z in game["f"]}
    goals = sorted(game["goals"])
    by_per = {}
    for pid, is_home, per, a, b in game["s"]:
        by_per.setdefault(per, []).append((pid, is_home, a, b))
    shot_by_per = {}
    for per, t, home_att, xg in shots:
        shot_by_per.setdefault(per, []).append((t, home_att, xg))
    for per, rows in by_per.items():
        if per > 3:   # regular-season overtime is 3-on-3
            continue
        cuts = sorted({a for _, _, a, _ in rows} | {b for _, _, _, b in rows})
        ps = sorted(shot_by_per.get(per, []))
        si = 0
        for a, b in zip(cuts, cuts[1:]):
            if b - a < MIN_STINT:
                continue
            on = [(pid, h) for pid, h, s0, s1 in rows if s0 <= a and s1 >= b]
            hg = [p for p, h in on if h and p in goalies]
            ag = [p for p, h in on if not h and p in goalies]
            hs = sorted(p for p, h in on if h and p not in goalies)
            as_ = sorted(p for p, h in on if not h and p not in goalies)
            # shots in (a, b]
            xh = xa = 0.0
            while si < len(ps) and ps[si][0] <= a:
                si += 1
            j = si
            while j < len(ps) and ps[j][0] <= b:
                if ps[j][1]:
                    xh += ps[j][2]
                else:
                    xa += ps[j][2]
                j += 1
            if len(hg) != 1 or len(ag) != 1 or len(hs) != 5 or len(as_) != 5:
                continue
            diff = sum(1 if g[2] else -1 for g in goals if (g[0], g[1]) < (per, a) or (g[0] == per and g[1] == a))
            yield hs, as_, b - a, xh, xa, fo.get((per, a), "F"), diff


# ------------------------------------------------------------------ regression
class Normal:
    """Sparse normal equations X'WX and X'Wy, built row by row."""

    def __init__(self):
        self.idx = {}          # column key -> index
        self.A = []            # list of dicts
        self.b = []
        self.toi = {}          # skater -> seconds at 5v5
        self.rows = 0
        self.wsum = 0.0
        self.ysum = 0.0

    def col(self, key):
        i = self.idx.get(key)
        if i is None:
            i = self.idx[key] = len(self.b)
            self.A.append({})
            self.b.append(0.0)
        return i

    def add(self, cols, w, xg):
        A = self.A
        for i in cols:
            Ai = A[i]
            for j in cols:
                Ai[j] = Ai.get(j, 0.0) + w
            self.b[i] += xg
        self.rows += 1
        self.wsum += w
        self.ysum += xg

    def add_stint(self, hs, as_, sec, xh, xa, zone, diff):
        w = sec / 3600.0
        for p in hs + as_:
            self.toi[p] = self.toi.get(p, 0) + sec
        ctx = {k: self.col(("c", k)) for k in CONTEXT}
        for att, dfn, xg, home, z, d in ((hs, as_, xh, 1, zone, diff), (as_, hs, xa, 0, {"O": "D", "D": "O"}.get(zone, zone), -diff)):
            cols = [ctx["intercept"]] + [self.col(("o", p)) for p in att] + [self.col(("d", p)) for p in dfn]
            if home:
                cols.append(ctx["home"])
            if z == "O":
                cols.append(ctx["oz_start"])
            elif z == "D":
                cols.append(ctx["dz_start"])
            if d == 1:
                cols.append(ctx["lead1"])
            elif d >= 2:
                cols.append(ctx["lead2"])
            elif d == -1:
                cols.append(ctx["trail1"])
            elif d <= -2:
                cols.append(ctx["trail2"])
            self.add(cols, w, xg)

    def merge(self, other):
        remap = [self.col(k) for k in other.idx]
        keys = list(other.idx)
        for k_i, row in zip(keys, other.A):
            i = remap[other.idx[k_i]]
            Ai = self.A[i]
            for j, v in row.items():
                jj = remap[j]
                Ai[jj] = Ai.get(jj, 0.0) + v
            self.b[i] += other.b[other.idx[k_i]]
        for p, s in other.toi.items():
            self.toi[p] = self.toi.get(p, 0) + s
        self.rows += other.rows
        self.wsum += other.wsum
        self.ysum += other.ysum

    def to_json(self):
        keys = list(self.idx)
        return {"keys": [list(k) for k in keys], "A": [[[j, round(v, 6)] for j, v in r.items()] for r in self.A],
                "b": [round(v, 6) for v in self.b], "toi": {str(k): v for k, v in self.toi.items()},
                "rows": self.rows, "wsum": self.wsum, "ysum": self.ysum}

    @classmethod
    def from_json(cls, j):
        n = cls()
        for k in j["keys"]:
            n.col((k[0], k[1] if k[0] == "c" else int(k[1])))
        n.A = [{j_: v for j_, v in r} for r in j["A"]]
        n.b = list(j["b"])
        n.toi = {int(k): v for k, v in j["toi"].items()}
        n.rows, n.wsum, n.ysum = j["rows"], j["wsum"], j["ysum"]
        return n

    def solve(self, lam, iters=400, tol=1e-8):
        """Conjugate gradients on (A + lam*I_skaters) x = b."""
        n = len(self.b)
        pen = [lam if k[0] != "c" else 1e-6 for k in self.idx]
        rows = [list(r.items()) for r in self.A]

        def mul(x):
            out = [0.0] * n
            for i, r in enumerate(rows):
                s = pen[i] * x[i]
                for j, v in r:
                    s += v * x[j]
                out[i] = s
            return out

        x = [0.0] * n
        r = list(self.b)
        p = list(r)
        rs = sum(v * v for v in r)
        b2 = rs or 1.0
        for _ in range(iters):
            Ap = mul(p)
            alpha = rs / (sum(pi * api for pi, api in zip(p, Ap)) or 1e-12)
            x = [xi + alpha * pi for xi, pi in zip(x, p)]
            r = [ri - alpha * api for ri, api in zip(r, Ap)]
            rs2 = sum(v * v for v in r)
            if rs2 / b2 < tol:
                break
            p = [ri + (rs2 / rs) * pi for ri, pi in zip(r, p)]
            rs = rs2
        return {k: x[i] for k, i in self.idx.items()}


# ------------------------------------------------------------------ season build
def season_games(y, shots, cache_games):
    """Fetch any games not in the cache; return {gid: compact game}."""
    need = [g for g in sorted(shots) if str(g) not in cache_games]
    log(f"impact {y}: {len(shots)} games with shots, {len(need)} to fetch")
    failed = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for gid, game, err in ex.map(fetch_game, need):
            if game:
                cache_games[str(gid)] = game
            else:
                failed += 1
    if failed:
        log(f"impact {y}: {failed} games unavailable")
    return cache_games


def build_normal(y, games, shots, holdout=None):
    """Normal equations for a season; holdout = set of game ids to skip (for the lambda test)."""
    N = Normal()
    n = 0
    for gid, game in games.items():
        if holdout and int(gid) in holdout:
            continue
        for st in stints(game, shots.get(int(gid), [])):
            N.add_stint(*st)
            n += 1
    log(f"impact {y}: {n} stints, {len(N.toi)} skaters")
    return N


def holdout_error(coef, games, shots, ids):
    err = w_ = 0.0
    c = {k[1]: v for k, v in coef.items() if k[0] == "c"}
    for gid in ids:
        game = games.get(str(gid))
        if not game:
            continue
        for hs, as_, sec, xh, xa, zone, diff in stints(game, shots.get(gid, [])):
            w = sec / 3600
            for att, dfn, xg, home, z, d in ((hs, as_, xh, 1, zone, diff), (as_, hs, xa, 0, {"O": "D", "D": "O"}.get(zone, zone), -diff)):
                pred = c["intercept"] + (c["home"] if home else 0) + (c["oz_start"] if z == "O" else c["dz_start"] if z == "D" else 0)
                pred += c["lead1"] if d == 1 else c["lead2"] if d >= 2 else c["trail1"] if d == -1 else c["trail2"] if d <= -2 else 0
                pred += sum(coef.get(("o", p), 0) for p in att) + sum(coef.get(("d", p), 0) for p in dfn)
                err += w * (xg / w - pred) ** 2
                w_ += w
    return err / w_ if w_ else float("nan")


def choose_lambda(y, games, shots):
    """Hold out 20% of games, fit on the rest, and report the error for a range of penalties."""
    rnd = random.Random(7)
    ids = [int(g) for g in games]
    hold = set(rnd.sample(ids, max(1, len(ids) // 5)))
    N = build_normal(y, games, shots, holdout=hold)
    res = {}
    for lam in (5, 10, 20, 30, 50, 80, 120):
        res[lam] = holdout_error(N.solve(lam), games, shots, hold)
        log(f"impact {y}: lambda {lam} holdout error {res[lam]:.4f}")
    return res


def result(y, single, three, lam):
    def pack(N):
        coef = N.solve(lam)
        sk = {}
        for k, v in coef.items():
            if k[0] in ("o", "d"):
                sk.setdefault(k[1], [0.0, 0.0])[0 if k[0] == "o" else 1] = v
        ctx = {k[1]: round(v, 4) for k, v in coef.items() if k[0] == "c"}
        return sk, ctx, N
    s1, c1, N1 = pack(single)
    s3, c3, N3 = pack(three) if three else ({}, {}, None)
    rows = []
    for p, (o, d) in s1.items():
        o3, d3 = s3.get(p, [None, None])
        rows.append([p, round(N1.toi.get(p, 0) / 60, 1), round(o, 4), round(d, 4),
                     round(N3.toi.get(p, 0) / 60, 1) if N3 else None,
                     round(o3, 4) if o3 is not None else None, round(d3, 4) if d3 is not None else None])
    return {"season": y, "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "lambda": lam,
            "league_xg60": round(N1.ysum / N1.wsum, 4) if N1.wsum else None,   # per team, per 60
            "context": c1, "context3": c3,
            "fields": ["id", "toi", "off", "def", "toi3", "off3", "def3"], "players": rows}


# ------------------------------------------------------------------ competition and teammates
COMP_FIELDS = ["id", "t5", "vs_top_line", "vs_top_pair", "opp_iso", "mate_iso"]


def positions(y):
    pos = {}
    for path, f_id, f_pos in ((os.path.join(DATA, "index.json"), "id", "pos"), (os.path.join(DATA, "seasons", f"{y}.json"), "id", "pos")):
        j = read_json(path)
        if j:
            fi = j["fields"]
            for r in j["players"]:
                pos[r[fi.index(f_id)]] = r[fi.index(f_pos)]
    return pos


def competition(y, games, imp):
    """Who each skater was on the ice against and with at 5v5 (same stints as the regression).
    vs_top_line: % of his time with 2+ of the opponent's three most-used forwards that game on the ice.
    vs_top_pair: % of his time with both of the opponent's two most-used defensemen on the ice.
    opp_iso / mate_iso: time-weighted average isolated net impact (xG/60, three-season fit where there is
    one with 600+ minutes, else this season) of the five opponents and four teammates."""
    fi = imp["fields"]
    iso = {}
    for r in imp["players"]:
        d = dict(zip(fi, r))
        if d.get("off3") is not None and (d.get("toi3") or 0) >= 600:
            iso[d["id"]] = d["off3"] - d["def3"]
        else:
            iso[d["id"]] = d["off"] - d["def"]
    pos = positions(y)
    acc = {}
    for game in games.values():
        st = list(stints(game, []))
        if not st:
            continue
        t = {}
        for hs, as_, sec, *_ in st:
            for p in hs + as_:
                t[p] = t.get(p, 0) + sec
        top = {}
        for side in (0, 1):
            ps = {p for hs, as_, *_ in st for p in (hs if side == 0 else as_)}
            fw = sorted((p for p in ps if pos.get(p) != "D"), key=lambda p: -t[p])[:3]
            dd = sorted((p for p in ps if pos.get(p) == "D"), key=lambda p: -t[p])[:2]
            top[side] = (set(fw), set(dd))
        for hs, as_, sec, *_ in st:
            for side, mine, opp in ((0, hs, as_), (1, as_, hs)):
                tf, td = top[1 - side]
                line = sum(1 for p in opp if p in tf) >= 2
                pair = len(td) == 2 and td <= set(opp)
                oi = sum(iso.get(p, 0.0) for p in opp) / 5
                for p in mine:
                    mi = (sum(iso.get(q, 0.0) for q in mine) - iso.get(p, 0.0)) / 4
                    a = acc.setdefault(p, [0, 0, 0, 0.0, 0.0])
                    a[0] += sec
                    a[1] += sec if line else 0
                    a[2] += sec if pair else 0
                    a[3] += sec * oi
                    a[4] += sec * mi
    rows = []
    for p, (t5, l, pr, oi, mi) in acc.items():
        if t5 >= 3600:
            rows.append([p, round(t5 / 60, 1), round(100 * l / t5, 1), round(100 * pr / t5, 1), round(oi / t5, 4), round(mi / t5, 4)])
    return rows


def add_competition(y, cur):
    """Add competition fields to data/impact/{y}.json, fetching the season's games if they aren't cached."""
    path = os.path.join(OUT, f"{y}.json")
    imp = read_json(path)
    if not imp:
        return
    games = load_cache(y, "games")
    if not games:
        games = season_games(y, load_shots(y), {})
        if y >= cur - 2:
            save_cache(y, "games", games)
    imp["comp_fields"] = COMP_FIELDS
    imp["comp"] = competition(y, games, imp)
    write_json(path, imp)
    log(f"impact {y}: competition for {len(imp['comp'])} skaters")


# ------------------------------------------------------------------ forecast test
def forecast_test(years):
    """Does this season's 5v5 measure predict next season's on-ice results? Relative vs. isolated vs. blends."""
    out = []
    for y in years:
        a, b = read_json(os.path.join(OUT, f"{y}.json")), read_json(os.path.join(DATA, "seasons", f"{y + 1}.json"))
        sa = read_json(os.path.join(DATA, "seasons", f"{y}.json"))
        if not (a and b and sa):
            continue
        fa, fb = sa["fields"], b["fields"]
        cur = {r[0]: dict(zip(fa, r)) for r in sa["players"]}
        nxt = {r[0]: dict(zip(fb, r)) for r in b["players"]}
        imp = {r[0]: dict(zip(a["fields"], r)) for r in a["players"]}
        pts = []
        for pid, i in imp.items():
            c, n = cur.get(pid), nxt.get(pid)
            if not (c and n) or i["toi"] < 500 or (n.get("t5") or 0) < 500:
                continue
            try:
                rel = (c["xgf60"] - c["off_xgf60"]) - (c["xga60"] - c["off_xga60"])
                tgt = n["xgf60"] - n["xga60"]
                tgt_rel = (n["xgf60"] - n["off_xgf60"]) - (n["xga60"] - n["off_xga60"])
            except (KeyError, TypeError):
                continue
            pts.append((rel, i["off"] - i["def"], tgt, tgt_rel))
        if len(pts) < 100:
            continue

        def z(v):
            m = sum(v) / len(v)
            s = math.sqrt(sum((x - m) ** 2 for x in v) / len(v)) or 1
            return [(x - m) / s for x in v]

        zr, zi = z([p[0] for p in pts]), z([p[1] for p in pts])

        def corr(u, v):
            mu, mv = sum(u) / len(u), sum(v) / len(v)
            su = math.sqrt(sum((x - mu) ** 2 for x in u)) or 1
            sv = math.sqrt(sum((x - mv) ** 2 for x in v)) or 1
            return sum((x - mu) * (w - mv) for x, w in zip(u, v)) / (su * sv)

        # Two targets so neither method is favoured: next season's on-ice results and next season's relative results.
        row = {"season": y, "n": len(pts), "onice": {}, "rel": {}}
        for wgt in WEIGHTS:
            blend = [wgt * i + (1 - wgt) * r for r, i in zip(zr, zi)]
            row["onice"][str(wgt)] = round(corr(blend, [p[2] for p in pts]), 4)
            row["rel"][str(wgt)] = round(corr(blend, [p[3] for p in pts]), 4)
        out.append(row)
    if out:
        avg = {t: {str(w): round(sum(r[t][str(w)] for r in out) / len(out), 4) for w in WEIGHTS} for t in ("onice", "rel")}
        both = {str(w): round((avg["onice"][str(w)] + avg["rel"][str(w)]) / 2, 4) for w in WEIGHTS}
        best = max(both, key=both.get)
        log(f"forecast test ({len(out)} seasons): on-ice {avg['onice']} relative {avg['rel']} both {both} best isolated weight {best}")
        write_json(os.path.join(OUT, "test.json"), {"updated": dt.date.today().isoformat(), "seasons": out,
                                                    "average": avg, "both": both, "best_isolated_weight": float(best),
                                                    "min_minutes": 500,
                                                    "targets": {"onice": "next season's on-ice 5v5 xG differential per 60",
                                                                "rel": "next season's relative 5v5 xG differential per 60"}})


# ------------------------------------------------------------------ main
def cache_path(y, kind):
    return os.path.join(CACHE, f"{kind}_{y}.json")


def load_cache(y, kind):
    p = cache_path(y, kind)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None


def save_cache(y, kind, obj):
    os.makedirs(CACHE, exist_ok=True)
    with open(cache_path(y, kind), "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))


def normal_for(y, cur, force=False):
    """Season normal equations, from cache when the season is finished."""
    if y < cur and not force:
        j = load_cache(y, "normal")
        if j:
            return Normal.from_json(j)
    shots = load_shots(y)
    games = season_games(y, shots, load_cache(y, "games") or {})
    save_cache(y, "games", games)
    N = build_normal(y, games, shots)
    save_cache(y, "normal", N.to_json())
    return N


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--season", type=int)
    ap.add_argument("--first", type=int, default=FIRST)
    ap.add_argument("--lambda-test", type=int, help="run the penalty holdout test on this season and stop")
    ap.add_argument("--max-backfill", type=int, default=MAX_BACKFILL)
    args = ap.parse_args()
    cur = args.season or current_season()
    os.makedirs(OUT, exist_ok=True)
    if args.lambda_test:
        y = args.lambda_test
        shots = load_shots(y)
        games = season_games(y, shots, load_cache(y, "games") or {})
        save_cache(y, "games", games)
        res = choose_lambda(y, games, shots)
        write_json(os.path.join(OUT, "lambda_test.json"), {"season": y, "holdout_error": res})
        return
    todo = [y for y in range(args.first, cur + 1)
            if y == cur or args.full or not os.path.exists(os.path.join(OUT, f"{y}.json"))]
    past = [y for y in todo if y < cur][: args.max_backfill]
    todo = past + ([cur] if cur in todo else [])
    log(f"impact seasons this run: {todo}")
    normals = {}
    for y in todo:
        try:
            for z in (y - 2, y - 1, y):
                if z >= args.first and z not in normals:
                    normals[z] = normal_for(z, cur, force=args.full and z == y)
            three = None
            if all(z in normals for z in (y - 2, y - 1)):
                three = Normal()
                for z in (y - 2, y - 1, y):
                    three.merge(normals[z])
            write_json(os.path.join(OUT, f"{y}.json"), result(y, normals[y], three, LAMBDA))
            log(f"impact {y}: written")
            add_competition(y, cur)
        except Exception as e:  # noqa: BLE001
            log(f"impact {y} FAILED: {e}")
    # seasons built before competition fields existed get them a few at a time
    for y in [z for z in range(cur - 1, args.first - 1, -1) if z not in todo
              and "comp" not in (read_json(os.path.join(OUT, f"{z}.json")) or {"comp": 1})][: args.max_backfill]:
        try:
            add_competition(y, cur)
        except Exception as e:  # noqa: BLE001
            log(f"impact {y} competition FAILED: {e}")
    forecast_test([y for y in range(args.first, cur - 1)])


if __name__ == "__main__":
    main()
