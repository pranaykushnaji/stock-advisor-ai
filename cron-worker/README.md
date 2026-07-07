# StockAdvisor cron worker (Cloudflare)

This tiny Cloudflare Worker is the **punctual clock** for the app. It replaces GitHub's
unreliable scheduled Actions. It doesn't do any work itself — it just fires HTTPS triggers
at exact times:

- **NSE snapshot** → triggers the GitHub Actions workflow (the GitHub runner still does the
  actual NSE fetch, because NSE blocks Vercel/Cloudflare IPs).
- **pick / sell-check / refresh** → calls the Vercel endpoints with `CRON_SECRET`.

## Schedule (all weekdays; IST = UTC + 5:30)

| IST | Job |
|-----|-----|
| 08:45 | NSE snapshot (pre-open) |
| 09:05 | Stock of the Day (pick) |
| 10:10, 11:10, 12:10, 13:10, 14:10, 15:10 | hourly sell-check |
| 12:00 | NSE snapshot (midday) |
| 15:40 | refresh prices + book exits |

`capture-open` (09:20 IST) is present but commented out in `worker.js` — uncomment the one
line if you want it.

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

## Test each trigger by hand (do this before turning GitHub off)

Using your Worker URL and your `CRON_SECRET`:

```
https://stock-advisor-cron.<you>.workers.dev/run?job=nse-snapshot&key=<CRON_SECRET>
https://stock-advisor-cron.<you>.workers.dev/run?job=sell-check&key=<CRON_SECRET>
https://stock-advisor-cron.<you>.workers.dev/run?job=stock-of-the-day&key=<CRON_SECRET>
https://stock-advisor-cron.<you>.workers.dev/run?job=refresh-prices&key=<CRON_SECRET>
```

Each returns JSON with the HTTP status of the downstream call. `nse-snapshot` success = a new
run appearing in the repo's **Actions** tab. The others reflect the Vercel endpoint's response.

Watch live logs while testing with: `wrangler tail`

## After it's verified (I'll do this part in the repo)

Once the Worker has driven a full trading day correctly, we turn off the now-duplicate
schedulers so nothing runs twice:

1. Remove the `schedule:` blocks from `.github/workflows/nse-snapshot.yml` and
   `.github/workflows/sell-check.yml` (keep `workflow_dispatch` so the Worker can still
   trigger the snapshot).
2. Remove the `crons` array from `vercel.json` (the Worker now drives pick + refresh).

Everything stays safe if both run for a bit, because the ledger writes are now idempotent.
