# Stats-Zor: Checks and Comparables

What we test the site against, what each check looks for, and what it found. Newest first within each part. For the formulas themselves, see the site's [How it works](https://ciiiv.github.io/Stats-Zor/about.html) page; for the build, [BUILD.md](BUILD.md).

Rule of thumb: a check reports. It never changes a number by itself. If a check turns up a weakness, the options go to the owner first.

## Ongoing checks (run automatically)

### Missing shift-chart games (nightly, since Nov 19, 2026)

**Looking for:** games whose NHL shift charts can't be read. Isolated impact needs them (who was on the ice for every shot), so those games are left out of it. The worry is a team missing many games, which would leave its players' isolated numbers resting on fewer games.

**How:** the nightly isolated-impact step records every game it couldn't read in `data/impact/missing.json`: date, teams, reason and a count by team. The Monday health check reads that file.

**Found (Nov 19, 2026):** 50 of 346 games this season. All of them are from one week, Oct 22–29, and the NHL's shift charts for them are empty ("0 shifts"), so they're unlikely ever to arrive. They're spread evenly: every team is missing 2 to 4 games. No team is singled out. The gap is about 14% of games now and will be under 4% by season's end. Points, ice time, on-ice expected goals, Leaders, box score and streaks all use complete data and are unaffected.

### Isolated vs. relative blend test (nightly)

**Looking for:** whether the 5v5 blend weight (two thirds isolated, one third relative) is still the best at predicting next season. `data/impact/test.json`, reported by the Monday health check. If the best weight moves for good, the owner decides whether to change it.

## Checks and comparables

### Value model vs. real standings (Nov 19, 2026)

**Looking for:** does the value model describe real team results? Two questions:

1. **Same season:** add up each team's wins above replacement (each player split by his games with that team, as on the teams page) and compare with its standings points.
2. **Next season, the fairer test:** take this season's roster, value each player on *last* season's numbers, and see how well that predicts this season's points. Compare it with two simple yardsticks: last season's goal differential and last season's points.

**How:** `scripts/check_value_vs_standings.py` (standings from `scripts/fetch_standings.py`, saved in `data/checks/standings.json`). 554 team-seasons since 2008-09, all scaled to 82 games (the 48-game 2012-13 season and the shortened 2019-20 and 2020-21 seasons included).

