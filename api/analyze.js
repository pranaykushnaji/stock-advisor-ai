// Advisor endpoint — analyze any stock on demand.
// Now grounded in REAL fundamentals (FMP -> Yahoo -> estimated) and deterministic
// factor scoring. Unlike POTD, this does NOT exclude no-fundamentals stocks — it
// analyzes them with a visible "estimated / price-only" flag so the user still gets
// an answer. The LLM writes only the qualitative narrative, never the numbers.

import { fetchFundamentals } from './_fundamentals.js';
import {
  computeReturns, annualizedVol, rawMomentum, volScaledMomentum,
  qualityInputs, valueInputs, composite, verdict,
} from './_scoring.js';

async function fetchWithTimeout(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Single-stock absolute scoring (no cross-sectional peers available on demand).
// Uses calibrated bands rather than percentile ranks. Momentum is vol-scaled.
function scoreSingle(closes, fund) {
  const returns = computeReturns(closes);
  const vol = annualizedVol(closes);
  const rawMom = rawMomentum(returns);
  const volMom = volScaledMomentum(rawMom, vol);

  // Momentum: map vol-scaled momentum through a sigmoid-ish band to 0-100.
  const momScore = volMom == null ? null
    : Math.max(0, Math.min(100, Math.round(50 + volMom * 12)));
  // Low-vol: lower annualized vol = higher score (30% vol -> ~50, 10% -> ~90).
  const lowVolScore = vol == null ? null
    : Math.max(0, Math.min(100, Math.round(115 - vol * 100 * 2.05)));

  // Quality/Value from real fundamentals via calibrated absolute bands.
  const f = fund.fields;
  const band = (v, pts) => { // pts: [[threshold, score], ...] descending
    if (v == null) return null;
    for (const [thr, sc] of pts) if (v >= thr) return sc;
    return pts[pts.length - 1][1] - 5;
  };
  const qParts = [
    band(f.roe, [[18, 90], [15, 78], [12, 65], [8, 52]]),
    band(f.roce, [[20, 90], [15, 78], [10, 62], [6, 50]]),
    f.debtToEquity == null ? null : band(-f.debtToEquity, [[-0.3, 90], [-0.6, 78], [-1.0, 62], [-2, 48]]),
    band(f.netMargin, [[20, 88], [12, 72], [6, 58], [2, 48]]),
    band(f.earningsGrowth, [[15, 85], [8, 70], [0, 55], [-10, 40]]),
  ].filter(v => v != null);
  const vParts = [
    f.peRatio == null || f.peRatio <= 0 ? null : band(-f.peRatio, [[-12, 90], [-18, 74], [-25, 60], [-40, 42]]),
    f.pbRatio == null || f.pbRatio <= 0 ? null : band(-f.pbRatio, [[-1.5, 88], [-3, 70], [-5, 55], [-8, 42]]),
    f.pegRatio == null || f.pegRatio <= 0 ? null : band(-f.pegRatio, [[-1, 90], [-1.5, 72], [-2, 55], [-3, 40]]),
    band(f.dividendYield, [[3, 78], [1.5, 65], [0.5, 55], [0, 45]]),
  ].filter(v => v != null);

  const mean = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const quality = mean(qParts);
  const value = mean(vParts);
  const scores = { momentum: momScore, quality, value, lowVol: lowVolScore };
  const comp = composite(scores);
  return {
    factors: scores, composite: comp, verdict: verdict(comp),
    annualizedVol: vol != null ? +(vol * 100).toFixed(1) : null,
    momentumDetail: returns ? { r3: returns.r3, r6: returns.r6, r12: returns.r12 } : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const { stock } = req.body || {};
    if (!stock || typeof stock !== 'string') return res.status(400).json({ error: 'stock name required' });
    const cleanStock = stock.trim().slice(0, 100);
    if (!cleanStock) return res.status(400).json({ error: 'stock name required' });

    // 1. Resolve to a ticker + price history via the existing stock endpoint logic.
    const base = cleanStock.replace(/\.(NS|BO)$/i, '').toUpperCase();
    let priceData = null;
    try {
      const host = req.headers.host;
      const proto = (req.headers['x-forwarded-proto'] || 'https');
      const pr = await fetchWithTimeout(`${proto}://${host}/api/stock?symbol=${encodeURIComponent(base)}&range=1y&interval=1d`, {}, 9000);
      if (pr.ok) priceData = await pr.json();
    } catch (e) {}

    const closes = priceData?.chart?.close?.filter(v => v != null && !isNaN(v)) || [];
    const ticker = (priceData?.symbol || base).replace(/\.(NS|BO)$/i, '').toUpperCase();

    // 2. Real fundamentals (FMP -> Yahoo -> estimated).
    const fundamentals = await fetchFundamentals(ticker, { fmpKey: process.env.FMP_KEY });

    // 3. Deterministic scoring (single-stock absolute bands).
    const scored = closes.length >= 30
      ? scoreSingle(closes, fundamentals)
      : { factors: { momentum: null, quality: null, value: null, lowVol: null }, composite: null, verdict: 'UNKNOWN', annualizedVol: null };

    // 4. LLM writes ONLY the narrative, from the real numbers.
    const NARRATIVE_PROMPT = `You are an equity analyst for Indian markets. Explain this stock using ONLY the real data provided — never invent numbers.

Stock: ${priceData?.name || cleanStock} (${ticker}), sector ${fundamentals.fields.sector || 'n/a'}
Factor scores (0-100): Momentum ${scored.factors.momentum}, Quality ${scored.factors.quality}, Value ${scored.factors.value}, Low-Vol ${scored.factors.lowVol}. Composite ${scored.composite} (${scored.verdict}).
Real fundamentals (source: ${fundamentals.source}): ${JSON.stringify(fundamentals.fields)}
Annualized volatility: ${scored.annualizedVol}%
${fundamentals.source === 'estimated' ? 'NOTE: fundamentals could NOT be fetched — do not state specific fundamental figures; focus on price-based factors and say fundamentals are unavailable.' : ''}

Return ONLY valid JSON (no markdown):
{
  "estimatedUpside": "e.g. 10-15%",
  "riskLevel": "Low" | "Medium" | "High",
  "horizon": "6-12 months" | "1-2 years",
  "qualityNotes": {"positives":[],"negatives":[]},
  "valueNotes": {"positives":[],"negatives":[]},
  "newsSummary": "1-2 sentences (informational)",
  "summary": "2-3 sentence overall view grounded in the scores + real data"
}
Return ONLY the JSON.`;

    let narrative = {};
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'system', content: NARRATIVE_PROMPT }, { role: 'user', content: `Analyze ${ticker}.` }],
          temperature: 0.3, max_tokens: 1500
        })
      });
      if (r.ok) {
        const d = await r.json();
        let text = d?.choices?.[0]?.message?.content || '';
        const s = text.indexOf('{'), e = text.lastIndexOf('}');
        try { narrative = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text); } catch (er) {}
      }
    } catch (er) {}

    // 5. Assemble response (deterministic scores + LLM narrative + source flags).
    const result = {
      ticker, fullName: priceData?.name || cleanStock, sector: fundamentals.fields.sector || null,
      price: priceData?.price ?? null, currency: priceData?.currency || 'INR',
      factors: {
        momentum: { score: scored.factors.momentum, detail: scored.momentumDetail },
        quality: { score: scored.factors.quality, positives: narrative?.qualityNotes?.positives || [], negatives: narrative?.qualityNotes?.negatives || [] },
        value: { score: scored.factors.value, positives: narrative?.valueNotes?.positives || [], negatives: narrative?.valueNotes?.negatives || [] },
        lowVol: { score: scored.factors.lowVol },
      },
      fundamentals: fundamentals.fields,
      fundamentalsSource: fundamentals.source,
      dataQuality: fundamentals.source === 'estimated' ? 'price-only (fundamentals unavailable)' : `real (${fundamentals.source})`,
      annualizedVol: scored.annualizedVol,
      composite: scored.composite, verdict: scored.verdict,
      estimatedUpside: narrative?.estimatedUpside || null,
      riskLevel: narrative?.riskLevel || null,
      horizon: narrative?.horizon || null,
      newsSummary: narrative?.newsSummary || null,
      summary: narrative?.summary || null,
    };
    // Backward-compat: the existing frontend expects `{ raw: "<json string>" }`.
    // Include it so nothing breaks; new frontends can read the structured fields above.
    result.raw = JSON.stringify(result);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
