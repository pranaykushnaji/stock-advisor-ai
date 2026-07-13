// api/_sell-engine.js
// AI-based sell logic, two-phase to mirror the entry design:
//   decideSell()   -> 9 AM cron  : rules gate -> LLM -> mark SELL_PENDING (provisional exit)
//   finalizeSell() -> 5:30 PM cron: book real exit price -> realized ledger -> drop from bouquet
//
// Field names match the REAL bouquet shape: fullName, yahooSymbol, ticker,
// entryPrice, currentPrice, date, composite, sector.

import { ema } from './_indicators.js';
import { rewardRisk, computeShortReturns } from './_scoring.js';

// Tunable thresholds. currentPrice on each holding is already kept fresh by the
// refresh cron, so the rules gate reads it directly (no extra fetch needed here).
// Tightened for swing-trade (momentum) horizon: quicker profit-taking, tighter stop,
// short max-hold. The whole point of the shorter horizon is faster exits — this is
// the risk control that makes momentum-trading survivable.
export const SELL_RULES = {
  // V2.1: MAX_HOLD_DAYS is now the REVIEW date, not an automatic exit. On reaching it, the
  // position must pass a health review at every subsequent sell-check (thesis intact, trend
  // healthy, above 20-EMA, reward/risk still there) — pass and it keeps compounding, fail and
  // it exits. Exceptional winners are no longer sold purely because a clock ran out.
  MAX_HOLD_DAYS: 10,   // review date for catalyst-lane positions

  // Data-sanity guard: a move this large on a position only a day (or less) old is almost
  // always a bad price (wrong symbol / stale fallback source), NOT a real target/stop.
  // We refuse to auto-book an exit on it so we never realize phantom P&L. (See PHOENIXLTD
  // 2026-07-07: entry ₹1549 vs real ₹2018 → a fake +33% "target hit".)
  SANITY_MAX_MOVE_PCT: 25, SANITY_MAX_MOVE_DAYS: 1,

  // VOLATILITY-ADAPTIVE EXITS (replaces the old fixed +8% target / -5% stop). The backtest
  // showed a flat -5% stop got whipsawed constantly on midcaps while the +8% target capped
  // the few big winners momentum lives on. So: the stop distance scales to each stock's own
  // daily volatility (a calm large-cap gets a tight-ish band, a wild midcap a wider one), and
  // a TRAILING stop lets winners run instead of selling at a fixed target. "Balanced but
  // accepts swings": moderate multipliers, floored/capped so bands stay sane.
  STOP_VOL_MULT: 2.5, STOP_MIN_PCT: 4, STOP_MAX_PCT: 12,   // initial stop = clamp(2.5×dailyVol%)
  TRAIL_VOL_MULT: 2.2, TRAIL_MIN_PCT: 4, TRAIL_MAX_PCT: 11, // trail band once in profit
  // V2.1: HARD_TARGET_PCT is no longer a live exit rule (fixed profit targets cut compounding
  // winners; the trailing stop is the profit protection). Kept exported for the backtest's
  // legacy A/B simulation only.
  HARD_TARGET_PCT: 25,
  DEFAULT_DAILY_VOL_PCT: 2.2,   // used when we can't measure vol from a price series
};

// Lane-specific exit overrides. Momentum-lane entries (bought WITHOUT a verified catalyst —
// see MOMENTUM_LANE in stock-of-the-day.js) run on tighter risk: narrower stop/trail bands and
// a shorter max hold, because a move with no news behind it decays faster and deserves less
// rope. Positions carry entryLane on the bouquet row; absent/unknown lanes get the defaults.
export const LANE_EXITS = {
  momentum: {
    MAX_HOLD_DAYS: 7,
    STOP_VOL_MULT: 2.0, STOP_MIN_PCT: 3.5, STOP_MAX_PCT: 9,
    TRAIL_VOL_MULT: 1.8, TRAIL_MIN_PCT: 3.5, TRAIL_MAX_PCT: 8,
  },
};
function laneRules(lane) { return { ...SELL_RULES, ...(LANE_EXITS[lane] || {}) }; }

// True when a P&L% is too large to be believable for how long we've held — i.e. it looks
// like a data glitch, not a real market move. Shared by the rules gate and the LLM path.
export function isSuspiciousMove(pnlPct, heldDays) {
  return heldDays <= SELL_RULES.SANITY_MAX_MOVE_DAYS
    && Math.abs(pnlPct) >= SELL_RULES.SANITY_MAX_MOVE_PCT;
}

