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
LAMBDA_PP = 80.0        # ridge penalty for the power-play / penalty-kill fit (best of 5-80 in --pp-test, Nov 2026)
PRIOR_KEEP = 0.75       # share of last season's estimate each player starts from (best of 0/0.5/0.75/1 in --prior-test, Nov 2026)
PRIOR_SPM = True        # players with no usable last season start from a box-score estimate (--prior-test, Nov 2026)
PRIOR_MIN_TOI = 200     # minutes last season needed before his estimate is used as a starting point
NORMAL_VERSION = 2      # cached normal equations older than this are rebuilt
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
    """{full game id: [(period, sec_in_period, home_attacking, xg, goal, home_skaters, away_skaters)]}
    for every non-empty-net regular-season unblocked shot (5v5 and special teams)."""
    raw = fetch(SHOTS_URL.format(y=y))
    zf = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    out = {}
    with zf.open(name) as fh:
        rd = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"))
        first = True
        for r in rd:
            if first:
                need = ["game_id", "period", "time", "isHomeTeam", "xGoal", "goal", "homeSkatersOnIce", "awaySkatersOnIce"]
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
                g = int(float(r["game_id"]))
                gid = g if g > 1_000_000 else y * 1_000_000 + g
                per = int(float(r["period"]))
                t = int(float(r["time"])) - (per - 1) * 1200
                out.setdefault(gid, []).append((per, t, 1 if r["isHomeTeam"] in ("1", "1.0") else 0, float(r["xGoal"] or 0),
                                                1 if r.get("goal") in ("1", "1.0") else 0, hs, as_))
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


def all_stints(game, shots):
    """Yield (home_skaters, away_skaters, seconds, shots_in_stint, home_zone, home_score_diff) for every stretch
    with one goalie per side and the same skaters on the ice, regulation periods only.
    shots_in_stint: [(home_attacking, xg, goal, home_skaters_mp, away_skaters_mp)]."""
    goalies = set(game["g"])
    fo = {(p, t): z for p, t, z in game["f"]}
    goals = sorted(game["goals"])
    by_per = {}
    for pid, is_home, per, a, b in game["s"]:
        by_per.setdefault(per, []).append((pid, is_home, a, b))
    shot_by_per = {}
    for sh in shots:
        shot_by_per.setdefault(sh[0], []).append(sh[1:])
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
            while si < len(ps) and ps[si][0] <= a:
                si += 1
            j, inside = si, []
            while j < len(ps) and ps[j][0] <= b:
                inside.append(ps[j][1:])
                j += 1
            if len(hg) != 1 or len(ag) != 1 or not (3 <= len(hs) <= 6) or not (3 <= len(as_) <= 6):
                continue
            diff = sum(1 if g[2] else -1 for g in goals if (g[0], g[1]) < (per, a) or (g[0] == per and g[1] == a))
            yield hs, as_, b - a, inside, fo.get((per, a), "F"), diff


def stints(game, shots, full=False):
    """5v5 stints: (home_skaters, away_skaters, seconds, xg_home, xg_away, home_zone, home_score_diff),
    with full=True also (goals_home, goals_away, attempts_home, attempts_away). Only shots MoneyPuck
    also records as 5v5 are counted."""
    for hs, as_, sec, inside, zone, diff in all_stints(game, shots):
        if len(hs) != 5 or len(as_) != 5:
            continue
        xh = xa = gh = ga = fh = fa = 0.0
        for home_att, xg, goal, mh, ma in inside:
            if mh != 5 or ma != 5:
                continue
            if home_att:
                xh += xg; gh += goal; fh += 1
            else:
                xa += xg; ga += goal; fa += 1
        if full:
            yield hs, as_, sec, xh, xa, zone, diff, gh, ga, fh, fa
        else:
            yield hs, as_, sec, xh, xa, zone, diff


