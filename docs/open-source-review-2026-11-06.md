# Decision evidence and implementation review — 6 November 2026

## Scope and result

This is a targeted review of README sections and selected source files across 13 public projects, not a full security audit or independent validation of their trading results. No third-party code was executed or imported; no new dependencies were added. Source versions below are pinned so findings can be checked later. License metadata is recorded for context, not as permission to copy code.

The existing architecture stays intact: Upstox supplies execution observations and candle history; deterministic JavaScript makes paper decisions; Git-backed JSON persists state; Vercel serves the desk; the existing scheduler drives scans. No broker orders, schedule changes, historical trade edits, or production deployment are part of this update.

## Why details were misleading

The current paper strategy does not use the old composite scoring model. Its details view nevertheless reused that model's template and populated its unused scores with null values. The display adapter also discarded the saved initial stop. Thus some “Not available” fields were display/schema defects, not proof the underlying buy lacked all evidence.

There was also a genuine auditability gap: earlier entries did not retain a complete, typed record of every decision input and its source/time. Current market measurements cannot legitimately fill that historical gap.

### Changes implemented

1. Paper details now use a strategy-specific view. Required, missing, invalid, optional and unused fields are distinguished. Original decision measurements are separated from current observations. Mobile details wrap without horizontal overflow and use expandable sections instead of blank legacy-score tiles.
2. A shared `decisionEvidence` schema records value, unit, source, observation timestamp, required status and a missing/invalid explanation. Both production-path simulation code and the approximate historical replay apply its readiness check. Completeness does not itself authorize a trade: the original freshness, safety, circuit, setup and risk gates still apply.
3. New entries require executable bid/ask and spread, quote age, prior daily EMA20 and traded-value baseline, breakout/VWAP/structural-stop/volume measurements, stock and index day returns, and loaded safety context. The revised momentum mode also requires recent stock/index returns, relative strength and prior-session movement. Missing mandatory evidence blocks the new buy.
4. Existing history requests now supply optional RSI14, ATR14%, average daily volume and EMA50 when warmed up. No extra vendor is required. Optional metrics are context, not extra mandatory indicators or promised alpha. EMA50 remains explicitly unavailable when fewer than 50 completed daily closes exist.
5. Strict candle validation rejects invalid OHLC geometry, invalid numeric inputs and conflicting duplicate timestamps. Identical duplicates are deduplicated; forming/future bars are excluded before calculating a historical decision. No zero filling or silent price repair is used.
6. Candidate history requests preserve a successful daily or intraday response when the other fails, and expose sanitized failure reasons. A failed required input still prevents entry. Remaining candidates retain their diagnostics after the first buy; this does not permit a second purchase in the same scan.
7. A separate, read-only historical audit recovered eight original metrics for each of 23 entries from its original buy commit. `data/decision-audit.json` links those records to pinned commits. It does not alter the ledger or invent historical spreads, order-book depth or confidence scores.

### Sources and limitations of measurements

| Measurement | Source and interpretation |
| --- | --- |
| Executable paper entry | Observed Upstox ask plus configured slippage, not that morning's open |
| Bid, ask, spread, quote age | Observed execution quote; existing freshness checks remain mandatory |
| EMA and daily context | Validated completed daily candles strictly before the decision date; cached per session/schema |
| Signal VWAP | Typical-price × volume candle approximation, explicitly labeled; not claimed to be exchange VWAP |
| Exchange average price | Upstox `average_price`, recorded separately when supplied |
| Breakout volume ratio | Completed breakout-bar volume relative to the preceding range's average bar volume |
| Session volume ratio | Volume so far divided by average FULL-day volume; explicitly not time-normalized intraday RVOL |
| Legacy recovered measurements | Original entry commit only; partial evidence, not a reconstructed order book |
| Historical replay execution | Estimated bid/ask and modeled costs, labeled hypothetical rather than actual Upstox fills |

