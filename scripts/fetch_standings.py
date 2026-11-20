"""Final regular-season standings (points, games, goals) for every season since 2008-09, from the NHL's standings
endpoint on each season's last game day, into data/checks/standings.json. Not part of the nightly job: run it on a
temporary branch when rerunning scripts/check_value_vs_standings.py (see docs/CHECKS.md)."""
import json, os, sys, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import DATA, fetch_json, read_json, write_json, log
out = {}
for y in range(2008, 2026):
    tf = read_json(os.path.join(DATA, "teams", f"{y}.json"))
    last = max(g[1] for t in tf["teams"].values() for g in t["games"])
    d = dt.datetime.strptime(str(last), "%Y%m%d").date()
    for k in range(6):
        try:
            j = fetch_json(f"https://api-web.nhle.com/v1/standings/{(d - dt.timedelta(days=k)).isoformat()}")
            rows = j.get("standings", [])
            if rows:
                break
        except Exception as e:
            log(f"{y} {d}: {e}")
    out[str(y)] = {r["teamAbbrev"]["default"]: {"gp": r["gamesPlayed"], "pts": r["points"], "w": r["wins"], "rw": r.get("regulationWins"),
                   "gf": r["goalFor"], "ga": r["goalAgainst"]} for r in rows}
    log(f"{y}: {len(rows)} teams, {sum(v['gp'] for v in out[str(y)].values())} team games")
os.makedirs(os.path.join(DATA, "checks"), exist_ok=True)
write_json(os.path.join(DATA, "checks", "standings.json"), out)