def pp_stints(game, shots):
    """5-on-4 stints: (pp_skaters, pk_skaters, seconds, pp_xg, pp_goals, pp_attempts, pp_is_home, zone_from_pp_side).
    Only the power-play team's shots that MoneyPuck also records as 5-on-4 are counted."""
    for hs, as_, sec, inside, zone, diff in all_stints(game, shots):
        if (len(hs), len(as_)) == (5, 4):
            pp, pk, home = hs, as_, 1
        elif (len(hs), len(as_)) == (4, 5):
            pp, pk, home = as_, hs, 0
        else:
            continue
        x = g = f = 0.0
        for home_att, xg, goal, mh, ma in inside:
            if home_att == home and ((mh, ma) == (5, 4) if home else (mh, ma) == (4, 5)):
                x += xg; g += goal; f += 1
        z = zone if home else {"O": "D", "D": "O"}.get(zone, zone)
        yield pp, pk, sec, x, g, f, home, z


# ------------------------------------------------------------------ regression
TARGETS = ("xg", "g", "f")   # expected goals, goals, unblocked shot attempts (all per 60)


class Normal:
    """Sparse normal equations X'WX and X'Wy (one y per target), built row by row.
    The same class holds the 5v5 fit (columns ("o", id) offense, ("d", id) defense) and the
    5-on-4 fit (columns ("p", id) power-play offense, ("k", id) penalty-kill defense)."""

    def __init__(self):
        self.idx = {}          # column key -> index
        self.A = []            # list of dicts
        self.B = {t: [] for t in TARGETS}
        self.toi = {}          # skater -> seconds (5v5, or on the power play)
        self.toi2 = {}         # skater -> seconds on the penalty kill (5-on-4 fit only)
        self.rows = 0
        self.wsum = 0.0
        self.ysum = 0.0

    @property
    def b(self):
        return self.B["xg"]

    def col(self, key):
        i = self.idx.get(key)
        if i is None:
            i = self.idx[key] = len(self.A)
            self.A.append({})
            for t in TARGETS:
                self.B[t].append(0.0)
        return i

    def add(self, cols, w, ys):
        A = self.A
        for i in cols:
            Ai = A[i]
            for j in cols:
                Ai[j] = Ai.get(j, 0.0) + w
            for t, v in ys.items():
                self.B[t][i] += v
        self.rows += 1
        self.wsum += w
        self.ysum += ys["xg"]

    def _ctx_cols(self, home, z, d):
        cols = [self.col(("c", "intercept"))]
        if home:
            cols.append(self.col(("c", "home")))
        if z == "O":
            cols.append(self.col(("c", "oz_start")))
        elif z == "D":
            cols.append(self.col(("c", "dz_start")))
        if d is None:
            return cols
        if d == 1:
            cols.append(self.col(("c", "lead1")))
        elif d >= 2:
            cols.append(self.col(("c", "lead2")))
        elif d == -1:
            cols.append(self.col(("c", "trail1")))
        elif d <= -2:
            cols.append(self.col(("c", "trail2")))
        return cols

    def add_stint(self, hs, as_, sec, xh, xa, zone, diff, gh=0.0, ga=0.0, fh=0.0, fa=0.0):
        w = sec / 3600.0
        for p in hs + as_:
            self.toi[p] = self.toi.get(p, 0) + sec
        for k in CONTEXT:
            self.col(("c", k))
        for att, dfn, x, g, f, home, z, d in ((hs, as_, xh, gh, fh, 1, zone, diff),
                                                (as_, hs, xa, ga, fa, 0, {"O": "D", "D": "O"}.get(zone, zone), -diff)):
            cols = self._ctx_cols(home, z, d) + [self.col(("o", p)) for p in att] + [self.col(("d", p)) for p in dfn]
            self.add(cols, w, {"xg": x, "g": g, "f": f})

    def add_pp(self, pp, pk, sec, x, g, f, home, z):
        w = sec / 3600.0
        for p in pp:
            self.toi[p] = self.toi.get(p, 0) + sec
        for p in pk:
            self.toi2[p] = self.toi2.get(p, 0) + sec
        cols = self._ctx_cols(home, z, None) + [self.col(("p", p)) for p in pp] + [self.col(("k", p)) for p in pk]
        self.add(cols, w, {"xg": x, "g": g, "f": f})

    def merge(self, other):
        remap = {k: self.col(k) for k in other.idx}
        for k, i_o in other.idx.items():
            i = remap[k]
            Ai = self.A[i]
            for j, v in other.A[i_o].items():
                jj = remap[other_keys(other)[j]]
                Ai[jj] = Ai.get(jj, 0.0) + v
            for t in TARGETS:
                self.B[t][i] += other.B[t][i_o]
        for src, dst in ((other.toi, self.toi), (other.toi2, self.toi2)):
            for p, sec in src.items():
                dst[p] = dst.get(p, 0) + sec
        self.rows += other.rows
        self.wsum += other.wsum
        self.ysum += other.ysum

    def to_json(self):
        keys = list(self.idx)
        return {"v": NORMAL_VERSION, "keys": [list(k) for k in keys], "A": [[[j, round(v, 6)] for j, v in r.items()] for r in self.A],
                "B": {t: [round(v, 6) for v in self.B[t]] for t in TARGETS},
                "toi": {str(k): v for k, v in self.toi.items()}, "toi2": {str(k): v for k, v in self.toi2.items()},
                "rows": self.rows, "wsum": self.wsum, "ysum": self.ysum}

    @classmethod
    def from_json(cls, j):
        if j.get("v") != NORMAL_VERSION:
            return None
        n = cls()
        for k in j["keys"]:
            n.col((k[0], k[1] if k[0] == "c" else int(k[1])))
        n.A = [{j_: v for j_, v in r} for r in j["A"]]
        n.B = {t: list(j["B"][t]) for t in TARGETS}
        n.toi = {int(k): v for k, v in j["toi"].items()}
        n.toi2 = {int(k): v for k, v in j.get("toi2", {}).items()}
        n.rows, n.wsum, n.ysum = j["rows"], j["wsum"], j["ysum"]
        return n

    def solve(self, lam, target="xg", prior=None, iters=400, tol=1e-8):
        """Conjugate gradients on (A + lam*I_skaters) x = b + lam*prior.
        prior: {column key: value} that skater columns are pulled toward instead of zero."""
        n = len(self.A)
        keys = list(self.idx)
        pen = [lam if k[0] != "c" else 1e-6 for k in keys]
        rows = [list(r.items()) for r in self.A]
        rhs = list(self.B[target])
        if prior:
            for i, k in enumerate(keys):
                v = prior.get(k)
                if v:
                    rhs[i] += lam * v

        def mul(x):
            out = [0.0] * n
            for i, r in enumerate(rows):
                s_ = pen[i] * x[i]
                for j, v in r:
                    s_ += v * x[j]
                out[i] = s_
            return out

        x = [0.0] * n
        r = list(rhs)
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


