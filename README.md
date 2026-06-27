# 📈 Stock Advisor AI

An AI-powered stock analysis web app using **Google Gemini (free tier)** — no credit card required, 1,500 analyses/day free.

## Features
- 🤖 AI analysis with verdict (BUY / HOLD / AVOID) + confidence score
- 📰 Bull case, bear case, recent catalysts
- 🌸 **My Bouquet** — approve picks and track simulated performance over time
- 📋 Analysis history
- 🔑 Your API key stored locally in your browser (never sent to any server)
- 🌙 Dark mode, mobile-friendly

## Setup

### 1. Get your free Gemini API key
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in with Google
3. Click **"Create API Key"**
4. Copy the key (starts with `AIza...`)

### 2. Run locally
Just open `index.html` in your browser — no build step needed.

### 3. Deploy to Vercel
1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → Import Project → select this repo
3. Deploy (no config needed — it's plain HTML/CSS/JS)

## How it works
- Enter any stock name or ticker (Indian or global)
- Gemini analyzes fundamentals, sector trends, and recent news
- Approve picks to add them to your **Bouquet**
- The Bouquet tracks simulated returns over time so you can see if the AI's calls were right

## Tech stack
- Pure HTML / CSS / JS (no framework, no build step)
- Google Gemini 1.5 Flash API (free tier)
- localStorage for persistence

## Disclaimer
For educational purposes only. Not financial advice. Always do your own research before investing.
