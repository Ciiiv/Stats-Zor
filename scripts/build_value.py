#!/usr/bin/env python3
"""Build player value (goals and wins above replacement), dollar worth, projections,
current rosters and recent draft prospects.

Value model (Stats-Zor's own, simple and transparent; not Evolving-Hockey's GAR):
  EV offense   0.5 x (relative xGF/60 - replacement) x 5v5 hours
  EV defense   0.5 x (replacement - relative xGA/60) x 5v5 hours
  Finishing    0.5 x (goals - expected goals), all situations
  Power play   0.3 x (on-ice PP xGF/60 - replacement) x PP hours
  Penalty kill 0.25 x (replacement - on-ice PK xGA/60) x PK hours
  Penalties    0.15 x (penalties drawn - penalties taken)
  Replacement level for each piece is the 20th percentile among regulars at the position.
  Wins = goals / 6.

Dollar worth: the league's skater cap pool above minimum salaries, divided by all positive
wins in the league, gives a market price per win. Worth = minimum salary + wins x price.

Goalies (data/goalies/seasons): goals saved above expected (expected goals minus goals
against) in each situation, measured against a replacement-level goalie over the same
minutes (the 20th percentile rate among regulars), times GOALIE_WEIGHT. Goalies are priced
from the goalie share of the cap (1 - SKATER_SHARE), with two goalies per team at minimum.

Output: data/value.json, data/rosters.json, data/prospects.json
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, MP_FIRST, current_season, fetch_json, log, read_json, write_json  # noqa: E402

# Upper limit and league minimum salary, by season start year (US$ millions).
CAP = {2008: 56.7, 2009: 56.8, 2010: 59.4, 2011: 64.3, 2012: 60.0, 2013: 64.3, 2014: 69.0, 2015: 71.4,
       2016: 73.0, 2017: 75.0, 2018: 79.5, 2019: 81.5, 2020: 81.5, 2021: 81.5, 2022: 82.5, 2023: 83.5,
       2024: 88.0, 2025: 95.5, 2026: 104.0, 2027: 113.5}
MIN = {2008: 0.475, 2009: 0.5, 2010: 0.5, 2011: 0.525, 2012: 0.525, 2013: 0.55, 2014: 0.55, 2015: 0.575,
       2016: 0.575, 2017: 0.65, 2018: 0.65, 2019: 0.7, 2020: 0.7, 2021: 0.75, 2022: 0.75, 2023: 0.775,
       2024: 0.775, 2025: 0.775, 2026: 0.85, 2027: 0.9, 2028: 0.95, 2029: 1.0}
CAP_GROWTH = 0.05      # assumed yearly cap growth beyond published figures
SKATER_SHARE = 0.88    # share of team cap spent on skaters (rest on goalies)
ROSTER = 20            # skaters per team counted at minimum salary
GOALS_PER_WIN = 6.0
GOALIE_WEIGHT = 0.5    # share of a goalie's goals saved above expected credited to him (the rest is noise and team)
GOALIE_ROSTER = 2      # goalies per team counted at minimum salary
SCHED = {2012: 48, 2019: 70, 2020: 56}


def cap(y):
    if y in CAP:
        return CAP[y]
    last = max(CAP)
    return round(CAP[last] * (1 + CAP_GROWTH) ** (y - last), 1)


def min_sal(y):
    return MIN.get(y, MIN[max(MIN)])


def pctile(vals, q):
    v = sorted(x for x in vals if x is not None)
    if not v:
        return 0.0
    return v[min(len(v) - 1, max(0, int(q * (len(v) - 1))))]


AGE_MULT = [(23, 1.10), (26, 1.03), (28, 1.0), (30, 0.95), (32, 0.90), (99, 0.85)]
# goalies develop later and hold their peak longer
AGE_MULT_G = [(24, 1.08), (27, 1.03), (31, 1.0), (33, 0.95), (35, 0.90), (99, 0.85)]
GOALIE_REGRESS = 0.3   # projections pull a goalie's blended rate 30% toward the average regular goalie


def age_mult(age, table=AGE_MULT):
    for a, m in table:
        if age <= a:
            return m
    return 0.85


def goalie_value(sf):
    """Goals and wins above replacement for every goalie in one MoneyPuck season file."""
    ix = {k: i for i, k in enumerate(sf["fields"])}
    tgp = sf.get("team_gp") or sf["gpmax"] or 82
    P = []
    for r in sf["players"]:
        g = lambda k: r[ix[k]] or 0  # noqa: E731
        t_all, t5, tpk = g("toi") / 60, g("t5") / 60, g("tpk") / 60  # hours
        gs_all, gs5, gspk = g("xga") - g("ga"), g("xga5") - g("ga5"), g("xgapk") - g("gapk")
        P.append({"id": r[ix["id"]], "team": r[ix["team"]], "gp": g("gp"),
                  "h": {"ev": t5, "pk": tpk, "oth": max(0.0, t_all - t5 - tpk)},
                  "gs": {"ev": gs5, "pk": gspk, "oth": gs_all - gs5 - gspk}})
    reg = [p for p in P if p["gp"] >= max(5, 0.25 * tgp)]
    repl = {}
    for k in ("ev", "pk", "oth"):
        rates = [p["gs"][k] / p["h"][k] for p in reg if p["h"][k] > 1]
        repl[k] = pctile(rates, 0.20)
    out = []
    for p in P:
        comp = {k: GOALIE_WEIGHT * (p["gs"][k] - repl[k] * p["h"][k]) for k in ("ev", "pk", "oth")}
        gar = sum(comp.values())
        out.append([p["id"], p["team"], "G", p["gp"], round(comp["ev"], 2), round(comp["pk"], 2), round(comp["oth"], 2),
                    round(gar, 2), round(gar / GOALS_PER_WIN, 2)])
    return out, repl


def season_value(sf, usage):
    f = sf["fields"]
    ix = {k: i for i, k in enumerate(f)}
    P = []
    for r in sf["players"]:
        g = lambda k: r[ix[k]]  # noqa: E731
        d = {k: g(k) for k in ("id", "name", "team", "pos", "gp", "ev", "pp", "pk", "xgf60", "xga60", "off_xgf60", "off_xga60",
                               "gax", "pend", "pen", "pp_xgf60", "pk_xga60", "t5")}
        d["grp"] = "D" if d["pos"] == "D" else "F"
        d["relf"] = d["xgf60"] - d["off_xgf60"] if None not in (d["xgf60"], d["off_xgf60"]) else None
        d["rela"] = d["xga60"] - d["off_xga60"] if None not in (d["xga60"], d["off_xga60"]) else None
        P.append(d)
    gpmax = sf["gpmax"] or 82
    repl = {}
    for grp in ("F", "D"):
        reg = [p for p in P if p["grp"] == grp and p["gp"] >= 0.25 * gpmax and (p["t5"] or 0) >= 18000 * gpmax / 82]
        repl[grp] = {
            "relf": pctile([p["relf"] for p in reg], 0.20),
            "rela": pctile([p["rela"] for p in reg], 0.80),
            "pp": pctile([p["pp_xgf60"] for p in reg if p["pp_xgf60"] is not None], 0.20),
            "pk": pctile([p["pk_xga60"] for p in reg if p["pk_xga60"] is not None], 0.80),
        }
    out = []
    for p in P:
        R = repl[p["grp"]]
        h5 = (p["t5"] or 0) / 3600
        hpp = p["pp"] * p["gp"] / 60
        hpk = p["pk"] * p["gp"] / 60
        evo = 0.5 * (p["relf"] - R["relf"]) * h5 if p["relf"] is not None else 0.0
        evd = 0.5 * (R["rela"] - p["rela"]) * h5 if p["rela"] is not None else 0.0
        fin = 0.5 * (p["gax"] or 0)
        ppv = 0.3 * (p["pp_xgf60"] - R["pp"]) * hpp if p["pp_xgf60"] is not None else 0.0
        pkv = 0.25 * (R["pk"] - p["pk_xga60"]) * hpk if p["pk_xga60"] is not None else 0.0
        pen = 0.15 * ((p["pend"] or 0) - (p["pen"] or 0))
        gar = evo + evd + fin + ppv + pkv + pen
        out.append([p["id"], p["team"], p["pos"], p["gp"], round(evo, 2), round(evd, 2), round(fin, 2), round(ppv, 2),
                    round(pkv, 2), round(pen, 2), round(gar, 2), round(gar / GOALS_PER_WIN, 2)])
    return out, repl, gpmax


def project(seasons, birth, cur, proj, war82_i, table, regress, goalie=False):
    """3-season weighted rate (3/2/1 by recency, weighted by games), then age-adjusted for 7 seasons."""
    by = {}
    for y, s in seasons.items():
        for r in s["rows"]:
            by.setdefault(r[0], []).append((y, r))
    ref_y = cur - 1 if (cur - 1) in seasons else max(seasons)
    per_win_ref = seasons[ref_y]["per_win"]
    regs = [r[war82_i] for r in seasons[ref_y]["rows"] if r[3] >= 20]
    mean = sum(regs) / len(regs) if regs else 0.0
    for pid, lst in by.items():
        lst.sort()
        if lst[-1][0] < cur - 1:
            continue
        num = den = 0.0
        for i, (y, r) in enumerate(reversed(lst[-3:])):
            w = (3 - i) * r[3]
            num += r[war82_i] * w
            den += w
        if den < 20:
            continue
        base = num / den
        if regress:  # pull toward the average regular, since one goalie season is mostly noise
            base = mean + (base - mean) * (1 - regress)
        age0 = None
        b = birth.get(pid)
        if b:
            try:
                bd = dt.date.fromisoformat(b[:10])
                ref = dt.date(cur + 1, 2, 1)
                age0 = ref.year - bd.year - ((ref.month, ref.day) < (bd.month, bd.day))
            except ValueError:
                age0 = None
        rows, war = [], base
        for t in range(1, 8):
            y = cur + t
            age = (age0 + t) if age0 is not None else None
            war = war * (age_mult(age, table) if age is not None else 1.0)
            pw = per_win_ref * cap(y) / cap(ref_y)
            rows.append([y, age, round(war, 2), round(min_sal(y) + max(0.0, war) * pw, 2), cap(y)])
        entry = {"base_war82": round(base, 2), "age": age0, "years": rows}
        if goalie:
            entry["g"] = 1
        proj[str(pid)] = entry


def main():
    cur = current_season()
    idx = read_json(os.path.join(DATA, "index.json"))
    careers = read_json(os.path.join(DATA, "careers.json"))
    birth = {int(k): v[3] for k, v in careers["players"].items()} if careers else {}
    seasons = {}
    for y in idx["mp_seasons"]:
        sf = read_json(os.path.join(DATA, "seasons", f"{y}.json"))
        if not sf:
            continue
        rows, repl, gpmax = season_value(sf, None)
        sched = SCHED.get(y, 82)
        prog = min(1.0, gpmax / sched)  # share of season played so far
        pos_war = sum(max(0.0, r[11]) for r in rows) / prog if prog else 1
        pool = 32 * (cap(y) * SKATER_SHARE - ROSTER * min_sal(y))
        per_win = pool / pos_war if pos_war else 0
        for r in rows:
            war82 = r[11] / r[3] * 82 if r[3] else 0
            worth = min_sal(y) + max(0.0, war82) * per_win
            r.extend([round(war82, 2), round(worth, 2), round(100 * worth / cap(y), 2)])
        seasons[y] = {"cap": cap(y), "min": min_sal(y), "per_win": round(per_win, 3), "progress": round(prog, 3),
                      "repl": {g: {k: round(v, 3) for k, v in d.items()} for g, d in repl.items()}, "rows": rows}
        log(f"value {y}: {len(rows)} players, ${per_win:.2f}M per win, {pos_war:.0f} positive wins")

    # goalies
    gseasons = {}
    for y in idx.get("goalie_seasons") or []:
        sf = read_json(os.path.join(DATA, "goalies", "seasons", f"{y}.json"))
        if not sf:
            continue
        if not sf.get("team_gp"):  # older files: team games from the skater file
            sf["team_gp"] = (read_json(os.path.join(DATA, "seasons", f"{y}.json")) or {}).get("gpmax")
        rows, repl = goalie_value(sf)
        sched = SCHED.get(y, 82)
        prog = min(1.0, (sf.get("team_gp") or sched) / sched)
        pos_war = sum(max(0.0, r[8]) for r in rows) / prog if prog else 1
        pool = 32 * (cap(y) * (1 - SKATER_SHARE) - GOALIE_ROSTER * min_sal(y))
        per_win = pool / pos_war if pos_war else 0
        for r in rows:
            war82 = r[8] / r[3] * 82 if r[3] else 0
            worth = min_sal(y) + max(0.0, war82) * per_win
            r.extend([round(war82, 2), round(worth, 2), round(100 * worth / cap(y), 2)])
        gseasons[y] = {"cap": cap(y), "min": min_sal(y), "per_win": round(per_win, 3), "progress": round(prog, 3),
                       "repl": {k: round(v, 4) for k, v in repl.items()}, "rows": rows}
        log(f"goalie value {y}: {len(rows)} goalies, ${per_win:.2f}M per win, {pos_war:.0f} positive wins")
    gbirth = {}
    gcar = read_json(os.path.join(DATA, "goalies", "careers.json"))
    if gcar:
        gbirth = {int(k): v[3] for k, v in gcar["players"].items()}

    # projections from a 3-season weighted rate (3/2/1 by recency, weighted by games)
    proj = {}
    project(seasons, birth, cur, proj, war82_i=12, table=AGE_MULT, regress=0.0)
    if gseasons:
        project(gseasons, gbirth, cur, proj, war82_i=9, table=AGE_MULT_G, regress=GOALIE_REGRESS, goalie=True)

    write_json(os.path.join(DATA, "value.json"), {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "current": cur,
        "fields": ["id", "team", "pos", "gp", "ev_off", "ev_def", "finishing", "pp", "pk", "penalties", "gar", "war",
                   "war82", "worth", "worth_pct"],
        "seasons": {str(y): s for y, s in seasons.items()},
        "goalie_fields": ["id", "team", "pos", "gp", "ev", "pk", "other", "gar", "war", "war82", "worth", "worth_pct"],
        "goalie_seasons": {str(y): s for y, s in gseasons.items()},
        "proj_fields": ["year", "age", "war", "worth", "cap"],
        "proj": proj,
        "cap_assumption": f"Published caps through {max(CAP)}; {int(CAP_GROWTH * 100)}% a year after that.",
    })

    # current rosters (NHL API)
    teams = read_json(os.path.join(DATA, "seasons", f"{cur}.json"), {}).get("teams") or []
    def roster(t):
        try:
            j = fetch_json(f"https://api-web.nhle.com/v1/roster/{t}/current")
        except Exception as e:  # noqa: BLE001
            log(f"roster {t} failed: {e}")
            return t, None
        out = []
        for grp in ("forwards", "defensemen", "goalies"):
            for p in j.get(grp, []) or []:
                nm = f"{(p.get('firstName') or {}).get('default', '')} {(p.get('lastName') or {}).get('default', '')}".strip()
                out.append([p.get("id"), nm, p.get("positionCode"), p.get("birthDate")])
        return t, out
    rosters = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for t, out in ex.map(roster, teams):
            if out:
                rosters[t] = out
    if rosters:
        write_json(os.path.join(DATA, "rosters.json"), {"updated": dt.date.today().isoformat(), "fields": ["id", "name", "pos", "birth"], "teams": rosters})
        log(f"rosters: {len(rosters)} teams")

    # prospects: recent draft picks who haven't become NHL regulars (matched to careers by name)
    gp_by_name = {}
    if careers:
        fi = careers["fields"]
        gp_by_id = {}
        for r in careers["seasons"]:
            gp_by_id[r[0]] = gp_by_id.get(r[0], 0) + r[fi.index("gp")]
        for pid, b in careers["players"].items():
            key = (b[0] or "").lower()
            gp_by_name[key] = max(gp_by_name.get(key, 0), gp_by_id.get(int(pid), 0))
    if gcar:
        gi = gcar["fields"].index("gp")
        ggp = {}
        for r in gcar["seasons"]:
            ggp[r[0]] = ggp.get(r[0], 0) + r[gi]
        for pid, b in gcar["players"].items():
            key = (b[0] or "").lower()
            gp_by_name[key] = max(gp_by_name.get(key, 0), ggp.get(int(pid), 0))
    last_draft = cur if dt.date.today().month >= 7 or dt.date.today().year > cur else cur - 1
    prospects = []
    for dy in range(last_draft - 4, last_draft + 1):
        try:
            j = fetch_json(f"https://api-web.nhle.com/v1/draft/picks/{dy}/all")
        except Exception as e:  # noqa: BLE001
            log(f"draft {dy} failed: {e}")
            continue
        for p in j.get("picks", []) or []:
            nm = f"{(p.get('firstName') or {}).get('default', '')} {(p.get('lastName') or {}).get('default', '')}".strip()
            gp = gp_by_name.get(nm.lower(), 0)
            if gp >= 100:
                continue
            prospects.append([nm, p.get("positionCode"), dy, p.get("overallPick"), p.get("round"), p.get("teamAbbrev"), gp])
    if prospects:
        write_json(os.path.join(DATA, "prospects.json"), {"updated": dt.date.today().isoformat(),
                   "fields": ["name", "pos", "draft_year", "overall", "round", "drafted_by", "nhl_gp"], "prospects": prospects})
        log(f"prospects: {len(prospects)}")


if __name__ == "__main__":
    main()
