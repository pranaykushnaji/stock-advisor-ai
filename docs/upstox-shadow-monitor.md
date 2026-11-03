# Upstox shadow monitoring and entry research

Development branch: `feature/upstox-market-data`. Draft PR: https://github.com/pranaykushnaji/stock-advisor-ai/pull/1.

## Activation record — 3 November 2026, 23:34 IST

The separate shadow service is deployed and enabled following user configuration of the
Upstox Analytics Token. Production trading code remains unmerged and unchanged.

- Vercel target: `https://stock-advisor-ai-git-feature-upstox-market-data-pk7.vercel.app`.
- Tested deployment: `https://stock-advisor-6xkvctk0q-pk7.vercel.app`, code `73f3913`.
- Cloudflare: `https://stock-advisor-upstox-shadow.pranaykushnaji.workers.dev`.
- Active worker version: `9fcd1c75-4643-4f36-9cd6-99aaaef52d67`.
- Remote flags verified: `SCHEDULER_MODE=monitor-only`, `UPSTOX_MONITOR_ENABLED=true`,
  `ENTRY_SETUP_RESEARCH_ENABLED=true`, and the feature preview origin above.
- Quote/candle connection test: HTTP 200; MCX and COFORGE map correctly and each return
  375 historical one-minute candles for November 2 and 375 current-day candles for November 3.
  Quotes were stale after market close, as expected; freshness checks remain enforced.
- Both authenticated preview routes return HTTP 200 `skipped` after hours. Both authenticated
  worker history routes return HTTP 200 and an empty history before the first scheduled session.
- First eligible session: November 4, 2026, 09:15 IST. Held-position checks every minute;
  considered-candidate research every 15 minutes. No future cron tick is claimed as observed.
- Vercel and Cloudflare logins were renewed. Preview/worker share a fresh separate cron secret;
  production's cron secret was not changed. Preview protection remains enabled and the worker
  uses its automation bypass secret. No secret values are written to source or this document.
- The user's existing unreadable Upstox secret is targeted to Preview as well as Production;
  its value was never retrieved. Existing Preview GitHub access is inherited. Runtime tests
  verify quote/candle access; a first scheduled open-session check is still needed to observe
  the complete held-position flow (the current bouquet is empty).

Checked-in worker flags remain false as a safe default. Redeploying the shadow worker later
requires the same explicit `--var` overrides for the two true flags and preview base, or the
deployment will deliberately disable monitoring again. There is no automatic paper exit or
buy execution on this service: its signals are shadow observations only.

The adapter, both endpoints and scheduler are read-only with respect to the trading account
and GitHub trade files. Shadow state belongs to separate Cloudflare Durable Objects. No order
API exists in this integration. Production activation and merging require authorization.

The two public monitor paths are rewrites into the existing `sell-check` function, which
dispatches to private handler modules only when the explicit monitor route is requested.
This preserves the existing 12 deployable function count and normal hourly sell-check flow.

## Implemented

- Official NSE BOD JSON mapping, raw gzip decoding, six-hour in-process caching, exact ticker
  matching, ISIN/key consistency, EQ-only selection, and ambiguous/missing-symbol failures.
- Read-only V3 full quotes, LTP, historical one-minute candles and current-day one-minute
  candles. Quotes are joined by instrument token, not response display keys.
- Protected `POST /api/minute-monitor`: held stocks only, existing frozen stops and trailing
  rules, no LLM/news/review-date work. Returns `would_sell`; does not execute a paper exit.
- Quote timestamp protection: both last-trade time and response time must exist, be within
  90 seconds, and have no more than 15 seconds of future clock skew. A fresh HTTP response
  does not renew a stale trade. Missing risk state and extreme moves are explicit failures.
- Durable Object serialization, minute de-duplication, quote ordering, latched signal IDs,
  atomic shadow state/history, and pruning of closed positions. Provider failures without a
  valid transition remain retryable. Partial responses preserve the fresh observations.
- Protected `POST /api/entry-research`: every 15 minutes, up to five currently considered
  candidates excluding held stocks. Checks completed five-minute consolidation breakouts,
  volume expansion, session VWAP and bounded price extension. A current quote is the proposed
  shadow entry. No production entry gate is bypassed and no stock is added to the bouquet.