def other_keys(n):
    """Index -> key list for a Normal (cached on the object)."""
    ks = getattr(n, "_keys", None)
    if ks is None or len(ks) != len(n.idx):
        ks = n._keys = list(n.idx)
    return ks


# ------------------------------------------------------------------ season build
def season_games(y, shots, cache_games):
    """Fetch any games not in the cache; return {gid: compact game}."""
    need = [g for g in sorted(shots) if str(g) not in cache_games]
    log(f"impact {y}: {len(shots)} games with shots, {len(need)} to fetch")
    failed = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for gid, game, err in ex.map(fetch_game, need):
            if game:
                cache_games[str(gid)] = game
            else:
                failed[str(gid)] = err or "unavailable"
    if failed:
        log(f"impact {y}: {len(failed)} games unavailable")
    try:
        write_missing(y, failed, len(shots))
    except Exception as e:  # noqa: BLE001
        log(f"impact {y}: missing-games file FAILED: {e}")
    return cache_games


def write_missing(y, failed, n_games):
    """data/impact/missing.json: per season, the games whose NHL shift charts couldn't be read (so isolated impact
    leaves them out), with date, teams and reason, and a count by team. Read by the weekly health check."""
    path = os.path.join(OUT, "missing.json")
    allm = read_json(path, {}) or {}
    tf = read_json(os.path.join(DATA, "teams", f"{y}.json")) or {}
    info = {}
    for team, d in (tf.get("teams") or {}).items():
        for g in d.get("games", []):
            gid, date, opp, home = str(g[0]), g[1], g[2], g[3]
            if gid in failed and home:
                info[gid] = {"date": date, "home": team, "away": opp}
            elif gid in failed and gid not in info:
                info[gid] = {"date": date, "home": opp, "away": team}
    games, by_team = [], {}
    for gid in sorted(failed):
        i = info.get(gid, {})
        games.append({"game": gid, "date": i.get("date"), "home": i.get("home"), "away": i.get("away"), "why": failed[gid][:80]})
        for t in (i.get("home"), i.get("away")):
            if t:
                by_team[t] = by_team.get(t, 0) + 1
    allm[str(y)] = {"updated": dt.date.today().isoformat(), "games_with_shots": n_games, "missing": len(failed),
                    "by_team": dict(sorted(by_team.items(), key=lambda kv: (-kv[1], kv[0]))), "games": games}
    write_json(path, allm)
    if by_team:
        log(f"impact {y}: missing by team {allm[str(y)]['by_team']}")


