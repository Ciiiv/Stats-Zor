#!/usr/bin/env python3
"""Build the static data files for Stats-Zor.

Sources
  - MoneyPuck season summaries (skaters + lines), 2008-09 onward. Free for
    non-commercial use with credit to MoneyPuck.com.
  - NHL public stats API for full careers back to 1917-18 (season totals,
    bios, league scoring) and the NHL player API for trophies.

Output (all under data/)
  seasons/{year}.json   one MoneyPuck season, every skater, computed metrics
  lines/{year}.json     5v5 forward lines and defence pairs for that season
  careers.json          every NHL skater season since 1917-18 + bios + awards
  index.json            search list of every player + manifest

Years are season start years: 2025 means 2025-26.

Run with --full to rebuild everything; the default refreshes only the current
season and anything missing. Only the Python standard library is used.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MP_FIRST = 2008
NHL_FIRST = 1917
UA = "Stats-Zor data builder (+https://github.com/Ciiiv/Stats-Zor)"
FIXTURES = os.environ.get("STATSZOR_FIXTURES")  # local testing only

MP_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/{y}/regular/{kind}.csv"
NHL_STATS = "https://api.nhle.com/stats/rest/en/{report}?{q}"
NHL_LANDING = "https://api-web.nhle.com/v1/player/{pid}/landing"


# ---------------------------------------------------------------- helpers
def log(*a):
    print(*a, flush=True)


def fetch(url: str, tries: int = 4) -> bytes:
    if FIXTURES:
        import hashlib
        path = os.path.join(FIXTURES, hashlib.sha1(url.encode()).hexdigest())
        if not os.path.exists(path):
            raise FileNotFoundError(url)
        with open(path, "rb") as f:
            return f.read()
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            if getattr(e, "code", None) == 404:
                break
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def fetch_json(url: str):
    return json.loads(fetch(url).decode("utf-8"))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def r(v, d=2):
    if v is None:
        return None
    return round(v, d)


def div(a, b):
    return a / b if b else None


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def current_season(today: dt.date | None = None) -> int:
    today = today or dt.date.today()
    return today.year if today.month >= 9 else today.year - 1


# ---------------------------------------------------------------- MoneyPuck
SEASON_FIELDS = [
    # identity
    "gp", "toi", "ev", "pp", "pk",
    # all-situation counts
    "g", "a1", "a2", "pts", "ppg", "ppp", "sog", "hits", "blk", "tk", "gv", "pen", "pend",
    "fow", "fol", "gs", "gax",
    # 5v5 on-ice rates per 60
    "xgf60", "xga60", "cf60", "ca60", "gf60", "ga60", "hdxgf60", "hdxga60",
    "off_xgf60", "off_xga60", "off_cf60", "off_ca60",
    # 5v5 individual rates per 60
    "ixg60", "ig60", "ia1_60", "ipts60", "isa60", "ihd60",
    # deployment
    "dzs",
    # per 60, all situations
    "hits60", "blk60", "tk60", "gv60", "pend60", "pen60",
    "dzgv60",
    # special teams
    "pk_xga60", "pp_xgf60", "pp_pts60",
    # 5v5 totals (seconds and counts) for splits and projections
    "t5", "xgf5", "xga5", "gf5", "ga5", "cf5", "ca5",
]


def parse_csv(raw: bytes):
    text = raw.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def build_season(y: int):
    rows = parse_csv(fetch(MP_URL.format(y=y, kind="skaters")))
    by = {}
    for row in rows:
        pid = row.get("playerId")
        if not pid:
            continue
        p = by.setdefault(pid, {"name": row["name"], "team": row["team"], "pos": row["position"], "sit": {}})
        p["sit"][row["situation"]] = row
    players = []
    gpmax = 0
    teams = set()
    for pid, p in by.items():
        a = p["sit"].get("all")
        s = p["sit"].get("5on5")
        if not a or not s:
            continue
        k = p["sit"].get("4on5", {})
        pp = p["sit"].get("5on4", {})
        g = lambda d, c: num(d.get(c))  # noqa: E731
        gp = int(g(a, "games_played"))
        if gp <= 0:
            continue
        gpmax = max(gpmax, gp)
        teams.add(p["team"])
        ta, t5, tk, tp = g(a, "icetime"), g(s, "icetime"), g(k, "icetime"), g(pp, "icetime")
        ha, h5, hk, hp = ta / 3600, t5 / 3600, tk / 3600, tp / 3600
        bench = g(s, "timeOnBench") / 3600
        per = lambda v, h: div(v, h)  # noqa: E731
        dz, oz = g(s, "I_F_dZoneShiftStarts"), g(s, "I_F_oZoneShiftStarts")
        v = {
            "gp": gp,
            "toi": ta / 60 / gp, "ev": t5 / 60 / gp, "pp": tp / 60 / gp, "pk": tk / 60 / gp,
            "g": g(a, "I_F_goals"), "a1": g(a, "I_F_primaryAssists"), "a2": g(a, "I_F_secondaryAssists"),
            "pts": g(a, "I_F_points"), "ppg": g(pp, "I_F_goals"), "ppp": g(pp, "I_F_points"),
            "sog": g(a, "I_F_shotsOnGoal"), "hits": g(a, "I_F_hits"), "blk": g(a, "shotsBlockedByPlayer"),
            "tk": g(a, "I_F_takeaways"), "gv": g(a, "I_F_giveaways"),
            "pen": g(a, "penalties"), "pend": g(a, "penaltiesDrawn"),
            "fow": g(a, "faceoffsWon"), "fol": g(a, "faceoffsLost"),
            "gs": g(a, "gameScore") / gp, "gax": g(a, "I_F_goals") - g(a, "I_F_xGoals"),
            "xgf60": per(g(s, "OnIce_F_xGoals"), h5), "xga60": per(g(s, "OnIce_A_xGoals"), h5),
            "cf60": per(g(s, "OnIce_F_shotAttempts"), h5), "ca60": per(g(s, "OnIce_A_shotAttempts"), h5),
            "gf60": per(g(s, "OnIce_F_goals"), h5), "ga60": per(g(s, "OnIce_A_goals"), h5),
            "hdxgf60": per(g(s, "OnIce_F_highDangerxGoals"), h5), "hdxga60": per(g(s, "OnIce_A_highDangerxGoals"), h5),
            "off_xgf60": per(g(s, "OffIce_F_xGoals"), bench), "off_xga60": per(g(s, "OffIce_A_xGoals"), bench),
            "off_cf60": per(g(s, "OffIce_F_shotAttempts"), bench), "off_ca60": per(g(s, "OffIce_A_shotAttempts"), bench),
            "ixg60": per(g(s, "I_F_xGoals"), h5), "ig60": per(g(s, "I_F_goals"), h5),
            "ia1_60": per(g(s, "I_F_primaryAssists"), h5), "ipts60": per(g(s, "I_F_points"), h5),
            "isa60": per(g(s, "I_F_shotAttempts"), h5), "ihd60": per(g(s, "I_F_highDangerShots"), h5),
            "dzs": div(dz * 100, dz + oz),
            "hits60": per(g(a, "I_F_hits"), ha), "blk60": per(g(a, "shotsBlockedByPlayer"), ha),
            "tk60": per(g(a, "I_F_takeaways"), ha), "gv60": per(g(a, "I_F_giveaways"), ha),
            "pend60": per(g(a, "penaltiesDrawn"), ha), "pen60": per(g(a, "penalties"), ha),
            "dzgv60": per(g(s, "I_F_dZoneGiveaways"), h5),
            # PK / PP rates need a minimum sample: 30 min on the season
            "pk_xga60": per(g(k, "OnIce_A_xGoals"), hk) if tk >= 1800 else None,
            "pp_xgf60": per(g(pp, "OnIce_F_xGoals"), hp) if tp >= 1800 else None,
            "pp_pts60": per(g(pp, "I_F_points"), hp) if tp >= 1800 else None,
            "t5": t5, "xgf5": g(s, "OnIce_F_xGoals"), "xga5": g(s, "OnIce_A_xGoals"),
            "gf5": g(s, "OnIce_F_goals"), "ga5": g(s, "OnIce_A_goals"),
            "cf5": g(s, "OnIce_F_shotAttempts"), "ca5": g(s, "OnIce_A_shotAttempts"),
        }
        if h5 < 1 / 6:  # under 10 minutes at 5v5: rates are noise
            for key in ("xgf60", "xga60", "cf60", "ca60", "gf60", "ga60", "hdxgf60", "hdxga60",
                        "ixg60", "ig60", "ia1_60", "ipts60", "isa60", "ihd60", "dzgv60"):
                v[key] = None
        row = [int(pid), p["name"], p["team"], p["pos"]]
        for f in SEASON_FIELDS:
            val = v.get(f)
            if val is None:
                row.append(None)
            elif f in ("t5",):
                row.append(int(val))
            elif isinstance(val, float) and val.is_integer() and f not in ("toi", "ev", "pp", "pk", "gs"):
                row.append(int(val))
            else:
                row.append(r(val, 3))
        players.append(row)
    players.sort(key=lambda x: x[1])
    return {
        "season": y,
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "gpmax": gpmax,
        "teams": sorted(teams),
        "fields": ["id", "name", "team", "pos"] + SEASON_FIELDS,
        "players": players,
    }


def build_lines(y: int):
    rows = parse_csv(fetch(MP_URL.format(y=y, kind="lines")))
    out = []
    for row in rows:
        if row.get("situation") != "5on5":
            continue
        t = num(row.get("icetime"))
        if t < 120:
            continue
        lid = row.get("lineId", "")
        ids = [int(lid[i:i + 7]) for i in range(0, len(lid), 7) if len(lid[i:i + 7]) == 7]
        if len(ids) < 2:
            continue
        kind = "P" if row.get("position") == "pairing" else "L"
        out.append([ids, row.get("team"), kind, int(t),
                    r(num(row.get("xGoalsFor")), 2), r(num(row.get("xGoalsAgainst")), 2),
                    int(num(row.get("shotAttemptsFor"))), int(num(row.get("shotAttemptsAgainst"))),
                    int(num(row.get("goalsFor"))), int(num(row.get("goalsAgainst")))])
    return {"season": y, "fields": ["ids", "team", "type", "t", "xgf", "xga", "cf", "ca", "gf", "ga"], "lines": out}


# ---------------------------------------------------------------- NHL API
SORT = urllib.parse.quote(json.dumps([{"property": "playerId", "direction": "ASC"}]))


def nhl_report(report: str, season_id: str, game_type: int = 2):
    out, start = [], 0
    while True:
        q = (f"isAggregate=false&isGame=false&sort={SORT}&start={start}&limit=100"
             f"&cayenneExp=" + urllib.parse.quote(f"seasonId={season_id} and gameTypeId={game_type}"))
        j = fetch_json(NHL_STATS.format(report=report, q=q))
        data = j.get("data", [])
        out.extend(data)
        start += len(data)
        if not data or start >= j.get("total", 0):
            break
    return out


def nhl_team_scoring(season_id: str):
    q = "cayenneExp=" + urllib.parse.quote(f"seasonId={season_id} and gameTypeId=2") + "&limit=100"
    data = fetch_json(NHL_STATS.format(report="team/summary", q=q)).get("data", [])
    goals = sum(num(t.get("goalsFor")) for t in data)
    gp = sum(num(t.get("gamesPlayed")) for t in data)
    sched = max((int(num(t.get("gamesPlayed"))) for t in data), default=0)
    return {"gpg": r(goals / (gp / 2), 3) if gp else None, "sched": sched, "teams": len(data)}


def age_in_season(birth: str | None, y: int):
    """Hockey-Reference convention: age on February 1 of the season."""
    if not birth:
        return None
    try:
        b = dt.date.fromisoformat(birth[:10])
    except ValueError:
        return None
    ref = dt.date(y + 1, 2, 1)
    return ref.year - b.year - ((ref.month, ref.day) < (b.month, b.day))


TROPHY_SHORT = {
    "Stanley Cup": "Cup",
    "Hart Memorial Trophy": "Hart",
    "James Norris Memorial Trophy": "Norris",
    "Frank J. Selke Trophy": "Selke",
    "Art Ross Trophy": "Art Ross",
    "Maurice \"Rocket\" Richard Trophy": "Richard",
    "Ted Lindsay Award": "Lindsay",
    "Lester B. Pearson Award": "Lindsay",
    "Calder Memorial Trophy": "Calder",
    "Conn Smythe Trophy": "Conn Smythe",
    "Lady Byng Memorial Trophy": "Lady Byng",
    "Bill Masterton Memorial Trophy": "Masterton",
    "King Clancy Memorial Trophy": "Clancy",
    "Mark Messier Leadership Award": "Messier",
}


def build_careers(cur: int, full: bool):
    path = os.path.join(DATA, "careers.json")
    old = None if full else read_json(path)
    seasons = {}  # (pid, y) -> row
    bios = {}
    league = {}
    awards = {}
    awards_checked = {}
    if old:
        f = old["fields"]
        for row in old["seasons"]:
            d = dict(zip(f, row))
            if d["y"] < cur:
                seasons[(d["id"], d["y"])] = row
        for pid, b in old["players"].items():
            bios[int(pid)] = b
        league = {int(k): v for k, v in old["league"].items() if int(k) < cur}
        awards = {int(k): v for k, v in old.get("awards", {}).items()}
        awards_checked = {int(k): v for k, v in old.get("awards_checked", {}).items()}

    need = [y for y in range(NHL_FIRST, cur + 1) if y == cur or y not in league]
    need = [y for y in need if y != 2004]  # 2004-05 lockout
    log(f"NHL seasons to fetch: {len(need)}")

    def one(y):
        sid = f"{y}{y + 1}"
        try:
            summ = nhl_report("skater/summary", sid)
            bio = nhl_report("skater/bios", sid)
            lg = nhl_team_scoring(sid)
        except Exception as e:  # noqa: BLE001
            log(f"  {y}: NHL fetch failed ({e}); will retry next run")
            return y, None, None, None
        return y, summ, bio, lg

    fields = ["id", "y", "age", "team", "gp", "g", "a", "pts", "pm", "pim", "toi", "ppp", "sog"]
    with ThreadPoolExecutor(max_workers=4) as ex:
        for y, summ, bio, lg in ex.map(one, need):
            if not lg or not lg["gpg"]:
                continue
            league[y] = lg
            for b in bio:
                pid = int(b["playerId"])
                bios[pid] = [b.get("skaterFullName"), b.get("positionCode"), b.get("shootsCatches"),
                             b.get("birthDate"), b.get("height"), b.get("weight"),
                             1 if b.get("isInHallOfFameYn") == "Y" else 0]
            agg = {}
            for s in summ:
                pid = int(s["playerId"])
                d = agg.setdefault(pid, {"team": [], "gp": 0, "g": 0, "a": 0, "pts": 0, "pm": 0, "pim": 0,
                                         "toi_tot": 0.0, "toi_gp": 0, "ppp": 0, "sog": 0})
                gp = int(num(s.get("gamesPlayed")))
                d["team"].append(s.get("teamAbbrevs") or "")
                for k_out, k_in in (("g", "goals"), ("a", "assists"), ("pts", "points"), ("pm", "plusMinus"),
                                    ("pim", "penaltyMinutes"), ("ppp", "ppPoints"), ("sog", "shots")):
                    d[k_out] += int(num(s.get(k_in)))
                d["gp"] += gp
                if s.get("timeOnIcePerGame") is not None:
                    d["toi_tot"] += num(s.get("timeOnIcePerGame")) * gp
                    d["toi_gp"] += gp
                if pid not in bios:
                    bios[pid] = [s.get("skaterFullName"), s.get("positionCode"), s.get("shootsCatches"),
                                 None, None, None, 0]
            for pid, d in agg.items():
                if d["gp"] <= 0:
                    continue
                birth = bios.get(pid, [None] * 4)[3]
                toi = r(d["toi_tot"] / d["toi_gp"] / 60, 2) if d["toi_gp"] else None
                team = ",".join(t for t in d["team"] if t)
                seasons[(pid, y)] = [pid, y, age_in_season(birth, y), team, d["gp"], d["g"], d["a"], d["pts"],
                                     d["pm"], d["pim"], toi, d["ppp"], d["sog"]]
            log(f"  {y}: {len(agg)} skaters, league {lg['gpg']} goals/game, {lg['sched']} games")

    # recompute ages (bios may have arrived after season rows)
    for key, row in seasons.items():
        if row[2] is None:
            row[2] = age_in_season(bios.get(row[0], [None] * 4)[3], row[1])

    # career GP for award lookups
    career_gp = {}
    active = set()
    for (pid, y), row in seasons.items():
        career_gp[pid] = career_gp.get(pid, 0) + row[4]
        if y == cur:
            active.add(pid)
    today = dt.date.today().isoformat()
    week_ago = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    todo = [pid for pid, gp in career_gp.items()
            if gp >= 100 and (pid not in awards_checked or (pid in active and awards_checked[pid] < week_ago))]
    log(f"award lookups: {len(todo)}")

    def aw(pid):
        try:
            j = fetch_json(NHL_LANDING.format(pid=pid))
        except Exception as e:  # noqa: BLE001
            return pid, None, str(e)
        out = []
        for a in j.get("awards", []) or []:
            name = (a.get("trophy") or {}).get("default", "")
            short = TROPHY_SHORT.get(name)
            if not short:
                continue
            for s in a.get("seasons", []) or []:
                sid = str(s.get("seasonId", ""))
                if len(sid) == 8:
                    out.append([short, int(sid[:4])])
        hof = 1 if j.get("inHHOF") else None
        return pid, (out, hof), None

    fails = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, (pid, res, err) in enumerate(ex.map(aw, todo)):
            if res is None:
                fails += 1
                continue
            out, hof = res
            if out:
                awards[pid] = sorted(out, key=lambda x: (x[1], x[0]))
            else:
                awards.pop(pid, None)
            if hof and pid in bios:
                bios[pid][6] = 1
            awards_checked[pid] = today
            if i and i % 500 == 0:
                log(f"  awards {i}/{len(todo)}")
    if fails:
        log(f"  award lookups failed: {fails} (will retry next run)")

    rows = sorted(seasons.values(), key=lambda x: (x[0], x[1]))
    keep_ids = {row[0] for row in rows}
    return {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "fields": fields,
        "bio_fields": ["name", "pos", "shoots", "birth", "height_in", "weight_lb", "hof"],
        "players": {str(pid): b for pid, b in bios.items() if pid in keep_ids},
        "seasons": rows,
        "league": {str(k): v for k, v in sorted(league.items())},
        "awards": {str(k): v for k, v in awards.items() if k in keep_ids},
        "awards_checked": {str(k): v for k, v in awards_checked.items()},
    }


# ---------------------------------------------------------------- index
def build_index(careers, season_files, cur):
    players = {}
    if careers:
        f = careers["fields"]
        span = {}
        for row in careers["seasons"]:
            d = dict(zip(f, row))
            s = span.setdefault(d["id"], [d["y"], d["y"], 0, d["team"]])
            s[0] = min(s[0], d["y"])
            if d["y"] >= s[1]:
                s[1], s[3] = d["y"], d["team"]
            s[2] += d["gp"]
        for pid, b in careers["players"].items():
            sp = span.get(int(pid))
            if not sp:
                continue
            players[int(pid)] = [b[0], b[1], sp[0], sp[1], sp[3].split(",")[-1] if sp[3] else "", sp[2], 0]
    for y, sf in season_files.items():
        for row in sf["players"]:
            pid, name, team, pos = row[0], row[1], row[2], row[3]
            p = players.get(pid)
            if not p:
                players[pid] = [name, pos, y, y, team, row[4], 1 << (y - MP_FIRST)]
            else:
                p[6] |= 1 << (y - MP_FIRST)
                if y >= p[3]:
                    p[3], p[4] = y, team
    # goalies, from the files build_goalies.py wrote on the last run (it refreshes them after this)
    goalie_rows, goalie_seasons = [], []
    try:
        from build_goalies import GDIR, index_rows
        goalie_rows = [r for r in index_rows() if r[0] not in players]
        sdir = os.path.join(GDIR, "seasons")
        if os.path.isdir(sdir):
            goalie_seasons = sorted(int(fn[:-5]) for fn in os.listdir(sdir) if fn.endswith(".json"))
    except Exception as e:  # noqa: BLE001
        log(f"goalie index rows skipped: {e}")
    rows = [[pid] + p for pid, p in players.items()] + goalie_rows
    return {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "current": cur,
        "mp_first": MP_FIRST,
        "mp_seasons": sorted(season_files.keys()),
        "fields": ["id", "name", "pos", "first", "last", "team", "gp", "mp_mask"],
        "goalie_seasons": goalie_seasons,
        "players": sorted(rows, key=lambda r: r[1] or ""),
    }


def build_mp_careers(season_files):
    """One small row per player-season of MoneyPuck metrics, for career arcs and comps."""
    rows = []
    for y, sf in sorted(season_files.items()):
        f = sf["fields"]
        ix = {k: i for i, k in enumerate(f)}
        for p in sf["players"]:
            g = lambda k: p[ix[k]]  # noqa: E731
            t5 = g("t5") or 0
            if t5 < 6000:  # under 100 minutes at 5v5
                continue
            xgf, xga = g("xgf60"), g("xga60")
            ofx, ofa = g("off_xgf60"), g("off_xga60")
            xgp = 100 * xgf / (xgf + xga) if xgf is not None and xga is not None and (xgf + xga) else None
            oxp = 100 * ofx / (ofx + ofa) if ofx is not None and ofa is not None and (ofx + ofa) else None
            rows.append([p[0], y, p[2], g("gp"), g("toi"), r(xgp, 1),
                         r(xgp - oxp, 1) if xgp is not None and oxp is not None else None,
                         r(xga - ofa, 2) if xga is not None and ofa is not None else None,
                         r(xgf - ofx, 2) if xgf is not None and ofx is not None else None,
                         g("ixg60"), g("ipts60"), int(t5)])
    return {"fields": ["id", "y", "team", "gp", "toi", "xgf_pct", "rel_xgf_pct", "rel_xga60", "rel_xgf60",
                       "ixg60", "ipts60", "t5"], "rows": rows}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="rebuild every season and career")
    ap.add_argument("--season", type=int, help="override the current season (start year)")
    ap.add_argument("--skip-careers", action="store_true")
    args = ap.parse_args()
    cur = args.season or current_season()
    log(f"current season: {cur}-{str(cur + 1)[2:]}")

    season_files = {}
    errors = []
    for y in range(MP_FIRST, cur + 1):
        sp = os.path.join(DATA, "seasons", f"{y}.json")
        lp = os.path.join(DATA, "lines", f"{y}.json")
        if not args.full and y < cur and os.path.exists(sp) and os.path.exists(lp):
            season_files[y] = read_json(sp)
            continue
        try:
            sf = build_season(y)
            write_json(sp, sf)
            season_files[y] = sf
            write_json(lp, build_lines(y))
            log(f"MoneyPuck {y}: {len(sf['players'])} skaters")
        except Exception as e:  # noqa: BLE001
            errors.append(f"MoneyPuck {y}: {e}")
            log(f"MoneyPuck {y} FAILED: {e}")
            if os.path.exists(sp):
                season_files[y] = read_json(sp)

    careers = read_json(os.path.join(DATA, "careers.json"))
    if not args.skip_careers:
        try:
            careers = build_careers(cur, args.full)
            write_json(os.path.join(DATA, "careers.json"), careers)
            log(f"careers: {len(careers['players'])} players, {len(careers['seasons'])} seasons")
        except Exception as e:  # noqa: BLE001
            errors.append(f"careers: {e}")
            log(f"careers FAILED: {e}")

    if season_files:
        write_json(os.path.join(DATA, "mp_careers.json"), build_mp_careers(season_files))

    idx = build_index(careers, season_files, cur)
    idx["errors"] = errors
    write_json(os.path.join(DATA, "index.json"), idx)
    log(f"index: {len(idx['players'])} players")
    if errors and not season_files:
        sys.exit(1)


if __name__ == "__main__":
    main()
