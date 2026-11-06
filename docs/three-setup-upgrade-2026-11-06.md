# Three-setup paper strategy preview — 6 November 2026

## Release status

Originally implemented on the draft review branch with activation withheld. The user subsequently explicitly authorized **“deploy everything”**, including activation. `RELEASE_SIM_CONFIG` now selects the three-setup paper engine for the default endpoint on release. Historical account records, quantities, entry/exit prices and P&L are unchanged. No scheduler or broker-order code was added. GitHub/Vercel release status must be verified separately; this source document alone is not deployment proof.

The configuration is `MULTI_SETUP_CONFIG` in `research/paper-policy.js`, selected by the explicit `RELEASE_SIM_CONFIG` alias in the default handler export. The same `transitionSimulation` and injected handler support it; tests and read-only research runners exercise it. `SIM_CONFIG` remains an unchanged historical research comparator and factory default for reproducible injected tests. Request-body overrides cannot select another strategy. No new environment secret or production flag is needed.

## What was implemented

### 1. Three distinct entry types

`research/trading-setups.js` independently implements deterministic detectors from completed five-minute candles. This is not copied third-party source, a statistical probability model or a full multi-week Minervini VCP implementation.

All three require eight contiguous completed five-minute bars, a current execution observation after the signal, a strong positive closing candle, price above the trigger/VWAP/prior daily EMA20, and at least 1.5× setup-baseline volume. Eight bars means the earliest new-mode signal can be 09:55 IST; there is no separate 10:00 timer. Earlier watches remain watches until their evidence exists.

| Entry type | Additional structure |
| --- | --- |
| Compression breakout | Pre-breakout range ≤1.5%; recent three-bar average range ≤80% of earlier three-bar range; volume dries to ≤90%; lows do not deteriorate; completed expansion closes above consolidation |
| Trend pullback / recovery | Rising prior impulse, two-bar actual retracement ≤1.5%, reduced pullback volume, support near short EMA/VWAP, then a completed strong recovery above the prior pullback bar's high |
| Verified catalyst continuation | Fresh positive verified company event, published no later than the signal bar's start, plus a bounded consolidation and completed volume-confirmed breakout; advisor-only or stale/future/negative news cannot qualify this lane |

The original common recent-stock/index momentum, prior-session extension and executable-price extension checks apply to every lane. Surveillance/event availability, fresh bid/ask, circuit distance, liquidity, modeled risk and same-session de-duplication remain binding. A signal can be confirmed but still fail the final buy checks.

When multiple lanes pass, the fixed priority is catalyst continuation → compression → pullback. It is an explicit experimental tie-break, not a confidence claim. All lane results are retained, so overlap and selection effects can be investigated.

No indicator-voting percentage or AI consensus is treated as probability of profit. News/research advises candidate selection; deterministic price/data/risk conditions decide entry.

### 2. Actionable suggestions

Every evaluated candidate gets a `setupReview` with per-lane label, status, trigger, structural invalidation, executable extension, passed/missing checks, research cohort and timestamp. Blocked candidates retain their measured levels; a weak market does not erase otherwise available evidence.

The desk shows these plans inside expandable research details. Labels distinguish recovery volume from breakout volume and prospective triggers from actual fills. A separate frozen-exit explanation describes R as original entry-to-stop risk. The UI/UX skill informed progressive disclosure, semantic theme colors, keyboard-accessible details and mobile wrapping—not a redesign of the homepage.

`/desk/setup-lab.html` is a **fictional, local-computation-only demonstration**, not a live opportunity feed. It includes compression, pullback, catalyst and deteriorating-market examples. SAMPLE is not a real recommendation. Example records are synthetic, excluded from account statistics, never saved and never submitted to an endpoint.

### 3. Bounded broader research

In opt-in mode the handler keeps the eight-candidate history budget. It reserves eligible pending/news names, rotates two eligible discovery names, and fills remaining slots from the existing ranked universe. Final candidates retain discovery-score order. Rotation never reintroduces names rejected for liquidity, identity, stale quotes, circuit conditions, holdings or same-day trades.

This broadens which already-eligible stocks receive pattern research; it does not retrospectively rediscover the full historical universe or guarantee every setup is examined. No extra provider, LLM call or history-request budget was introduced. Daily references remain cached.

### 4. Setup-specific exit experiments

`research/setup-exits.js` provides three modes: original risk-unit trail, setup-specific risk trail, and setup-specific volatility-buffered trail.

| Profile | Trail activates | Trail distance |
| --- | --- | --- |
| Original comparison | 1.5R | 1R |
| Compression | 1.5R | 1R |
| Pullback | 2R | 1.5R |
| Catalyst continuation | 2R | 1.5R |

The volatility variant increases the profile's trail distance using half the entry-day daily ATR, bounded at 2R. It requires a valid ATR14 measurement before entry; otherwise it cannot fund a position. This is a proposed buffer, not a fitted or proven optimum.

The chosen `exitPolicy` is frozen on the position at entry and copied into the closed trade. Later settings/ATR changes cannot widen an existing position's initial stop or already-armed trailing price. Positions without a saved new policy continue through the original protection. Corrupt policy metadata falls back to original conservative protection and produces an actionable warning, rather than disabling a stop.

No fixed +5%/+10% profit targets were introduced. Existing negative-event, no-progress and maximum-session exits remain unchanged. The ₹100 per-position and ₹500 total modeled-risk limits, one-share sizing, sampled bid/slippage execution, same-day de-duplication and exit-first processing remain intact. Sampled paper stops are not guaranteed stop-price fills; gaps/circuits can exceed modeled loss limits.

### 5. Shared historical and forward comparison

Both the live-paper transition and approximate candle replay call the same setup detectors, evidence validator and saved exit-policy logic. Exact recorded-input replay reuses the entire paper transition.

