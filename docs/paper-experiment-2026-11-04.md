# ₹10,000/day forward paper experiment — 4 November 2026

User authorized production deployment and then selected ₹10,000/day **simulated investment**.
This replaces the earlier ₹2,000 amount for this experiment. It is neither a profit target
nor consent to a real-money trading service. No broker order endpoint is used.

## Operational contract

- Hypothetical funding of ₹10,000 credited once per trading day on the first in-session tick.
  Unspent cash carries forward. Aggregate new investment, including entry costs, is at most
  ₹10,000/day. Exits do not refill that day's allowance.
- Whole shares only, at most ₹5,000 per position, three new positions/day and five open positions.
- Experimental modeled initial risk ₹100/trade and ₹500 aggregate open initial risk. These
  are study configuration assumptions, **not the user's declared loss tolerance**, and not
  maximum guaranteed losses. Gaps, circuits and missing observations can exceed modeled risk.
- Price checks every five minutes 09:15–15:25 IST; candidate scans every fifteen minutes.
  Candidate entry window 09:50–14:45; on the quarter-hour schedule the first potential entry
  is 10:00 IST. Scans outside that window still perform price protection.
- The legacy opening/hourly BUY handlers return `legacy_paused` when the experiment flag is
  enabled. Legacy positions still retain their old sell handler; there were none at release.
- The separate Upstox shadow worker is unchanged. It is not the production execution owner.

## Entry experiment

Scan the official registry's mapped Midcap 150 and Smallcap 250 members (currently 395).
Registry has 495 mapped total members; do not advertise all 495 as current detailed evaluations.
Batch Upstox full quotes. Rank cheaply with the existing composite discovery score using real
sector labels. Review eight shortlisted candidates, excluding held/same-day traded names.

Require fresh exact-instrument quotes, valid bid/ask, spread ≤30bp, official circuit headroom,
price ≥₹20, positive but <8% session move, positive relative strength vs Nifty, a fresh safety
snapshot, and no material official-filing risk flag. Benchmark declines worse than −1% pause
new entries. Require completed-session average turnover ≥₹10Cr over 20 sessions and price
above EMA20. No hard near-52-week-high, accumulation-proxy or calibrated-probability gate.

Reuse the versioned completed-candle consolidation setup: six prior five-minute bars inside
a ≤2% range, breakout close above that range, breakout volume ≥1.5× recent-bar average, above
session VWAP but ≤2% extended, and no >0.75% gap above the signal close at the proposed fill.
Daily history excludes the signal session. Quotes are refreshed after slower research.
No compulsory verified positive catalyst for this deliberately price/volume-only lane.
The LLM neither buys nor sells this portfolio; full news/event interpretation remains a
separate research layer. Official-subject risk words are review exclusions, not assertions
that an allegation is true.

The initial stop lies just below consolidation support and must be 0.5–3% below the simulated
entry. Position quantity is the minimum permitted by stop risk, daily cash allowance and
position-size limits. One qualifying buy per scan; remaining setups are reconsidered later.
Scores are rankings, **not probabilities or predicted percentage returns**.

## Exits and execution accounting

Initial stop is frozen. Trail arms after a favorable move of 1.5 initial-risk units and trails
by one risk unit, with a cost-aware floor. It never moves down. Stops are evaluated at observed
quotes, not retrospectively filled at a level crossed between checks. There is no fixed profit
target. Exit a stagnant setup after three exchange sessions without 0.5R progress; the research
horizon ends after five exchange sessions. Material official-filing risk flags can also exit.

Paper entry = observed ask plus 5bp slippage. Exit = observed bid less 5bp slippage. Fees/costs
are an explicit 15bp-per-side scenario, not reconciled broker charges. Record gross and net
rupee P&L separately. These assumptions do not guarantee actual executable depth or fills.

## Persistence and controls

`data/paper-simulation.json` is the single atomic CAS-updated account: cash, contributions,
daily usage, positions, closed trades, reference cache and candidate reasons. Concurrent
requests re-read and re-evaluate against fresh state. Duplicate action slots, old clocks,
held names and same-day re-entries are blocked. Partial ledger/portfolio commits cannot occur
because there is no separate portfolio-removal write. Malformed state fails closed.

Before slow research, an entry scan processes/persists existing price-risk exits. Quote and
history outages are explicit. Force parameters cannot bypass market hours. The account is
not backfilled with hypothetical morning purchases. Closed outcomes are separate from the
archived legacy trades and never manufacture a historical win probability.

Flags: `PAPER_SIMULATION_ENABLED=true` on Vercel and the existing production worker. Disable
the worker flag first to pause scheduling; disable the Vercel flag to stop the experiment.
Do not re-enable legacy buys without separately reviewing their evidence and budget settings.

## Validation status and limitations

Synthetic/unit tests cover whole-share capital sizing, daily funding idempotence, aggregate
budget including costs, no allowance recycling, duplicate slots, stale quotes, missing safety,
cash/position atomicity, CAS conflicts, after-hours refusal and actual scheduler dispatch.
This is **forward testing**, not proof of historical or future profitability. No new Sharpe,
expected edge, win rate or claimed return improvement is asserted. The existing daily-candle
backtest is NOT evidence for this new intraday setup. The deterministic transition is injectable
for replay once point-in-time quotes, depth, safety data and candles have been collected.

Intraday bars only observe available completed candles. Five-minute risk sampling can miss
price excursions between checks. Sector scores, liquidity floors, risk units, cost allowances
and the time horizon are preregistered experimental choices and may prove inferior. Surveillance
and filing flags still depend on the NSE fetch; unavailable safety blocks buys. The official
registry refresh is included in the existing snapshot workflow. Add the 2027 exchange calendar
before that year; unknown years fail closed. Funding is hypothetical, not a deposit instruction.

Production deployment and after-hours connection checks are not proof that the first scheduled
market-hours run will succeed. Verify that run independently after the market opens.
