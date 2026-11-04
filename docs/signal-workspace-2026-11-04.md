# Signal workspace and missed-entry review — 4 November 2026

## Visual direction

Precision rather than decoration: an almost-black graphite canvas, restrained lime accents,
Manrope display typography, DM Sans labels and thin structural borders. The reference direction
is the compact hierarchy of Linear, Raycast and Vercel, not a copied template or their assets.

The workspace gives research and execution their own visual identities. Real paper equity and
engine health sit above the current opportunity radar; operational detail is progressively
disclosed. Desktop navigation becomes an iPhone-safe bottom bar on phones. Light mode,
keyboard navigation, source freshness and reduced-motion support are preserved.

Charts use recorded observations only. No sample performance curve, invented probability or
daily stock return is presented as money the portfolio earned. Earlier suggestions remain
distinct from the current shortlist and from actual simulated picks.

## Confirmed morning defect

The first 35 archived scans, through 12:05 IST, rejected every shortlisted candidate with
`benchmark price unavailable`. An index has no ordinary stock trade, yet the benchmark gate
required an equity last-trade timestamp. This was an infrastructure/validation failure, not
evidence that all suggestions lacked momentum.

The fix validates the exact Nifty instrument using its provider snapshot timestamp and a
valid prior close (or price minus the provider's documented net change). Missing, old, future
or mismatched index data still blocks entries. Equity execution continues to require an actual
fresh trade timestamp and valid bid/ask. The benchmark is refreshed after slower research.

The first verified post-fix scan at approximately 12:10 IST passed the index check and opened
KAYNES in the live paper account. Historical entries have not been added to that account.

The archive shows BHEL and Medanta each advanced approximately 3% between their first recorded
suggestion and a later observed scan price. Linde advanced approximately 4%, but separately
failed the ₹10Cr average-turnover gate and exceeds the ₹5,000 whole-share allocation cap.
These are sampled opportunities, not claims that the entire move was executable profit.

## Replay requested by the user

`scripts/replay-paper-session.js` reconstructs the original chronological shortlists and their
then-available daily references and safety snapshots. The same completed-bar setup detector,
risk sizing, budget, sector cap and five-minute exit cadence are used. Only candles completed
before a decision are visible to it. It includes losses and does not select only remembered
winners.

`data/replays/2026-11-04.json` is an isolated estimated scenario through 12:20 IST: conditional
entries in UNO Minda (10:05), KAYNES (10:15), and Godrej Properties (10:50). Its three entries
fit the ₹10,000 aggregate allowance and no entry is larger than ₹5,000. No position had closed
at the replay cutoff.

Historical executable bid/ask and execution-time circuit bands were not archived, so these
are **not fully proven live-eligible trades**. The replay assumes a 30bp spread, 5bp additional
slippage per side, and 15bp estimated costs per side. It uses Yahoo one-minute candles, not a
recovered Upstox stream. Those limitations are embedded in the dataset and the UI. Every replay
position is marked synthetic, historicalReplay, executed=false and excluded from live stats.

## Deliberate limits

No entry thresholds were reduced to fit today's winners. The confirmed blocking bug was fixed
first; actual remaining setup failures are now recorded even when another gate rejects a name.
The live state gains bounded per-session observations (36 recent points per candidate, 90 scan
checkpoints) for honest future audits. A pullback/retest lane would need its own preregistered
out-of-sample test rather than being tuned to this morning's rising stocks.
