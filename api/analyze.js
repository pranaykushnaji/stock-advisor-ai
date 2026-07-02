export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const { stock, mode } = req.body || {};
    if (!stock || typeof stock !== 'string') return res.status(400).json({ error: 'stock name required' });
    const cleanStock = stock.trim().slice(0, 100); // cap length to prevent abuse
    if (cleanStock.length < 1) return res.status(400).json({ error: 'stock name required' });

    const AGENT_PROMPT = `You are a factor-based equity analyst. Score two fundamental factors for the given stock. (Momentum and Low-Volatility are computed separately from real price data — do NOT score those.)

Score each sub-metric 0-100 against the benchmark, then the factor score is the weighted average of its sub-metrics.

=== QUALITY FACTOR (sub-metrics & weights) ===
High-quality = strong, stable, low-leverage businesses that compound.
- roe (weight 25%): >18%=90+, 15-18%=75-88, 12-15%=60-72, <12%=below 55
- roce (weight 25%): >20%=90+, 15-20%=75-90, 10-15%=55-70, <10%=below 50
- debtToEquity (weight 20%): <0.3=90+, 0.3-0.6=75-88, 0.6-1.0=55-70, >1=below 50 (sector-adjusted)
- earningsStability (weight 15%): consistent/growing profits 5y=85+, erratic=lower
- margins (weight 15%): EBITDA margin >20% & stable/improving=85+, declining=lower

=== VALUE FACTOR (sub-metrics & weights) ===
Value = cheap relative to fundamentals. Cheaper = higher score.
- peRatio (weight 35%): PE well below sector avg=90+, at par=60, above=40, very expensive=below 30
- pbRatio (weight 25%): P/B low vs sector/history=85+, high=below 40
- pegRatio (weight 25%): PEG<1=90+, 1-1.5=70, 1.5-2=50, >2=below 35
- dividendYield (weight 15%): healthy sustainable yield=75+, none=45

Return ONLY valid JSON (no markdown). ALL scores 0-100 integers:
{
  "ticker": "SYMBOL",
  "fullName": "Full Company Name",
  "sector": "Sector",
  "estimatedUpside": "12-20%",
  "riskLevel": "Low" or "Medium" or "High",
  "horizon": "6-12 months" or "1-2 years",
  "factors": {
    "quality": {
      "score": <weighted avg>,
      "subScores": {"roe":0-100,"roce":0-100,"debtToEquity":0-100,"earningsStability":0-100,"margins":0-100},
      "positives": ["ROE 22% — excellent", "Net cash positive"],
      "negatives": ["Margins compressed 300bps YoY"]
    },
    "value": {
      "score": <weighted avg>,
      "subScores": {"peRatio":0-100,"pbRatio":0-100,"pegRatio":0-100,"dividendYield":0-100},
      "positives": ["PE 18x vs sector 26x — cheap"],
      "negatives": ["No dividend"]
    }
  },
  "newsSummary": "1-2 sentences on any major recent catalyst or risk from news (informational only, not scored)",
  "summary": "2-3 sentence overall view combining quality + value + what the price-based factors will likely add",
  "priceContext": "CMP, 52-week range, PE, sector PE, P/B"
}

RULES:
- Compute each factor score as the WEIGHTED AVERAGE of its subScores
- Use REAL financial data — never invent; if unsure, score conservatively toward 50
- Each positive/negative references an actual metric vs benchmark
- Return ONLY the JSON`

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: AGENT_PROMPT },
          { role: 'user', content: `Analyze this stock's Quality and Value factors: "${cleanStock}"` }
        ],
        temperature: 0.3,
        max_tokens: 3000
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
