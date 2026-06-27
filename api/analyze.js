export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const { stock, mode } = req.body || {};
    if (!stock) return res.status(400).json({ error: 'stock name required' });

    const AGENT_PROMPT = `You are a multi-agent stock analysis system with 4 specialist AI agents. For the given stock, each agent performs independent analysis and returns a score 0-100.

Return ONLY valid JSON (no markdown):
{
  "ticker": "SYMBOL",
  "fullName": "Full Company Name",
  "sector": "Sector",
  "estimatedUpside": "15-25%",
  "riskLevel": "Low" or "Medium" or "High",
  "horizon": "3-6 months" or "6-12 months" or "1-2 years",
  "agents": {
    "fundamental": {
      "score": 0-100,
      "positives": ["Revenue CAGR 24%", "ROCE improving to 18%"],
      "negatives": ["High PE of 48x"]
    },
    "news": {
      "score": 0-100,
      "positives": ["Won govt tender", "Promoter increased holding"],
      "negatives": ["Sector headwinds"]
    },
    "technical": {
      "score": 0-100,
      "positives": ["Above 50DMA and 200DMA", "RSI 62"],
      "negatives": ["Near resistance"]
    },
    "risk": {
      "score": 0-100,
      "positives": ["Strong cash", "No pledged shares"],
      "negatives": ["Small-cap volatility"]
    }
  },
  "summary": "2-3 sentence overall AI summary",
  "priceContext": "CMP, 52-week range, PE"
}

RULES:
- Each agent score 0-100 based on real analysis
- Use REAL financial data, metrics, news
- Each agent: at least 2 positives, 1 negative
- Be specific with numbers
- Return ONLY JSON`;

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: AGENT_PROMPT },
          { role: 'user', content: `Analyze this stock with all 4 agents: "${stock}"` }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err?.error?.message || `Groq error ${r.status}` });
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ raw: text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