def build_normal(y, games, shots, holdout=None):
    """5v5 normal equations for a season; holdout = set of game ids to skip (for the lambda test)."""
    N = Normal()
    n = 0
    for gid, game in games.items():
        if holdout and int(gid) in holdout:
            continue
        for st in stints(game, shots.get(int(gid), []), full=True):
            N.add_stint(*st)
            n += 1
    log(f"impact {y}: {n} stints, {len(N.toi)} skaters")
    return N


def build_pp(y, games, shots):
    """5-on-4 normal equations for a season."""
    P = Normal()
    n = 0
    for gid, game in games.items():
        for st in pp_stints(game, shots.get(int(gid), [])):
            P.add_pp(*st)
            n += 1
    log(f"impact {y}: {n} power-play stints, {len(P.toi)} on the PP, {len(P.toi2)} on the PK")
    return P


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


FIELDS = ["id", "toi", "off", "def", "toi3", "off3", "def3",
          "goff", "gdef", "goff3", "gdef3", "foff", "fdef", "foff3", "fdef3",
          "ppt", "pp", "pkt", "pk", "ppt3", "pp3", "pkt3", "pk3"]


def coefs(N, lam, target="xg", prior=None, a="o", b="d"):
    """{skater: [a-coefficient, b-coefficient]} and context from one solve."""
    c = N.solve(lam, target, prior)
    sk = {}
    for k, v in c.items():
        if k[0] in (a, b):
            sk.setdefault(k[1], [0.0, 0.0])[0 if k[0] == a else 1] = v
    return sk, {k[1]: round(v, 4) for k, v in c.items() if k[0] == "c"}


