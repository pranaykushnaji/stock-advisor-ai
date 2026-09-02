# StockAdvisor cron worker (Cloudflare)

This tiny Cloudflare Worker is the **punctual clock** for the app. It replaces GitHub's
unreliable scheduled Actions. It doesn't do any work itself — it just fires HTTPS triggers
at exact times:

- **NSE snapshot** → triggers the GitHub Actions workflow (the GitHub runner still does the
  actual NSE fetch, because NSE blocks Vercel/Cloudflare IPs).
- **research / buy / sell / refresh / analytics** → calls the Vercel endpoints with
  `CRON_SECRET` in an Authorization header.

## Schedule (all weekdays; IST = UTC + 5:30)

| IST | Job |
|-----|-----|
| 07:45 | NSE snapshot for overnight filings |
| 08:05 | Pre-market research and watchlist |
| 08:45 | Pre-open NSE snapshot |
| 09:25 | Opening-window buy scan |
| 09:40 | Early sell check |
| 09:45, 10:45, 11:45, 12:45, 13:45, 14:45 | NSE snapshots before hourly scans |
| 10:00, 11:00, 12:00, 13:00, 14:00, 15:00 | hourly buy scans |
| 10:10, 11:10, 12:10, 13:10, 14:10, 15:10 | hourly sell checks |
| 15:40 | Final price refresh |
| 16:10 | Rejected-candidate and LLM-advice analytics |

## One-time deploy

You need [Node.js](https://nodejs.org) installed. Then, in a terminal:

```bash
cd cron-worker

# 1. Install the Cloudflare CLI (once)
npm install -g wrangler

# 2. Log into the Cloudflare account you created (opens a browser)
wrangler login

# 3. Store the two secrets (you'll be prompted to paste each value — it is NOT saved to any file)
wrangler secret put CRON_SECRET      # paste your Vercel CRON_SECRET value
wrangler secret put GITHUB_TOKEN     # paste your NEW fine-grained GitHub token

# 4. Deploy
wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g. `https://stock-advisor-cron.<you>.workers.dev`.

> The **GitHub token** must be a fine-grained PAT with access to `stock-advisor-ai` and
> **Actions: Read and write** permission. Nothing else. Do not reuse a token you have pasted
> into a chat — generate a fresh one.

## Test each trigger by hand

Using your Worker URL and your `CRON_SECRET` (do not put the secret in a saved URL):

```bash
curl -X POST -H "Authorization: Bearer <CRON_SECRET>" \
  "https://stock-advisor-cron.<you>.workers.dev/run?job=nse-snapshot"
```

Valid jobs are `nse-snapshot`, `premarket`, `open-scan`, `stock-of-the-day`, `sell-check`,
`refresh-prices`, and `analytics`. Each returns the downstream status. A snapshot success means
a new run appears in the repository's **Actions** tab.

Watch live logs while testing with: `wrangler tail`

The old duplicate schedules are already removed. GitHub Actions retains `workflow_dispatch`
for NSE snapshots, and the independent watchdog provides recovery if the Worker stops or a
downstream job fails after all retries.
