#!/usr/bin/env python3
"""Build deployment data: how each player was used game by game, and how he did in each role.

Input: MoneyPuck game-by-game skater files
  https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/skaters/{year}.zip
  (one row per player, game and situation; same stats as the season files).

For every team and game, players are slotted by their ice time that night:
  - even strength: forwards ranked by 5v5 time -> line 1-4 (3 per line),
    defensemen -> pair 1-3 (2 per pair)
  - power play: skaters ranked by 5-on-4 time -> unit 1 (top 5) or 2 (next 5)
  - penalty kill: forwards ranked by 4-on-5 time -> unit 1 (top 2) or 2 (next 2); same for D
  - zone: 5v5 offensive- vs defensive-zone shift starts that night

Output: data/usage/{year}.json
  baselines  league-wide 5v5 results for each line / pair slot, and PP / PK units
  players    per player: games in each slot and his 5v5 totals in each slot,
             results by zone usage, PP and PK totals by unit
Output: data/teams/{year}.json (the teams page)
  per team, every game in order: date, opponent, home/away, the team's 5v5 minutes, xGF, xGA, GF, GA
  (the sum of its skaters' on-ice numbers divided by 5, exact at 5v5), and per player a slot string
  with one character per game: forwards 1-4 (line), defensemen 1-3 (pair), "." not dressed;
  plus a power-play string (1 or 2 = unit, "." none).
Output: data/teams/coaches/{year}.json  {gameId: [away head coach, home head coach]} from the NHL's
  game-center right rail. Each run fetches at most --coach-budget games (newest season first), so the
  history fills in over a few nights and later runs only fetch new games.

Default run rebuilds the current season and anything missing; --full rebuilds everything.
"""
from __future__ import annotations

import argparse
import csv
import json
from concurrent.futures import ThreadPoolExecutor
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, MP_FIRST, current_season, fetch, log, read_json, write_json  # noqa: E402

GBG_URL = "https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/skaters/{y}.zip"
SITS = {"5on5", "5on4", "4on5"}
COACH_URL = "https://api-web.nhle.com/v1/gamecenter/{g}/right-rail"
COACH_BUDGET = 1500  # games looked up per run
# 5v5 tallies kept per bucket: games, seconds, xGF, xGA, GF, GA, CF, CA, points, ixG
EV_KEYS = ("t", "xgf", "xga", "gf", "ga", "cf", "ca", "pts", "ixg")


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def new_ev():
    return [0] + [0.0] * len(EV_KEYS)


def add_ev(acc, ev):
    acc[0] += 1
    for i, v in enumerate(ev):
        acc[i + 1] += v


def rnd(a, nd=2):
    return [a[0]] + [round(v, nd) if isinstance(v, float) else v for v in a[1:]]


