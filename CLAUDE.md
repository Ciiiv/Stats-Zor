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
| Shared front end | `common.js` (formatters, SVG axes, search with cross-page routing), `theme.js` (auto/dark/light toggle), `styles.css`, site icon `favicon.svg` (+ `favicon-32.png`, `apple-touch-icon.png` rendered from it; re-render if the SVG changes) |
| Pipeline | `scripts/build_data.py` → `build_shots.py` → `build_usage.py` → `build_edge.py` → `build_goalies.py` → `build_impact.py` → `build_value.py` |
| Nightly job | `.github/workflows/update-data.yml` (12:17 UTC; each step after the first is continue-on-error; input `full` rebuilds everything; `.cache/impact` lives in the Actions cache) |
| Model settings | top of `scripts/build_value.py` (`CAP`, `MIN`, weights, `ISO_WEIGHT`, `GOALIE_WEIGHT`, `GOALIE_SHOTS_K`, age curves), top of `scripts/build_impact.py` (`LAMBDA`, `FIRST`) and top of `trade.js` (`pickWins`, discounts) |

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
- **Value card** shows worth for the selected season and over the last 3 seasons (wins per 82 blended 3/2/1 × games, priced at the selected season's win; goalies use wins a season), because one season can swing a lot (Makar 2025-26).
- **Isolated impact** (`build_impact.py`, skater page Part 1): a ridge regression over every 5v5 shift since 2010-11 (NHL shift charts + play-by-play for faceoff zones and score, MoneyPuck shot xG). Each stint is two rows (each team attacking), weighted by time, with each skater's offense and defense plus home, zone start and score-state terms. The penalty is applied to skaters only. Single-season and three-season fits. Shown next to relative, not instead of it. Rink scorekeeper bias is not adjusted for: discussed and skipped (MoneyPuck already arena-adjusts shot locations, so the leftover effect is small).
- **5v5 in the value model** blends isolated and relative (`ISO_WEIGHT`, chosen by the forecast test in `data/impact/test.json`, which scores against next season's on-ice and relative results so neither method is favoured). Isolated numbers are stretched per season and position to the spread of 0.5 × relative, so 5v5 keeps the same share of value and only who gets the credit changes. The test (15 season pairs, Nov 2026) put 0.67 best on the average of both targets (isolated alone wins on next on-ice, relative alone on next relative). The test reruns nightly; if `best_isolated_weight` moves for good, update `ISO_WEIGHT` and the about page. Seasons before 2010-11 use relative only. One official number everywhere; the Value card's "5v5 method" box is read-only.
- **NHL EDGE stats** (speed, shot speed) describe style, so they feed similarity and a "slowing" trend, not value.
- **Deployment fit** is judged three ways (5v5 results, overall value, against his role).
- **Competition and linemates** (`competition()` in `build_impact.py`, `comp` in `data/impact/{y}.json`, shown at the top of Role & fit): % of 5v5 time vs the opponent's top line (2+ of its 3 most-used forwards that game) and top pair, and time-weighted isolated net of opponents and teammates. Descriptive only; it doesn't change value (isolated impact already accounts for both). Older seasons are backfilled newest first, a few a night. Competition varies far less than linemates.
- **Trade machine contracts:** the site never knows contracts. Years left after this season are blank until the user types them (blank = this season only, flagged). Cap hits are in $M; dollar amounts convert. Trades are not saved on refresh, on purpose (the owner prefers a clean slate).
- **Team control:** RFA seasons are estimated with the UFA rule (27 by June 30 or 7 accrued seasons; accrued ≈ 40+ NHL games, 25+ for goalies) and added through a checkbox that auto-sets but can be overridden. RFA seasons are assumed paid fair value, so they add wins but no surplus.
- **Team plans** (trade machine): No preference (default, pure value) / Contending (next 2 seasons full, then −15% a season) / Bubble team (−7.5% a season) / Rebuilding (×0.5 this season, ×0.8 next) per side, weighting wins by season (`MODES` in `trade.js`). A plan describes what a team cares about, not its standings. No-preference verdicts stay the headline; plans add a per-team row. Pick wins are spread over 3 seasons from 2 years after the draft. Dollar figures on assets are totals over the seasons counted; real salary and assumed RFA pay are shown separately. The trade page header holds the team and plan pickers plus a live score card (one tap-to-expand line on phones); the intro is one line linking to `about.html#m-trade`.
- **Small-sample skater projections** (`SKATER_GAMES_FULL` = 150 in `build_value.py`): under 150 games in the 3-season window, keep games ÷ 150 of the gap to an average regular at the position. The owner chose this over full shrinkage (K=60, best in the 2011-26 backtest) because full shrinkage also marks established stars down about 15%. Known gap, discussed and parked: the model prices every win the same, so top stars' fair value (~12–15% of cap) sits below the 2026 market (Makar $20.4M, Carlsson $18M, Kaprizov $17M). Decided: no star-premium "market price" (it would be set by hand without contract data; the owner prefers every number to come from data). The gap is explained in the contract limits note and visible through the cap-hit box. 
- **Skater age curve is fitted from data** (`fit_age_curve` in `build_value.py`, nightly): next-season ÷ this-season wins per 82 by age band and position, players chosen by being 1+ win regulars the season before (avoids regression bias), leavers count as replacement, bands need 100+ players, never rises after falling. Backtest beat the old hand-set curve (Nov 2026). No special rule for elite players: the data showed stars don't age better in percentage terms. Goalies keep hand-set `AGE_MULT_G`.
- **"Doing more than the box score" sidebar** (`renderGems` in `common.js`; lists built by `renderGemsSkaters` in `app.js` and `renderGemsGoalies` in `goalies.js`, all in the browser from data already loaded). Pages wrap `<aside id="gems">` and `<main>` in `.layout`: a sticky right column at 1400px and wider, a tap-to-open line above the content otherwise. Skaters: 1,500+ five-on-five minutes over three seasons (`GEM_MIN_TOI3`; owner's no-small-samples rule), three-season isolated net in the top 20% at the position, points per game not top 10%, plus low points (bottom half) / weak linemates (bottom third) / tough minutes (top fifth opponents' quality); sorted by isolated percentile minus points percentile. Goalies: save % above expected top 20% plus losing record / tough shots / busy nights. Top 10, show more, F/D filter, click opens the player on the same season. The owner's original idea for the site: elite work in bad situations that doesn't get full credit. The sidebar is meant to hold more side lists later (scouting-type lists); `renderGems` takes any title, sub, items and chips, so a new list only needs a builder function. Ideas the owner liked, for another day: breakout watch (young players with rising isolated impact), due for a bounce (finishing well below expected goals), overpaid risk (big minutes, weak isolated impact). Requirement: no small samples (use three-season numbers or minimum minutes, like the existing list).
- **Shot maps** draw smoothed by default (`smoothHeat` in `common.js`: Gaussian over the 5 ft cells, σ 7 ft, sampled every 1.25 ft into a canvas image in the SVG), with a Cells toggle. A `themechange` event (from `common.js`) redraws them.
- **Prospects** are valued by draft slot (decaying 15% a year since the draft); from 40 NHL games their own projection blends in by games played (100 = all NHL record). CapFriendly is gone and PuckPedia can't be scraped, so none of this uses contract data.
- Defaults: skater page Seider vs. Makar; goalie page Vasilevskiy vs. Shesterkin. Both open on the last complete season until the current one passes 41 team games.

## Next ideas (not built; owner wants these explored another day)
Every new list or model change must avoid small samples (three-season numbers or minimum minutes). Keep these out of the README and How it works until they're built.

**Model** (ideas like Evolving-Hockey's, built only from our own data; EH's data is paid and must not be copied), in order:
1. Start each season's isolated impact from the player's previous seasons instead of zero (shrink toward his history). Steadier single-season numbers, especially early in a season. Test with the existing forecast test before switching. Do this first.
2. Isolated impact on the power play and penalty kill, from the same shift charts and shots, to replace the on-ice special-teams numbers in the value model.
3. Isolated impact on goals and shot attempts as extra comparison columns (display only).
4. Lowest priority: use individual stats (shots, assists, takeaways) to steady small samples; overlaps with the existing small-sample pull.

**Sidebar lists** (tabs in the "Doing more than the box score" sidebar; `renderGems` already takes any list). Draft rules from a Nov 2026 first pass:
- Breakout watch: age 24 or under, isolated impact up sharply from last season (top quarter this season, up 0.15+ xG/60, 800+ minutes this season and 500+ last). 2025-26 examples: Seider, Cozens, Zegras, Hutson.
- Due for a bounce: proven finishers (goals above expected over the two previous seasons) scoring well below expected this season. Examples: Drouin, Saad, Kadri, J.T. Miller.
- Big minutes, low impact: top-quarter ice time with bottom-fifth three-season isolated impact. Not "overpaid": the site has no contract data. Examples: Stephenson, Bedard, Boeser, Matheson.

**Look:** team-color stripe, team abbreviation badge and jersey number on the player cards (mocked up Nov 2026). Decided: no team logos or player photos (trademarks and copyrighted photos).

## Yearly upkeep
- Update `CAP` and `MIN` in `scripts/build_value.py` when the league announces new figures (published through 2027-28; 5% growth assumed after).
- Each September, check that the nightly workflow wasn't paused by GitHub's 60-day inactivity rule over the summer.
