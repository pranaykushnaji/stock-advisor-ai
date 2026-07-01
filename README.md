# 📈 StockAdvisor AI

AI-powered stock analysis for Indian markets — completely free, no user API key required.

## Features
- 🤖 **Multi-Agent AI Analysis** — 4 specialist agents (Fundamental, News, Technical, Risk) each score sub-metrics against research-backed benchmarks; confidence is a deterministic weighted mean computed in code, not guessed by the LLM
- ⭐ **Stock of the Day** — every morning at 9 AM IST a cron discovers candidates live (market news + top movers), picks the single best stock, and tracks it with real NSE prices
- 📊 **Real Price Tracking** — entry price captured at pick time; a daily cron refreshes current prices from Yahoo Finance so returns are real, not simulated
- 📈 **Nifty 50 Benchmark** — every pick's return is compared against the index over the same period, so you can see actual alpha (edge) vs. just riding the market
- 🌸 **Shared Project Bouquet** — daily picks accumulate in a shared bouquet (₹10,000 virtual each); add your own picks too
- 🔍 **Compare** — side-by-side analysis of two stocks
- 📊 **Dashboard** — real daily-pick performance, win rate, alpha vs Nifty, confidence distribution
- 📥 **Export CSV** — download all picks with real prices (injection-safe)
- 🌓 **Light/Dark Theme** · 📱 **Mobile responsive** (iOS safe-area aware)

## Architecture
- **Frontend:** Pure HTML / CSS / JS (no framework), served statically
- **AI:** Groq API (`openai/gpt-oss-120b`) — key stored server-side, never exposed to users
- **Data:** Yahoo Finance (prices) + Google News RSS (news/discovery), via Vercel serverless proxies
- **Storage:** GitHub Contents API (daily pick + project bouquet committed as JSON) — no external DB
- **Automation:** Two Vercel Cron jobs
  - `stock-of-the-day` @ 3:30 UTC (9 AM IST) — discover + pick
  - `refresh-prices` @ 12:00 UTC (5:30 PM IST) — update prices + Nifty benchmark

## Setup (deploy)
Already live on Vercel; push to `main` to auto-deploy. Required environment variables:
- `GROQ_API_KEY` — from [console.groq.com/keys](https://console.groq.com/keys)
- `GITHUB_TOKEN` — classic token with `repo` scope (lets crons commit JSON to the repo)
- `CRON_SECRET` — any random string (protects the cron endpoints)

Manual cron triggers (for testing):
- `…/api/stock-of-the-day?key=CRON_SECRET&force=true`
- `…/api/refresh-prices?key=CRON_SECRET`

## Reliability notes
- All external fetches have hard timeouts so a slow source can't blow the serverless limit
- Price refresh runs in parallel batches (scales to a large bouquet)
- GitHub writes retry on conflict; malformed AI responses fail gracefully without losing the day
- Live discovery falls back to Nifty-50 if news/movers come up empty

## Disclaimer
**Educational tool only — not financial advice.** The AI reasons over news and general knowledge; it does not read audited financials and can be wrong. Verdicts, confidence scores, and returns are for learning and paper-tracking. For real investment decisions, consult a SEBI-registered advisor. Nothing here is a recommendation to buy or sell any security.
