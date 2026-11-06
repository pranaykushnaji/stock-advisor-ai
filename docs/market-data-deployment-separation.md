# Market-data updates are not website releases

## Verified incident — 6 November 2026

The project audit at 16:51 IST found **85 created deployment objects**, not 100 successful website releases:

| Triggering change | Completed | Canceled | Total |
| --- | ---: | ---: | ---: |
| Data JSON / mutable registry only | 19 | 61 | 80 |
| Code/UI | 5 | 0 | 5 |
| Total | 24 | 61 | 85 |

Counts by IST creation hour: 00:00=3, 07:00=1, 08:00=14, 09:00=22, 10:00=24, 11:00=4, 12:00=4, 13:00=4, 14:00=4, 15:00=2, 16:00=3. Full triggering commits, paths, timestamps and deployment URLs are in [the audit JSON](deployment-audit-2026-11-06.json).

An owner-wide rolling-24-hour query at 16:52 IST also returned 85 records, all for this project. Vercel nevertheless returned “Deployment rate limited — retry in 24 hours.” These visible records do **not** establish the remaining counter difference. Rejected attempts with no deployment object are excluded; no invisible deployments or exact reset time are invented.

The previous explanation equating the advertised limit with 100 actual deployments today was too strong. The verified problem is that **80 routine data updates unnecessarily entered deployment creation**.

### Root cause

Git integration created deployments for main-branch commits. `ignoreCommand` then canceled data-only builds, but that was too late: canceled ignored builds still consume deployment quota. `[skip ci]` did not prevent those Vercel deployment objects. Also, the ignore script did not classify `research/universe.json` as mutable data, so registry refreshes could cause completed builds.

Official references: [deployment quotas](https://vercel.com/docs/limits), [ignored builds still count](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step), [Git deployment control](https://vercel.com/docs/project-configuration/git-configuration), and [project-setting API](https://vercel.com/docs/rest-api/projects/update-an-existing-project).

## Fix

1. **Live Vercel project setting:** `gitProviderOptions.createDeployments` changed from `enabled` to `disabled`, verified with a separate GET. This is active immediately and does not need a deployment. The running website, production branch `main`, credentials, Git connection and cron endpoints were not removed or changed.
2. **Repository defense in depth:** `vercel.json` sets `git.deploymentEnabled:false`. New code/preview releases are deliberate CLI operations, not automatic responses to every commit. This replaces the earlier proposed separate-production-branch approach with a smaller change; no database or branch migration is necessary.
3. **Runtime data:** the desk already loads snapshot/paper-state JSON from public GitHub main. Its universe registry now does too. `/data/:path*` and `/research/universe.json` have external rewrites to GitHub main so legacy same-origin readers do not depend on bundled JSON after the next release.
4. **No frozen market data in deployments:** `.vercelignore` excludes `data/**` and `research/universe.json`. These remain in Git for persistence/audit; they are only excluded from the deployed source upload.
5. **Runtime server registry:** `_live-registry.js` loads and validates the current official registry with a ten-minute instance cache and coalesced requests. Membership is not imported into the function bundle. Stale (>7 days), future, malformed or duplicate records are unusable. Failed new-entry registry reads pause entries; risk-only position protection does not wait for that request. The read-only research coverage diagnostic also uses the runtime registry.
6. **Controlled release helper:** `node scripts/release-vercel.js --check` is a dry preflight. `--production` fetches main, requires a clean checkout exactly at that fetched commit and the correct project, reruns tests/checks, then invokes the ordinary Vercel production deploy. `--preview` permits an explicit tested preview from a clean branch. It does not read/copy tokens, add secrets, retry through quotas or bypass provider limits.
7. **Old ignore command:** retained only as defense in depth, now correctly includes the mutable universe registry. It is **not** represented as deployment-quota protection.

The existing JSON database, all writer paths, five-minute scan timing, trading rules, risk limits and historical trades remain intact. No cron was fired to fabricate a test event, no new broker order API was introduced, and no plan upgrade was made.

## Operational behavior

- Market/news/paper updates continue committing to main and are consumed at runtime, with provider/source timestamps and existing freshness guards.
- Data-only commits create **zero automatic Vercel deployments** while the verified project switch remains disabled.
- Code changes still run GitHub safety tests, but **do not auto-publish a website**. After approval, use the release helper/normal Vercel CLI. Explicit preview releases also consume quota normally.
- GitHub main remains both the audited data store and reviewed source. No additional database, account, token or secret is required.
- The registry/rewrites code requires the next successful website release; the Git-auto-deploy prevention setting is already active. The previously rate-limited strategy/UI release is not magically deployed by this infrastructure fix.

## Verification and rollback

Tests cover cached registry refresh without rebuild, concurrent requests, source validation, authenticated health without state writes, unauthorized requests without upstream calls, missing registry with working position-stop exits, data rewrites, upload exclusions and manual release guards. Existing trading/scheduler regression tests must continue passing.

Audit helper: `node scripts/audit-vercel-deployments.js 2026-11-06`; add `--rolling-owner` for aggregate owner-window counts. This is read-only and uses existing CLI authentication without exposing credentials.

Rollback automatic publishing only after reviewing quota consequences: set the project `gitProviderOptions.createDeployments` back to `enabled` and change `vercel.json` Git deployment policy accordingly. Do not restore bundled market data merely to obtain auto-deploy behavior. Normal code rollback is another explicit tested release; there is no account-ledger migration to reverse.
