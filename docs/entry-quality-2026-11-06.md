# Intraday entry repair — 6 November 2026

Implementation is for the existing paper experiment, not broker orders. Production
release is deliberately withheld pending review: the initial historical study did
not establish that the revised entry policy improves returns. No historical
position, price, quantity, contribution or exit has been edited.

## What changed

- `research/entry-quality.js` is shared by execution and isolated research.
- Nifty conditions are computed once per scan using completed five-minute bars
  and a fresh provider index snapshot. A positive daily index change no longer
  overrides recent deterioration.
- Entry pauses on a five-minute index fall of at least 0.15%, a fifteen-minute
  fall of at least 0.25%, a negative fifteen-minute trend below its short EMA,
  or an additional 0.10% fall since the last completed candle. Missing index
  history fails closed for entries only. These are versioned research thresholds,
  not statistically optimized NSE parameters.
- A stock needs positive recent five- and fifteen-minute returns, positive
  fifteen-minute relative strength versus Nifty and a price above its short EMA.
- The executable ask plus slippage is checked against VWAP (maximum +1.5%) and
  the breakout level (maximum +0.75%). Recent fifteen-minute rises over 2.5% and
  confirmation candles over twice the preceding mean range are rejected.
- Prior five-session movement is calculated only from completed earlier sessions.
  A >12% prior run together with >6% extension above EMA20 is rejected.
- Follow-through waits for another completed five-minute candle: it must hold the
  breakout, close strongly and not deteriorate from the breakout close.
- Retest waits for a subsequent candle touching within 0.20% of the breakout
  level, without a deeper breach, followed by a strong recovery close. It never
  guesses the order of highs/lows inside the original breakout candle.
- Combined/adaptive accepts either evidence-based confirmation path. Earliest
  opening confirmation can be 09:35 IST; there is no fixed 10:00 buy gate.
- Pending signals are retained for up to fifteen minutes, with four reserved
  history-fetch slots; they still pass the same discovery/safety rules.
- New records store entry assessment, recent market metrics, confirmation type
  and research cohort. Research-backed requires a dated, verified positive event
  no older than 72 hours; advisor headlines are price-only.

Unchanged: five-minute scheduling, one share per new entry, no notional/count or
blanket sector caps, ₹100/₹500 modeled risk limits, no same-session duplicates,
actual ask/bid execution modeling, frozen initial stops and existing exits.
Exit processing precedes and does not depend on entry history/news availability.

## Evidence and backtesting repair

The previous public-history runner used `range=1d`, even for another requested
session. It also relied on mutable chart metadata for previous close. Requests
now explicitly bound the requested session; previous close comes from a strictly
earlier daily candle. Saved contemporaneous EMA/liquidity references are preserved.

Old shortlists omit a stock after the old engine buys it. The study therefore
retains an originally observable pending breakout for fifteen minutes. If it is
absent from a subsequent shortlist, its later reference is a clearly modeled
completed-minute close—not an invented historical executable quote.

`entryEvidence` stores bounded, minified point-in-time market input in the same
atomic ledger. Only market-field allowlisted quotes are stored. The latest input
is overwritten each scan; Git retains earlier versions. Oversized frames are
marked omitted and cannot interrupt exits. No credentials are captured.

`replayPointInTimeEntries` reuses the exact production state transition for future
archived inputs. All returned hypothetical records are synthetic and excluded
from live statistics. Old sessions without these frames are explicitly reported
as `no_recorded_evidence`; they cannot be falsely advertised as exact replays.

Actual ledger reporting now groups by ENTRY date and research cohort, separating
closed net returns from open marks. It reports both equal-stock and
capital-weighted returns; open marks do not silently assume free liquidation.

## Initial study — diagnostic, not validation

Study generated at 2026-11-06T09:48:41.754Z. Inputs: 75 archived scans on 4 Nov,
75 on 5 Nov and 68 through 14:50 IST on 6 Nov. Coverage: 51/60/61 original
suggestion tickers respectively; public historical downloads succeeded for all.
Source session commits: `264c1520`, `afd12b77`, `9c448f61`.

All variants use uncapped ONE-SHARE sizing; baseline means the original breakout
signal under that standardized sizing, NOT replication of the old three-buy
account. Each day starts empty. Results include hypothetical liquidation of open
positions at the last study mark, 30bp assumed spread, 5bp slippage and 15bp fees
per side. They are not an overnight portfolio test or the actual account P&L.

| Variant | Entries | Capital deployed | Net modeled P&L | Return / deployed |
|---|---:|---:|---:|---:|
| Original breakout baseline | 49 | ₹37,430.35 | −₹165.95 | −0.4434% |
| Follow-through | 9 | ₹8,480.32 | −₹61.40 | −0.7240% |
| Retest | 14 | ₹12,996.94 | −₹68.43 | −0.5265% |
| Either confirmation | 15 | ₹13,230.61 | −₹70.58 | −0.5335% |

Combined approach by session: +0.7794%, −0.7323%, −1.0975% respectively.
It is NOT consistently better. Smaller rupee losses largely reflect smaller
capital deployed. The baseline had only one research-backed sample; revised
variants had none. This cannot validate a news advantage either way.

Limitations: retrospective Yahoo candles rather than recovered Upstox minute
history; possible revisions and cross-provider differences; no historical depth
or circuit eligibility proof; original discovery lists rather than full universe
rediscovery; short sample; partial final session; no inherited overnight positions.
No variant was selected by optimizing this three-session outcome.

## Reproduce / next release gate

- `npm test` and `npm run check`
- `node scripts/compare-paper-entries.js --summary 2026-11-04 2026-11-05 2026-11-06`
- `node scripts/review-paper-performance.js 2026-11-04 2026-11-05 2026-11-06`
- Once exact inputs accumulate: `node scripts/compare-recorded-entries.js YYYY-MM-DD ...`

Use a longer chronological holdout (including down/choppy days), not repeated
threshold searches on these same three days. Require cost-inclusive return,
drawdown and opportunity-cost evidence before promoting a variant. Twenty
sessions is only a minimum data-collection checkpoint, not statistical proof.
Do not loosen existing stop losses or rewrite entry prices to improve a report.

## Primary research and provider documentation consulted

- [Upstox historical candles V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)
  and [intraday V3](https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/):
  provider input availability and date/interval semantics.
- [Upstox rate limits](https://upstox.com/developer/api-documentation/rate-limiting/):
  reuse one Nifty candle call per scan, daily reference cache and bounded shortlist.
- [Baltussen et al., Hedging demand and market intraday momentum](https://academicweb.nd.edu/~zda/intramom.pdf):
  evidence that intraday conditions matter; NOT proof of these specific NSE rules
  or a universal five-minute prediction.
- [Bailey et al., Backtest overfitting in financial markets](https://escholarship.org/content/qt4hn4t174/qt4hn4t174_noSplash_2bb6c5b6dbbb66bcadbc3d0a05e3af6b.pdf):
  why a small, predeclared comparison and honest holdout are preferable to fitting
  dozens of thresholds to this week's winners/losers.
