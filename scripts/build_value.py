#!/usr/bin/env python3
"""Build player value (goals and wins above replacement), dollar worth, projections,
current rosters and recent draft prospects.

Value model (Stats-Zor's own, simple and transparent; not Evolving-Hockey's GAR):
  EV offense   (5v5 offense rate - replacement) x 5v5 hours
  EV defense   (replacement - 5v5 defense rate) x 5v5 hours
               where each 5v5 rate is ISO_WEIGHT x isolated impact (data/impact, stretched to the same
               spread as the relative number) + (1 - ISO_WEIGHT) x 0.5 x relative xGF/60 or xGA/60.
               Seasons before 2010-11 (no shift charts) use the relative number alone.
  Finishing    0.5 x (goals - expected goals), all situations
  Power play   0.3 x (on-ice PP xGF/60 - replacement) x PP hours
  Penalty kill 0.25 x (replacement - on-ice PK xGA/60) x PK hours
  Penalties    0.15 x (penalties drawn - penalties taken)
  Replacement level for each piece is the 20th percentile among regulars at the position.
  Wins = goals / 6.

Dollar worth: the league's skater cap pool above minimum salaries, divided by all positive
wins in the league, gives a market price per win. Worth = minimum salary + wins x price.

Skater projections from fewer than SKATER_GAMES_FULL games over the 3-season window are pulled
toward an average regular at the position (keeping games / SKATER_GAMES_FULL of the gap).

Goalie projections keep shots / (shots + GOALIE_SHOTS_K) of the gap between his 3-season rate
and the league-average goalie, so one hot season counts for much less than three, and are
valued at his own workload (games per season), since no goalie plays 82.

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
from build_data import DATA, MP_FIRST, NHL_LANDING, current_season, fetch_json, log, read_json, write_json  # noqa: E402

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
ISO_WEIGHT = 0.67      # isolated share of the 5v5 rates (set from the forecast test in data/impact/test.json)


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
GOALIE_SHOTS_K = 3000
SKATER_GAMES_FULL = 150  # skater projections from fewer games in the 3-season window keep games / 150 of their gap
                         # to an average regular at the position (backtest 2011-26: best of 120/150/200)  # goalie projections keep shots / (shots + K) of the gap to an average goalie (3 seasons of shots)


AGE_MIN_N = 100  # fewest players an age band needs; thinner bands are merged with the next
AGE_BANDS = [(18, 21), (22, 23), (24, 26), (27, 28), (29, 30), (31, 32), (33, 34), (35, 45)]  # starting age


def fit_age_curve(seasons, birth, cur, min_gp=20):
    """Skater aging measured from our own seasons, by position: for each age band, total wins per 82 the
    next season / this season (weighted by games), for players who were regulars worth 1+ wins per 82 the
    season BEFORE (so this season's luck doesn't bias the ratio). Players who leave the NHL count as falling
    to replacement. Bands are pooled where needed so value never rises with age past a younger band.
    Returns tables in AGE_MULT form, keyed by the age of the season being projected."""
    def age_in(pid, y):
        b = birth.get(pid)
        if not b:
            return None
        try:
            bd = dt.date.fromisoformat(b[:10])
        except ValueError:
            return None
        ref = dt.date(y + 1, 2, 1)
        return ref.year - bd.year - ((ref.month, ref.day) < (bd.month, bd.day))
    rows = {y: {r[0]: r for r in s["rows"]} for y, s in seasons.items()}
    acc = {(g, i): [0.0, 0.0, 0] for g in ("F", "D") for i in range(len(AGE_BANDS))}
    for y in sorted(rows):
        if y - 1 not in rows or y + 1 >= cur:
            continue
        for pid, r in rows[y].items():
            p, n, a = rows[y - 1].get(pid), rows.get(y + 1, {}).get(pid), age_in(pid, y)
            if a is None or r[3] < min_gp or not p or p[3] < 40 or p[12] <= 1.0:
                continue
            if n and n[3] >= min_gp:
                w, nv = 2 / (1 / r[3] + 1 / n[3]), n[12]
            elif not n and y + 2 < cur and pid not in rows.get(y + 2, {}):
                w, nv = r[3] / 2, 0.0
            else:
                continue
            i = next((k for k, (lo, hi) in enumerate(AGE_BANDS) if lo <= a <= hi), None)
            if i is None:
                continue
            o = acc[("D" if r[2] == "D" else "F", i)]
            o[0] += w * nv
            o[1] += w * r[12]
            o[2] += 1
    out = {}
    for g in ("F", "D"):
        raw = [[acc[(g, i)][0], acc[(g, i)][1], acc[(g, i)][2], [i]] for i in range(len(AGE_BANDS))]
        k = 0
        while k < len(raw):  # thin bands (under AGE_MIN_N players) are merged into the next band
            if raw[k][2] < AGE_MIN_N and len(raw) > 1:
                j = k + 1 if k + 1 < len(raw) else k - 1
                raw[j] = [raw[j][0] + raw[k][0], raw[j][1] + raw[k][1], raw[j][2] + raw[k][2], sorted(raw[j][3] + raw[k][3])]
                del raw[k]
                k = max(0, k - 1) if j < k else k
            else:
                k += 1
        blocks = [[a / b if b > 0 else 1.0, n, ix] for a, b, n, ix in raw]
        i = 0
        while i < len(blocks) - 1:  # pool adjacent bands until ratios never rise with age
            if blocks[i][0] < blocks[i + 1][0]:
                a, b = blocks[i], blocks[i + 1]
                n = a[1] + b[1] or 1
                blocks[i] = [(a[0] * a[1] + b[0] * b[1]) / n, a[1] + b[1], a[2] + b[2]]
                del blocks[i + 1]
                i = max(0, i - 1)
            else:
                i += 1
        val = {j: round(v, 3) for v, _, ix in blocks for j in ix}
        cnt = {i: acc[(g, i)][2] for i in range(len(AGE_BANDS))}
        if sum(cnt.values()) < 500:  # not enough data: keep the hand-set curve
            return None
        out[g] = {"table": [(hi + 1 if k < len(AGE_BANDS) - 1 else 99, val[k]) for k, (lo, hi) in enumerate(AGE_BANDS)],
                  "bands": [[lo, hi, val[k], cnt[k]] for k, (lo, hi) in enumerate(AGE_BANDS)]}
    return out


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
    # isolated impact (build_impact.py), stretched per position to the spread of 0.5 x relative
    imp = read_json(os.path.join(DATA, "impact", f"{sf['season']}.json")) if sf.get("season") else None
    iso = {}
    if imp:
        fi = imp["fields"]
        iso = {r[fi.index("id")]: (r[fi.index("off")], r[fi.index("def")]) for r in imp["players"]}
    repl, scale = {}, {}

    def sd(v):
        v = [x for x in v if x is not None]
        if len(v) < 2:
            return 0.0
        m = sum(v) / len(v)
        return (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5

    regs = {}
    for grp in ("F", "D"):
        reg = [p for p in P if p["grp"] == grp and p["gp"] >= 0.25 * gpmax and (p["t5"] or 0) >= 18000 * gpmax / 82]
        regs[grp] = reg
        both = [p for p in reg if p["id"] in iso and p["relf"] is not None and p["rela"] is not None]
        so, sd_ = sd([iso[p["id"]][0] for p in both]), sd([iso[p["id"]][1] for p in both])
        scale[grp] = (sd([0.5 * p["relf"] for p in both]) / so if so else 0.0,
                      sd([0.5 * p["rela"] for p in both]) / sd_ if sd_ else 0.0)

    def rates(p, w):
        """(offense, defense) 5v5 rates per 60 for isolated weight w; relative only when no isolated number."""
        rf = 0.5 * p["relf"] if p["relf"] is not None else None
        ra = 0.5 * p["rela"] if p["rela"] is not None else None
        i = iso.get(p["id"])
        if i is None or not scale.get(p["grp"], (0, 0))[0]:
            return rf, ra
        k = scale[p["grp"]]
        io, idf = i[0] * k[0], i[1] * k[1]
        return (io if rf is None else w * io + (1 - w) * rf), (idf if ra is None else w * idf + (1 - w) * ra)

    w_used = ISO_WEIGHT if iso else 0.0
    ev = {}  # weight -> {id: (off, def) goals}
    for w in {w_used, 0.0, 1.0}:
        R5 = {}
        for grp in ("F", "D"):
            rr = [rates(p, w) for p in regs[grp]]
            R5[grp] = (pctile([r[0] for r in rr], 0.20), pctile([r[1] for r in rr], 0.80))
        d = {}
        for p in P:
            h5 = (p["t5"] or 0) / 3600
            o, a = rates(p, w)
            d[p["id"]] = ((o - R5[p["grp"]][0]) * h5 if o is not None else 0.0,
                          (R5[p["grp"]][1] - a) * h5 if a is not None else 0.0)
        ev[w] = d
        if w == w_used:
            for grp in ("F", "D"):
                repl.setdefault(grp, {})["ev_off"], repl[grp]["ev_def"] = R5[grp]
    for grp in ("F", "D"):
        reg = regs[grp]
        repl[grp].update({
            "pp": pctile([p["pp_xgf60"] for p in reg if p["pp_xgf60"] is not None], 0.20),
            "pk": pctile([p["pk_xga60"] for p in reg if p["pk_xga60"] is not None], 0.80),
        })
    out, alt = [], {}
    for p in P:
        R = repl[p["grp"]]
        hpp = p["pp"] * p["gp"] / 60
        hpk = p["pk"] * p["gp"] / 60
        evo, evd = ev[w_used][p["id"]]
        fin = 0.5 * (p["gax"] or 0)
        ppv = 0.3 * (p["pp_xgf60"] - R["pp"]) * hpp if p["pp_xgf60"] is not None else 0.0
        pkv = 0.25 * (R["pk"] - p["pk_xga60"]) * hpk if p["pk_xga60"] is not None else 0.0
        pen = 0.15 * ((p["pend"] or 0) - (p["pen"] or 0))
        gar = evo + evd + fin + ppv + pkv + pen
        out.append([p["id"], p["team"], p["pos"], p["gp"], round(evo, 2), round(evd, 2), round(fin, 2), round(ppv, 2),
                    round(pkv, 2), round(pen, 2), round(gar, 2), round(gar / GOALS_PER_WIN, 2)])
        alt[p["id"]] = (round(sum(ev[0.0][p["id"]]), 2), round(sum(ev[1.0][p["id"]]), 2) if iso and p["id"] in iso else None)
    meta = {"iso_weight": w_used, "iso_scale": {g: [round(a, 3), round(b, 3)] for g, (a, b) in scale.items()} if iso else None}
    return out, repl, gpmax, alt, meta


def project(seasons, birth, cur, proj, war82_i, table):
    """3-season weighted rate (3/2/1 by recency, weighted by games), then age-adjusted for 7 seasons."""
    by = {}
    for y, s in seasons.items():
        for r in s["rows"]:
            by.setdefault(r[0], []).append((y, r))
    ref_y = cur - 1 if (cur - 1) in seasons else max(seasons)
    per_win_ref = seasons[ref_y]["per_win"]
    prior = {}  # games-weighted wins per 82 of regulars (40+ games) by position, last complete season
    for g in ("F", "D"):
        rs = [r for r in seasons[ref_y]["rows"] if ("D" if r[2] == "D" else "F") == g and r[3] >= 40]
        prior[g] = sum(r[war82_i] * r[3] for r in rs) / sum(r[3] for r in rs) if rs else 0.0
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
        base = raw = num / den
        games = sum(r[3] for _, r in lst[-3:])
        if games < SKATER_GAMES_FULL:  # small sample: pull toward an average regular at his position
            pr = prior.get("D" if lst[-1][1][2] == "D" else "F", 0.0)
            base = pr + (raw - pr) * games / SKATER_GAMES_FULL
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
            tb = table.get("D" if lst[-1][1][2] == "D" else "F", AGE_MULT) if isinstance(table, dict) else table
            war = war * (age_mult(age, tb) if age is not None else 1.0)
            pw = per_win_ref * cap(y) / cap(ref_y)
            rows.append([y, age, round(war, 2), round(min_sal(y) + max(0.0, war) * pw, 2), cap(y)])
        proj[str(pid)] = {"base_war82": round(base, 2), "age": age0, "years": rows, "games": games,
                          **({"raw_war82": round(raw, 2), "prior": round(prior["D" if lst[-1][1][2] == "D" else "F"], 2)} if base != raw else {})}


def project_goalies(gseasons, birth, cur, proj, shots):
    """Goalie projection in wins per season at his own workload.

    rate     = wins per 82 games, 3-season blend (weights 3, 2, 1 x games)
    kept     = shots faced in those seasons / (shots + GOALIE_SHOTS_K)
    rate'    = league-average goalie rate + kept x (rate - league-average rate)
    workload = his games per season, same 3/2/1 blend (an unfinished season at pace, weighted by how much is played), max 65
    wins     = rate' x workload / 82, then the goalie age curve each year
    """
    by = {}
    for y, s in gseasons.items():
        for r in s["rows"]:
            by.setdefault(r[0], []).append((y, r, s["progress"] or 1))
    ref_y = cur - 1 if (cur - 1) in gseasons else max(gseasons)
    per_win_ref = gseasons[ref_y]["per_win"]
    rows_ref = gseasons[ref_y]["rows"]
    gp_all = sum(r[3] for r in rows_ref)
    lg_rate = sum(r[8] for r in rows_ref) / gp_all * 82 if gp_all else 0.0  # games-weighted league average
    for pid, lst in by.items():
        lst.sort(key=lambda x: x[0])
        if lst[-1][0] < cur - 1:
            continue
        num = den = gnum = gden = 0.0
        for i, (y, r, prog) in enumerate(reversed(lst[-3:])):
            w = 3 - i
            num += r[9] * w * r[3]
            den += w * r[3]
            gnum += w * prog * min(65.0, r[3] / prog)  # an unfinished season counts in proportion to how much is played
            gden += w * prog
        if den < 20:
            continue
        rate = num / den
        n = sum(shots.get((pid, y), 0) for y, _, _ in lst[-3:])
        kept = n / (n + GOALIE_SHOTS_K)
        rate_p = lg_rate + kept * (rate - lg_rate)
        games = gnum / gden
        base = rate_p * games / 82
        age0 = None
        b = birth.get(pid)
        if b:
            try:
                bd = dt.date.fromisoformat(b[:10])
                ref = dt.date(cur + 1, 2, 1)
                age0 = ref.year - bd.year - ((ref.month, ref.day) < (bd.month, bd.day))
            except ValueError:
                age0 = None
        out, war = [], base
        for t in range(1, 8):
            y = cur + t
            age = (age0 + t) if age0 is not None else None
            war = war * (age_mult(age, AGE_MULT_G) if age is not None else 1.0)
            pw = per_win_ref * cap(y) / cap(ref_y)
            out.append([y, age, round(war, 2), round(min_sal(y) + max(0.0, war) * pw, 2), cap(y)])
        proj[str(pid)] = {"g": 1, "base_war82": round(base, 2), "per": "season", "age": age0, "years": out,
                          "rate": round(rate, 2), "lg_rate": round(lg_rate, 2), "kept": round(kept, 3), "shots": n,
                          "games": round(games, 1)}


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
        sf.setdefault("season", y)
        rows, repl, gpmax, alt, meta = season_value(sf, None)
        sched = SCHED.get(y, 82)
        prog = min(1.0, gpmax / sched)  # share of season played so far
        pos_war = sum(max(0.0, r[11]) for r in rows) / prog if prog else 1
        pool = 32 * (cap(y) * SKATER_SHARE - ROSTER * min_sal(y))
        per_win = pool / pos_war if pos_war else 0
        for r in rows:
            war82 = r[11] / r[3] * 82 if r[3] else 0
            worth = min_sal(y) + max(0.0, war82) * per_win
            r.extend([round(war82, 2), round(worth, 2), round(100 * worth / cap(y), 2), *alt[r[0]]])
        seasons[y] = {"cap": cap(y), "min": min_sal(y), "per_win": round(per_win, 3), "progress": round(prog, 3), **meta,
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
            # goalies never play 82 games, so worth uses his own season (at pace if it's unfinished)
            worth = min_sal(y) + max(0.0, r[8] / prog if prog else 0) * per_win
            r.extend([round(war82, 2), round(worth, 2), round(100 * worth / cap(y), 2)])
        gseasons[y] = {"cap": cap(y), "min": min_sal(y), "per_win": round(per_win, 3), "progress": round(prog, 3),
                       "repl": {k: round(v, 4) for k, v in repl.items()}, "rows": rows}
        log(f"goalie value {y}: {len(rows)} goalies, ${per_win:.2f}M per win, {pos_war:.0f} positive wins")
    gshots = {}
    for y in gseasons:
        sf = read_json(os.path.join(DATA, "goalies", "seasons", f"{y}.json")) or {}
        if sf:
            ix = {k: i for i, k in enumerate(sf["fields"])}
            for r in sf["players"]:
                gshots[(r[ix["id"]], y)] = r[ix["sa"]] or 0
    gbirth = {}
    gcar = read_json(os.path.join(DATA, "goalies", "careers.json"))
    if gcar:
        gbirth = {int(k): v[3] for k, v in gcar["players"].items()}

    # projections from a 3-season weighted rate (3/2/1 by recency, weighted by games)
    proj = {}
    curve = fit_age_curve(seasons, birth, cur)
    if curve:
        log("age curve: " + "; ".join(f"{g} {c['table']}" for g, c in curve.items()))
    project(seasons, birth, cur, proj, war82_i=12, table={g: c["table"] for g, c in curve.items()} if curve else AGE_MULT)
    if gseasons:
        project_goalies(gseasons, gbirth, cur, proj, gshots)

    # team-control inputs for the trade machine: birth date and accrued seasons (an estimate of the
    # CBA rule: a season with 40+ NHL games, 25+ for goalies), completed seasons only
    acc = {}
    if careers:
        fi = careers["fields"]
        for r in careers["seasons"]:
            if r[fi.index("y")] < cur and r[fi.index("gp")] >= 40:
                acc[r[0]] = acc.get(r[0], 0) + 1
    if gcar:
        fg = gcar["fields"]
        for r in gcar["seasons"]:
            if r[fg.index("y")] < cur and r[fg.index("gp")] >= 25:
                acc[r[0]] = acc.get(r[0], 0) + 1
    for pid, e in proj.items():
        b = (gbirth if e.get("g") else birth).get(int(pid))
        e["birth"] = b[:10] if b else None
        e["acc"] = acc.get(int(pid), 0)

    write_json(os.path.join(DATA, "value.json"), {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "current": cur,
        "fields": ["id", "team", "pos", "gp", "ev_off", "ev_def", "finishing", "pp", "pk", "penalties", "gar", "war",
                   "war82", "worth", "worth_pct", "ev_rel_only", "ev_iso_only"],
        "seasons": {str(y): s for y, s in seasons.items()},
        "goalie_fields": ["id", "team", "pos", "gp", "ev", "pk", "other", "gar", "war", "war82", "worth", "worth_pct"],
        "goalie_seasons": {str(y): s for y, s in gseasons.items()},
        "proj_fields": ["year", "age", "war", "worth", "cap"],
        "age_curve": {g: c["bands"] for g, c in curve.items()} if curve else None,
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
    for out in rosters.values():
        for row in out:
            row.append(0)  # on the active roster
    # Players still under a team's control but missing from its active roster (sitting out,
    # unsigned RFA, long-term injury, suspended): anyone who played the last two seasons and
    # isn't on any active roster, kept if his NHL player record still names a current team.
    if len(rosters) >= 0.9 * len(teams):
        on = {row[0] for out in rosters.values() for row in out}
        recent = {}
        for y in (cur - 1, cur):
            sf = read_json(os.path.join(DATA, "seasons", f"{y}.json"))
            if sf:
                for r in sf["players"]:
                    recent[r[0]] = (r[1], r[3])
            gf = read_json(os.path.join(DATA, "goalies", "seasons", f"{y}.json"))
            if gf:
                gi = {k: i for i, k in enumerate(gf["fields"])}
                for r in gf["players"]:
                    recent[r[gi["id"]]] = (r[gi["name"]], "G")
        todo = [pid for pid in recent if pid not in on]

        def status(pid):
            try:
                j = fetch_json(NHL_LANDING.format(pid=pid))
            except Exception:  # noqa: BLE001
                return pid, None, None
            return pid, j.get("currentTeamAbbrev") if j.get("isActive") else None, j.get("birthDate")

        added = 0
        with ThreadPoolExecutor(max_workers=8) as ex:
            for pid, team, birth in ex.map(status, todo):
                if team and team in rosters:
                    nm, pos = recent[pid]
                    rosters[team].append([pid, nm, pos, birth, 1])
                    added += 1
        log(f"rosters: {added} players under contract or team control but not on an active roster ({len(todo)} checked)")
    if rosters:
        write_json(os.path.join(DATA, "rosters.json"), {"updated": dt.date.today().isoformat(), "fields": ["id", "name", "pos", "birth", "off_roster"], "teams": rosters})
        log(f"rosters: {len(rosters)} teams")

    # prospects: recent draft picks who haven't become NHL regulars (matched to careers by name)
    gp_by_name = {}
    id_by_name = {}  # name -> (career GP, NHL id), for linking prospects to their NHL record
    if careers:
        fi = careers["fields"]
        gp_by_id = {}
        for r in careers["seasons"]:
            gp_by_id[r[0]] = gp_by_id.get(r[0], 0) + r[fi.index("gp")]
        for pid, b in careers["players"].items():
            key = (b[0] or "").lower()
            gp_by_name[key] = max(gp_by_name.get(key, 0), gp_by_id.get(int(pid), 0))
            if gp_by_id.get(int(pid), 0) >= id_by_name.get(key, (-1, None))[0]:
                id_by_name[key] = (gp_by_id.get(int(pid), 0), int(pid))
    if gcar:
        gi = gcar["fields"].index("gp")
        ggp = {}
        for r in gcar["seasons"]:
            ggp[r[0]] = ggp.get(r[0], 0) + r[gi]
        for pid, b in gcar["players"].items():
            key = (b[0] or "").lower()
            gp_by_name[key] = max(gp_by_name.get(key, 0), ggp.get(int(pid), 0))
            if ggp.get(int(pid), 0) >= id_by_name.get(key, (-1, None))[0]:
                id_by_name[key] = (ggp.get(int(pid), 0), int(pid))
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
            prospects.append([nm, p.get("positionCode"), dy, p.get("overallPick"), p.get("round"), p.get("teamAbbrev"), gp,
                              id_by_name.get(nm.lower(), (0, None))[1] if gp else None])
    if prospects:
        write_json(os.path.join(DATA, "prospects.json"), {"updated": dt.date.today().isoformat(),
                   "fields": ["name", "pos", "draft_year", "overall", "round", "drafted_by", "nhl_gp", "id"], "prospects": prospects})
        log(f"prospects: {len(prospects)}")


if __name__ == "__main__":
    main()
