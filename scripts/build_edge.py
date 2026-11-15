#!/usr/bin/env python3
"""Build NHL EDGE tracking stats (skating speed, bursts, distance, shot speed, zone time).

Source: https://api-web.nhle.com/v1/edge/skater-detail/{playerId}/{seasonId}/2
EDGE starts in 2021-22. One request per player per season, so past seasons are built
once and kept; the default run refreshes only the current season and anything missing.

Output: data/edge/{year}.json, one row per skater with 10+ games in MoneyPuck's season file.
Percentiles are the NHL's own, which compare forwards with forwards and defensemen with
defensemen. Higher always means more (faster, harder, farther, more zone time).
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, current_season, fetch_json, log, read_json, write_json  # noqa: E402

EDGE_FIRST = 2021
URL = "https://api-web.nhle.com/v1/edge/skater-detail/{pid}/{y}{y1}/2"
FIELDS = ["id", "gp", "shot_mph", "shot_pct", "speed_mph", "speed_pct", "bursts20", "bursts20_pct",
          "dist_mi", "dist_pct", "oz_pct", "oz_pctile", "oz_ev_pct", "oz_ev_pctile", "nz_pct", "dz_pct"]


def g(d, *path):
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def r(v, n=3):
    try:
        return round(float(v), n)
    except (TypeError, ValueError):
        return None


def one(pid, y):
    try:
        j = fetch_json(URL.format(pid=pid, y=y, y1=y + 1))
    except Exception:  # noqa: BLE001
        return None
    z = j.get("zoneTimeDetails") or {}
    row = [pid, None,
           r(g(j, "topShotSpeed", "imperial"), 2), r(g(j, "topShotSpeed", "percentile")),
           r(g(j, "skatingSpeed", "speedMax", "imperial"), 2), r(g(j, "skatingSpeed", "speedMax", "percentile")),
           g(j, "skatingSpeed", "burstsOver20", "value"), r(g(j, "skatingSpeed", "burstsOver20", "percentile")),
           r(g(j, "totalDistanceSkated", "imperial"), 1), r(g(j, "totalDistanceSkated", "percentile")),
           r(z.get("offensiveZonePctg")), r(z.get("offensiveZonePercentile")),
           r(z.get("offensiveZoneEvPctg")), r(z.get("offensiveZoneEvPercentile")),
           r(z.get("neutralZonePctg")), r(z.get("defensiveZonePctg"))]
    if all(v is None for v in row[2:]):
        return None
    return row


def build(y):
    sf = read_json(os.path.join(DATA, "seasons", f"{y}.json"))
    if not sf:
        raise RuntimeError(f"no season file for {y}")
    gp_i = sf["fields"].index("gp")
    gp = {p[0]: p[gp_i] for p in sf["players"] if p[gp_i] >= 10}
    ids = list(gp)
    rows = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for row in ex.map(lambda pid: one(pid, y), ids):
            if row:
                row[1] = gp[row[0]]
                rows.append(row)
    log(f"edge {y}: {len(rows)} of {len(ids)} skaters")
    if len(rows) < 0.3 * len(ids):
        raise RuntimeError(f"too few EDGE rows for {y} ({len(rows)} of {len(ids)})")
    return {"season": y, "updated": dt.date.today().isoformat(), "fields": FIELDS, "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--season", type=int)
    args = ap.parse_args()
    cur = args.season or current_season()
    for y in range(EDGE_FIRST, cur + 1):
        path = os.path.join(DATA, "edge", f"{y}.json")
        if not args.full and y < cur and os.path.exists(path):
            continue
        try:
            write_json(path, build(y))
        except Exception as e:  # noqa: BLE001
            log(f"edge {y} FAILED: {e}")


if __name__ == "__main__":
    main()
