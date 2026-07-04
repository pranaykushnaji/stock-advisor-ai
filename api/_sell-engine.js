// api/_sell-engine.js
// AI-based sell logic, two-phase to mirror the entry design:
//   decideSell()   -> 9 AM cron  : rules gate -> LLM -> mark SELL_PENDING (provisional exit)
//   finalizeSell() -> 5:30 PM cron: book real exit price -> realized ledger -> drop from bouquet
//
// Field names match the REAL bouquet shape: fullName, yahooSymbol, ticker,
// entryPrice, currentPrice, date, composite, sector.

// Tunable thresholds. currentPrice on each holding is already kept fresh by the
// refresh cron, so the rules gate reads it directly (no extra fetch needed here).
export const SELL_RULES = { TARGET_PCT: 15, STOP_PCT: -8, MAX_HOLD_DAYS: 30 };

function daysHeld(dateStr) {
  if (!dateStr) return 0;
  const from = new Date(dateStr + 'T00:00:00Z');
  return Math.floor((Date.now() - from.getTime()) / 86400000);
}

// Deterministic gate. Returns a forced SELL decision, or null to defer to the LLM.
export function rulesGate(item) {
  const entry = item.entryPrice, cur = item.currentPrice;
  if (!entry || !cur) return null;
  const pnlPct = ((cur - entry) / entry) * 100;
  const held = daysHeld(item.date);
  if (pnlPct >= SELL_RULES.TARGET_PCT) return { verdict: 'SELL', source: 'rule', reason: `target hit (+${pnlPct.toFixed(1)}%)` };
  if (pnlPct <= SELL_RULES.STOP_PCT) return { verdict: 'SELL', source: 'rule', reason: `stop-loss breached (${pnlPct.toFixed(1)}%)` };
  if (held >= SELL_RULES.MAX_HOLD_DAYS) return { verdict: 'SELL', source: 'rule', reason: `max hold ${held}d reached` };
  return null;
}

// LLM confirmation for the ambiguous middle. Uses the same Groq model/endpoint
// as the pick cron. `headlines` is optional (pass [] if news lookup is skipped).
export async function llmDecide(item, apiKey, headlines = []) {
  const entry = item.entryPrice, cur = item.currentPrice;
  const pnlPct = entry && cur ? (((cur - entry) / entry) * 100).toFixed(1) : 'n/a';
  const held = daysHeld(item.date);
  const sys = `You are a disciplined equity risk manager for NSE stocks. Decide HOLD or SELL for an OPEN position based on current sentiment and price action. Sell when the original bullish thesis no longer has clear support. Respond ONLY with strict JSON, no markdown: {"verdict":"HOLD"|"SELL","reason":"<max 15 words>"}`;
  const payload = {
    ticker: item.ticker, fullName: item.fullName, sector: item.sector,
    entryPrice: entry, currentPrice: cur, unrealizedPnlPct: Number(pnlPct),
    daysHeld: held, compositeAtEntry: item.composite,
    recentHeadlines: (headlines || []).slice(0, 8),
  };
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(payload) }],
        temperature: 0.3, max_tokens: 200,
      }),
    });
    if (!r.ok) return { verdict: 'HOLD', source: 'llm', reason: 'undecided (groq error)' };
    let text = (await r.json())?.choices?.[0]?.message?.content || '';
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    const parsed = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text);
    const verdict = parsed.verdict === 'SELL' ? 'SELL' : 'HOLD';
    return { verdict, source: 'llm', reason: (parsed.reason || 'llm decision').slice(0, 120) };
  } catch (err) {
    // A bad parse or network blip must NEVER force a sale on garbage -> default HOLD.
    return { verdict: 'HOLD', source: 'llm', reason: 'undecided (parse fail)' };
  }
}

// PHASE 1 decision for one holding. Returns a decision object or null (keep).
// `apiKey` = GROQ_API_KEY; `headlines` optional news for the LLM.
export async function decideSell(item, apiKey, headlines = []) {
  if (item.status && item.status !== 'OPEN') return null; // already pending/closed
  const forced = rulesGate(item);
  const decision = forced || (await llmDecide(item, apiKey, headlines));
  if (decision.verdict !== 'SELL') return null;
  return decision; // { verdict:'SELL', source, reason }
}

// Apply a SELL decision to a holding in place -> SELL_PENDING with provisional exit.
// Provisional exit = current price known at 9 AM (== prevClose pre-open), mirroring
// how entries lock at prevClose then upgrade at 5:30.
export function markPending(item, decision) {
  return {
    ...item,
    status: 'SELL_PENDING',
    exitDecidedAt: new Date().toISOString(),
    exitReason: decision.reason,
    exitSource: decision.source,
    provisionalExitPrice: item.currentPrice ?? item.entryPrice,
  };
}

// PHASE 2: book the real exit for a SELL_PENDING holding. `realExit` is the real
// session price from the refresh fetch. Returns the closed-trade record.
export function bookExit(item, realExit) {
  const entry = item.entryPrice;
  const exit = realExit ?? item.provisionalExitPrice ?? entry;
  const realizedPnl = (exit - entry) * (item.shares || 0);
  const realizedPnlPct = entry ? ((exit - entry) / entry) * 100 : 0;
  return {
    ticker: item.ticker, fullName: item.fullName, sector: item.sector,
    entryPrice: entry, entryDate: item.date,
    exitPrice: +Number(exit).toFixed(2),
    exitDate: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
    shares: item.shares || 0, investedAmount: item.investedAmount || 10000,
    exitReason: item.exitReason, exitSource: item.exitSource,
    realizedPnl: +realizedPnl.toFixed(2),
    realizedPnlPct: +realizedPnlPct.toFixed(2),
  };
}
