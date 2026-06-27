# 📈 Stock Advisor AI

AI-powered stock analysis web app — completely free.

## Features
- 🤖 **AI Analysis** — verdict (BUY/HOLD/AVOID) + confidence score + bull/bear case
- 📊 **Live Stock Charts** — real price data from Yahoo Finance
- 📰 **Live News Feed** — latest news for every stock analyzed
- 🔍 **Compare Stocks** — side-by-side AI analysis of two stocks
- 🌸 **My Bouquet** — approve picks and track simulated performance
- 💰 **Portfolio Simulator** — "If I invested ₹1L, what would it be worth?"
- 🥧 **Sector Breakdown** — pie chart of your bouquet by sector
- 🌓 **Light/Dark Theme** — toggle between themes
- 📥 **Export CSV** — download your bouquet data
- 📱 **Mobile Responsive** — works on all devices

## Setup

### 1. Get your free API key (Groq recommended)
1. Go to [console.groq.com/keys](https://console.groq.com/keys)
2. Sign up with Google/GitHub (free, no credit card)
3. Click **"Create API Key"**
4. Copy the `gsk_...` key

### 2. Deploy
Already live on Vercel. Push to `main` to auto-deploy.

## Tech Stack
- Pure HTML / CSS / JS (no framework)
- Groq API (Llama 3.3 70B) or Google Gemini
- Yahoo Finance (via Vercel serverless proxy)
- Google News RSS (via Vercel serverless proxy)
- Vercel for hosting + serverless functions

## Disclaimer
For educational purposes only. Not financial advice.
