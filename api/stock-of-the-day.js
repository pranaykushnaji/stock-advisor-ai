import { kv } from '@vercel/kv';

// Candidate universe — liquid large/mid-cap Indian stocks to scan daily
const CANDIDATES = [
  'Reliance Industries', 'TCS', 'HDFC Bank', 'Infosys', 'ICICI Bank',
  'Bharti Airtel', 'Larsen & Toubro', 'State Bank of India', 'Axis Bank',
  'Kotak Mahindra Bank', 'Hindustan Unilever', 'ITC', 'Bajaj Finance',
  'Maruti Suzuki', 'Sun Pharma', 'Tata Motors', 'NTPC', 'Power Grid',
  'UltraTech Cement', 'Asian Paints', 'Titan', 'Wipro', 'Adani Ports',
  'Coal India', 'JSW Steel', 'Tata Steel', 'Mahindra & Mahindra',
  'Nestle India', 'Bajaj Auto', 'Hindalco', 'Zomato', 'DMart'
];

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  // Protect: only allow Vercel Cron or manual trigger with secret
  const authHeader = req.headers.authorization || '';
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.key === process.env.CRON_SECRET;
  if (!isCron && !isManual && process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  const date = todayIST();

  // Don't regenerate if already picked today
  try {
    const existing = await kv.get(`sotd:${date}`);
    if (existing && !req.query.force) {
      return res.status(200).json({ status: 'already_picked', pick: existing });
    }
  } catch (e) { /* kv may be empty, continue */ }

  const SELECTION_PROMPT = `You are the chief market strategist for an Indian stock advisory. Today is ${date}.

From this candidate list, pick the SINGLE best stock to buy today based on current fundamentals, recent news, technical setup, and risk-reward. Consider recent earnings, news catalysts, sector momentum, and valuation.

Candidates: ${CANDIDATES.join(', ')}

Return ONLY valid JSON (no markdown):
{
  "ticker": "SYMBOL",
  "fullName": "Full Company Name",
  "sector": "Sector",
  "verdict": "BUY",
  "estimatedUpside": "12-20%",
  "riskLevel": "Low" or "Medium" or "High",
  "horizon": "3-6 months",
  "agents": {
    "fundamental": {"score": 0-100, "subScores": {"revenueGrowth":0-100,"roce":0-100,"roe":0-100,"debtToEquity":0-100,"margins":0-100,"valuation":0-100}, "positives": ["..."], "negatives": ["..."]},
    "news": {"score": 0-100, "subScores": {"recentCatalysts":0-100,"institutionalActivity":0-100,"sectorTrend":0-100,"sentiment":0-100}, "positives": ["..."], "negatives": ["..."]},
    "technical": {"score": 0-100, "subScores": {"trend":0-100,"momentum_rsi":0-100,"macd":0-100,"volume_support":0-100}, "positives": ["..."], "negatives": ["..."]},
    "risk": {"score": 0-100, "subScores": {"debtRisk":0-100,"pledgedShares":0-100,"volatility":0-100,"concentration":0-100}, "positives": ["..."], "negatives": ["..."]}
  },
  "summary": "Why this is today's top pick — 2-3 sentences with the key catalyst",
  "priceContext": "CMP, 52-week range, PE",
  "whyToday": "The single most important reason this stock stands out TODAY vs the others"
}

Pick the one with the best combination of strong fundamentals, positive recent catalysts, and favorable technicals. Return ONLY the JSON.`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: SELECTION_PROMPT },
          { role: 'user', content: `Pick the Stock of the Day for ${date}.` }
        ],
        temperature: 0.4,
        max_tokens: 3000
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err?.error?.message || `Groq ${r.status}` });
    }

    const data = await r.json();
    let text = data?.choices?.[0]?.message?.content || '';
    const start = text.indexOf('{');
    if (start > 0) text = text.slice(start);
    let depth = 0, end = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const pick = JSON.parse(end > 0 ? text.slice(0, end + 1) : text);
    pick.date = date;
    pick.pickedAt = new Date().toISOString();

    // Store today's pick
    await kv.set(`sotd:${date}`, pick);
    await kv.set('sotd:latest', pick);

    // Add to the shared project bouquet (append)
    let bouquet = (await kv.get('project_bouquet')) || [];
    if (!bouquet.find(b => b.date === date)) {
      bouquet.unshift({
        ticker: pick.ticker,
        fullName: pick.fullName,
        sector: pick.sector,
        verdict: pick.verdict,
        date: date,
        addedAt: pick.pickedAt,
        investedAmount: 10000,
        estimatedUpside: pick.estimatedUpside,
        riskLevel: pick.riskLevel,
        summary: pick.summary,
        whyToday: pick.whyToday
      });
      if (bouquet.length > 365) bouquet = bouquet.slice(0, 365);
      await kv.set('project_bouquet', bouquet);
    }

    return res.status(200).json({ status: 'picked', pick });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