Official provider references: [full market quote fields](https://upstox.com/developer/api-documentation/get-full-market-quote/) and [historical candles](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/). Provider availability does not guarantee correct or fresh data; the runtime validators remain necessary. No secrets are included in evidence or client payloads.

## Public-source findings

### 1. PKScreener

Version `ab4212355e2442e7c8f5430d53fa3f56ea5af3b8` — GitHub license metadata: MIT.

Reviewed README sections and [ScreeningStatistics.py](https://github.com/pkjmesra/PKScreener/blob/ab4212355e2442e7c8f5430d53fa3f56ea5af3b8/pkscreener/classes/ScreeningStatistics.py), including preprocessing, volume validation and consolidation checks. It keeps an explicit volume baseline/ratio. We likewise retain the actual breakout ratio and its meaning. We deliberately did **not** adopt the inspected zero-filling/replacement of invalid values: absent data must not look like a valid neutral observation.

### 2. Freqtrade

Version `0789f5d5c3e7649e2b83f82d65ecb2e1381f02ad` — GPL-3.0 metadata.

Reviewed README sections and [lookahead.py](https://github.com/freqtrade/freqtrade/blob/0789f5d5c3e7649e2b83f82d65ecb2e1381f02ad/freqtrade/optimize/analysis/lookahead.py). Its full-versus-cut dataframe comparisons are a useful test pattern. Our future-bar invariance tests check that data appearing later cannot change an earlier decision. The crypto exchange architecture and source code were not imported.

### 3. backtesting.py

Version `ca2e2611621e472542ba90f7243a1fa06a7d7108` — AGPL-3.0 metadata.

Reviewed README sections and [backtesting.py](https://github.com/kernc/backtesting.py/blob/ca2e2611621e472542ba90f7243a1fa06a7d7108/backtesting/backtesting.py), especially indicator warm-up and commission-aware P&L. Adopted the engineering principle of explicit warm-up readiness; retained both-side modeled costs. No library integration or historical profitability inference.

### 4. QuantConnect LEAN

Version `06eb5cb315c7265e00fd2c3c0eda1caef697e637` — Apache-2.0 metadata.

Reviewed readme sections and [QCAlgorithm.History.cs](https://github.com/QuantConnect/Lean/blob/06eb5cb315c7265e00fd2c3c0eda1caef697e637/Algorithm/QCAlgorithm.History.cs), including `IsWarmingUp` and period/resolution-specific warm-up. Applied the readiness-before-trading principle without replacing the architecture or adopting the framework.

### 5. Backtrader

Version `b853d7c90b6721476eb5a5ea3135224e33db1f14` — GPL-3.0 metadata.

Reviewed README sections and [strategy.py](https://github.com/mementum/backtrader/blob/b853d7c90b6721476eb5a5ea3135224e33db1f14/backtrader/strategy.py), including market-order timing and commission reporting. Signal time and executable fill time must remain distinct. Our existing ask/bid-based paper execution and replay caveats are retained; no source imported.

### 6. OpenTerminalUI

Version `c24a8ca9d442c5d861a61cd6ebab28bd5e07e343` — MIT metadata.

Reviewed README sections, [schemas.py](https://github.com/Hitheshkaranth/OpenTerminalUI/blob/c24a8ca9d442c5d861a61cd6ebab28bd5e07e343/backend/data_quality/schemas.py) and [service.py](https://github.com/Hitheshkaranth/OpenTerminalUI/blob/c24a8ca9d442c5d861a61cd6ebab28bd5e07e343/backend/data_quality/service.py). Source provenance and clear anomaly categories are useful concepts. However, the inspected service derives demo anomalies from a dataset-ID hash rather than inspecting actual candles. That checker was explicitly rejected; our validator examines real row values and timestamps. This is a finding about that module/version, not a judgment on every component of the project.

### 7. Stock-Trading-Agent

Version `8ece143078c0852788f24904b80596a2a427a663` — README claims MIT; GitHub did not return a license object, so licensing was not verified.

Reviewed README sections and [analyze.py](https://github.com/lshariprasad/Stock-Trading-Agent/blob/8ece143078c0852788f24904b80596a2a427a663/analyze.py), including its daily NSE-symbol data fetch and EMA/RSI/ATR-style calculations. Structured explanations are useful; adding many overlapping indicators or making an LLM the decision authority is not justified by this inspection. Bundled archives were not opened or executed.

### 8. TradingAgents

Version `9fa1196fffbcfd9de5146d2dd2869df84ab99838` — Apache-2.0 metadata.

Reviewed README sections and [Yahoo OHLCV vendor](https://github.com/TauricResearch/TradingAgents/blob/9fa1196fffbcfd9de5146d2dd2869df84ab99838/tradingagents/dataflows/vendors/yahoo/ohlcv.py), including stale-history guards and cache refresh. Retained dated inputs/cache invalidation as principles. Its daily-data stale window and cache TTL are **not** appropriate substitutes for our intraday execution freshness checks. LLMs remain advisers, not trade executors.

### 9. FinRobot

Version `63e1884a42ea7b729551a5424b4bd6a65af636e0` — Apache-2.0 metadata.

Reviewed README sections and [price cross-validation tests](https://github.com/AI4Finance-Foundation/FinRobot/blob/63e1884a42ea7b729551a5424b4bd6a65af636e0/finrobot_desktop/tests/unit/test_price_cross_validate.py). Explicit discrepancy reporting and abstention when secondary data is missing are useful. A cross-provider execution-price checker is **deferred**, not implemented here; a generic percentage discrepancy band should not be copied into NSE execution rules without evidence.

### 10. FinRL

Version `7e98df461cbc7772f16a545a2f13b521e5d0b8f4` — MIT metadata.

Reviewed README sections and [stock-trading environment](https://github.com/AI4Finance-Foundation/FinRL/blob/7e98df461cbc7772f16a545a2f13b521e5d0b8f4/finrl/meta/env_stock_trading/env_stocktrading.py), including separate buy/sell costs and portfolio accounting. Retained explicit per-side costs and ledger reconciliation. No reinforcement-learning system was adopted and no demonstrated profit advantage is inferred.

### 11. OpenBB

Version `2a392e890f6eb1f0f4e3a71742720af8f056333a` — GitHub license metadata was `NOASSERTION`; README claims Apache-2.0.

Reviewed README sections and [equity quote standard model](https://github.com/OpenBB-finance/OpenBB/blob/2a392e890f6eb1f0f4e3a71742720af8f056333a/openbb_platform/core/openbb_core/provider/standard_models/equity_quote.py). Typed optional quote fields and explicit descriptions informed our independently written evidence schema. Unknown is not zero; every required measurement has a source/time and readiness state. No provider framework was imported.

### 12. yfinance

Version `e2f6104164b70085556fe2f8e194cf3ca18550f5` — Apache-2.0 metadata.

Reviewed README sections and [history.py](https://github.com/ranaroussi/yfinance/blob/e2f6104164b70085556fe2f8e194cf3ca18550f5/yfinance/scrapers/history.py), including adjustment and optional unit/price repair behavior. Research history may differ from executable quotes. We do not silently repair an execution observation or promote retrospective Yahoo candles into actual Upstox fills. Upstox remains the execution-data source.

### 13. vectorbt

Version `c923f74c9e4d1e07e626ae9002f7382cd8264833` — metadata `NOASSERTION`; README describes Fair Code licensing.

Reviewed README sections and [portfolio/base.py](https://github.com/polakowo/vectorbt/blob/c923f74c9e4d1e07e626ae9002f7382cd8264833/vectorbt/portfolio/base.py), including time-step order records, price/size/fees and explicit cost examples. Retained inspectable order/cost records. No dependency, exhaustive parameter search or claimed optimal settings were introduced.

## Validation, performance and remaining work

- Automated tests cover required-data rejection, zero/false values, invalid OHLC, duplicate timestamps, future bars, daily warm-up, original-commit recovery, HTML escaping, UI adapters and preserving one purchase per scan while retaining other candidates' diagnostics.
- Desktop and 375px mobile preview checked; no horizontal overflow. UI uses progressive disclosure and existing theme tokens rather than another visual redesign.
- Historical audit covers 23 entries with eight recoverable original measurements each, as of `2026-11-06T09:55:41.025Z`, from main commit `1e077d7`. Historical quote depth and unused scores remain unknown. The audit file is supplemental; recorded fills, quantities, exits and P&L are unchanged.
- Context calculations reuse daily history and cache it. Local validation adds computation but no new external data provider. More complete candidate diagnostics require finishing the existing bounded candidate loop after one purchase; they do not add history requests or permit additional purchases in that scan.
- Expected benefit: fewer decisions made with incomplete/invalid evidence and explanations that can actually be audited. **No measured profit improvement is claimed.** New evidence gates can reduce trade count.
- The earlier 4–6 November entry-mode comparison did not establish better cost-adjusted returns. See [entry-quality study](entry-quality-2026-11-06.md). Its numbers predate this evidence-schema update and have not been relabeled as current results. Broader point-in-time replay and forward paper observation remain necessary before promoting the revised entry logic.
- Future work: archive decision evidence over more sessions; compare research-backed versus price-only cohorts after costs; measure data-provider failures and missed setups; add an independently timestamped secondary-price discrepancy check if an appropriate licensed source is available. Do not infer institutional ownership, delivery or calibrated success probability from price/volume proxies.

## Files and rollback

Engine/data: `api/_entry-research.js`, `api/_paper-simulation.js`, `api/_paper-simulation-handler.js`, `research/candle-integrity.js`, `research/decision-evidence.js`, `research/entry-quality.js`, `research/entry-evidence.js`, `research/session-replay.js`.

Historical read-only audit: `research/decision-audit.js`, `scripts/audit-decision-evidence.js`, `data/decision-audit.json`.

Display: `desk/decision-details.js`, `desk/desk.js`, `desk/desk.css`, `desk/index.html`. Tests: `test/decision-evidence.test.js` and the related desk/entry fixtures.

Changes stay on the existing draft review branch/PR. No merge or production deployment is authorized by this review. Rollback is a normal revert of this review-branch change; there is no ledger migration to undo.