function daysHeld(dateStr) {
  if (!dateStr) return 0;
  const from = new Date(dateStr + 'T00:00:00Z');
  return Math.floor((Date.now() - from.getTime()) / 86400000);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Daily realized volatility (%) from a close series — drives the adaptive stop/trail widths.
export function dailyVolPct(closes) {
  if (!Array.isArray(closes) || closes.length < 15) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100;
}

// The volatility-adaptive stop/trail band widths (%) for a stock, given its recent closes.
// `lane` (optional) selects the LANE_EXITS overrides — momentum-lane positions get tighter bands.
export function exitBands(recentCloses, lane = null) {
  const R = laneRules(lane);
  const dv = dailyVolPct(recentCloses) ?? R.DEFAULT_DAILY_VOL_PCT;
  return {
    stopPct: clamp(R.STOP_VOL_MULT * dv, R.STOP_MIN_PCT, R.STOP_MAX_PCT),
    trailPct: clamp(R.TRAIL_VOL_MULT * dv, R.TRAIL_MIN_PCT, R.TRAIL_MAX_PCT),
  };
}

// Deterministic gate. Returns a forced SELL decision, or null to defer to the LLM.
// `recentCloses` (optional) enables vol-adaptive stops, a trailing exit, and momentum-fade.
// Trailing uses item.peakPrice (highest price seen since entry, kept fresh by the refresh /
// sell-check crons); if it's missing we fall back to the current price.
export function rulesGate(item, recentCloses = null) {
  const entry = item.entryPrice, cur = item.currentPrice;
  if (!entry || !cur) return null;
  const pnlPct = ((cur - entry) / entry) * 100;
  const held = daysHeld(item.date);
  // Never auto-sell on an implausibly large move for a brand-new position — treat it as a
  // bad price and defer (return null) instead of booking a phantom exit.
  if (isSuspiciousMove(pnlPct, held)) return null;

  const R = laneRules(item.entryLane);
  const bands = exitBands(recentCloses, item.entryLane);
  const stopPct = bands.stopPct; // STOP IS ABSOLUTE — the thesis engine may never widen it
  let trailPct = bands.trailPct;
  let maxHold = R.MAX_HOLD_DAYS;
  const laneTag = item.entryLane === 'momentum' ? ' [mom-lane]' : '';

  // V2 THESIS-AWARE EXITS: a position whose thesis has STRENGTHENED since entry (follow-on
  // orders, results beat, more filings — maintained by sell-check) earns more rope: a wider
  // trail band (winners with reinforcing news shouldn't be shaken out by normal noise) and a
  // longer max hold. A WEAKENED thesis tightens the trail. The initial stop-loss is never
  // touched in either direction — capital protection is not negotiable.
  const ts = item.thesisScore;
  if (ts != null && isFinite(ts)) {
    if (ts >= 70) { trailPct = Math.min(trailPct * 1.15, bands.trailPct + 2); maxHold += (item.entryLane === 'momentum' ? 2 : 3); }
    else if (ts < 40) { trailPct = Math.max(trailPct * 0.85, 2.5); }
  }

  // 1. Initial volatility stop, measured from entry. ABSOLUTE — no thesis adjustment.
  //    (V2.1: the old fixed +25% "failsafe target" was removed — a fixed profit level is just a
  //    cap on compounding; the trailing stop below is the profit protection.)
  if (pnlPct <= -stopPct) return { verdict: 'SELL', source: 'rule', reason: `vol-stop (${pnlPct.toFixed(1)}%, ${stopPct.toFixed(1)}% band)${laneTag}` };
  // 2. Trailing stop — once the peak is up more than a trail band, protect gains from the peak.
  const peak = Math.max(item.peakPrice ?? entry, cur);
  if ((peak - entry) / entry * 100 >= trailPct) {
    const dropFromPeak = (peak - cur) / peak * 100;
    if (dropFromPeak >= trailPct) return { verdict: 'SELL', source: 'rule', reason: `trailing stop (-${dropFromPeak.toFixed(1)}% from peak, +${pnlPct.toFixed(1)}% locked)${laneTag}` };
  }
  // 3. REVIEW DATE (V2.1, replaces the automatic max-hold exit): once a position reaches its
  //    review age (10d catalyst / 7d momentum, +3/+2 when the thesis strengthened), it must
  //    RE-EARN its slot at every check — "would this still be worth holding as a fresh
  //    decision today?" Health checks (all deterministic, from data already in hand):
  //      • thesis intact         (thesisScore >= 45; damaged theses don't get patience)
  //      • trend healthy         (1-week return > -2%)
  //      • structure holding     (price above its 20-EMA, when computable)
  //      • reward/risk remains   (forward RR from current prices >= 1.2)
  //    Pass all → keep holding and compounding. Fail any → exit with the specific reason.
  //    A stagnant sideways position fails the RR check; a runner passes everything.
  if (held >= maxHold) {
    if (!Array.isArray(recentCloses) || recentCloses.length < 10) {
      // No usable price series to review with — give a small grace window, then exit rather
      // than holding an unreviewable position forever.
      if (held >= maxHold + 5) return { verdict: 'SELL', source: 'rule', reason: `review overdue ${held}d, no price data${laneTag}` };
    } else {
      const failed = [];
      if ((ts ?? 50) < 45) failed.push(`thesis ${ts ?? 50}<45`);
      const last = recentCloses[recentCloses.length - 1];
      const wkAgoP = recentCloses.length >= 6 ? recentCloses[recentCloses.length - 6] : null;
      if (wkAgoP > 0 && ((last - wkAgoP) / wkAgoP * 100) <= -2) failed.push('1wk trend weak');
      const e20 = recentCloses.length >= 20 ? ema(recentCloses, 20) : null;
      if (e20 != null && cur < e20) failed.push('below 20-EMA');
      const rr = rewardRisk(recentCloses, computeShortReturns(recentCloses), null);
      if ((rr?.rr ?? 0) < 1.2) failed.push(`RR ${rr?.rr ?? 'n/a'}<1.2`);
      if (failed.length) return { verdict: 'SELL', source: 'rule', reason: `review day ${held}: ${failed.join(', ')}${laneTag}` };
      // Healthy — hold on. It will be re-reviewed at the next sell-check.
    }
  }
  // 5. Momentum-fade: the short-term trend that justified the buy has reversed.
  if (Array.isArray(recentCloses) && recentCloses.length >= 6) {
    const last = recentCloses[recentCloses.length - 1];
    const wkAgo = recentCloses[recentCloses.length - 6];
    if (wkAgo > 0) {
      const wkTrend = (last - wkAgo) / wkAgo * 100;
      if (held >= 2 && wkTrend <= -3) return { verdict: 'SELL', source: 'rule', reason: `momentum faded (1wk ${wkTrend.toFixed(1)}%)` };
    }
  }
  return null;
}

// LLM confirmation for the ambiguous middle. Uses the same Groq model/endpoint
// as the pick cron. `headlines` is optional (pass [] if news lookup is skipped).
// `marketContext` (optional) = the morning Claude market analysis — advisory background so the
// risk manager judges the position against the day's actual tape, not in a vacuum.
export async function llmDecide(item, apiKey, headlines = [], marketContext = null) {
  const entry = item.entryPrice, cur = item.currentPrice;
  const pnlPct = entry && cur ? (((cur - entry) / entry) * 100).toFixed(1) : 'n/a';
  const held = daysHeld(item.date);
  const sys = `You are a disciplined equity risk manager for NSE stocks. Decide HOLD or SELL for an OPEN position based on current sentiment and price action. Sell when the original bullish thesis no longer has clear support. Respond ONLY with strict JSON, no markdown: {"verdict":"HOLD"|"SELL","reason":"<max 15 words>"}`;
  const payload = {
    ticker: item.ticker, fullName: item.fullName, sector: item.sector,
    entryPrice: entry, currentPrice: cur, unrealizedPnlPct: Number(pnlPct),
    daysHeld: held, compositeAtEntry: item.composite,
    positionThesis: item.currentThesis?.summary || item.originalThesis?.summary || null,
    recentHeadlines: (headlines || []).slice(0, 8),
    morningMarketContext: marketContext ? { tone: marketContext.tone, summary: marketContext.summary, sectorsInFocus: marketContext.sectorsInFocus } : null,
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
// `recentCloses` optional — enables the momentum-fade exit for swing trades.
export async function decideSell(item, apiKey, headlines = [], recentCloses = null) {
  if (item.status && item.status !== 'OPEN') return null; // already pending/closed
  const forced = rulesGate(item, recentCloses);
  if (forced) return forced; // rulesGate only ever returns a SELL decision or null
  // Data-sanity: don't even ask the LLM on an implausibly large move for a fresh position —
  // it's almost certainly a bad entry price, and we must not auto-book a phantom exit.
  if (item.entryPrice && item.currentPrice) {
    const pnlPct = ((item.currentPrice - item.entryPrice) / item.entryPrice) * 100;
    if (isSuspiciousMove(pnlPct, daysHeld(item.date))) return null;
  }
  const decision = await llmDecide(item, apiKey, headlines);
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
    entryLane: item.entryLane || 'catalyst', // lane-level P&L lets analytics judge the momentum lane
    // v2 learning payload: what the engine believed at entry/exit, for calibration analytics.
    expectedEdge: item.expectedEdge ?? null,
    confidenceComponents: item.confidenceComponents ?? null,
    effectiveConfidence: item.effectiveConfidence ?? null, // similarity dimension for calibration
    thesisScore: item.thesisScore ?? null,
    thesisType: item.currentThesis?.type || item.originalThesis?.type || null,
    regime: item.regime ?? null,
    entryPrice: entry, entryDate: item.date,
    exitPrice: +Number(exit).toFixed(2),
    exitDate: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
    shares: item.shares || 0, investedAmount: item.investedAmount || 10000,
    exitReason: item.exitReason, exitSource: item.exitSource,
    realizedPnl: +realizedPnl.toFixed(2),
    realizedPnlPct: +realizedPnlPct.toFixed(2),
  };
}
