# Stats-Zor: notes for Claude

A static NHL analytics site (skaters and goalies) on GitHub Pages: https://ciiiv.github.io/Stats-Zor/
No server, no database, no AI at runtime. A nightly GitHub Actions job builds JSON into `data/`; the pages read it in the browser.
Read `README.md` (structure, pipeline, how to run) and `about.html` (every formula and its limits) before changing anything.

## Working with the owner
- If a message says "no code", "just a question" or "let's talk first", answer only. Don't edit files, publish or push until asked.
- For big or judgment-call changes (model weights, new sections), lay out the plan or options first and let the owner pick.
- Explain results in plain hockey terms, with real player examples, not code details.
- Commit to `main` only when asked to build something. Don't leave extra branches behind.

## Hard rules
- **Never scrape PuckPedia** (its terms forbid it). Contract data isn't in the site; cap hits are typed in by the user and stay in their browser (`localStorage` key `sz-cap-{playerId}`).
- **MoneyPuck data is non-commercial use with credit to MoneyPuck.com.** Keep the credit in every page footer and in the README. The bulk files on `peter-tanner.com` are MoneyPuck's (Peter Tanner runs MoneyPuck).
- Pipeline scripts use the **Python standard library only**. Front end is vanilla JS + hand-written SVG, no frameworks or chart libraries.

## Map
| Area | Files |
|---|---|
| Skater page | `index.html`, `app.js` |
| Goalie page | `goalies.html`, `goalies.js` |
| Trade machine | `trade.html`, `trade.js` (values players, prospects, picks; goalies priced at the goalie price of a win; rosters include players under team control who are off the active roster, `off_roster` in `rosters.json`; RFA team control from `birth`/`acc` in `value.json` projections; prospects carry an NHL `id` in `prospects.json`) |
| Methods page | `about.html` (glossary + a section per page section; anchors `#m-…`, goalie ones `#m-g-…`) |
| Shared front end | `common.js` (formatters, SVG axes, search with cross-page routing), `theme.js` (auto/dark/light toggle), `styles.css` |
| Pipeline | `scripts/build_data.py` → `build_shots.py` → `build_usage.py` → `build_edge.py` → `build_goalies.py` → `build_value.py` |
| Nightly job | `.github/workflows/update-data.yml` (12:17 UTC; each step after the first is continue-on-error; input `full` rebuilds everything) |
| Model settings | top of `scripts/build_value.py` (`CAP`, `MIN`, weights, `GOALIE_WEIGHT`, `GOALIE_SHOTS_K`, age curves) and top of `trade.js` (`pickWins`, discounts) |

Searching a goalie on the skater page goes to `goalies.html#a={id}` and vice versa (`crossTo` in `common.js`). Goalies are in `data/index.json` with `pos: "G"`; their season mask refers to `data/goalies/seasons/`.

## Conventions
- **Seasons are start years:** `2025` = 2025-26. A new season starts September 1 (`current_season()`).
- **Age** is as of February 1 of the season.
- **Percentiles** are within position group only (F, D, G), flipped where lower is better, so blue is always good.
- **Goalie pools use team games**, not the goalie max: `team_gp` in the goalie season files (no goalie plays 82).
- **Cache busting:** pages load `styles.css?v=…`, `theme.js?v=…`, `common.js?v=…`, `app.js?v=…`, `goalies.js?v=…`, `trade.js?v=…`. Bump the `v` (a timestamp like `202611150400`) in every page that loads a file you changed.
- **When a calculation changes, update its section in `about.html`** (and the README if a setting or script changes).
- Every section head links to its `about.html` anchor with `<a class="how">`. Sections render through `safe(id, fn)` so one failure doesn't break the page.
- Copy style on the pages: plain sentences, no jargon without a glossary entry, state limits honestly (the `details.lim` boxes).

## Testing
- **The cloud workspace usually can't reach MoneyPuck, peter-tanner.com, the NHL APIs or the live site.** Don't assume the scripts can run against real data locally.
- **Real data:** what works is a temporary branch with a workflow triggered `on: push` that runs the needed scripts and commits `data/` back to that branch with `[skip ci]` in the message (needs `permissions: contents: write`). Fetch it, inspect, then copy the files onto `main` and delete the branch (the owner may need to delete it on GitHub; the proxy can block branch deletion). Workflow artifact downloads are blocked by the proxy, so commit the data instead.
- **Fake data:** `STATSZOR_FIXTURES=/path` makes `fetch()` read files named by the sha1 of each URL. Good for checking that the code runs, not for checking numbers.
- **Front end:** serve the repo with `python -m http.server` and drive it with Playwright (preinstalled). Check for console errors, look at screenshots, and check `document.documentElement.scrollWidth` at 390 px wide (no sideways page scroll on phones; wide tables go in `.scroll`).
- Trigger the nightly job: `gh api -X POST repos/Ciiiv/Stats-Zor/actions/workflows/update-data.yml/dispatches -f ref=main -F 'inputs[full]=false'`; read logs with `gh run view {id} --log`.
- Sanity-check against known numbers, e.g. MoneyPuck goalie shots on goal and goals match NHL `shotsAgainst` and `goalsAgainst` exactly.

## Git in this environment
- Shallow clones: `git -c fetch.negotiate=true fetch origin main --depth=5`, rebase onto `origin/main` before pushing (the nightly bot commits data), push with `git -c push.negotiate=true push`.
- Don't commit `__pycache__` (it's in `.gitignore`).

## Decisions already made (and why)
- **Value model** is Stats-Zor's own, simple and fully shown on the methods page: skater goals above replacement scaled down for shared on-ice credit; wins = goals ÷ 6; a win is priced from the skater (88%) or goalie (12%) share of the cap.
- **Goalies get half credit** for goals saved above replacement (a season is roughly half luck). That puts goalies at about 13–15% of all positive wins, close to their cap share. Dollar worth barely depends on this weight.
- **Goalie projections** keep `shots ÷ (shots + 3,000)` of a goalie's edge over the league-average goalie (three seasons of shots), and are valued at his own workload (games per season, up to 65). One hot season shouldn't price like a proven elite goalie; the owner wanted "only valued if they're great" to hold. Skaters keep their simpler 3-season projection.
- **NHL EDGE stats** (speed, shot speed) describe style, so they feed similarity and a "slowing" trend, not value.
- **Deployment fit** is judged three ways (5v5 results, overall value, against his role) because public data has no quality of competition.
- **Trade machine contracts:** the site never knows contracts. Years left after this season are blank until the user types them (blank = this season only, flagged). Cap hits are in $M; dollar amounts convert. Trades are not saved on refresh, on purpose (the owner prefers a clean slate).
- **Team control:** RFA seasons are estimated with the UFA rule (27 by June 30 or 7 accrued seasons; accrued ≈ 40+ NHL games, 25+ for goalies) and added through a checkbox that auto-sets but can be overridden. RFA seasons are assumed paid fair value, so they add wins but no surplus.
- **Prospects** are valued by draft slot (decaying 15% a year since the draft); from 40 NHL games their own projection blends in by games played (100 = all NHL record). CapFriendly is gone and PuckPedia can't be scraped, so none of this uses contract data.
- Defaults: skater page Seider vs. Makar; goalie page Vasilevskiy vs. Shesterkin. Both open on the last complete season until the current one passes 41 team games.

## Yearly upkeep
- Update `CAP` and `MIN` in `scripts/build_value.py` when the league announces new figures (published through 2027-28; 5% growth assumed after).
- Each September, check that the nightly workflow wasn't paused by GitHub's 60-day inactivity rule over the summer.