def build(y: int):
    raw = fetch(GBG_URL.format(y=y))
    zf = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    games = {}  # (gameId, team) -> {pid: {"pos":, "5on5": [...], "5on4": [...], "4on5": [...]}}
    with zf.open(name) as fh:
        rd = csv.reader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"))
        head = next(rd)
        ix = {k: i for i, k in enumerate(head)}
        need = ["playerId", "gameId", "playerTeam", "position", "situation", "icetime",
                "OnIce_F_xGoals", "OnIce_A_xGoals", "OnIce_F_goals", "OnIce_A_goals",
                "OnIce_F_shotAttempts", "OnIce_A_shotAttempts", "I_F_points", "I_F_xGoals",
                "I_F_oZoneShiftStarts", "I_F_dZoneShiftStarts"]
        miss = [k for k in need if k not in ix]
        if miss:
            raise RuntimeError(f"game-by-game file missing columns {miss}")
        si, pi, gi, ti, oi = ix["situation"], ix["playerId"], ix["gameId"], ix["playerTeam"], ix["position"]
        di, opi, hi = ix.get("gameDate"), ix.get("opposingTeam"), ix.get("home_or_away")
        ginfo = {}  # (gameId, team) -> (date, opponent, home)
        cols = [ix[k] for k in ("icetime", "OnIce_F_xGoals", "OnIce_A_xGoals", "OnIce_F_goals", "OnIce_A_goals",
                                "OnIce_F_shotAttempts", "OnIce_A_shotAttempts", "I_F_points", "I_F_xGoals",
                                "I_F_oZoneShiftStarts", "I_F_dZoneShiftStarts")]
        for row in rd:
            if len(row) < len(head):
                continue
            sit = row[si]
            if sit not in SITS:
                continue
            key = (row[gi], row[ti])
            if key not in ginfo:
                ginfo[key] = (row[di] if di is not None else "", row[opi] if opi is not None else "",
                              1 if hi is not None and row[hi].upper().startswith("H") else 0)
            p = games.setdefault(key, {}).setdefault(int(float(row[pi])), {"pos": row[oi]})
            p[sit] = [fnum(row[c]) for c in cols]
    log(f"usage {y}: {len(games)} team-games")

    players = {}
    base_ev = {"F": [new_ev() for _ in range(4)], "D": [new_ev() for _ in range(3)]}
    base_pp = [[0, 0.0, 0.0, 0.0] for _ in range(2)]   # games, seconds, xGF, points
    base_pk = {"F": [[0, 0.0, 0.0] for _ in range(2)], "D": [[0, 0.0, 0.0] for _ in range(2)]}  # games, seconds, xGA

    def pl(pid, grp):
        return players.setdefault(pid, {
            "grp": grp,
            "ev": [new_ev() for _ in range(4 if grp == "F" else 3)],
            "zone": {"oz": new_ev(), "nz": new_ev(), "dz": new_ev()},
            "pp": [[0, 0.0, 0.0, 0.0] for _ in range(3)],   # unit 1, 2, none (games, sec, xGF, pts)
            "pk": [[0, 0.0, 0.0] for _ in range(3)],         # unit 1, 2, none (games, sec, xGA)
        })

    tg = {}  # team -> list of [gameId, slots {pid: slot}, pp {pid: unit}, totals]
    for (gid, team), roster in games.items():
        dressed = [(pid, p) for pid, p in roster.items() if "5on5" in p]
        slots_g, pp_g = {}, {}
        ev = [sum(p["5on5"][i] for _, p in dressed) / 5 for i in range(5)]  # t, xgf, xga, gf, ga
        tg.setdefault(team, []).append((gid, slots_g, pp_g, ev))
        for grp, per, n in (("F", 3, 4), ("D", 2, 3)):
            sk = [(pid, p) for pid, p in dressed if (p["pos"] == "D") == (grp == "D")]
            sk.sort(key=lambda x: -x[1]["5on5"][0])
            for r, (pid, p) in enumerate(sk):
                slot = min(n - 1, r // per)
                slots_g[pid] = slot
                ev = p["5on5"][:9]
                P = pl(pid, grp)
                add_ev(P["ev"][slot], ev)
                add_ev(base_ev[grp][slot], ev)
                oz, dz = p["5on5"][9], p["5on5"][10]
                z = "oz" if oz >= dz + 2 else "dz" if dz >= oz + 2 else "nz"
                add_ev(P["zone"][z], ev)
            # penalty kill units by position group
            pk = sorted([(pid, p) for pid, p in sk], key=lambda x: -(x[1].get("4on5", [0])[0]))
            for r, (pid, p) in enumerate(pk):
                k = p.get("4on5")
                unit = 0 if r < 2 and k and k[0] >= 30 else 1 if r < 4 and k and k[0] >= 30 else 2
                t = k[0] if k else 0.0
                xa = k[2] if k else 0.0
                a = pl(pid, grp)["pk"][unit]
                a[0] += 1; a[1] += t; a[2] += xa
                if unit < 2:
                    b = base_pk[grp][unit]; b[0] += 1; b[1] += t; b[2] += xa
        # power play units across all skaters
        pp = sorted(dressed, key=lambda x: -(x[1].get("5on4", [0])[0]))
        for r, (pid, p) in enumerate(pp):
            k = p.get("5on4")
            unit = 0 if r < 5 and k and k[0] >= 30 else 1 if r < 10 and k and k[0] >= 30 else 2
            if unit < 2:
                pp_g[pid] = unit
            t = k[0] if k else 0.0
            xf = k[1] if k else 0.0
            pts = k[7] if k else 0.0
            grp = "D" if p["pos"] == "D" else "F"
            a = pl(pid, grp)["pp"][unit]
            a[0] += 1; a[1] += t; a[2] += xf; a[3] += pts
            if unit < 2:
                b = base_pp[unit]; b[0] += 1; b[1] += t; b[2] += xf; b[3] += pts

    out = {}
    for pid, P in players.items():
        gp = sum(a[0] for a in P["ev"])
        if gp < 5:
            continue
        out[str(pid)] = {
            "g": P["grp"],
            "ev": [rnd(a) for a in P["ev"]],
            "zone": [rnd(P["zone"][k]) for k in ("oz", "nz", "dz")],
            "pp": [[a[0], round(a[1]), round(a[2], 2), int(a[3])] for a in P["pp"]],
            "pk": [[a[0], round(a[1]), round(a[2], 2)] for a in P["pk"]],
        }
    teams = {}
    for team, lst in tg.items():
        lst.sort(key=lambda g: (ginfo.get((g[0], team), ("",))[0], g[0]))
        rows, sl, pp = [], {}, {}
        n = len(lst)
        for i, (gid, slots_g, pp_g, ev) in enumerate(lst):
            d, opp, home = ginfo.get((gid, team), ("", "", 0))
            rows.append([gid, d, opp, home, round(ev[0]), round(ev[1], 2), round(ev[2], 2), round(ev[3]), round(ev[4])])
            for pid, k in slots_g.items():
                sl.setdefault(str(pid), ["."] * n)[i] = str(k + 1)
            for pid, k in pp_g.items():
                pp.setdefault(str(pid), ["."] * n)[i] = str(k + 1)
        teams[team] = {"games": rows, "slots": {k: "".join(v) for k, v in sl.items()},
                       "pp": {k: "".join(v) for k, v in pp.items()}}
    return {
        "season": y,
        "teams": teams,
        "ev_fields": ["games", *EV_KEYS],
        "baselines": {
            "ev": {g: [rnd(a) for a in v] for g, v in base_ev.items()},
            "pp": [[a[0], round(a[1]), round(a[2], 2), int(a[3])] for a in base_pp],
            "pk": {g: [[a[0], round(a[1]), round(a[2], 2)] for a in v] for g, v in base_pk.items()},
        },
        "players": out,
    }


def coach_of(gid):
    try:
        gi = json.loads(fetch(COACH_URL.format(g=gid), tries=2).decode("utf-8")).get("gameInfo") or {}
    except Exception:  # noqa: BLE001
        return gid, None
    name = lambda side: ((gi.get(side) or {}).get("headCoach") or {}).get("default")  # noqa: E731
    return gid, [name("awayTeam"), name("homeTeam")]


def update_coaches(cur, budget):
    for y in range(cur, MP_FIRST - 1, -1):
        if budget <= 0:
            break
        tf = read_json(os.path.join(DATA, "teams", f"{y}.json"))
        if not tf:
            continue
        path = os.path.join(DATA, "teams", "coaches", f"{y}.json")
        have = read_json(path, {})
        gids = sorted({row[0] for t in tf["teams"].values() for row in t["games"]})
        todo = [g for g in gids if g not in have][:budget]
        if not todo:
            continue
        with ThreadPoolExecutor(max_workers=6) as ex:
            got = list(ex.map(coach_of, todo))
        ok = 0
        for gid, c in got:
            if c is not None:
                have[gid] = c
                ok += 1
        budget -= len(todo)
        write_json(path, have)
        log(f"coaches {y}: {ok} of {len(todo)} games looked up, {len(have)} of {len(gids)} known")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--season", type=int)
    ap.add_argument("--coach-budget", type=int, default=COACH_BUDGET)
    args = ap.parse_args()
    cur = args.season or current_season()
    fails = 0
    for y in range(MP_FIRST, cur + 1):
        path = os.path.join(DATA, "usage", f"{y}.json")
        tpath = os.path.join(DATA, "teams", f"{y}.json")
        if not args.full and y < cur and os.path.exists(path) and os.path.exists(tpath):
            continue
        try:
            out = build(y)
            write_json(os.path.join(DATA, "teams", f"{y}.json"), {
                "season": y, "game_fields": ["game", "date", "opp", "home", "t5", "xgf", "xga", "gf", "ga"],
                "teams": out.pop("teams")})
            write_json(path, out)
        except Exception as e:  # noqa: BLE001
            fails += 1
            log(f"usage {y} FAILED: {e}")
    if fails == cur - MP_FIRST + 1:
        sys.exit(1)
    try:
        update_coaches(cur, args.coach_budget)
    except Exception as e:  # noqa: BLE001
        log(f"coaches FAILED: {e}")


if __name__ == "__main__":
    main()
