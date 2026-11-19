#!/usr/bin/env python3
"""Discipline: penalties drawn and taken, fights, instigators, roughing and misconducts for every skater-season.

Sources:
  NHL stats API skater/penalties report (one per season): minors, majors, misconducts, penalties drawn, ice time.
  NHL game-center play-by-play (one per game, https://api-web.nhle.com/v1/gamecenter/{id}/play-by-play):
    every penalty with its type, so fighting majors, instigator penalties and roughing minors can be counted.
Game ids come from data/teams/{year}.json (build_usage.py). Games already read are remembered in the output,
so a nightly run only fetches new games; past seasons are read once (--budget games per run, newest first).

Output: data/disc/{year}.json  {"fields": [...], "rows": [[id, ...]], "games": [game ids read]}
  fields: id, gp, toi (minutes), minors, majors, misc (misconducts incl. game), drawn (penalties drawn, NHL),
          fights, instig (instigator), rough (roughing minors),
          mt / md: minor penalties taken / drawn from play-by-play, leaving out scrum calls (roughing, fighting,
          unsportsmanlike, misconducts), which usually go both ways and rarely change the man advantage
Descriptive only: penalties already count in value through the power play; nothing here changes value.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, MP_FIRST, current_season, fetch, log, nhl_report, read_json, write_json  # noqa: E402

PBP_URL = "https://api-web.nhle.com/v1/gamecenter/{g}/play-by-play"
BUDGET = 1500  # play-by-play games per run
FIELDS = ["id", "gp", "toi", "minors", "majors", "misc", "drawn", "fights", "instig", "rough", "mt", "md"]
VERSION = 2
# scrum calls usually go both ways (coincidental), so they rarely change the man advantage
SCRUM = ("roughing", "fight", "unsportsmanlike", "misconduct")


def pens_of(gid):
    """[(player id, kind)] for every penalty in one game; kind in fight / instig / rough. None if the fetch failed."""
    try:
        j = json.loads(fetch(PBP_URL.format(g=gid), tries=2).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return gid, None
    out = []
    for p in j.get("plays", []):
        if p.get("typeDescKey") != "penalty":
            continue
        d = p.get("details") or {}
        key = (d.get("descKey") or "").lower()
        who = d.get("committedByPlayerId")
        drew = d.get("drawnByPlayerId")
        if (d.get("typeCode") or "").upper() == "MIN" and not any(k in key for k in SCRUM):
            if who:
                out.append((who, "mt"))
            if drew:
                out.append((drew, "md"))
        if not who:
            continue
        if "fight" in key:
            out.append((who, "fights"))
        elif "instigat" in key:
            out.append((who, "instig"))
        elif "roughing" in key:
            out.append((who, "rough"))
        out.append((who, "key:" + key))
    return gid, out


def build(y, budget):
    path = os.path.join(DATA, "disc", f"{y}.json")
    old = read_json(path, {}) or {}
    if old.get("v") != VERSION:
        old = {}
    have = set(old.get("games", []))
    prev = {r[0]: dict(zip(old.get("fields", FIELDS), r)) for r in old.get("rows", [])}
    tf = read_json(os.path.join(DATA, "teams", f"{y}.json"))
    gids = sorted({str(row[0]) for t in (tf or {}).get("teams", {}).values() for row in t["games"]}) if tf else []
    todo = [g for g in gids if g not in have][:budget]
    if old.get("complete") and y < current_season() and not todo:
        return 0
    counts = {pid: {k: p.get(k, 0) or 0 for k in ("fights", "instig", "rough", "mt", "md")} for pid, p in prev.items()}
    keys = {}
    if todo:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for gid, pens in ex.map(pens_of, todo):
                if pens is None:
                    continue
                have.add(gid)
                for who, kind in pens:
                    if kind.startswith("key:"):
                        keys[kind[4:]] = keys.get(kind[4:], 0) + 1
                        continue
                    c = counts.setdefault(who, {"fights": 0, "instig": 0, "rough": 0, "mt": 0, "md": 0})
                    c[kind] += 1
    rep = {r["playerId"]: r for r in nhl_report("skater/penalties", f"{y}{y + 1}")}
    rows = []
    for pid, r in rep.items():
        c = counts.get(pid, {})
        toi = (r.get("timeOnIcePerGame") or 0) * (r.get("gamesPlayed") or 0) / 60
        rows.append([pid, r.get("gamesPlayed") or 0, round(toi, 1), r.get("minorPenalties") or 0, r.get("majorPenalties") or 0,
                     (r.get("misconductPenalties") or 0) + (r.get("gameMisconductPenalties") or 0), r.get("penaltiesDrawn") or 0,
                     c.get("fights", 0), c.get("instig", 0), c.get("rough", 0), c.get("mt", 0), c.get("md", 0)])
    rows.sort()
    top = sorted(keys.items(), key=lambda kv: -kv[1])[:12]
    log(f"disc {y}: {len(todo)} new games read, {len(have)} of {len(gids)} known, {len(rows)} skaters; penalty types {top}")
    write_json(path, {"season": y, "v": VERSION, "fields": FIELDS, "rows": rows, "games": sorted(have),
                      "complete": len(have) >= len(gids) > 0})
    return len(todo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=BUDGET)
    ap.add_argument("--first", type=int, default=MP_FIRST)
    args = ap.parse_args()
    cur = current_season()
    budget = args.budget
    for y in range(cur, args.first - 1, -1):
        try:
            budget -= build(y, max(0, budget))
        except Exception as e:  # noqa: BLE001
            log(f"disc {y} FAILED: {e}")


if __name__ == "__main__":
    main()
