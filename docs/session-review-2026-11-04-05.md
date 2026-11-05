# Paper-account review: 4–5 November 2026

Reviewed just after midnight IST on 6 November. These are the last two completed sessions,
not 5–6 November. Source: `origin/main` at `87ca4bb2f2538eb40458b68d6650353e3a91e1de`;
75 committed paper scan decisions per day, their original suggestions, the actual paper
ledger, current strategy source and the later NSE snapshot. Reproduce the audit with
`node scripts/review-paper-performance.js 2026-11-04 2026-11-05`.

## Results and definitions

Saved account as of 5 November, 15:25 IST. Three positions closed; three remain open.

| Stock | Entry IST | Exit IST / status | Entry | Exit / saved mark | Net closed result |
|---|---|---|---:|---:|---:|
| KAYNES | 4 Nov 12:10 | 5 Nov 09:35 | ₹3,291.34485 | ₹3,341.3285 | ₹40.03 / +1.22% |
| UNOMINDA | 4 Nov 12:30 | 5 Nov 11:00 | ₹1,196.598 | ₹1,232.48345 | ₹128.97 / +2.69% |
| GODREJPROP | 4 Nov 12:55 | 5 Nov 10:45 | ₹1,735.0671 | ₹1,779.20995 | ₹38.87 / +2.24% |
| ANGELONE | 5 Nov 10:00 | Open; mark 15:14:59 | ₹326.163 | ₹325.50 | −0.20% gross, unrealized |
| ZENSARTECH | 5 Nov 10:10 | Open; mark 15:25 | ₹561.4806 | ₹565.95 | +0.80% gross, unrealized |
| MEESHO | 5 Nov 10:15 | Open; mark 15:25 | ₹233.106495 | ₹232.78 | −0.14% gross, unrealized |

Closed net profit: ₹207.87 after estimated costs. Average net percentage per unique closed
stock: **+2.05%**. Weighted return on closed entry notionals: +2.12%.

Cash + saved open value = ₹20,219.01 against ₹20,000 contributions: marked profit ₹219.01.
Profit / all entry notionals (₹19,617.24) = **+1.12%**. Profit / contributions = **+1.10%**.
The first denominator counts recycled entry capital again. Neither is a time-weighted
return. Open marks include paid entry costs through cash, but not future liquidation
fees, spread or slippage. ANGELONE's last price predates the final scan by ten minutes;
the last check explicitly reports `unusable_price`. The UI now flags older marks.

Nifty's 5 November 15:25 saved change is **+2.4273%**, compared with +0.4235% at the previous
session's saved 15:25 observation. These are session index changes, not portfolio alpha.
The account holds a small selected mid/small-cap basket, has different entry/exit times
and receives another ₹10,000 each day; it is not a fully invested Nifty tracker.

## What was missed, and why

| Date | Suggestion | Largest recorded rise from first suggestion | Actual recorded impediments |
|---|---|---:|---|
| 4 Nov | JSWINFRA | +5.38% | Morning benchmark bug; later no confirmed setup / daily cap |
| 4 Nov | LINDEINDIA | +4.43% | Morning bug; saved average turnover ₹9.12Cr below ₹10Cr minimum; later setup / cap |
| 4 Nov | BHEL | +3.30% | Morning bug; later setup, sector exposure and cap constraints |
| 5 Nov | GROWW | +3.59% | No early confirmed breakout; later same-sector, buy-count and temporary open-position caps |
| 5 Nov | MOTILALOFS | +3.14% | No early confirmed breakout; later same-sector, buy-count and temporary open-position caps |
| 5 Nov | MAHABANK | +3.01% | Appeared after funding mostly used; same-sector / setup / quote timing constraints |

These are sampled prices while shortlisted, not daily highs, attainable fills or maximum
trade profits. Rejection reasons shown are a union across scans, not all conditions failing
simultaneously. In particular, the old benchmark bug prevented full downstream diagnosis
on 35 of 75 scans on 4 November. Fix `2588aad` addressed the provider index timestamp and
previous-close parsing. **Zero** benchmark-blocked scans occurred on 5 November.

All three exits were triggered by the existing 1.5R activation / 1R trailing-profit rule.
UNOMINDA's initial stop width was only 0.634% and KAYNES's 0.605%, so those trailing distances
were correspondingly tight. The rule intentionally protected small gains; it was not
designed to retain every intraday pullback in a large trend.

