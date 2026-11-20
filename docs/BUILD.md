# Stats-Zor: How the Build Works

November 17, 2026. A short tour of the code: what runs, in what order, what each piece reads and writes. For the reasoning behind the numbers see the [How it works](https://ciiiv.github.io/Stats-Zor/about.html) page; for a non-technical summary see [OVERVIEW.md](OVERVIEW.md).

## The big picture

There are two halves, and they never talk to each other directly:

1. **The nightly build (Python).** A GitHub Actions job downloads public hockey data, crunches it, and saves the results as JSON files in `data/`, then commits them to the repo.
2. **The pages (JavaScript).** When someone opens the site, their browser downloads only the JSON files it needs and does the rest of the math on the spot: percentiles, charts, the scouting lists, the trade machine.

There is no server, no database and no AI in either half. Everything is Python's standard library on one side and plain JavaScript with hand-drawn SVG on the other.

## The nightly job

File: `.github/workflows/update-data.yml`. It runs every day at 12:17 UTC (about 7:17 am Eastern), and can also be started by hand. It runs nine scripts from `scripts/`, in order. Each one after the first is allowed to fail without stopping the rest, so one bad download only leaves that part a day old. At the end it commits whatever changed in `data/`.

By default each script only refreshes the current season and fills in anything missing. Past seasons are built once and kept. Running with `--full` (or the job's `full` option) rebuilds everything.

| # | Script | Reads | Writes (under `data/`) | What it does |
|---|---|---|---|---|
| 1 | `build_data.py` | MoneyPuck season summaries; NHL stats API (careers back to 1917-18, bios, trophies) | `seasons/{y}.json`, `lines/{y}.json`, `careers.json`, `mp_careers.json`, `index.json` | The foundation: every skater's season stats and computed metrics, forward lines and D pairs, full careers, and the search list |
| 2 | `build_shots.py` | MoneyPuck shot-by-shot files | `shots/{y}.json`, `goalies/shots/{y}.json` | Shot maps: every unblocked shot dropped into 5 × 5 ft cells of the offensive zone, for shooters and for goalies |
| 3 | `build_usage.py` | MoneyPuck game-by-game skater files; NHL game-center data (head coaches) | `usage/{y}.json`, `teams/{y}.json`, `teams/coaches/{y}.json`, `teams/history.json`, `puck/{y}.json`, `streaks/{y}.json`, `streaks/career.json` | Deployment: each night, ranks a team's players by ice time into lines, pairs, PP and PK units, plus zone starts. Also saves every team's games in order (5v5 xG and goals) with each player's slot that night for the teams page, and looks up each game's head coaches (up to 1,500 games a run, newest season first). Last, a few-KB summary of every team-season for the history table. It also writes each skater's takeaways, giveaways, hits and blocks adjusted for each arena's scorekeeper, for the Puck play list, and each skater's hat tricks, multi-point games and point and goal streaks, season by season and career since 2008-09, for the player cards |
| 4 | `build_edge.py` | NHL EDGE API (one call per player per season, 2021-22 on) | `edge/{y}.json` | Skating speed, 20+ mph bursts, distance, shot speed, offensive-zone time |
| 5 | `build_box.py` | NHL stats API reports (a few per season) | `box/{y}.json` | Box-score detail for the player cards (EV/PP/SH goals and points, primary and secondary assists, shot attempts, game-winning, OT, empty-net and shootout goals, plus/minus, PIM) and faceoffs by zone and situation for the faceoff list. Descriptive only |
| 6 | `build_disc.py` | NHL stats API penalties report; NHL game-center play-by-play | `disc/{y}.json` | Penalties for the Discipline list: minors drawn and taken (scrum calls left out), fights, instigators, roughing and misconducts. Reads each game's play-by-play once (1,500 games a run, newest season first). Descriptive only |
| 7 | `build_goalies.py` | MoneyPuck goalie season and game files; NHL goalie stats and trophies | `goalies/seasons/{y}.json`, `goalies/games/{y}.json`, `goalies/careers.json`, `goalies/mp_careers.json`; adds goalies to `index.json` | Everything for the goalie page: saves above expected by situation and danger, starts, decisions, rest, careers |
| 8 | `build_impact.py` | NHL shift charts and play-by-play for every game since 2010-11; MoneyPuck shot xG | `impact/{y}.json`, `impact/missing.json` (games whose shift charts couldn't be read, by team and date, for the weekly health check), `impact/test.json` | Isolated impact: cuts games into stints with the same ten skaters, then solves one big regression for each player's offense and defense. Also the power-play fit, quality of competition and linemates, and the nightly forecast test |
| 9 | `build_value.py` | Everything above (seasons, impact, usage, goalies); NHL roster and draft APIs | `value.json`, `rosters.json`, `prospects.json` | The value model: goals above replacement, wins, dollars, three-season projections, the fitted age curve, current rosters with jersey numbers, and recent draft prospects |

Step 8 is the heavy one. It downloads thousands of games, so the raw game files are kept between nights in the GitHub Actions cache (`.cache/impact`), not in the repo. A night normally only fetches the new games. Older seasons for quality of competition are filled in a few at a time.

Step 9 must run last because it reads the output of every other step.

## The pages

| Page | Script | Main files it reads |
|---|---|---|
| Skater page, `index.html` | `app.js` | `index.json`, `seasons/`, `box/`, `streaks/`, `puck/`, `disc/`, `lines/` (also the Leaders lines and pairs), `teams/{y}.json` (team 5v5 share for Leaders), `shots/`, `usage/`, `edge/`, `impact/`, `careers.json`, `mp_careers.json`, `value.json` |
| Goalie page, `goalies.html` | `goalies.js` | `index.json`, `goalies/seasons/`, `goalies/games/`, `goalies/shots/`, `goalies/careers.json`, `goalies/mp_careers.json`, `value.json` |
| Trade machine, `trade.html` | `trade.js` | `value.json`, `rosters.json`, `prospects.json` |
| Teams, `teams.html` | `teams.js` (plus `app.js` for the deployment fit, with its own start-up skipped) | `teams/{y}.json`, `teams/coaches/{y}.json`, `teams/history.json`, `usage/`, `seasons/`, `value.json`, `careers.json` and `goalies/careers.json` (ages), `goalies/games/{y}.json` |
| How it works, `about.html` | none (plain text) | none |

Shared by all pages:

- `common.js`: number formatting, chart axes, the search box (which jumps between the skater and goalie pages), team colors and badges, jersey numbers from `rosters.json`, the smoothed shot maps, and the scouting-list sidebar.
- `theme.js`: the auto / dark / light switch.
- `styles.css`: the look of every page.

Each page loads a season's files only when that season is picked, so opening the skater page downloads about 9 MB (less after the browser caches it), not the whole 74 MB. Every section draws inside a safety wrapper (`safe()`), so one broken section shows an error box instead of taking down the page.

## Where the settings live

- `scripts/build_value.py`, at the top: salary cap figures, replacement levels, the isolated/relative blend weights, goalie weight, finishing shrinkage, small-sample rule.
- `scripts/build_impact.py`, at the top: regression strength and the starting-point settings.
- `trade.js`, at the top: draft pick values and the team-plan discounts.

## Testing changes

The cloud workspace usually can't reach the data sources, so real-data tests run on a temporary GitHub branch whose workflow commits results back, which are then inspected and copied to `main`. Page changes are checked by serving the repo locally and driving it in a headless browser (Playwright): no console errors, screenshots look right, and no sideways scrolling at phone width. Details are in the README and CLAUDE.md.

One-off checks that are not part of the nightly job: `scripts/fetch_standings.py` (final standings since 2008-09 into `data/checks/standings.json`, run on a temporary branch) and `scripts/check_value_vs_standings.py` (value model vs. real standings, prints only). What each check looks for and what it found is in [CHECKS.md](CHECKS.md).