def result(y, single, three, lam, prior=None, pp=None, pp3=None, extra=None):
    """Season file. prior: starting points for the single-season xG fit (see PRIOR_KEEP)."""
    s1, c1 = coefs(single, lam, "xg", prior)
    s3, c3 = coefs(three, lam) if three else ({}, {})
    g1, _ = coefs(single, lam, "g")
    g3, _ = coefs(three, lam, "g") if three else ({}, {})
    f1, _ = coefs(single, lam, "f")
    f3, _ = coefs(three, lam, "f") if three else ({}, {})
    q1, cq = coefs(pp, LAMBDA_PP, "xg", None, "p", "k") if pp else ({}, {})
    q3, _ = coefs(pp3, LAMBDA_PP, "xg", None, "p", "k") if pp3 else ({}, {})
    r4 = lambda v: round(v, 4) if v is not None else None  # noqa: E731
    m1 = lambda N, p: round(N.toi.get(p, 0) / 60, 1) if N else None  # noqa: E731
    m2 = lambda N, p: round(N.toi2.get(p, 0) / 60, 1) if N else None  # noqa: E731
    rows = []
    for p in sorted(set(s1) | set(q1)):
        o, d = s1.get(p, [None, None])
        o3, d3 = s3.get(p, [None, None])
        go, gd = g1.get(p, [None, None]); go3, gd3 = g3.get(p, [None, None])
        fo, fd = f1.get(p, [None, None]); fo3, fd3 = f3.get(p, [None, None])
        pq, kq = (q1[p] if p in q1 else [None, None])
        pq3, kq3 = (q3[p] if p in q3 else [None, None])
        if pp and p in q1:   # a PP-only or PK-only player has the other coefficient fixed at zero by the penalty
            pq = pq if pp.toi.get(p) else None
            kq = kq if pp.toi2.get(p) else None
        if pp3 and p in q3:
            pq3 = pq3 if pp3.toi.get(p) else None
            kq3 = kq3 if pp3.toi2.get(p) else None
        rows.append([p, m1(single, p), r4(o), r4(d), m1(three, p) if three else None, r4(o3), r4(d3),
                     r4(go), r4(gd), r4(go3), r4(gd3), r4(fo), r4(fd), r4(fo3), r4(fd3),
                     m1(pp, p), r4(pq), m2(pp, p), r4(kq), m1(pp3, p), r4(pq3), m2(pp3, p), r4(kq3)])
    out = {"season": y, "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "lambda": lam,
           "lambda_pp": LAMBDA_PP, "prior_keep": PRIOR_KEEP, "prior_spm": PRIOR_SPM,
           "league_xg60": round(single.ysum / single.wsum, 4) if single.wsum else None,   # per team, per 60
           "league_pp_xg60": round(pp.ysum / pp.wsum, 4) if pp and pp.wsum else None,
           "context": c1, "context3": c3, "context_pp": cq, "fields": FIELDS, "players": rows}
    if extra:
        out.update(extra)
    return out


# ------------------------------------------------------------------ starting points (priors)
SPM_FEATS = ["ixg60", "ig60", "ia1_60", "isa60", "ihd60", "tk60", "gv60", "blk60", "hits60", "pend60", "pen60"]


def season_rows(y):
    j = read_json(os.path.join(DATA, "seasons", f"{y}.json"))
    if not j:
        return {}
    f = j["fields"]
    return {r[0]: dict(zip(f, r)) for r in j["players"]}


