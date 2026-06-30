export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' });

  try {
    const { stock, mode } = req.body || {};
    if (!stock) return res.status(400).json({ error: 'stock name required' });

    const AGENT_PROMPT = `You are a multi-agent stock analysis system. You have 4 specialist agents. Each agent scores specific sub-metrics from 0-100 against defined benchmarks, then you compute a weighted score for that agent.

CRITICAL: Do NOT pick scores arbitrarily. For EACH sub-metric, evaluate the actual data against the benchmark and assign a score. Then the agent score is the weighted average of its sub-metrics.

=== FUNDAMENTAL ANALYST (sub-metrics & weights) ===
Score each 0-100 vs benchmark, then weight:
- revenueGrowth (weight 20%): >15% YoY=90+, 10-15%=70-85, 5-10%=50-65, <5%=below 50
- roce (weight 20%): >20%=90+, 15-20%=75-90, 10-15%=55-70, <10%=below 50
- roe (weight 15%): >18%=90+, 15-18%=75-85, 12-15%=60-72, <12%=below 55
- debtToEquity (weight 15%): <0.3=90+, 0.3-0.6=75-88, 0.6-1.0=55-70, >1=below 50 (sector-adjusted)
- margins (weight 15%): EBITDA margin >20% & stable/improving=85+, declining=lower
- valuation (weight 15%): PEG<1=90+, PE below sector avg=75+, PE above sector avg=40-60, very expensive=below 40

=== TECHNICAL ANALYST (sub-metrics & weights) ===
- trend (weight 35%): price above 50DMA AND 200DMA=85+, above one=60, below both=below 40
- momentum_rsi (weight 25%): RSI 40-60 healthy=80, 60-70 bullish=75, >70 overbought=45, <30 oversold=55 (could bounce)
- macd (weight 25%): bullish crossover/above signal=85, bearish=35
- volume_support (weight 15%): rising volume on up-moves + near support=80, near resistance=50

=== NEWS ANALYST (sub-metrics & weights) ===
- recentCatalysts (weight 35%): major positive (orders, contracts, expansion)=85+, neutral=55, negative=below 40
- institutionalActivity (weight 25%): promoter/FII increasing stake=85+, selling=below 40
- sectorTrend (weight 25%): sector tailwinds/govt support=80+, headwinds=below 45
- sentiment (weight 15%): overall news tone positive=75+, mixed=55, negative=below 40

=== RISK ANALYST (sub-metrics & weights) — higher score = LOWER risk ===
- debtRisk (weight 30%): low/no debt=90+, manageable=65, high leverage=below 40
- pledgedShares (weight 25%): zero pledged=95, some=60, high pledge=below 35
- volatility (weight 25%): large-cap stable=85, mid-cap=65, small-cap volatile=45
- concentration (weight 20%): diversified revenue/clients=85, concentrated/single-customer=below 45

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
      "score": <weighted avg of sub-metrics below, 0-100>,
      "subScores": {"revenueGrowth": 0-100, "roce": 0-100, "roe": 0-100, "debtToEquity": 0-100, "margins": 0-100, "valuation": 0-100},
      "positives": ["Revenue CAGR 24% (>15% benchmark)", "ROCE 22% — excellent capital efficiency"],
      "negatives": ["PE 48x vs sector 30x — expensive"]
    },
    "news": {
      "score": <weighted avg>,
      "subScores": {"recentCatalysts": 0-100, "institutionalActivity": 0-100, "sectorTrend": 0-100, "sentiment": 0-100},
      "positives": ["Won 1000 Cr govt order", "Promoter raised stake 2%"],
      "negatives": ["Sector facing regulatory pressure"]
    },
    "technical": {
      "score": <weighted avg>,
      "subScores": {"trend": 0-100, "momentum_rsi": 0-100, "macd": 0-100, "volume_support": 0-100},
      "positives": ["Above 50 & 200 DMA — uptrend", "RSI 58 — healthy momentum"],
      "negatives": ["Near resistance at 1450"]
    },
    "risk": {
      "score": <weighted avg, higher=safer>,
      "subScores": {"debtRisk": 0-100, "pledgedShares": 0-100, "volatility": 0-100, "concentration": 0-100},
      "positives": ["Zero pledged shares", "Net cash positive"],
      "negatives": ["Small-cap — higher volatility"]
    }
  },
  "summary": "2-3 sentence summary explaining the overall verdict and key drivers",
  "priceContext": "CMP, 52-week range, PE, sector PE"
}

RULES:
- Compute each agent score as the WEIGHTED AVERAGE of its subScores using the weights above
- Use REAL financial data and actual metrics — never invent
- Each positive/negative must reference the actual metric vs benchmark
- subScores must justify the agent score
- Return ONLY the JSON`

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
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