- Separate scheduler config `cron-worker/wrangler.upstox-shadow.toml`, one-minute weekday
  ticks, two independent actors, bounded history of 400 samples each. Price checks operate
  09:15–15:29 IST; entry research runs at quarter hours in that window. Vercel applies the NSE
  holiday calendar. Cloudflare scheduling is best effort; late slots over 90 seconds are
  rejected rather than replayed as if they were current prices.
- Authenticated worker logs at `/monitor/log` and `/monitor/entries/log` (last 30 samples).
  No per-minute GitHub commits. Existing hourly research, buys, sells and schedules continue
  under their existing configuration. The shadow worker cannot invoke legacy trade jobs.

## Feature flags and configuration

All new behavior is disabled by default. Keep production environment variables and the
existing `cron-worker/wrangler.toml` unchanged during review.

| Location | Variable | Purpose |
| --- | --- | --- |
| Vercel **feature-branch Preview** | `UPSTOX_ACCESS_TOKEN` | Analytics token; configure through Vercel, never source/chat |
| Vercel feature-branch Preview | `UPSTOX_MONITOR_ENABLED=true` | Permit read-only held-position checks |
| Vercel feature-branch Preview | `ENTRY_SETUP_RESEARCH_ENABLED=true` | Permit experimental entry observations |
| Vercel feature-branch Preview | `GITHUB_TOKEN`, `CRON_SECRET` | Existing authorized GitHub reads and endpoint authentication |
| Separate Cloudflare shadow worker | `UPSTOX_MONITOR_BASE` | HTTPS origin of the Vercel feature preview; production domain is rejected |
| Separate Cloudflare shadow worker | `UPSTOX_MONITOR_ENABLED=true` | Enable minute shadow checks after connection test |
| Separate Cloudflare shadow worker | `ENTRY_SETUP_RESEARCH_ENABLED=true` | Enable quarter-hour entry research |
| Separate Cloudflare shadow worker | `CRON_SECRET` | Secret matching preview endpoint; set through secret storage |
| Separate Cloudflare shadow worker | `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional secret for a protected Vercel preview |

A token set only for Production is not necessarily available in Preview. Redeploy the preview
after setting environment values. Validate the Analytics Token against each endpoint;
authenticated entitlement has not been demonstrated by the public instrument-master check.

Deployment command for the separate worker, after configuring the preview and secrets:

```sh
wrangler deploy --config cron-worker/wrangler.upstox-shadow.toml
```

The checked-in config leaves flags false and the preview origin unset. No production worker
deployment is needed. The current PR does not activate automatic minute exits.

### Connection check

Send an authenticated POST to the preview's `/api/minute-monitor` with JSON:

```json
{"mode":"connection-test","symbols":["MCX","COFORGE"],"testCandles":true}
```

Use `Authorization: Bearer <preview CRON_SECRET>` as a header. This explicit test can run after
hours, but returned prices will correctly show as stale then. It tests mapping and full-quote
authentication; the current-day and historical candle APIs require separate entitlement checks.
With `testCandles:true`, the response also reports authorization and row counts for prior-session
historical candles and current-day intraday candles. The Analytics Token stays in Vercel.
None of these tokens belong in URLs or public logs.

## Entry investigation and proposed fixes

The complete five-session investigation is saved in
`docs/suggestion-review-2026-11-03.json`. Reproduce it with:

```sh
npm run review:suggestions -- --from=2026-10-28 --to=2026-11-03 --ref=origin/main
```

Archived hourly reports identify the suggestion time. Yahoo five-minute history provides
post-suggestion observations. The reference is the next complete candle's open after that
report; daily gains and the maximum later high are never booked as achieved profits.

| Stock/date | Daily move | Move from post-report reference to close | Actual blocker |
| --- | ---: | ---: | --- |
| MCX, Nov 3 | +7.42% | +4.54% after 11:00 report | RVOL 1.90 at 11:00; later accumulation proxy 54.8–56.9 below 65; no verified catalyst. At 13:00 the daily-high/circuit heuristic also wrongly rejected it. |
| BHARTIARTL, Nov 3 | +3.77% | +0.44% after 15:00 report | RVOL 1.85, below momentum 2.5 and catalyst 2.1; no verified event. |
| MOTILALOFS, Nov 3 | +4.73% | −0.40% after 11:00 report | Accumulation proxy 48.7–53.4 below 65; no verified event. |
| COFORGE, Nov 2 | +2.64% | −0.24% after 11:00 report | RVOL 1.93 below 2.5; no verified event. |
| COFORGE, Oct 30 | +4.23% | +0.64% after 10:00 report | Weak regime disabled momentum lane; no verified catalyst. |
| LAURUSLABS, Oct 30 | +7.20% | +2.92% after 10:00 report | Weak regime disabled momentum lane despite strong flow/confidence; no verified catalyst. |

The displayed final pair on Nov 3 was MCX/BHARTIARTL. MOTILALOFS was also considered earlier;
we cannot know which second name the user remembered without more context.

Two concrete corrections are included:

1. **Circuit detection:** the current heuristic calls a stock near its daily high with a gain
   of at least 5% an upper-circuit stock. Those are not equivalent. The corrected policy uses
   official upper/lower bands only. It is opt-in via `ENTRY_OFFICIAL_CIRCUIT_FILTER_ENABLED`,
   which stays unset pending review. Official bands must be supplied to the filter; absent
   bands are unknown, never inferred from the daily high. Surveillance, gap and liquidity
   checks remain. Production keeps its existing policy until approved.
2. **Rejection explanations:** record both catalyst-lane and momentum-lane requirements,
   lane-specific confidence, accumulation blockers, reference prices and tradeable state.
   The old report often said only “no catalyst” even when the momentum lane failed for
   another reason. Original score-based trend bonuses and buy thresholds remain unchanged.

The historical-edge gate also remains: enabling a new setup eventually requires separate,
versioned shadow outcome evidence. This PR does not falsely insert shadow observations into
the executed-trade ledger to bootstrap that gate.

## Experimental setup and results

`consolidation-v1` looks for six preceding completed five-minute bars within a 2% range, a close
above their high, at least 1.5× their average bar volume, and price no more than 2% above session
VWAP. It rejects an opening jump over 0.75% from the confirming close. This is a research
parameter set chosen for testing, not an optimized or guaranteed strategy.

The historical test examines all 19 considered stock-days over Oct 28–Nov 3, not only the
remembered winners. Twelve rose from their post-report reference to that session's close;
seven fell. Mean raw reference-to-close move was +0.68% before costs. The candidate cohort
excludes names rejected before the considered stage and is not the complete NSE universe.

The experimental setup generated seven modeled entries. Average same-session net return was
about +0.26% with a 0.30% friction scenario. MCX modeled an entry around 12:05 IST at ₹3,354.20
and +3.75% net to the session close, while MOTILALOFS modeled −1.65%. The seven outcomes were
identical with existing volatility trailing versus the proposed +2% activation / 2% distance;
there is no demonstrated trailing improvement in this sample.

The historical replay examines every completed five-minute candle; the staged live research
schedule is only every 15 minutes. It cannot be claimed to capture that exact 12:05 modeled
entry. A forward test is required. OHLC paths, next-open prices, no spread/depth execution,
and a same-session horizon are approximations, not actual paper fills or portfolio returns.
Both stop variants retain the same initial volatility stop; production thresholds are intact.

## Validation and remaining work

- Public official instrument mapping verified for MCX, COFORGE, BHARTIARTL and MOTILALOFS.
- Automated tests cover gzip/ambiguity/identity, provider/auth errors, timestamps, missing risk,
  duplicate and out-of-order data, no mutation of holdings, stop equivalence, actor serialization
  across restarts, failed-response retryability, holding exclusion and shadow-only entry signals.
- All 58 automated tests, syntax checks and Cloudflare shadow-worker dry-run build pass.
- The feature preview build succeeds with the existing 12 deployable function count. Remote
  anonymous smoke checks reach Vercel's SSO redirect rather than the app; authenticated
  end-to-end testing therefore also requires a preview protection bypass secret or a renewed
  Vercel login. The local Vercel CLI login is expired. No protection setting was disabled.
- Authenticated live quote/history/intraday and protected worker history checks passed on
  November 3 as recorded above. No Upstox token is present in local source or shell env.
- Recent production bouquet is empty. The monitor correctly returns `no_open_positions`;
  connection testing or fixture tests are needed to verify quote access while it is empty.
- The exchange calendar still covers 2026 only and fails closed for unknown years. Add the
  official 2027 calendar before year end.
- 400 bounded samples are operational history, not a long-term research archive. Export shadow
  observations before retention rolls over if they will support future model calibration.
- No production merge, production deployment, real-money order or historical trade edit occurs
  as part of this development work.

## Official contracts consulted

- [Upstox instruments](https://upstox.com/developer/api-documentation/instruments/)
- [Full quotes V3 and last trade time](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
- [Historical candles V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)
- [Intraday candles V3](https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/)
