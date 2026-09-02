# 📈 StockAdvisor AI

AI-powered stock analysis for Indian markets — completely free, no user API key required.

## Features
- 🎯 **Deterministic swing engine** — composite discovery, quality momentum, relative strength, volume, sector, regime, liquidity and expected-edge gates
- ⭐ **Hourly AI Pick scans** — pre-market research, an opening scan and six hourly scans; the engine may return NO TRADE
- 📰 **Verified catalyst pipeline** — official NSE filings plus multiple news sources, concrete event classification and event-specific decay
- 📊 **Real Price Tracking** — entry price locked at signal time; hourly sell reviews and an end-of-day price refresh
- 📈 **Nifty 50 Benchmark** — every pick's return is compared against the index over the same period, so you can see actual alpha (edge) vs. just riding the market
- 🌸 **Shared Project Portfolio** — confidence-sized paper positions (approximately ₹4,000–₹18,000), with up to three new positions per session
- 🛡️ **Risk controls** — surveillance rejection, concentration limits, volatility stops, trailing stops and thesis-aware health reviews
- 🔍 **Compare** — side-by-side analysis of two stocks
- 📊 **Dashboard** — real daily-pick performance, win rate, alpha vs Nifty, confidence distribution
- 📥 **Export CSV** — download all picks with real prices (injection-safe)
- 🌓 **Light/Dark Theme** · 📱 **Mobile responsive** (iOS safe-area aware)

## Architecture
- **Frontend:** Pure HTML / CSS / JS (no framework), served statically
- **AI:** Groq interprets catalysts and writes explanations; deterministic gates make trade decisions
- **Market data:** GitHub Actions fetches NSE snapshots because NSE blocks many serverless IP ranges; Yahoo/Alpha Vantage provide price history and fallback quotes
- **News:** NSE announcements, Marketaux, Finnhub, NewsData, Alpha Vantage and Google News RSS
- **Storage:** Versioned JSON files committed through the GitHub Contents API — no SQL/MongoDB
- **Automation:** A Cloudflare Worker ticks every five minutes and dispatches only the exact scheduled job; a separate GitHub watchdog recovers a stale or failed scheduler
- **Trading schedule:** 07:45 snapshot, 08:05 pre-market research, 09:25 open scan, hourly snapshot/buy/sell cycles through 15:10, 15:40 refresh and 16:10 analytics

## Setup (deploy)
Already live on Vercel; push to `main` to auto-deploy. Required environment variables:
- `GROQ_API_KEY` — from [console.groq.com/keys](https://console.groq.com/keys)
- `GITHUB_TOKEN` — fine-grained token limited to this repository with the required Contents/Actions permissions
- `CRON_SECRET` — any random string (protects the cron endpoints)
- Optional news keys: `MARKETAUX_KEY`, `FINNHUB_KEY`, `NEWSDATA_KEY`, `ALPHAVANTAGE_KEY`

Manual cron testing should send `Authorization: Bearer <CRON_SECRET>`. Query-key support remains only for backwards compatibility and should not be used in saved URLs.

## Reliability notes
- All external fetches have hard timeouts so a slow source can't blow the serverless limit
- Price refresh runs in parallel batches (scales to a large bouquet)
- GitHub writes retry on conflict; malformed AI responses fail gracefully without losing the day
- Live discovery falls back to a liquid large-cap list if snapshot discovery is unavailable
- Mutation endpoints fail closed when `CRON_SECRET` is missing
- Run `npm test` for core guardrail tests and `npm run check` for syntax checks

## Disclaimer
**Educational tool only — not financial advice.** The AI reasons over news and general knowledge; it does not read audited financials and can be wrong. Verdicts, confidence scores, and returns are for learning and paper-tracking. For real investment decisions, consult a SEBI-registered advisor. Nothing here is a recommendation to buy or sell any security.
