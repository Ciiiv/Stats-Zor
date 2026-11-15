# Stats-Zor

NHL player analysis that runs entirely in the browser. Search any skater or goalie, compare two players, and follow them from a single season to their whole career.

**Live site:** https://ciiiv.github.io/Stats-Zor/
**How it works:** https://ciiiv.github.io/Stats-Zor/about.html explains the math, logic and limits behind every section.

## What's on the site

The player page (`index.html`) opens with two profile cards (season line, scores, trophies, and NHL EDGE tools like skating speed and shot speed with a slowing-down flag), then four parts, matching the nav bar:

1. **How he played:** one season, MoneyPuck data.
   - **Two-way composite:** ranking with adjustable defense, offense and role weights.
   - **Stat board:** a color-coded percentile matrix, filled with top-ranked or most-similar players.
   - **Head to head:** percentile radar plus a side-by-side table.
   - **Shot environment:** xGF/60 vs. xGA/60, and zone starts vs. relative impact.
   - **Shot maps:** where he shoots compared with his position, and finishing by location.
   - **Linemates and partners:** 5v5 results with and without each teammate.
   - **Team swap:** projects his on/off impact onto another team.
2. **How he's used:** game-by-game deployment.
   - **Role and fit:** line or pair, PP and PK units, and zone starts each night. Results are judged three ways (5v5 results, overall value, against his role), with a note on what the data can't see.
   - **Team deployment card:** every regular on a team, "used as" vs. 5v5 fit, overall fit and vs. role, with flags.
3. **What he's worth:** the Stats-Zor value model.
   - **Value and worth:** wins above replacement by component, priced with the salary cap, plus an optional cap-hit box for the underpaid/overpaid comparison.
   - **Fair-value contract:** the AAV his projected value justifies for 1–7 year terms.
4. **Vs. history:** careers back to 1917-18.
   - **Career vs. career:** era-adjusted totals, same-age and same-stage comparisons, trophies and Cups.
   - **Career arcs and comps:** every season by age, plus the closest historical comps.

The goalie page (`goalies.html`) has the same four parts, built for goalies. Searching a goalie on the skater page sends you there, and the other way around.

1. **How he played:** goalie composite (stopping, danger and situations, workload), stat board, head to head, shot environment (how much help he got), maps of the shots he faced, and a goalie swap.
2. **How he's used:** start share and role, rest and back-to-back splits, quality starts, form through the season, and a team goalie card with results fit.
3. **What he's worth:** goals saved above a replacement goalie, priced with the goalie share of the cap, plus a fair-value contract.
4. **Vs. history:** careers back to 1917-18, with save % against the league average (1955-56 on), goals saved above average and era-adjusted GAA.

Two more pages:
- **Trade machine** (`trade.html`): two teams; skaters, goalies, prospects and draft picks; optional cap hits and years left; a value or surplus verdict.
- **How it works** (`about.html`): a glossary plus the method for every section.

## How the data works

Nothing runs on a server. `.github/workflows/update-data.yml` runs every morning at 12:17 UTC (about 7 a.m. Eastern), after MoneyPuck's overnight update. It runs six scripts, then commits the JSON files they write to `data/`. The site reads those files.

| Script | Writes | From |
|---|---|---|
| `scripts/build_data.py` | `seasons/`, `lines/`, `careers.json`, `mp_careers.json`, `index.json` | MoneyPuck season summaries and lines; NHL stats API (careers, bios, league scoring) and player API (trophies) |
| `scripts/build_shots.py` | `shots/`, `goalies/shots/` | MoneyPuck shot data (shots taken by skaters, shots faced by goalies) |
| `scripts/build_usage.py` | `usage/` | MoneyPuck game-by-game skater data |
| `scripts/build_edge.py` | `edge/` | NHL EDGE API, one request per player per season (2021-22 on) |
| `scripts/build_goalies.py` | `goalies/seasons/`, `goalies/games/`, `goalies/careers.json`, `goalies/mp_careers.json`; adds goalies to `index.json` | MoneyPuck goalie season and game-by-game files; NHL goalie reports (seasons, game logs, careers) and player API (trophies) |
| `scripts/build_value.py` | `value.json` (skaters and goalies), `rosters.json`, `prospects.json` | The files above, plus NHL roster and draft API |

