# Homepage simplification — 6 November 2026

The homepage is now a summary rather than a second research/operations screen.

- Keep marked return in rupees, return on invested entry capital, average net return per
  closed stock, open-position count, saved timestamp and the latest three distinct picks.
- If no stock has been bought, show up to five research suggestions clearly marked as
  unpurchased. Open picks link to Positions; closed picks link to Results.
- Keep urgent paused-entry / missing-account warnings visible. Older-price warnings become
  a short link to the detailed performance screen; they are not silently discarded.
- Results retains all three percentage measures, cost calculations, denominator explanations,
  full closed trades and separate historical replays.
- Suggestions retains discovery scores, research, catalysts, observed price traces and reasons.
- New System navigation holds coverage, Nifty observation, scan timeline, one-share policy,
  safeguards, execution/funding assumptions and source diagnostics. The existing
  `#system-health` link still opens the source details in that section.

The five top-level sections are available on desktop and the phone bottom navigation.
Safe-area padding, dark/light themes, keyboard navigation, manual refresh and visible-tab
automatic refresh remain. No chart or percentage is fabricated. This is presentation only:
no changes to trading rules, risk limits, schedules, position quantities or historical records.

Regression tests check homepage information boundaries, watch-versus-pick distinction,
five-suggestion fallback, retained urgent warnings and continued visibility of the versioned
one-share policy in System.
