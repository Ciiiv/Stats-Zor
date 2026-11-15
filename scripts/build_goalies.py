#!/usr/bin/env python3
"""Build goalie data for the goalie page (goalies.html).

Sources
  - MoneyPuck goalie season summaries (2008-09 on): goals against vs. expected goals by
    situation and shot danger, rebounds and freezes vs. expected.
      https://moneypuck.com/moneypuck/playerData/seasonSummary/{y}/regular/goalies.csv
  - MoneyPuck goalie game-by-game files: expected goals against in every game.
      https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/goalies/{y}.zip
  - NHL stats API goalie reports: wins, losses, shutouts and games started, by season and
    by game (starts and decisions), and every goalie season since 1917-18 for careers.
  - NHL player API: trophies (Vezina, Jennings, Hart, ...), Stanley Cups, Hall of Fame.

Output (under data/goalies/)
  seasons/{y}.json  one row per goalie: MoneyPuck + NHL season totals
  games/{y}.json    every appearance: start, decision, shots, goals, expected goals, rest
  careers.json      every NHL goalie season since 1917-18, bios, awards, league save %
Also adds goalies to data/index.json so search on either page finds them.

Shots-faced maps are built by build_shots.py (it already reads the shot files).
Default run refreshes the current season and fills in anything missing; --full rebuilds all.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import (DATA, MP_FIRST, MP_URL, NHL_FIRST, NHL_LANDING, NHL_STATS, SORT, TROPHY_SHORT,  # noqa: E402
                        age_in_season, current_season, fetch, fetch_json, log, num, parse_csv, read_json, write_json)

GDIR = os.path.join(DATA, "goalies")
GBG_URL = "https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/goalies/{y}.zip"

SEASON_FIELDS = ["id", "name", "team", "gp", "gs", "w", "l", "otl", "so",
                 "toi", "sa", "ga", "xga", "fa",
                 "ld_g", "md_g", "hd_g", "ld_x", "md_x", "hd_x", "ld_n", "md_n", "hd_n",
                 "reb", "xreb", "frz", "xfrz",
                 "t5", "sa5", "ga5", "xga5", "fa5", "hd5_g", "hd5_x",
                 "tpk", "sapk", "gapk", "xgapk"]
GAME_FIELDS = ["game", "date", "team", "opp", "home", "start", "dec", "toi", "sa", "ga", "xga", "hd_x", "hd_g",
               "rest", "b2b", "pulled"]


def rr(v, n=2):
    return None if v is None else round(v, n)


def nhl_goalie_report(report, season_id, by_game=False):
    out, start = [], 0
    while True:
        q = (f"isAggregate=false&isGame={'true' if by_game else 'false'}&sort={SORT}&start={start}&limit=100"
             "&cayenneExp=" + urllib.parse.quote(f"seasonId={season_id} and gameTypeId=2"))
        j = fetch_json(NHL_STATS.format(report=report, q=q))
        data = j.get("data", [])
        out.extend(data)
        start += len(data)
        if not data or start >= j.get("total", 0):
            break
    return out


# ---------------------------------------------------------------- one MoneyPuck season
def build_season(y):
    rows = parse_csv(fetch(MP_URL.format(y=y, kind="goalies")))
    by = {}
    for row in rows:
        pid = row.get("playerId")
        if not pid:
            continue
        p = by.setdefault(int(float(pid)), {"name": row["name"], "team": row["team"], "sit": {}})
        p["sit"][row["situation"]] = row
    try:
        nhl = {int(d["playerId"]): d for d in nhl_goalie_report("goalie/summary", f"{y}{y + 1}")}
    except Exception as e:  # noqa: BLE001
        log(f"  goalie NHL summary {y} failed: {e}")
        nhl = {}
    out, gpmax, teams = [], 0, set()
    for pid, p in by.items():
        a = p["sit"].get("all")
        if not a:
            continue
        s = p["sit"].get("5on5", {})
        k = p["sit"].get("4on5", {})
        g = lambda d, c: num(d.get(c))  # noqa: E731
        gp = int(g(a, "games_played"))
        if gp <= 0:
            continue
        n = nhl.get(pid, {})
        gpmax = max(gpmax, gp)
        teams.add(p["team"])
        row = [pid, p["name"], p["team"], gp,
               int(num(n.get("gamesStarted"))) if n else None,
               int(num(n.get("wins"))) if n else None, int(num(n.get("losses"))) if n else None,
               int(num(n.get("otLosses"))) if n else None, int(num(n.get("shutouts"))) if n else None,
               rr(g(a, "icetime") / 60, 1), int(g(a, "ongoal")), int(g(a, "goals")), rr(g(a, "xGoals")),
               int(g(a, "unblocked_shot_attempts")),
               int(g(a, "lowDangerGoals")), int(g(a, "mediumDangerGoals")), int(g(a, "highDangerGoals")),
               rr(g(a, "lowDangerxGoals")), rr(g(a, "mediumDangerxGoals")), rr(g(a, "highDangerxGoals")),
               int(g(a, "lowDangerShots")), int(g(a, "mediumDangerShots")), int(g(a, "highDangerShots")),
               int(g(a, "rebounds")), rr(g(a, "xRebounds")), int(g(a, "freeze")), rr(g(a, "xFreeze")),
               rr(g(s, "icetime") / 60, 1), int(g(s, "ongoal")), int(g(s, "goals")), rr(g(s, "xGoals")),
               int(g(s, "unblocked_shot_attempts")), int(g(s, "highDangerGoals")), rr(g(s, "highDangerxGoals")),
               rr(g(k, "icetime") / 60, 1), int(g(k, "ongoal")), int(g(k, "goals")), rr(g(k, "xGoals"))]
        out.append(row)
    out.sort(key=lambda x: x[1])
    if not out:
        raise RuntimeError("no goalie rows")
    # team games so far (the skater file's most games played), for pools and season progress
    sk = read_json(os.path.join(DATA, "seasons", f"{y}.json")) or {}
    return {"season": y, "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "gpmax": gpmax, "team_gp": sk.get("gpmax") or gpmax, "teams": sorted(teams), "fields": SEASON_FIELDS, "players": out}


# ---------------------------------------------------------------- one season of games
def ymd(s):
    s = str(s).replace("-", "")[:8]
    return int(s) if s.isdigit() else None


def build_games(y):
    raw = fetch(GBG_URL.format(y=y))
    zf = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
    mp = {}  # (pid, gameId) -> dict
    with zf.open(name) as fh:
        rd = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"))
        for row in rd:
            if row.get("situation") != "all":
                continue
            try:
                key = (int(float(row["playerId"])), int(float(row["gameId"])))
            except (KeyError, ValueError):
                continue
            mp[key] = {"team": row.get("playerTeam"), "opp": row.get("opposingTeam"),
                       "home": 1 if (row.get("home_or_away") or "").upper().startswith("H") else 0,
                       "date": ymd(row.get("gameDate")), "toi": num(row.get("icetime")),
                       "sa": int(num(row.get("ongoal"))), "ga": int(num(row.get("goals"))),
                       "xga": num(row.get("xGoals")), "hd_x": num(row.get("highDangerxGoals")),
                       "hd_g": int(num(row.get("highDangerGoals")))}
    try:
        nhl = nhl_goalie_report("goalie/summary", f"{y}{y + 1}", by_game=True)
    except Exception as e:  # noqa: BLE001
        log(f"  goalie NHL game log {y} failed: {e}")
        nhl = []
    nh = {}
    for d in nhl:
        try:
            nh[(int(d["playerId"]), int(d["gameId"]))] = d
        except (KeyError, ValueError, TypeError):
            continue
    # MoneyPuck game ids are sometimes the short form (20017); map both ways
    def nkey(pid, gid):
        if (pid, gid) in nh:
            return nh[(pid, gid)]
        if gid < 1000000:
            return nh.get((pid, y * 1000000 + gid))
        return None

    team_dates = {}
    by_game_team = {}
    for (pid, gid), m in mp.items():
        if m["date"]:
            team_dates.setdefault(m["team"], set()).add(m["date"])
        by_game_team.setdefault((gid, m["team"]), []).append(pid)

    def day(d):
        return dt.date(d // 10000, d // 100 % 100, d % 100)

    players = {}
    for (pid, gid), m in sorted(mp.items(), key=lambda kv: (kv[1]["date"] or 0, kv[0][1])):
        n = nkey(pid, gid) or {}
        if n:
            start = 1 if num(n.get("gamesStarted")) >= 1 else 0
            dec = "W" if num(n.get("wins")) else "L" if num(n.get("losses")) else "O" if num(n.get("otLosses")) else ""
        else:
            # without the NHL log, the goalie with the most ice time for his team that night started
            mates = by_game_team.get((gid, m["team"]), [pid])
            start = 1 if max(mates, key=lambda q: mp[(q, gid)]["toi"]) == pid else 0
            dec = ""
        b2b = 0
        if m["date"]:
            prev = int((day(m["date"]) - dt.timedelta(days=1)).strftime("%Y%m%d"))
            b2b = 1 if prev in team_dates.get(m["team"], set()) else 0
        mates = by_game_team.get((gid, m["team"]), [pid])
        pulled = 1 if start and len(mates) > 1 and m["toi"] < 3300 else 0
        players.setdefault(pid, []).append([gid, m["date"], m["team"], m["opp"], m["home"], start, dec, int(m["toi"]),
                                            m["sa"], m["ga"], round(m["xga"], 3), round(m["hd_x"], 3), m["hd_g"], None, b2b, pulled])
    # days since his previous start (for starts only)
    for rows in players.values():
        last = None
        for row in rows:
            if not row[5] or not row[1]:
                continue
            if last:
                row[13] = (day(row[1]) - day(last)).days
            last = row[1]
    team_games = {t: len(ds) for t, ds in team_dates.items()}
    log(f"goalie games {y}: {sum(len(v) for v in players.values())} appearances, NHL log rows {len(nh)}")
    return {"season": y, "fields": GAME_FIELDS, "team_games": team_games,
            "team_dates": {t: sorted(ds) for t, ds in team_dates.items()},
            "players": {str(k): v for k, v in players.items()}}


# ---------------------------------------------------------------- careers since 1917-18
GOALIE_TROPHIES = dict(TROPHY_SHORT)
GOALIE_TROPHIES.update({"Vezina Trophy": "Vezina", "William M. Jennings Trophy": "Jennings"})


def build_careers(cur, full):
    path = os.path.join(GDIR, "careers.json")
    old = None if full else read_json(path)
    seasons, bios, league, awards, checked = {}, {}, {}, {}, {}
    if old:
        f = old["fields"]
        for row in old["seasons"]:
            d = dict(zip(f, row))
            if d["y"] < cur:
                seasons[(d["id"], d["y"])] = row
        bios = {int(k): v for k, v in old["players"].items()}
        league = {int(k): v for k, v in old["league"].items() if int(k) < cur}
        awards = {int(k): v for k, v in old.get("awards", {}).items()}
        checked = {int(k): v for k, v in old.get("awards_checked", {}).items()}
    need = [y for y in range(NHL_FIRST, cur + 1) if (y == cur or y not in league) and y != 2004]
    log(f"goalie NHL seasons to fetch: {len(need)}")

    def one(y):
        sid = f"{y}{y + 1}"
        try:
            return y, nhl_goalie_report("goalie/summary", sid), nhl_goalie_report("goalie/bios", sid)
        except Exception as e:  # noqa: BLE001
            log(f"  {y}: goalie fetch failed ({e})")
            return y, None, None

    fields = ["id", "y", "age", "team", "gp", "gs", "w", "l", "t", "otl", "so", "sa", "ga", "toi"]
    with ThreadPoolExecutor(max_workers=4) as ex:
        for y, summ, bio in ex.map(one, need):
            if not summ:
                continue
            for b in bio or []:
                bios[int(b["playerId"])] = [b.get("goalieFullName"), "G", b.get("shootsCatches"), b.get("birthDate"),
                                            b.get("height"), b.get("weight"), 1 if b.get("isInHallOfFameYn") == "Y" else 0]
            agg = {}
            for s in summ:
                pid = int(s["playerId"])
                d = agg.setdefault(pid, {"team": [], **{k: 0 for k in ("gp", "gs", "w", "l", "t", "otl", "so", "ga", "toi")},
                                         "sa": 0, "sa_ok": True})
                d["team"].append(s.get("teamAbbrevs") or "")
                for ko, ki in (("gp", "gamesPlayed"), ("gs", "gamesStarted"), ("w", "wins"), ("l", "losses"), ("t", "ties"),
                               ("otl", "otLosses"), ("so", "shutouts"), ("ga", "goalsAgainst"), ("toi", "timeOnIce")):
                    d[ko] += num(s.get(ki))
                if s.get("shotsAgainst") is None:
                    d["sa_ok"] = False
                else:
                    d["sa"] += num(s.get("shotsAgainst"))
                if pid not in bios:
                    bios[pid] = [s.get("goalieFullName"), "G", s.get("shootsCatches"), None, None, None, 0]
            lg_sa = lg_ga_sa = lg_ga = lg_toi = 0.0
            for pid, d in agg.items():
                if d["gp"] <= 0:
                    continue
                sa = int(d["sa"]) if d["sa_ok"] and d["sa"] > 0 else None
                seasons[(pid, y)] = [pid, y, None, ",".join(t for t in d["team"] if t), int(d["gp"]), int(d["gs"]),
                                     int(d["w"]), int(d["l"]), int(d["t"]), int(d["otl"]), int(d["so"]), sa, int(d["ga"]),
                                     round(d["toi"] / 60, 1)]
                lg_ga += d["ga"]
                lg_toi += d["toi"]
                if sa:
                    lg_sa += sa
                    lg_ga_sa += d["ga"]
            cover = lg_sa and lg_ga_sa >= 0.9 * lg_ga
            league[y] = {"sv": round(1 - lg_ga_sa / lg_sa, 4) if cover else None,
                         "gaa": round(lg_ga / lg_toi * 3600, 3) if lg_toi else None}
            log(f"  {y}: {len(agg)} goalies, league sv {league[y]['sv']}, GAA {league[y]['gaa']}")
    for row in seasons.values():
        row[2] = age_in_season(bios.get(row[0], [None] * 4)[3], row[1])

    career_gp, active = {}, set()
    for (pid, y), row in seasons.items():
        career_gp[pid] = career_gp.get(pid, 0) + row[4]
        if y == cur:
            active.add(pid)
    today = dt.date.today().isoformat()
    week_ago = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    todo = [pid for pid, gp in career_gp.items() if gp >= 40 and (pid not in checked or (pid in active and checked[pid] < week_ago))]
    log(f"goalie award lookups: {len(todo)}")

    def aw(pid):
        try:
            j = fetch_json(NHL_LANDING.format(pid=pid))
        except Exception:  # noqa: BLE001
            return pid, None
        out = []
        for a in j.get("awards", []) or []:
            short = GOALIE_TROPHIES.get((a.get("trophy") or {}).get("default", ""))
            if not short:
                continue
            for s in a.get("seasons", []) or []:
                sid = str(s.get("seasonId", ""))
                if len(sid) == 8:
                    out.append([short, int(sid[:4])])
        return pid, (out, 1 if j.get("inHHOF") else None)

    with ThreadPoolExecutor(max_workers=8) as ex:
        for pid, res in ex.map(aw, todo):
            if res is None:
                continue
            out, hof = res
            if out:
                awards[pid] = sorted(out, key=lambda x: (x[1], x[0]))
            else:
                awards.pop(pid, None)
            if hof and pid in bios:
                bios[pid][6] = 1
            checked[pid] = today

    rows = sorted(seasons.values(), key=lambda x: (x[0], x[1]))
    keep = {r[0] for r in rows}
    return {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "fields": fields,
            "bio_fields": ["name", "pos", "catches", "birth", "height_in", "weight_lb", "hof"],
            "players": {str(k): v for k, v in bios.items() if k in keep}, "seasons": rows,
            "league": {str(k): v for k, v in sorted(league.items())},
            "awards": {str(k): v for k, v in awards.items() if k in keep},
            "awards_checked": {str(k): v for k, v in checked.items()}}


def mp_summary(season_files):
    """Per goalie-season MoneyPuck totals for career arcs and comps."""
    rows = []
    for y, sf in sorted(season_files.items()):
        ix = {k: i for i, k in enumerate(sf["fields"])}
        for p in sf["players"]:
            rows.append([p[ix["id"]], y, p[ix["gp"]], p[ix["toi"]], p[ix["sa"]], p[ix["ga"]], p[ix["xga"]]])
    return {"fields": ["id", "y", "gp", "toi", "sa", "ga", "xga"], "rows": rows}


# ---------------------------------------------------------------- index
def index_rows(careers=None, season_files=None):
    """Search-index rows for goalies: [id, name, 'G', first, last, team, gp, mask]."""
    careers = careers or read_json(os.path.join(GDIR, "careers.json"))
    if season_files is None:
        season_files = {}
        sdir = os.path.join(GDIR, "seasons")
        if os.path.isdir(sdir):
            for fn in os.listdir(sdir):
                if fn.endswith(".json"):
                    season_files[int(fn[:-5])] = read_json(os.path.join(sdir, fn))
    players = {}
    if careers:
        f = careers["fields"]
        for row in careers["seasons"]:
            d = dict(zip(f, row))
            p = players.setdefault(d["id"], [None, "G", d["y"], d["y"], d["team"], 0, 0])
            p[2] = min(p[2], d["y"])
            if d["y"] >= p[3]:
                p[3], p[4] = d["y"], d["team"]
            p[5] += d["gp"]
        for pid, b in careers["players"].items():
            if int(pid) in players:
                players[int(pid)][0] = b[0]
    for y, sf in season_files.items():
        if not sf:
            continue
        ix = {k: i for i, k in enumerate(sf["fields"])}
        for row in sf["players"]:
            pid = row[ix["id"]]
            p = players.setdefault(pid, [row[ix["name"]], "G", y, y, row[ix["team"]], row[ix["gp"]], 0])
            p[0] = p[0] or row[ix["name"]]
            p[6] |= 1 << (y - MP_FIRST)
            if y >= p[3]:
                p[3], p[4] = y, row[ix["team"]]
    out = []
    for pid, p in players.items():
        team = (p[4] or "").split(",")[-1]
        out.append([pid, p[0], "G", p[2], p[3], team, p[5], p[6]])
    return out


def merge_index(rows):
    path = os.path.join(DATA, "index.json")
    idx = read_json(path)
    if not idx:
        return
    keep = [r for r in idx["players"] if r[2] != "G"]
    ids = {r[0] for r in keep}
    keep += [r for r in rows if r[0] not in ids]
    keep.sort(key=lambda r: r[1] or "")
    idx["players"] = keep
    idx["goalie_seasons"] = sorted(int(fn[:-5]) for fn in os.listdir(os.path.join(GDIR, "seasons")) if fn.endswith(".json"))
    write_json(path, idx)
    log(f"index: {len(rows)} goalies merged")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--season", type=int)
    ap.add_argument("--skip-careers", action="store_true")
    args = ap.parse_args()
    cur = args.season or current_season()
    season_files, fails = {}, 0
    for y in range(MP_FIRST, cur + 1):
        sp = os.path.join(GDIR, "seasons", f"{y}.json")
        gp_ = os.path.join(GDIR, "games", f"{y}.json")
        if not args.full and y < cur and os.path.exists(sp):
            season_files[y] = read_json(sp)
            if "team_gp" not in season_files[y]:  # files from before team_gp existed
                sk = read_json(os.path.join(DATA, "seasons", f"{y}.json")) or {}
                season_files[y]["team_gp"] = sk.get("gpmax") or season_files[y]["gpmax"]
                write_json(sp, season_files[y])
        else:
            try:
                season_files[y] = build_season(y)
                write_json(sp, season_files[y])
                log(f"goalies {y}: {len(season_files[y]['players'])}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                log(f"goalies {y} FAILED: {e}")
                if os.path.exists(sp):
                    season_files[y] = read_json(sp)
        if args.full or y == cur or not os.path.exists(gp_):
            try:
                write_json(gp_, build_games(y))
            except Exception as e:  # noqa: BLE001
                log(f"goalie games {y} FAILED: {e}")
    careers = read_json(os.path.join(GDIR, "careers.json"))
    if not args.skip_careers:
        try:
            careers = build_careers(cur, args.full)
            write_json(os.path.join(GDIR, "careers.json"), careers)
            log(f"goalie careers: {len(careers['players'])} goalies")
        except Exception as e:  # noqa: BLE001
            log(f"goalie careers FAILED: {e}")
    if season_files:
        write_json(os.path.join(GDIR, "mp_careers.json"), mp_summary(season_files))
    merge_index(index_rows(careers, season_files))
    if fails == cur - MP_FIRST + 1:
        sys.exit(1)


if __name__ == "__main__":
    main()