**Results over time** (one row per yearly rerun; the September upkeep check adds a row after each season's final standings):

| Run | Seasons | Same season r (model / goal diff.) | Next season r: model / last GD / last points | Typical next-season miss: model / last GD | Points per projected skater win / goalie win | Team spread, model vs. real |
| --- | --- | --- | --- | --- | --- | --- |
| Nov 19, 2026 | 2008-09 to 2025-26 | 0.82 / 0.96 | 0.60 / 0.55 / 0.52 | 9.9 / 10.3 points | 2.1 / 0.7 | 9.9 vs. 15.2 points |

**How much miss is unavoidable:** even a perfect model would miss. If a team's true quality were known exactly, the bounces of 82 games alone would still move its point total by about 8.5 points (one standard deviation), or about 7 points on average. So the model's typical next-season miss of 9.9 points is already close to that floor. The rest comes from things no one knows in advance: injuries, trades during the season, young players growing.

**Found, same season:**

| Measure | Correlation with points | Typical miss |
| --- | --- | --- |
| Team wins above replacement (the model) | 0.82 | 7.0 points |
| Goal differential | 0.96 | 3.4 points |

Goal differential is almost the same thing as the standings, since it includes every lucky bounce, hot goalie and shooting streak. The model deliberately leaves much of that luck out (half credit for goalies, finishing credited only as far as it repeats). So matching goal differential within the same season was never the goal. A 0.82 correlation is a strong result for a model built from player parts.

Each model win was worth about 2.5 standings points. That's a little more than the 2 points of a real win, so team totals are somewhat compressed. The spread of team totals is about two thirds of the real spread (9.9 vs. 15.2 points). That's partly by design: luck is removed and small samples are pulled toward average.

**Found, next season (the main test):**

| Predictor | Correlation with next season's points | Typical miss |
| --- | --- | --- |
| This roster valued on last season's numbers (the model) | 0.60 | 9.9 points |
| Last season's goal differential | 0.55 | 10.3 points |
| Last season's points | 0.52 | 10.4 points |
| Model + goal differential together | 0.62 | 9.7 points |

The model beats both yardsticks, and by more in recent seasons (2017–2025: 0.65 vs. 0.57 for goal differential). It knows about roster changes (trades, signings, players leaving), and goal differential doesn't. Adding goal differential on top helps only a little, so the model already captures most of what goal differential knows.

**Skaters vs. goalies, next season:** one projected skater win was worth 2.1 points the next season, almost exactly the 2 points of a real win, so skater value is well calibrated. One goalie win from last season was worth only about 0.7 points the next season. That's not a flaw in the projections: this test used last season's goalie wins raw, and the site's own goalie projections already keep only `shots ÷ (shots + 3,000)` of a goalie's edge. The test backs that choice: a goalie's season carries over far less than a skater's. Within the same season, a credited goalie win moved points about 1.4 times as much as a skater win. That suggests the half credit for what actually happened is, if anything, a bit stingy. The case for half credit is that it describes the season without overpaying luck, so this is something to discuss, not change.

**Biggest same-season misses** (points per 82, against what the model's wins predict):

| Season | Team | Points | Model wins | Miss | Likely reason |
| --- | --- | --- | --- | --- | --- |
| 2012-13 | CHI | 132 | 25.2 | +27 | 48-game lockout season (24-game point streak to open), scaled to 82 |
| 2014-15 | ANA | 109 | 17.2 | +25 | Goal differential only +10 per 82: won close games the underlying play didn't support |
| 2022-23 | FLA | 92 | 29.9 | −24 | Strong underlying numbers, weak regular-season results (they reached the Cup Final that spring) |
| 2014-15 | MTL | 110 | 18.7 | +22 | Elite goaltending season (Price) beyond what half credit gives |
| 2022-23 | SJS | 60 | 16.4 | −22 | Bad team rated as merely below average (the compressed spread) |
| 2023-24 | FLA | 110 | 36.2 | −22 | Rated the league's best by a wide margin; won the Cup |
| 2020-21 | BUF | 54 | 14.0 | −22 | Same as San Jose: the bottom gets pulled toward average |

The misses are mostly at the extremes: very lucky or unlucky teams, and teams far from average in either direction. That's the expected cost of leaving out luck and pulling small samples in.

**What this means:** the model does what it's built for. It predicts the future better than the simple yardsticks, and skater value is well calibrated. The known trade-off is that team totals are narrower than reality. **Nothing was changed.** Possible follow-ups for the owner: (a) look again at goalie half credit for describing a season; (b) check whether the compressed spread comes mostly from the small-sample pull or from the 5v5 scaling.

**Rerun:** the September upkeep check does this every year and adds a row to "Results over time". By hand: run `scripts/fetch_standings.py` on a temporary branch, as in the README's testing notes (the NHL isn't reachable from the cloud workspace). Then run `python scripts/check_value_vs_standings.py` locally.

### Goalie credit, replacement level and skater scaling (Nov 24-25, 2026)

**Looking for:** whether season value should count more of what actually happened (a goalie's goals saved, a shooter's actual finishing), and whether goalies run high on combined leaderboards because of how replacement level or skater credit is set.

**Season value vs. same-season standings** (554 team-seasons, `check_value_vs_standings.py` with the season pieces swapped; projections untouched):

| Season value version | Correlation with points | Typical miss | Goalie share of all positive wins | Goalies in a season's top 25 (average) |
| --- | --- | --- | --- | --- |
| Today (goalie 0.5, cautious finishing) | 0.82 | 7.0 | about 13-15% | — |
| Goalie 0.5 + actual finishing | 0.869 | 5.9 | 12.6% | 4.7 |
| Goalie 0.6 + actual finishing | 0.874 | 5.8 | 14.7% | 6.9 |
| Goalie 0.7 + actual finishing | 0.877 | 5.7 | 16.7% | 9.9 |
| Goalie full + actual finishing | 0.875 | 5.8 | 22.3% | 17-19 |

Actual finishing is the big gain. Goalie credit barely moves the fit; it decides how goalies rank against skaters. A credited goalie win and a skater win are worth the same in the standings at about 0.8 credit; full credit overpays goalies on our data. Season values predict next season worse than today's (0.55-0.58 vs. 0.60), so projections stay as they are. Six goals per win is confirmed (the "what happened" version gives 2.0 standings points per win).

**Replacement level:** players below the regular cutoff (call-ups and fill-ins, the freely available pool) should land near zero if the bar is right. Skaters below the cutoff average +0.13 goals per 5v5 hour (regulars +0.33); goalies below the cutoff +0.06 per hour (regulars +0.20). Both bars sit a little below the truly free pool, skaters slightly more so, so the goalie bar is not what makes goalies run high.

**Skater scaling:** each team's summed skater 5v5 credit spreads almost exactly like its real 5v5 expected-goal differential (spread 19.8 vs. 20.1 goals; r 0.77). The shared-credit scaling is about right. Goalie credit tracks team goals saved above expected at 1.84 per credited goal (2.0 by design at half credit).

**Finishing weight check (Nov 25, 2026):** with the season version, team wins split into finishing, other skater play and goaltending were each worth, in standings points per win: finishing 1.92, other skater play 2.24, goalies at 0.6 credit 2.79 (a real win is about 2). Finishing is not overcounted. Compared with Evolving-Hockey's 2025-26 awards post, the season version agrees better (Caufield 17th → 3rd, their Hart tier 2; Werenski 20th → 12th); it moves away on Quinn Hughes (5th → 26th after a cold shooting year) and still differs on MacKinnon's defense and on Demidov.

**Decision (Nov 25, 2026):** the owner chose goalie credit 0.6 plus actual finishing for season value only; projections, fair contracts and the trade machine keep the cautious basis (checked: all 1,011 projections identical before and after). Value cards relabeled "Value of his season" with a "Fair value for next season" tile; teams page lists most valuable skater and top goalie separately and draws goalies as diamonds.

**What this means:** neither replacement level nor skater scaling is off. Goalies run high on combined lists because one goalie season really does swing many goals, and a lot of that swing is luck; the credit level is a judgment between balance in the standings (0.7-0.8) and keeping goalies near their cap share (0.5-0.6). Nothing was changed; the owner picks.

### Big nights line vs. NHL game logs (Nov 19, 2026)

**Looking for:** whether hat tricks, multi-point games and point streaks counted from MoneyPuck's game-by-game data match the NHL. **Found:** games played, hat tricks, multi-point games and longest point streak matched exactly for all 30 player-seasons checked (McDavid, Matthews, MacKinnon, Makar and others, three seasons).

### Earlier model tests (Nov 2026)

Each of these was adopted only after beating what it replaced at predicting next season. Details are in CLAUDE.md and on the How it works page.

- **Isolated impact v2 starting points:** about 10% better at predicting next season than starting from zero (0.342 vs. 0.312).
- **Power-play blend:** half isolated predicted slightly better (0.394 vs. 0.389). Isolated penalty kill predicted worse, so it isn't used.
- **Finishing rule:** beat the old half-of-goals-above-expected by 11% (forwards) and 14% (defensemen).
- **Fitted age curve:** beat the old hand-set curve in a 2011–26 backtest.
- **Puck play and discipline lists:** repeat rates checked before building (hits and blocks about 0.9, takeaways and giveaways about 0.6, minors drawn 0.64, fights 0.74).
- **Goalie data:** MoneyPuck shots on goal and goals against match the NHL's exactly.

## Comparables (not done yet)

Comparing with other public models (Evolving-Hockey, JFresh/TopDown, Patrick Bacon's public WAR): rank agreement on the top players and the biggest disagreements. Evolving-Hockey is paid, so only whatever it publishes freely would be used, kept private, and never copied into the site.
