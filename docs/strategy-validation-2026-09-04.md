# Risk and evidence changes — 4 September 2026

## Status

Implemented and tested; deployment approved by the user on 4 September 2026. See the release
commit's deployment check for live status. No historical trade, open position, cash balance,
cron schedule or secret was modified during implementation. These changes improve correctness;
they do not demonstrate profitable future performance.

## Behavior changes

| Area | New behavior |
| --- | --- |
| Initial stop | Both entry paths freeze price, percentage and trail width at entry. Existing positions freeze on their next priced sell check, explicitly marked `legacy-first-observation`; their original stop cannot be recovered from the old ledger. |
| Trailing protection | Once armed, its absolute price can only move upward. Concurrent writes preserve the highest peak and tightest trailing protection. |
| Peak tracking | Entry-day daily highs are excluded because they might precede purchase. Sell checks may use a dated high from a later session. Price refresh conservatively uses observed quotes only. |
| Holding review | Counts exchange sessions, excluding the entry session, weekends and configured holidays. Reviews remain 7 sessions for momentum / 10 for catalyst, with existing thesis extensions. |
| Healthy winners | No fixed profit target. Removed the speculative reward/risk calculation as a standalone review exit; thesis, weekly trend, EMA and stop checks remain. |
| Exit accounting | Observed quote is the paper fill, not the theoretical stop. Save trigger, timestamps, peak, initial risk and strategy version. Gross P&L remains compatible; separate estimated net fields include a stated friction scenario. |
| Missing/extreme quotes | Unpriced or unverified extreme moves return an unsuccessful check, not a misleading green HOLD. Automatic independent verification of extreme moves is still pending. |
| Expected returns | Historical win rate AND historical average win/loss replace confidence-derived probabilities and synthetic payoff estimates. Minimum 20 comparable completed trades, deduplicated and strictly before the evaluation date. Insufficient or nonpositive evidence blocks entry. |
| Technical R/R | Retained as an explicitly unvalidated scenario. Removed the addition of allowed downside to upside and the minimum upside floor. Existing numerical entry thresholds remain unchanged, but the inputs are now stricter. |
| Catalyst evidence | Classifier cites article numbers supporting the specific event. Verification counts a curated publisher-domain list, not API providers; an unrelated filing does not verify the selected event. Duplicate titles do not count twice. Unknown publishers cannot corroborate automatically. |
| Catalyst memory | Old evidence-free VERIFIED memories are not reusable. Decay uses cited publication time rather than resetting to each scan time. |
| Backtesting | Shared sell gate and lane-specific frozen stops. Daily path assumed open-low-high-close; opening exits cannot use a later high. Optional high-first path supports sensitivity tests. |

### Important entry consequence

The current ledger would block both lanes under the new evidence gate:

- Momentum: 25 comparable trades; historical net expectancy about **−1.21%** using the
  30-basis-point (0.30%) round-trip friction scenario.
- Catalyst: only 4 comparable trades; insufficient evidence for the minimum of 20.

This is deliberately conservative, but it is not a self-bootstrapping learning system. When
entries are blocked, executed-trade history cannot grow. A separate, versioned shadow study
must establish new evidence before a new setup is enabled; do not fabricate or force trades
to satisfy the sample threshold. Twenty observations is an operational minimum, not statistical
proof. Historical cohorts span multiple strategy versions and have selection bias.

## Read-only trade audit

Run `npm run audit:trades -- --as-of=2026-09-04` for every closed trade, its original forecast,
actual return, cost sensitivity, and evidence that was available before its entry date.

| Recorded measure | Result |
| --- | ---: |
| Closed trades | 31 |
| Wins / losses | 10 / 21 |
| Gross realized P&L | −₹2,385.23 |
| Mean return per trade | −1.00% |
| Mean forecast edge, 26 trades | +5.65% |
| Mean actual return, same 26 | −0.96% |
| Estimated P&L with 0.30% round-trip friction | −₹3,187.73 |

Cost numbers are sensitivity scenarios, not verified broker charges. Existing gross records
are never rewritten. This is a calibration/accounting audit, **not** a full intraday replay:
the original timestamped quotes, frozen stops and thesis states were not archived.

## Validation performed

- Unit tests for immutable stops, monotonic trailing floors, entry-day high exclusion,
  safe concurrent merges, exchange-session age, and separate net/gross accounting.
- Synthetic OHLC tests for lane stops, gap fills and no use of future highs for opening fills.
- Evidence tests for missing samples, time leakage, duplicate trades, event-level filing
  selection, duplicate publisher feeds, and legacy catalyst memory rejection.
- Sell-handler tests with mocked external services for hold-state persistence, immediate
  observed-price exit booking, failed risk saves, and unverified extreme-move failures.
- Syntax checks and whitespace checks. No production cron was force-run.

## Limitations and follow-up priorities

1. **Forward shadow evaluation:** compare only two preregistered setups initially: verified
   material event with confirmed breakout; relative-strength consolidation breakout. Do not
   retroactively pick parameters from PAYTM/BANDHAN winners. Include all qualifying and rejected
   names, and the same entry timestamps, risk budgets and execution assumptions.
2. **Capture replay evidence:** timestamped entry/exit quotes, post-entry bars, point-in-time
   catalyst citations, selected setup, strategy version, and all rejection reasons. Current
   rejected-candidate 5-session outcomes are research data, not identical to live exit outcomes.
3. **Position sizing:** change confidence-based capital allocation to money-at-risk sizing
   only after total paper capital and per-trade/portfolio risk budgets are defined. Current
   sizing ladder and exposure/daily caps were preserved.
4. **Quote quality:** add an independent fresh quote/corporate-action reconciliation path.
   The current extreme-move guard reports a failure and requires attention; it does not resolve
   a genuine crash automatically. Existing legacy peaks may contain errors that cannot be
   repaired without historical intraday data.
5. **Faster protection:** consider 1–5 minute deterministic price-only checks once freshness,
   provider rate limits and persistence design support them. Leave expensive research slower.
   This does not remove gap/circuit/execution risk. Cloudflare schedules were not changed here.
6. **News provenance:** selected headlines are still interpreted by an LLM. Full filing bodies,
   original event dates and syndicated story identity need stronger validation. The publisher
   allowlist is conservative and not exhaustive. The separate news-intel thesis path remains
   an additional review target.
7. **Backtest honesty:** shared exit code is not a complete production replica. Daily candle
   ordering is assumed, end-of-day review fills are approximated, thesis history is absent,
   and the existing backtest does not reconstruct empirical entry-edge gates. No new Sharpe,
   portfolio return or claimed strategy uplift is presented.
8. **Avoid tuning noise:** retain the current EMA, volume and regime threshold values while
   gathering independent evidence. More indicators and a wider universe are not substitutes
   for a measured edge. See Bailey et al., [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

## Files

- Risk/execution: `api/_position-risk.js`, `api/_sell-engine.js`, `api/sell-check.js`,
  `api/refresh-prices.js`, `api/open-scan.js`, `api/stock-of-the-day.js`.
- Evidence/scoring: `api/_edge.js`, `api/_scoring.js`, `api/_catalyst.js`, `api/premarket.js`.
- Simulation/audit: `api/_exit-simulation.js`, `api/backtest.js`, `scripts/audit-trades.js`,
  `package.json`.
- Regression tests: `test/core.test.js`, `test/risk-and-evidence.test.js`,
  `test/sell-persistence.test.js`.
