// Stock of the Day — picks best stock daily, commits result to repo as JSON.
// Storage = GitHub repo files (no KV needed). Requires GITHUB_TOKEN env var.

const REPO = 'pranaykushnaji/stock-advisor-ai';
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
  return ist.toISOString().slice(0, 10);
}

// Map company names / tickers to Yahoo NSE symbols
const SYMBOL_MAP = {
  'RELIANCE INDUSTRIES':'RELIANCE.NS','TCS':'TCS.NS','HDFC BANK':'HDFCBANK.NS',
  'INFOSYS':'INFY.NS','ICICI BANK':'ICICIBANK.NS','BHARTI AIRTEL':'BHARTIARTL.NS',
  'LARSEN & TOUBRO':'LT.NS','STATE BANK OF INDIA':'SBIN.NS','AXIS BANK':'AXISBANK.NS',
  'KOTAK MAHINDRA BANK':'KOTAKBANK.NS','HINDUSTAN UNILEVER':'HINDUNILVR.NS','ITC':'ITC.NS',
  'BAJAJ FINANCE':'BAJFINANCE.NS','MARUTI SUZUKI':'MARUTI.NS','SUN PHARMA':'SUNPHARMA.NS',
  'TATA MOTORS':'TATAMOTORS.NS','NTPC':'NTPC.NS','POWER GRID':'POWERGRID.NS',
  'ULTRATECH CEMENT':'ULTRACEMCO.NS','ASIAN PAINTS':'ASIANPAINT.NS','TITAN':'TITAN.NS',
  'WIPRO':'WIPRO.NS','ADANI PORTS':'ADANIPORTS.NS','COAL INDIA':'COALINDIA.NS',
  'JSW STEEL':'JSWSTEEL.NS','TATA STEEL':'TATASTEEL.NS','MAHINDRA & MAHINDRA':'M&M.NS',
  'NESTLE INDIA':'NESTLEIND.NS','BAJAJ AUTO':'BAJAJ-AUTO.NS','HINDALCO':'HINDALCO.NS',
  'ZOMATO':'ZOMATO.NS','DMART':'DMART.NS','AVENUE SUPERMARTS':'DMART.NS'
};

// Fetch live price from Yahoo — tries mapped symbol, then NSE/BSE suffixes
async function fetchPrice(ticker, fullName) {
  const upper = (ticker || '').toUpperCase();
  const nameUpper = (fullName || '').toUpperCase().replace(/ LTD\.?| LIMITED/g, '').trim();
  const mapped = SYMBOL_MAP[upper] || SYMBOL_MAP[nameUpper];
  const clean = upper.replace(/[^A-Z0-9.&]/g, '');
  const trySymbols = [mapped, clean.includes('.') ? clean : clean + '.NS', clean + '.BO', clean].filter(Boolean);
  for (const sym of trySymbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return { price: +meta.regularMarketPrice.toFixed(2), symbol: meta.symbol, currency: meta.currency };
      }
    } catch (e) { continue; }
  }
  return null;
}

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) return { content: null, sha: null };
  const d = await r.json();
  const content = Buffer.from(d.content, 'base64').toString('utf-8');
  return { content, sha: d.sha };
}

async function ghPutFile(path, contentObj, sha, token, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64'),
    ...(sha ? { sha } : {})
  };
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isManual = cronSecret && req.query.key === cronSecret;
  if (cronSecret && !isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const date = todayIST();

  const existing = await ghGetFile('data/daily-pick.json', ghToken);
  if (existing.content && !req.query.force) {
    try {
      const prev = JSON.parse(existing.content);
      if (prev?.pick?.date === date) {
        return res.status(200).json({ status: 'already_picked', pick: prev.pick });
      }
    } catch (e) {}
  }

  const SELECTION_PROMPT = `You are the chief market strategist for an Indian stock advisory. Today is ${date}.

From this candidate list, pick the SINGLE best stock to buy today based on current fundamentals, recent news, technical setup, and risk-reward.

Candidates: ${CANDIDATES.join(', ')}

Return ONLY valid JSON (no markdown). ALL scores must be on a 0-100 scale (e.g. 85, not 8.5):
{
  "ticker": "SYMBOL", "fullName": "Full Name", "sector": "Sector",
  "verdict": "BUY", "estimatedUpside": "12-20%", "riskLevel": "Low/Medium/High", "horizon": "3-6 months",
  "agents": {
    "fundamental": {"score":0,"subScores":{"revenueGrowth":0,"roce":0,"roe":0,"debtToEquity":0,"margins":0,"valuation":0},"positives":["..."],"negatives":["..."]},
    "news": {"score":0,"subScores":{"recentCatalysts":0,"institutionalActivity":0,"sectorTrend":0,"sentiment":0},"positives":["..."],"negatives":["..."]},
    "technical": {"score":0,"subScores":{"trend":0,"momentum_rsi":0,"macd":0,"volume_support":0},"positives":["..."],"negatives":["..."]},
    "risk": {"score":0,"subScores":{"debtRisk":0,"pledgedShares":0,"volatility":0,"concentration":0},"positives":["..."],"negatives":["..."]}
  },
  "summary": "Why this is today's pick", "priceContext": "CMP, range, PE",
  "whyToday": "The single most important reason this stands out TODAY"
}
Every subScore is an integer from 0 to 100. Return ONLY the JSON.`;

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
        temperature: 0.4, max_tokens: 3000
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

    await ghPutFile('data/daily-pick.json', { pick }, existing.sha, ghToken, `Stock of the Day: ${pick.ticker} (${date})`);

    const bq = await ghGetFile('data/project-bouquet.json', ghToken);
    let bouquet = [];
    try { bouquet = JSON.parse(bq.content)?.bouquet || []; } catch (e) {}
    if (!bouquet.find(b => b.date === date)) {
      // Capture real entry price from Yahoo
      const priceData = await fetchPrice(pick.ticker, pick.fullName);
      const entryPrice = priceData?.price || null;
      bouquet.unshift({
        ticker: pick.ticker, fullName: pick.fullName, sector: pick.sector,
        verdict: pick.verdict, date, addedAt: pick.pickedAt, investedAmount: 10000,
        entryPrice, currentPrice: entryPrice, lastPriceUpdate: pick.pickedAt,
        yahooSymbol: priceData?.symbol || null,
        estimatedUpside: pick.estimatedUpside, riskLevel: pick.riskLevel,
        summary: pick.summary, whyToday: pick.whyToday, agents: pick.agents
      });
      if (bouquet.length > 365) bouquet = bouquet.slice(0, 365);
      await ghPutFile('data/project-bouquet.json', { bouquet }, bq.sha, ghToken, `Add ${pick.ticker} to project bouquet`);
    }

    return res.status(200).json({ status: 'picked', pick });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
