# Trading desk preview — 3 November 2026

## Scope and isolation

Separate branch `codex/trading-desk-preview`, based on the unmerged Upstox feature branch.
Production, its scheduler, its holdings and historical records are unchanged. The new UI is
`/desk/`; the original interface remains at `/`. No new automated trading is enabled.
The existing Upstox shadow worker continues pointing at its original feature preview, not here.

## Evidence reviewed

Remote `main` at `fbb208af700e43e8d4e2efeddc50721167fb0ed4`:

| Recorded quantity | Result |
| --- | ---: |
| Closed paper trades | 34 |
| Wins / losses | 10 / 24 |
| Gross rupee P&L | −₹2,756.99 |
| Mean winning return | +2.945% |
| Mean losing return | −2.784% |
| Mean trade return | −1.099% |
| Forecast mean / realized mean for 29 forecast-bearing trades | +5.638% / −1.080% |
| Momentum historical net mean after a 30bp friction scenario | −1.34%, 28 samples |
| Catalyst labeled completed trades | 4; insufficient for the 20-sample gate |

These are mixed-version historical paper records, not a clean test of this preview. Rupee P&L
is not a portfolio percentage return. Legacy forecasts are not evidence that a new setup has an edge.
The last recorded exit is 9 September; no newer executed trades were invented to fill the gap.

Latest snapshot has 214 names and seven empty index feeds out of eight. Only the F&O list works.
The downstream engine considers at most 40 price histories and eight catalyst candidates; a
snapshot with 214 names does not mean 214 complete evaluations. The old sector map recognizes
130 of those 214 symbols. Its missing classifications also weaken concentration checks.

## Findings and changes in this preview

1. **Coverage:** public official Nifty 500 / Midcap 150 / Smallcap 250 lists are joined to
   Upstox's exact NSE cash instrument identity. The current files contain 496 distinct entries,
   495 mapped; 149 mid-index and 247 small-index members including one non-tradable official
   corporate-action placeholder. Counts are reported as observed, never padded to an index name.
   Membership is reference coverage, not completed scans or permission to trade.
2. **Quotes:** Upstox normalization retains valid best bid/ask, quantities, spread, average
   traded price, day range, annual range and official circuit bands. Crossed/missing/zero-size
   books remain unknown, not zero spread. An authenticated, opt-in `mode:coverage` diagnostic on
   the existing entry-research route batches this registry without changing a holding.
3. **Selection bug:** all final candidates are checked before selecting a winner. A rejected
   first choice cannot suppress an otherwise eligible runner-up. Existing thresholds and edge
   safeguards remain; this is a correctness fix, not a bypass of the unprofitable historical cohort.
4. **Sell safety:** reject stale, non-INR or wrong-instrument Yahoo quotes; daily fallback data
   cannot masquerade as a fresh executable fill. Preserve provider timestamps. Malformed or
   unreadable existing ledgers cannot be replaced with an empty ledger. Failed filing
   classification remains retryable; filings and news intelligence have separate cursors.
5. **Research sizing:** pure `researchPositionPlan` caps whole shares by explicit cash,
   remaining investment/exposure budgets, and permitted stop loss including a stated execution
   allowance. No minimum investment reverses a size reduction. Missing budgets block a proposal.
6. **Research volume:** same-time RVOL compares completed cumulative one-minute volume against
   complete prior sessions at the same clock time, requiring ten reference sessions by default.
   Missing bars do not fabricate a high ratio. It is not connected to production gates yet.
7. **Research exit:** a separately versioned risk-unit trail activates at 1.5 times frozen
   initial risk, trails by one risk unit, and introduces a cost-aware floor only after activation.
   Uses observed price/bid, latches the exit proposal, never loosens the original stop. This is
   an unvalidated comparison profile, not an established improvement or guaranteed net profit.
8. **Interface:** Overview / Suggestions / Positions / Results, with collapsible health.
   Shows whole ledger sums, actual source/scan times, missing inputs, all saved intraday
   candidates, literal rejection reasons, and coverage failures. Scores are not probabilities;
   accumulation proxies are not proof of institutional buying. No equal-weight fictional
   portfolio return, alpha or CAGR. Costs are explicitly a 30bp scenario, not verified fees.

## Intended strategy study (not production-enabled)

Compare a small, preregistered set of setups: verified material-event breakout and
price/volume consolidation breakout. Reuse completed-bar setup confirmation already in
`api/_entry-research.js`; do not require every discovery score/proxy to exceed another threshold.
Evaluate intraday and short-swing holding variants on the same timestamped universe, with
identical budgets, costs, exposure caps and entry observation times. Do not pick a holding
period from MCX or COFORGE alone. Include failed setups and missed signals, not just winners.

Use Upstox for quote identity/freshness, spread, circuit bands, historical/intraday candles,
same-time volume curves and realistic entry/exit replay. Its news endpoint can query up to 30
instrument keys per request; this is an additional feed, not independent confirmation if it
repeats the same publisher. Retain official filings and event-level source verification.
Do not infer delivery percentage or institutional accumulation from a basic quote/depth feed.

Broad quotes can run on a slower cadence; only shortlisted setups need five-minute candle
research, and only held positions need minute-by-minute price risk checks. Batch and cache
history. Do not re-fetch one year of history for hundreds of names each minute. Broker rate
limits apply separately from Cloudflare request allowances. REST is adequate for the first
experiment; a long-lived streaming collector is optional later, not required for this UI.

## Outstanding blockers before promotion

- Clarify whether the user's “₹1–2k/day” is investment, tolerated loss or desired profit.
  No capital, loss tolerance or daily profit guarantee has been assumed.
- Durable exit intents and reconciliation across ledger/portfolio partial-write failures.
- Move deterministic stop checks/persistence ahead of potentially slow news/LLM work.
- Fresh final entry quote immediately before every fill, not the quote fetched before research.
- Commit-time lane/concentration checks, including races between open/hourly scans.
- Wire official circuit data before replacing the existing daily-high circuit proxy.
- A common event evidence schema and exchange-session-aware premarket carryover window.
- Fix calendar-day duplication in the legacy backtest; add point-in-time membership and
  corporate-action validation. Current membership must never become a historical universe.
- Forward or walk-forward replay with capital constraints, costs, gaps and actual observation
  cadence. No profitable-strategy claim or parameter promotion follows from unit tests.
- Obtain and verify the official 2027 holiday calendar before that year is enabled.

## Operational notes

`npm test` includes the isolated registry, sizing, RVOL, exit-observation, quote-safety and UI
regressions. `npm run research:universe` prints refreshed public reference JSON; it does not
write a trade or use an access token. The checked-in registry has its own retrieval timestamp.
It must be refreshed before being treated as current session membership.

New coverage diagnostic requires existing cron authentication, `ENTRY_SETUP_RESEARCH_ENABLED`
and `RESEARCH_COVERAGE_ENABLED`; neither creates an order or writes a trade. Never put broker
tokens or cron secrets into the browser, a file, a screenshot or source control.

Authoritative API references:
- [Instrument identity](https://upstox.com/developer/api-documentation/instruments/)
- [Full quotes; up to 500 instruments per request](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
- [News; up to 30 instrument keys](https://upstox.com/developer/api-documentation/get-news/)
- [Historical candles and retrieval limits](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)
- [Per-user API limits](https://upstox.com/developer/api-documentation/rate-limiting/)
- [Stop execution is not guaranteed at the stop price](https://www.investor.gov/introduction-investing/investing-basics/how-stock-markets-work/types-orders)