There is real give-up evidence, but it is not proof that a different stop would have
earned the subsequent high. The NSE snapshot fetched at 5 Nov 14:46 IST lists UNOMINDA
at ₹1,325 versus the 11:00 exit ₹1,232.48 (+7.51% later price difference), and GODREJPROP at
₹1,809.90 versus ₹1,779.21 (+1.72%). Conversely KAYNES was ₹3,320.20 at that later observation,
below its ₹3,341.33 exit. These are a different provider's later saved marks, not exit fills
or confirmed closing prices. Future exit experiments must include losers and post-exit
drawdowns, not just selected winners.

## Why three picks did not explain all missed returns

`maxBuysPerDay: 3` is a fixed experimental churn/concentration guard, not an optimized number.
There is no evidence that exactly three maximizes returns. However, the three buys spent
₹9,827.52 on 4 Nov and ₹9,819.15 on 5 Nov, including entry costs. Only ₹172.48 / ₹180.85 remained.
Exits replenish cash but do not recycle that day's ₹10,000 cumulative buying allowance.

There were two 4-Nov and seven 5-Nov candidate-scan observations with a confirmed setup
and the count cap as the only *recorded* rejection. Every one already cost more than the
remaining allowance for even one share at last price. Other execution checks were not run
after an early rejection, so these are not nine proven executable missed trades. Removing
the count cap alone would not have funded them under the existing budget.

The broader `sector === existingPosition.sector` exclusion is more restrictive than it
sounds: a broker, bank, insurer and asset manager all share Financial Services. ANGELONE
then excluded GROWW / MOTILALOFS / NAM-INDIA / several banks from consideration. On 5 Nov,
444 candidate-scan rows recorded this exclusion. These are repeated scan occurrences,
not 444 different stocks or independently qualified trades.

## Duplicates

Six entries across six unique tickers; zero duplicate IDs, zero duplicate open tickers.
Current quantities are ANGELONE 12 shares, ZENSARTECH 8, MEESHO 6: one entry each. A company
reappearing in scan history or on Overview and Positions is not another buy. Replays remain
separate and excluded. The UI now says “1 entry, N shares” and labels quantities explicitly.
No historical trades were removed or rewritten.

## Ranked next experiments (not live rule changes)

1. **Exit retention:** shadow the current 1.5R/1R trail against a later-arming, wider trail
   and a completed-bar structure trail. Freeze each initial stop. Measure net returns,
   profit give-back, maximum adverse excursion and drawdown on all trades, not just UNOMINDA.
2. **Allocation:** compare smaller first entries with a reserved later-session budget against
   spending essentially all ₹10,000 by 10:15. Retain whole-share, cash, risk and total exposure caps.
3. **Concentration:** compare the blanket one-sector rule with capped sector *rupee exposure*
   plus narrower industry/theme limits. Financial names remain correlated; this is not a
   reason to accept unlimited banking/broker exposure on a rally day.
4. **Count cap:** test budget/risk-limited entries without an arbitrary three-entry cap, as
   part of the allocation experiment. Keeping ₹5,000 positions but changing only “3” is not
   a solution to an already-used ₹10,000 budget. Include costs and churn.
5. **Entry lanes:** compare consolidation-only entry with a separately defined first-pullback
   continuation lane for sustained trends. Do not relabel every rising stock as a breakout.

Two sessions and three closed winners are insufficient to establish which variant is better.
Keep production paper logic and all stops unchanged until timestamp-correct comparison data
supports a change. Five-minute observations are not exchange-native stop orders; gaps and
execution failures remain possible. NSE's order mechanics explain that trigger price is not
a promise of fill price: https://www.nseindia.com/static/products-services/equity-market-trading-system.

## Delivered tracking changes

Overview and Results now show average closed-stock net %, marked profit / deployed capital %,
and portfolio / contributions %. Position cards/tables show entry-relative gross %, closed
rows show after-cost net %, and suggestion cards retain first-observation changes separately
from trade P&L. Formulas, quote timestamps, missing-data states and replay exclusions are visible.
The last saved session stays visible after midnight instead of losing its candidate history.
Read-only return arithmetic and audit functions have dedicated regression tests. No trading
threshold, schedule, capital limit, open position or realised record changed.
