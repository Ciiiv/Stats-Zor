#!/usr/bin/env python3
"""Build box-score detail and faceoffs by zone for every skater-season (NHL stats API).

Source: https://api.nhle.com/stats/rest/en/skater/{summary, scoringpergame, realtime, shootout, faceoffwins}
One set of reports per season (a few requests each, paged 100 rows at a time), so past seasons are built
once and kept; the default run refreshes only the current season and anything missing.

Output: data/box/{year}.json  one row per skater with fields FIELDS:
  even-strength / power-play / shorthanded goals and points, primary and secondary assists,
  game-winning, overtime, empty-net and shootout goals, plus/minus, penalty minutes, shots and all
  shot attempts (on net + missed + blocked), and faceoffs won/lost overall, by zone (offensive,
  defensive, neutral) and by situation (even strength, power play, shorthanded).
These are descriptive only: nothing here feeds the value model. Zone faceoffs are blank (null)
in seasons where the NHL didn't record them.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, MP_FIRST, current_season, log, nhl_report, write_json  # noqa: E402

# (output name, report, NHL field)
COLS = [
    ("gp", "skater/summary", "gamesPlayed"),
    ("g", "skater/summary", "goals"),
    ("a", "skater/summary", "assists"),
    ("evg", "skater/summary", "evGoals"),
    ("evp", "skater/summary", "evPoints"),
    ("ppg", "skater/summary", "ppGoals"),
    ("ppp", "skater/summary", "ppPoints"),
    ("shg", "skater/summary", "shGoals"),
    ("shp", "skater/summary", "shPoints"),
    ("gwg", "skater/summary", "gameWinningGoals"),
    ("otg", "skater/summary", "otGoals"),
    ("pm", "skater/summary", "plusMinus"),
    ("pim", "skater/summary", "penaltyMinutes"),
    ("sog", "skater/summary", "shots"),
    ("a1", "skater/scoringpergame", "totalPrimaryAssists"),
    ("a2", "skater/scoringpergame", "totalSecondaryAssists"),
    ("att", "skater/realtime", "totalShotAttempts"),
    ("miss", "skater/realtime", "missedShots"),
    ("blkd", "skater/realtime", "shotAttemptsBlocked"),
    ("eng", "skater/realtime", "emptyNetGoals"),
    ("so_g", "skater/shootout", "shootoutGoals"),
    ("so_s", "skater/shootout", "shootoutShots"),
    ("so_gdg", "skater/shootout", "shootoutGameDecidingGoals"),
    ("fow", "skater/faceoffwins", "totalFaceoffWins"),
    ("fol", "skater/faceoffwins", "totalFaceoffLosses"),
    ("oz_w", "skater/faceoffwins", "offensiveZoneFaceoffWins"),
    ("oz_l", "skater/faceoffwins", "offensiveZoneFaceoffLosses"),
    ("dz_w", "skater/faceoffwins", "defensiveZoneFaceoffWins"),
    ("dz_l", "skater/faceoffwins", "defensiveZoneFaceoffLosses"),
    ("nz_w", "skater/faceoffwins", "neutralZoneFaceoffWins"),
    ("nz_l", "skater/faceoffwins", "neutralZoneFaceoffLosses"),
    ("ev_fw", "skater/faceoffwins", "evFaceoffsWon"),
    ("ev_fl", "skater/faceoffwins", "evFaceoffsLost"),
    ("pp_fw", "skater/faceoffwins", "ppFaceoffsWon"),
    ("pp_fl", "skater/faceoffwins", "ppFaceoffsLost"),
    ("sh_fw", "skater/faceoffwins", "shFaceoffsWon"),
    ("sh_fl", "skater/faceoffwins", "shFaceoffsLost"),
]
FIELDS = ["id", "pos"] + [c[0] for c in COLS]


def num(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def build(y: int):
    sid = f"{y}{y + 1}"
    reports = {}
    for rep in sorted({c[1] for c in COLS}):
        reports[rep] = {row["playerId"]: row for row in nhl_report(rep, sid)}
    base = reports["skater/summary"]
    rows = []
    for pid, s in base.items():
        out = [pid, s.get("positionCode")]
        for _, rep, key in COLS:
            out.append(num((reports[rep].get(pid) or {}).get(key)))
        rows.append(out)
    rows.sort(key=lambda r: r[0])
    zones = sum(1 for r in rows if r[FIELDS.index("dz_w")] is not None)
    log(f"box {y}: {len(rows)} skaters, zone faceoffs for {zones}")
    return {"season": y, "fields": FIELDS, "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--season", type=int)
    args = ap.parse_args()
    cur = args.season or current_season()
    fails = 0
    for y in range(MP_FIRST, cur + 1):
        path = os.path.join(DATA, "box", f"{y}.json")
        if not args.full and y < cur and os.path.exists(path):
            continue
        try:
            write_json(path, build(y))
        except Exception as e:  # noqa: BLE001
            fails += 1
            log(f"box {y} FAILED: {e}")
    if fails == cur - MP_FIRST + 1:
        sys.exit(1)


if __name__ == "__main__":
    main()