def _ols(X, Y, W, ridge=1e-3):
    """Weighted least squares with a tiny ridge, by Gaussian elimination."""
    k = len(X[0])
    A = [[0.0] * k for _ in range(k)]
    b = [0.0] * k
    for x, yv, w in zip(X, Y, W):
        for i in range(k):
            b[i] += w * x[i] * yv
            for j in range(k):
                A[i][j] += w * x[i] * x[j]
    for i in range(k):
        A[i][i] += ridge
    M = [row[:] + [bi] for row, bi in zip(A, b)]
    for c in range(k):
        piv = max(range(c, k), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        for r in range(k):
            if r != c:
                fct = M[r][c] / M[c][c]
                for cc in range(c, k + 1):
                    M[r][cc] -= fct * M[c][cc]
    return [M[i][k] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(k)]


def spm_features(r):
    try:
        return [1.0] + [float(r.get(k) or 0) for k in SPM_FEATS]
    except (TypeError, ValueError):
        return None


def spm_fit(estimates):
    """Box-score model: predicts a skater's isolated offense and defense from his individual per-60 stats.
    estimates: {season: {id: (off, def, toi)}}. Fit by position group, weighted by minutes, on 800+ minute seasons."""
    data = {g: ([], [], [], []) for g in ("F", "D")}
    for y, est in estimates.items():
        rows = season_rows(y)
        for pid, (o, d, toi) in est.items():
            r = rows.get(pid)
            if not r or toi < 800:
                continue
            x = spm_features(r)
            if not x:
                continue
            g = "D" if r.get("pos") == "D" else "F"
            data[g][0].append(x); data[g][1].append(o); data[g][2].append(d); data[g][3].append(toi)
    model = {}
    for g, (X, O, D, W) in data.items():
        if len(X) >= 100:
            model[g] = (_ols(X, O, W), _ols(X, D, W))
    return model


def spm_predict(model, r):
    g = "D" if r.get("pos") == "D" else "F"
    if g not in model:
        return None
    x = spm_features(r)
    if not x:
        return None
    co, cd = model[g]
    return sum(a * b for a, b in zip(co, x)), sum(a * b for a, b in zip(cd, x))


def make_prior(prev, keep, spm_model=None, rows=None):
    """Starting points for a single-season fit: keep x last season's estimate where he played PRIOR_MIN_TOI+
    minutes, else (with a box-score model) the box-score estimate from this season's individual stats."""
    pr = {}
    for pid, (o, d, toi) in (prev or {}).items():
        if toi >= PRIOR_MIN_TOI and keep:
            pr[("o", pid)] = keep * o
            pr[("d", pid)] = keep * d
    if spm_model and rows:
        for pid, r in rows.items():
            if ("o", pid) in pr:
                continue
            v = spm_predict(spm_model, r)
            if v:
                pr[("o", pid)], pr[("d", pid)] = v
    return pr


def file_estimates(y):
    j = read_json(os.path.join(OUT, f"{y}.json"))
    if not j:
        return None
    f = j["fields"]
    out = {}
    for r in j["players"]:
        d = dict(zip(f, r))
        if d.get("off") is not None:
            out[d["id"]] = (d["off"], d["def"], d.get("toi") or 0)
    return out


def next_season_corr(est, y):
    """Correlation of a skater's net estimate (offense minus defense) with next season's on-ice and relative
    5v5 xG differential per 60, for skaters with 500+ minutes in both. Returns (onice, relative, n)."""
    cur, nxt = season_rows(y), season_rows(y + 1)
    xs, a, b = [], [], []
    for pid, (o, d, toi) in est.items():
        n_ = nxt.get(pid)
        if toi < 500 or not n_ or (n_.get("t5") or 0) < 500:
            continue
        try:
            a.append(n_["xgf60"] - n_["xga60"])
            b.append((n_["xgf60"] - n_["off_xgf60"]) - (n_["xga60"] - n_["off_xga60"]))
        except (KeyError, TypeError):
            continue
        xs.append(o - d)
    if len(xs) < 100:
        return None

    def corr(u, v):
        mu, mv = sum(u) / len(u), sum(v) / len(v)
        su = math.sqrt(sum((x - mu) ** 2 for x in u)) or 1
        sv = math.sqrt(sum((x - mv) ** 2 for x in v)) or 1
        return sum((x - mu) * (w - mv) for x, w in zip(u, v)) / (su * sv)
    return corr(xs, a), corr(xs, b), len(xs)


def prior_test(normals, first, last):
    """Which starting point predicts next season best? Variants: keep 0 / 0.5 / 0.75 / 1 of last season's
    estimate, each with and without a box-score starting point for players with no usable last season."""
    keeps = (0.0, 0.5, 0.75, 1.0)
    base = {}   # plain fits (start at zero), also used to fit the box-score model on earlier seasons only
    for y in range(first, last + 1):
        if y in normals:
            sk, _ = coefs(normals[y], LAMBDA)
            base[y] = {p: (o, d, normals[y].toi.get(p, 0) / 60) for p, (o, d) in sk.items()}
    res = {}
    for keep in keeps:
        for spm in (False, True):
            if keep == 0.0 and not spm:
                est_by = base
            else:
                est_by, prev = {}, None
                for y in range(first, last + 1):
                    if y not in normals:
                        prev = None
                        continue
                    model = spm_fit({z: base[z] for z in base if z < y}) if spm else None
                    pr = make_prior(prev, keep, model, season_rows(y) if spm else None)
                    sk, _ = coefs(normals[y], LAMBDA, "xg", pr)
                    est_by[y] = {p: (o, d, normals[y].toi.get(p, 0) / 60) for p, (o, d) in sk.items()}
                    prev = est_by[y]
            per = []
            for y in range(first, last):
                if y in est_by:
                    c = next_season_corr(est_by[y], y)
                    if c:
                        per.append({"season": y, "onice": round(c[0], 4), "rel": round(c[1], 4), "n": c[2]})
            if per:
                on = sum(r["onice"] for r in per) / len(per)
                rl = sum(r["rel"] for r in per) / len(per)
                key = f"keep {keep}" + (" + box score" if spm else "")
                res[key] = {"keep": keep, "spm": spm, "onice": round(on, 4), "rel": round(rl, 4), "both": round((on + rl) / 2, 4), "seasons": per}
                log(f"prior test {key}: on-ice {on:.4f} relative {rl:.4f} both {(on + rl) / 2:.4f} ({len(per)} seasons)")
    best = max(res, key=lambda k: res[k]["both"])
    write_json(os.path.join(OUT, "prior_test.json"), {"updated": dt.date.today().isoformat(), "variants": res, "best": best,
                                                       "min_minutes": 500, "prior_min_toi": PRIOR_MIN_TOI})
    log(f"prior test best: {best}")
    return res


def pp_test(pps, first, last):
    """Power play and penalty kill: which penalty, and which blend of isolated and on-ice numbers,
    best predicts next season's on-ice PP xGF/60 (PK xGA/60)? Players with 100+ minutes in both seasons."""
    def corr(u, v):
        mu, mv = sum(u) / len(u), sum(v) / len(v)
        su = math.sqrt(sum((x - mu) ** 2 for x in u)) or 1
        sv = math.sqrt(sum((x - mv) ** 2 for x in v)) or 1
        return sum((x - mu) * (w - mv) for x, w in zip(u, v)) / (su * sv)

    def z(v):
        m = sum(v) / len(v)
        s_ = math.sqrt(sum((x - m) ** 2 for x in v) / len(v)) or 1
        return [(x - m) / s_ for x in v]
    out = {}
    for lam in (5.0, 10.0, 20.0, 40.0, 80.0):
        acc = {"pp": {str(w): [] for w in WEIGHTS}, "pk": {str(w): [] for w in WEIGHTS}}
        for y in range(first, last):
            if y not in pps:
                continue
            sk, _ = coefs(pps[y], lam, "xg", None, "p", "k")
            cur, nxt = season_rows(y), season_rows(y + 1)
            for side, fld, ti, idx, sign in (("pp", "pp_xgf60", "pp", 0, 1), ("pk", "pk_xga60", "pk", 1, -1)):
                iso, onice, tgt = [], [], []
                for pid, v in sk.items():
                    c, n_ = cur.get(pid), nxt.get(pid)
                    tmin = (pps[y].toi if side == "pp" else pps[y].toi2).get(pid, 0) / 60
                    if not c or not n_ or tmin < 100 or c.get(fld) is None or n_.get(fld) is None:
                        continue
                    if (n_.get(ti) or 0) * (n_.get("gp") or 0) < 100:
                        continue
                    iso.append(sign * v[idx]); onice.append(sign * c[fld]); tgt.append(sign * n_[fld])
                if len(iso) < 60:
                    continue
                zi, zo = z(iso), z(onice)
                for w in WEIGHTS:
                    acc[side][str(w)].append(corr([w * a + (1 - w) * b for a, b in zip(zi, zo)], tgt))
        out[str(lam)] = {side: {w: round(sum(v) / len(v), 4) for w, v in d.items() if v} for side, d in acc.items()}
        log(f"pp test lambda {lam}: {out[str(lam)]}")
    best_lam = max(out, key=lambda l: (out[l]["pp"].get("1", 0) + out[l]["pk"].get("1", 0)))
    bl = out[best_lam]
    best_w = {side: float(max(bl[side], key=bl[side].get)) for side in ("pp", "pk") if bl[side]}
    write_json(os.path.join(OUT, "pp_test.json"), {"updated": dt.date.today().isoformat(), "by_lambda": out,
                                                    "best_lambda": float(best_lam), "best_isolated_weight": best_w,
                                                    "target": "next season's on-ice 5-on-4 xGF/60 (PP) or xGA/60 (PK)",
                                                    "min_minutes": 100})
    log(f"pp test best lambda {best_lam}, best isolated weights {best_w}")
    return out


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
    """Season normal equations (5v5, 5-on-4), from cache when the season is finished."""
    if y < cur and not force:
        jn, jp = load_cache(y, "normal"), load_cache(y, "ppnormal")
        N = Normal.from_json(jn) if jn else None
        P = Normal.from_json(jp) if jp else None
        if N and P:
            return N, P
    shots = load_shots(y)
    games = season_games(y, shots, load_cache(y, "games") or {})
    if y >= cur - 2:
        save_cache(y, "games", games)
    N, P = build_normal(y, games, shots), build_pp(y, games, shots)
    save_cache(y, "normal", N.to_json())
    save_cache(y, "ppnormal", P.to_json())
    return N, P


def merged(parts):
    M = Normal()
    for x in parts:
        M.merge(x)
    return M


def main():
    global LAMBDA_PP, PRIOR_KEEP, PRIOR_SPM
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="refetch and rebuild every season")
    ap.add_argument("--rewrite", action="store_true", help="rewrite every season file from cached fits (after a settings change)")
    ap.add_argument("--season", type=int)
    ap.add_argument("--first", type=int, default=FIRST)
    ap.add_argument("--lambda-test", type=int, help="run the penalty holdout test on this season and stop")
    ap.add_argument("--prior-test", action="store_true", help="test starting points for the single-season fit")
    ap.add_argument("--pp-test", action="store_true", help="test the power-play / penalty-kill penalty and blend")
    ap.add_argument("--prior-keep", type=float)
    ap.add_argument("--prior-spm", type=int)
    ap.add_argument("--lambda-pp", type=float)
    ap.add_argument("--max-backfill", type=int, default=MAX_BACKFILL)
    args = ap.parse_args()
    if args.prior_keep is not None:
        PRIOR_KEEP = args.prior_keep
    if args.prior_spm is not None:
        PRIOR_SPM = bool(args.prior_spm)
    if args.lambda_pp is not None:
        LAMBDA_PP = args.lambda_pp
    cur = args.season or current_season()
    os.makedirs(OUT, exist_ok=True)
    if args.lambda_test:
        y = args.lambda_test
        shots = load_shots(y)
        games = season_games(y, shots, load_cache(y, "games") or {})
        res = choose_lambda(y, games, shots)
        write_json(os.path.join(OUT, "lambda_test.json"), {"season": y, "holdout_error": res})
        return
    every = args.full or args.rewrite or args.prior_test or args.pp_test
    todo = [y for y in range(args.first, cur + 1)
            if y == cur or every or not os.path.exists(os.path.join(OUT, f"{y}.json"))]
    past = [y for y in todo if y < cur][: (None if every else args.max_backfill)]
    todo = past + ([cur] if cur in todo else [])
    log(f"impact seasons this run: {todo}")
    normals, pps = {}, {}
    for y in todo:
        try:
            for z in (y - 2, y - 1, y):
                if z >= args.first and z not in normals:
                    normals[z], pps[z] = normal_for(z, cur, force=args.full and z == y)
            three = merged([normals[z] for z in (y - 2, y - 1, y)]) if all(z in normals for z in (y - 2, y - 1)) else None
            pp3 = merged([pps[z] for z in (y - 2, y - 1, y)]) if all(z in pps for z in (y - 2, y - 1)) else None
            prior = None
            if PRIOR_KEEP or PRIOR_SPM:
                model = spm_fit({z: e for z in range(args.first, y) if (e := file_estimates(z))}) if PRIOR_SPM else None
                prior = make_prior(file_estimates(y - 1), PRIOR_KEEP, model, season_rows(y) if PRIOR_SPM else None)
            old = read_json(os.path.join(OUT, f"{y}.json")) or {}
            keep = {k: old[k] for k in ("comp", "comp_fields") if k in old}
            write_json(os.path.join(OUT, f"{y}.json"), result(y, normals[y], three, LAMBDA, prior, pps[y], pp3, keep))
            log(f"impact {y}: written")
            if "comp" not in keep or y == cur:
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
    if args.prior_test:
        prior_test(normals, args.first, cur - 1)
    if args.pp_test:
        pp_test(pps, args.first, cur - 1)
    forecast_test([y for y in range(args.first, cur - 1)])


if __name__ == "__main__":
    main()
