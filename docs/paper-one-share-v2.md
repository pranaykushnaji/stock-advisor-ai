# One-share paper policy — 6 November 2026

User-approved changes: remove fixed ₹10,000/day buying allocation, ₹5,000 position-notional
cap, three-new-buy cap, five-open-position cap (separately confirmed), and blanket same-sector
exclusion. Every **new** entry is exactly one whole share. These settings live in the public,
versioned `research/paper-policy.js`; the engine, UI and replay use that shared policy.

## What remains

- Maximum ₹100 modeled initial risk per position and ₹500 aggregate initial open risk.
  Existing multi-share holdings consume their original modeled risk until exited.
- Fresh exact-instrument Upstox quotes, real bid/ask spread and official circuit checks.
- Current surveillance/negative-event safety, minimum turnover, EMA20 and Nifty checks.
- Completed consolidation / opening-breakout evidence; no signal-time morning-open fills.
- Frozen initial stops and existing trailing/time/no-progress/negative-event exits.
- Held names excluded from discovery; no pyramiding, duplicate entry or same-day re-entry.
- One accepted new name at most per five-minute scan, but no daily entry count ceiling.
- Paper-only execution. No broker orders, added credentials or scheduler changes.

One share may still be rejected if its risk exceeds ₹100 or the remaining ₹500 aggregate
budget. This is deliberately not “enter every rising stock.” Removing the sector rule can
increase correlated losses; even the modeled total is not a guaranteed maximum gap loss.

## Funding and migration

No automatic ₹10,000 deposit at day start. New days begin with zero contributed capital.
The simulation spends existing cash first; if an otherwise qualifying one-share buy needs
more cash, it records exactly the shortfall as **additional simulated capital contributed**.
That contribution updates the single atomic ledger along with the position, cash and day
deployment. It never counts as profit and is never a real deposit or broker transaction.
Risk-rejected / duplicate / stale-data decisions never fund a trade.

Existing `paper-breakout-v1` ledgers are accepted and become `paper-one-share-v2` on the next
valid transition. Existing holdings, trade quantities, cost bases, cash and historical day
deposits are retained. There is **no** retrospective sell-down to one share. New position IDs
carry the new strategy version. Validation rejects cross-open/closed duplicate IDs and
duplicate open tickers. CAS retries continue to re-evaluate the newest state before booking.

Exit rupee P&L now uses rounded sale proceeds minus the recorded invested notional, matching
cash movements to the paisa. Trigger logic does not change. Already-closed rows are not edited.

## Research compatibility and checks

Historical replay imports the same `paperEntryAllocation` helper for sizing, risk and funding.
An explicit `LEGACY_SIM_CONFIG` reproduces the original budget/sector/count restrictions;
existing saved historical replay files remain untouched and excluded from live performance.
Historical order-book/circuit limitations still apply; no improvement in profitability is
asserted from configuration changes alone.

Regression tests cover six same-sector positions, total deployment above ₹10,000, exactly
one share each, no ₹5,000 notional ceiling, per-position/aggregate risk rejection, cash-first
funding, duplicate/CAS protection, future entry after a normal exit on a later session,
one-share exit/capital reconciliation, legacy-position migration and old-policy replay.

The UI displays the deployed entry policy independently from the last saved scan's policy,
so old JSON does not appear to reinstate yesterday's caps before the next cron. It labels
grandfathered multi-share positions and continues to show returns using actual saved cost
bases. A one-share format makes comparison convenient; percentage return itself is independent
of quantity (except for rounding/cost assumptions).