| Source | Used for |
|---|---|
| [MoneyPuck.com](https://moneypuck.com/data.htm) (2008-09 on) | Expected goals, on/off-ice impact, zone starts, lines and pairs, shots, game-by-game deployment, goalie goals saved above expected |
| NHL stats API (`api.nhle.com`) | Every NHL skater and goalie season since 1917-18, bios, league scoring and save % for era adjustment, goalie game logs (starts, decisions) |
| NHL player API (`api-web.nhle.com`) | Trophies, Stanley Cups, Hall of Fame, current rosters, draft picks |
| NHL EDGE API (`api-web.nhle.com/v1/edge`) | Skating speed, bursts, distance, shot speed, zone time (2021-22 on) |

MoneyPuck data is free for non-commercial use with credit to MoneyPuck.com. Contract data is not included. PuckPedia's terms don't allow scraping, so cap hits are typed in by the user and stay in their browser.

### Model assumptions in code
- **Era adjustment:** `adjusted = actual × 6.0 ÷ that season's league goals per game`.
- **Salary cap and minimum salary by season:** the `CAP` and `MIN` tables at the top of `scripts/build_value.py`. Published caps run through 2027-28 ($113.5M); the model assumes 5% a year after that. Update these when the league announces new figures.
- **Value weights, replacement level, age curves:** also in `scripts/build_value.py`. Goalies use `GOALIE_WEIGHT` (half credit for goals saved), `GOALIE_SHOTS_K` (projections keep shots ÷ (shots + 3,000) of a goalie's edge over average, and use his own workload), `AGE_MULT_G` and the goalie cap share (1 − `SKATER_SHARE`).
- **Pick and prospect values:** `pickWins`, `FUTURE_DISCOUNT` and `PROSPECT_DECAY` at the top of `trade.js`.

## Running the update yourself

- **Nightly:** runs on its own, and picks up each new season (from September 1) as soon as MoneyPuck and the NHL publish it. GitHub switches off scheduled jobs in a repo with 60 days of no activity, which can happen over the summer when there's no new data to commit, so each September check the Actions tab and click **Enable workflow** if it's been paused.
- **Each year:** when the league announces a new salary cap, update the `CAP` and `MIN` tables in `scripts/build_value.py`.
- **On demand:** Actions tab → **Update data** → **Run workflow**.
- **Full rebuild:** tick **full** when you run it. This re-downloads every season and takes about 1–2 hours, mostly the game-by-game and shot files. Normal runs only refresh the current season and fill in anything missing.
- **Locally:** run the six scripts in order: `python scripts/build_data.py`, then `build_shots.py`, `build_usage.py`, `build_edge.py`, `build_goalies.py` and `build_value.py`. Add `--full` to the first five to rebuild everything. They use only the Python standard library.

## Files

```
index.html  app.js                 skater page
goalies.html  goalies.js           goalie page
common.js                          shared helpers (formatting, charts, search)
theme.js                           light/dark toggle in the header (auto follows the device)
trade.html  trade.js               trade machine
about.html                         how it works (methods and glossary)
styles.css                         shared styles
scripts/build_data.py              seasons, lines, careers, index
scripts/build_shots.py             shot maps
scripts/build_usage.py             deployment (roles, splits)
scripts/build_edge.py              NHL EDGE tracking
scripts/build_goalies.py           goalie seasons, games, careers
scripts/build_value.py             value model, rosters, prospects
.github/workflows/update-data.yml  nightly job
data/                              generated by the job; don't edit by hand
```

## Updating the site code

The HTML pages load `styles.css?v=…`, `theme.js?v=…`, `common.js?v=…`, `app.js?v=…`, `goalies.js?v=…` and `trade.js?v=…`. Bump the `v` value in every page that loads a file you changed, so browsers fetch the new version instead of a cached one. The nightly data job doesn't need this, because data files are fetched fresh every time.

If you change how a number is calculated, update its entry in `about.html` too.
