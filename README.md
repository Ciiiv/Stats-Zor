# Stats-Zor

Two-way NHL player analysis that runs entirely in the browser. Search any skater, forward or defenseman, compare two players, and follow them from a single season to their whole career.

**Live site:** https://ciiiv.github.io/Stats-Zor/
**How it works:** https://ciiiv.github.io/Stats-Zor/about.html explains the math, logic and limits behind every section.

## What's on the site

The player page (`index.html`) opens with two profile cards, then four parts, matching the nav bar:

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

Two more pages:
- **Trade machine** (`trade.html`): two teams; players, prospects and draft picks; optional cap hits and years left; a value or surplus verdict.
- **How it works** (`about.html`): a glossary plus the method for every section.

## How the data works

Nothing runs on a server. `.github/workflows/update-data.yml` runs every morning at 12:17 UTC (about 7 a.m. Eastern), after MoneyPuck's overnight update. It runs four scripts, then commits the JSON files they write to `data/`. The site reads those files.

| Script | Writes | From |
|---|---|---|
| `scripts/build_data.py` | `seasons/`, `lines/`, `careers.json`, `mp_careers.json`, `index.json` | MoneyPuck season summaries and lines; NHL stats API (careers, bios, league scoring) and player API (trophies) |
| `scripts/build_shots.py` | `shots/` | MoneyPuck shot data |
| `scripts/build_usage.py` | `usage/` | MoneyPuck game-by-game skater data |
| `scripts/build_value.py` | `value.json`, `rosters.json`, `prospects.json` | The files above, plus NHL roster and draft API |

| Source | Used for |
|---|---|
| [MoneyPuck.com](https://moneypuck.com/data.htm) (2008-09 on) | Expected goals, on/off-ice impact, zone starts, lines and pairs, shots, game-by-game deployment |
| NHL stats API (`api.nhle.com`) | Every NHL skater season since 1917-18, bios, league scoring for era adjustment |
| NHL player API (`api-web.nhle.com`) | Trophies, Stanley Cups, Hall of Fame, current rosters, draft picks |

MoneyPuck data is free for non-commercial use with credit to MoneyPuck.com. Contract data is not included. PuckPedia's terms don't allow scraping, so cap hits are typed in by the user and stay in their browser.

### Model assumptions in code
- **Era adjustment:** `adjusted = actual × 6.0 ÷ that season's league goals per game`.
- **Salary cap and minimum salary by season:** the `CAP` and `MIN` tables at the top of `scripts/build_value.py`. Published caps run through 2027-28 ($113.5M); the model assumes 5% a year after that. Update these when the league announces new figures.
- **Value weights, replacement level, age curve:** also in `scripts/build_value.py`.
- **Pick and prospect values:** `pickWins`, `FUTURE_DISCOUNT` and `PROSPECT_DECAY` at the top of `trade.js`.

## Running the update yourself

- **Nightly:** runs on its own. If GitHub pauses scheduled jobs after a long quiet stretch, re-enable it in the Actions tab.
- **On demand:** Actions tab → **Update data** → **Run workflow**.
- **Full rebuild:** tick **full** when you run it. This re-downloads every season and takes about 1–2 hours, mostly the game-by-game and shot files. Normal runs only refresh the current season and fill in anything missing.
- **Locally:** run the four scripts in order: `python scripts/build_data.py`, then `build_shots.py`, `build_usage.py` and `build_value.py`. Add `--full` to the first three to rebuild everything. They use only the Python standard library.

## Files

```
index.html  app.js                 player page
trade.html  trade.js               trade machine
about.html                         how it works (methods and glossary)
styles.css                         shared styles
scripts/build_data.py              seasons, lines, careers, index
scripts/build_shots.py             shot maps
scripts/build_usage.py             deployment (roles, splits)
scripts/build_value.py             value model, rosters, prospects
.github/workflows/update-data.yml  nightly job
data/                              generated by the job; don't edit by hand
```

## Updating the site code

The HTML pages load `styles.css?v=…`, `app.js?v=…` and `trade.js?v=…`. Bump the `v` value in every page that loads a file you changed, so browsers fetch the new version instead of a cached one. The nightly data job doesn't need this, because data files are fetched fresh every time.

If you change how a number is calculated, update its entry in `about.html` too.