Eight preregistered scenarios compare the original breakout, existing confirmed breakout, combined setups with original/risk/volatility exits, and each setup individually. Reports separate setup type from research-backed/price-only cohort and include after-cost returns and failure reasons. Exact studies distinguish closed returns from open marks. Approximate studies explicitly model liquidation costs on remaining session marks.

## Initial historical diagnostic

Saved report: `research/setup-comparison-2026-11-06.json`, generated `2026-11-06T10:51:57.415Z`.

Inputs: 75 archived scans per session on 4, 5 and 6 November; respectively 51, 60 and 71 original shortlist tickers with available dated Yahoo minute history. Source session commits: `264c1520cc8cd3f0148c05030b1f4301a5cb478a`, `afd12b77b1194958d119b5ae97fe87b9fb94d3a6`, `1e077d784fbb02ec0f9c644365b9ae4e9bdd3630`. These include later 6 November scans than the earlier entry-quality study, so its totals differ.

Every variant uses one share per name, independent empty daily portfolios, 30bp assumed spread, 5bp slippage and 15bp fees per side. Historical executable depth/circuit eligibility is not proven. Open positions are valued using hypothetical liquidation, not inserted as closed account trades.

| Scenario | Entries | Modeled net ₹ | Return / deployed | Equal-stock average return |
| --- | ---: | ---: | ---: | ---: |
| Original breakout | 50 | −133.08 | −0.3436% | −0.5430% |
| Confirmed breakout | 15 | −57.64 | −0.4356% | −0.5600% |
| Combined + original exits | 5 | +22.49 | +0.2316% | −0.3479% |
| Combined + setup-risk exits | 5 | +22.49 | +0.2316% | −0.3479% |
| Combined + volatility exits | 5 | +22.49 | +0.2316% | −0.3479% |
| Compression only | 3 | +43.45 | +0.8198% | −0.2830% |
| Pullback only | 3 | +47.00 | +0.8252% | +0.0098% |
| Catalyst only | 1 | −16.68 | −0.5054% | −0.5054% |

**Do not read this as validated profit improvement.** Four of the five combined entries were negative; one higher-priced winner carries the capital-weighted gain. Equal-stock average remains negative. Three sessions and one catalyst observation cannot establish a reliable edge. Identical results across the three combined exit modes do not prove exit equivalence: this short study did not produce enough differentiating exit paths.

The old opportunity list and its 15-minute pending-breakout carry logic are used; new shortlist rotation is not historically simulated. Revised/cross-provider candles, assumed spreads, modeled carry quotes and missing inherited overnight positions are further limitations. No thresholds were tuned to these reported results.

The exact recorded-input study returned `no_recorded_evidence` for these dates. That is missing evidence, not evidence that zero trades were optimal. Forward collection/longer chronological holdout is required before release; no automatic best-scenario promotion exists.

## Reproduce and review

- `npm test` and `npm run check`
- `node scripts/compare-trading-setups.js 2026-11-04 2026-11-05 2026-11-06` — exact inputs only; honest no-evidence result when absent.
- `node scripts/compare-trading-setups.js --estimated --summary 2026-11-04 2026-11-05 2026-11-06` — network access for dated public research candles, no writes.
- Open the Setup Lab on the existing HTTP preview; do not substitute its fictional examples for live results.

Tests cover all lanes, invalid/future data, stale/negative news, market deterioration, bounded rotation, endpoint integration, cached history, missing ATR, frozen stops, duplicate ticks, synthetic isolation and actionable details. Phone-sized layout was checked at 375px without horizontal overflow; original desk styling and safe-area treatment are retained.

## Files / new structures

New strategy/reporting modules: `research/trading-setups.js`, `research/setup-exits.js`, `research/setup-study.js`, `scripts/compare-trading-setups.js` and the saved research JSON. New preview: `desk/setup-lab.html`, `desk/setup-lab.js`. New regression tests: `test/trading-setups.test.js`.

Integration updates: `api/_paper-simulation.js`, `api/_paper-simulation-handler.js`, `research/paper-policy.js`, `research/entry-quality.js`, `research/decision-evidence.js`, `research/session-replay.js`, `research/entry-comparison.js`, `research/point-in-time-entry-replay.js`, `desk/desk.js`, `desk/decision-details.js`, `desk/desk.css`, `desk/index.html`.

New records: candidate/position `setupReview`, position/trade `setupType` and frozen `exitPolicy`, scan-history `setupStates`/`selectedSetup`, scenario results grouped by setup and research cohort. No SQL/database migration or account-history rewrite.

## Assumptions and next work

- Five-minute cadence, long-only NSE cash equities, existing mid/small-cap coverage and one-share policy remain unchanged.
- Optional semantic research stays advisory; this batch does not add autonomous multi-LLM debates or an uncalibrated probability score.
- Strengthening price action is not proof of institutional buying. No delivery/shareholding evidence was invented.
- Collect sufficient forward observations across rising, falling and choppy sessions; measure rejection opportunity costs and setup overlap. Validate exit buffers over multi-day portfolios, not just same-day marks.
- Activation was explicitly authorized after the diagnostic caveats were reported. To roll back new entries, select `SIM_CONFIG` (confirmed breakout) or `BASELINE_SIM_CONFIG` (original breakout) in `RELEASE_SIM_CONFIG` and redeploy. Existing saved exit policies continue unchanged; no historical ledger migration is necessary.

Research context: [targeted public-project review](open-source-review-2026-11-06.md), [Freqtrade exit callbacks](https://www.freqtrade.io/en/stable/strategy-callbacks/), and [Upstox intraday candle semantics](https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/). Framework capabilities are not evidence of profitability in NSE stocks.
