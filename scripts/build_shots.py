#!/usr/bin/env python3
"""Build per-player shot maps from MoneyPuck's shot-level data.

Input: https://peter-tanner.com/moneypuck/downloads/shots_{year}.zip (one CSV per season,
unblocked shot attempts: shots on goal, misses and goals; blocked shots aren't included).

Output: data/shots/{year}.json with, for every skater, a sparse grid of the offensive zone
(5 x 5 ft cells) holding attempts, goals and expected goals, split by situation
(all, 5v5, power play), plus league totals by position group for comparison.

Regular season only; empty-net shots are left out. Default run rebuilds only the current season
and any season that is missing; --full rebuilds everything.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, MP_FIRST, current_season, fetch, log, write_json  # noqa: E402

SHOTS_URL = "https://peter-tanner.com/moneypuck/downloads/shots_{y}.zip"
X0, X1, Y0, Y1, CELL = 25, 100, -42.5, 42.5, 5  # offensive zone, feet
NX, NY = int((X1 - X0) / CELL), int(round((Y1 - Y0) / CELL))
SITS = ("all", "ev", "pp")


def col(row, *names, default=None):
    for n in names:
        if n in row and row[n] not in ("", None):
            return row[n]
    return default


def fnum(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def build(y: int):
    raw = fetch(SHOTS_URL.format(y=y))
    zf = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    players = {}   # pid -> {sit: {cell: [n, g, xg]}}
    league = {}    # grp -> {sit: {cell: [n, g, xg]}}
    pos_of = {}
    sp = os.path.join(DATA, "seasons", f"{y}.json")
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            for r in json.load(f)["players"]:
                pos_of[r[0]] = r[3]
    checked = False
    kept = 0
    with zf.open(name) as fh:
        reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"))
        for row in reader:
            if not checked:
                need = ["shooterPlayerId", "xGoal", "goal"]
                missing = [k for k in need if k not in row]
                if missing or not any(k in row for k in ("xCordAdjusted", "arenaAdjustedXCordABS")):
                    raise RuntimeError(f"unexpected shot columns; missing {missing}; have {list(row)[:40]}")
                checked = True
            if fnum(col(row, "isPlayoffGame"), 0) == 1:
                continue
            if fnum(col(row, "shotOnEmptyNet"), 0) == 1:
                continue
            pid = col(row, "shooterPlayerId")
            if not pid or pid in ("0", "0.0"):
                continue
            pid = int(float(pid))
            x = fnum(col(row, "xCordAdjusted", "arenaAdjustedXCordABS"), None)
            yv = fnum(col(row, "yCordAdjusted", "arenaAdjustedYCord", "arenaAdjustedYCordAbs"), None)
            if x is None or yv is None:
                continue
            x = abs(x)
            if x > X1:
                x = X1 - 0.01
            cx = min(NX - 1, max(0, int((x - X0) // CELL)))
            cy = min(NY - 1, max(0, int((yv - Y0) // CELL)))
            cell = cy * NX + cx
            g = 1 if fnum(col(row, "goal"), 0) == 1 else 0
            xg = fnum(col(row, "xGoal"), 0)
            home = fnum(col(row, "isHomeTeam"), 0) == 1
            hs, as_ = fnum(col(row, "homeSkatersOnIce"), 5), fnum(col(row, "awaySkatersOnIce"), 5)
            mine, opp = (hs, as_) if home else (as_, hs)
            sits = ["all"]
            if mine == 5 and opp == 5:
                sits.append("ev")
            elif mine > opp:
                sits.append("pp")
            if pid not in pos_of:
                pos = (col(row, "playerPositionThatDidEvent", default="") or "").upper()[:1]
                if pos in ("C", "L", "R", "D"):
                    pos_of[pid] = pos
            grp = "D" if pos_of.get(pid) == "D" else "F"
            for s in sits:
                for bucket in (players.setdefault(pid, {}).setdefault(s, {}), league.setdefault(grp, {}).setdefault(s, {})):
                    c = bucket.setdefault(cell, [0, 0, 0.0])
                    c[0] += 1
                    c[1] += g
                    c[2] += xg
            kept += 1
    out_players = {}
    for pid, by in players.items():
        if sum(c[0] for c in by.get("all", {}).values()) < 10:
            continue
        out_players[str(pid)] = {s: [[cell, c[0], c[1], round(c[2] * 100)] for cell, c in sorted(by[s].items())] for s in SITS if s in by}
    out_league = {grp: {s: [[cell, c[0], c[1], round(c[2] * 100)] for cell, c in sorted(by[s].items())] for s in SITS if s in by} for grp, by in league.items()}
    log(f"shots {y}: {kept} shots, {len(out_players)} shooters")
    return {"season": y, "grid": {"x0": X0, "x1": X1, "y0": Y0, "y1": Y1, "cell": CELL, "nx": NX, "ny": NY},
            "fields": ["cell", "shots", "goals", "xg_x100"], "players": out_players, "league": out_league}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--season", type=int)
    args = ap.parse_args()
    cur = args.season or current_season()
    errors = []
    for y in range(MP_FIRST, cur + 1):
        path = os.path.join(DATA, "shots", f"{y}.json")
        if not args.full and y < cur and os.path.exists(path):
            continue
        try:
            write_json(path, build(y))
        except Exception as e:  # noqa: BLE001
            errors.append(f"{y}: {e}")
            log(f"shots {y} FAILED: {e}")
    if errors and len(errors) == cur - MP_FIRST + 1:
        sys.exit(1)


if __name__ == "__main__":
    main()
