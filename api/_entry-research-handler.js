import { requireCronAuth } from './_cron-auth.js';
import { mapNseSymbols, fetchFullQuotes, fetchIntradayOneMinuteCandles, quoteFreshness } from './_upstox-market-data.js';
import { monitorSession } from './_minute-monitor.js';
import { liveResearchEntry } from './_entry-research.js';
import { nowIST } from './_market-calendar.js';
import registry from '../research/universe.json' with { type: 'json' };
import { quoteBatches } from '../research/coverage.js';
import { summarizeQuoteCoverage } from '../research/quote-coverage.js';

async function readContext() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GitHub read access missing');
  const read = async name => {
    const r = await fetch(`https://api.github.com/repos/pranaykushnaji/stock-advisor-ai/contents/data/${name}.json?ref=main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('context unavailable');
    return JSON.parse(Buffer.from((await r.json()).content, 'base64').toString('utf8'));
  };
  const [store, pick, bouquet] = await Promise.all(['intraday-candidates', 'daily-pick', 'project-bouquet'].map(read));
  return { store, pick: pick.pick, held: bouquet.bouquet };
}

export function createEntryResearchHandler({ read = readContext, map = mapNseSymbols, quotes = fetchFullQuotes,
  candles = fetchIntradayOneMinuteCandles, now = () => new Date(), env = process.env } = {}) {
  return async (req, res) => {
    res.setHeader?.('Cache-Control', 'no-store');
    if (!requireCronAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    if (env.ENTRY_SETUP_RESEARCH_ENABLED !== 'true') return res.status(200).json({ status: 'disabled' });
    if (!env.UPSTOX_ACCESS_TOKEN) return res.status(503).json({ status: 'not_configured' });
    const at = now(), date = nowIST(at).ymd;
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
    catch { return res.status(400).json({ error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || JSON.stringify(body).length > 128000) return res.status(400).json({ error: 'invalid payload' });
    if (body.mode === 'coverage') {
      if (env.RESEARCH_COVERAGE_ENABLED !== 'true') return res.status(200).json({status:'disabled'});
      try {
        // An explicit authenticated diagnostic, never called by the normal scheduler.
        // Current registry is versioned; session membership and quote identity remain explicit.
        const allQuotes = {};
        for (const batch of quoteBatches(registry.members)) Object.assign(allQuotes, await quotes(batch));
        return res.status(200).json({status:'coverage_observed',...summarizeQuoteCoverage(registry,allQuotes,at)});
      } catch { return res.status(502).json({status:'coverage_unavailable'}); }
    }
    if (!monitorSession(at).open) return res.status(200).json({ status: 'skipped' });
    if (body.slot && (!Number.isFinite(Date.parse(body.slot)) || Math.abs(at - Date.parse(body.slot)) > 90000)) return res.status(409).json({ status: 'expired_slot' });
    try {
      const context = await read();
      if (context.store?.date !== date || context.pick?.date !== date || !Array.isArray(context.held)) return res.status(502).json({ status: 'stale_research_context' });
      const held = new Set(context.held.filter(p => !p.status || ['OPEN', 'SELL_PENDING'].includes(p.status)).map(p => p.ticker));
      const watch = Object.values(context.store.candidates || {}).filter(p => /^[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(p.ticker || '') && !held.has(p.ticker))
        .sort((a, b) => (b.scans?.at(-1)?.discoveryScore || 0) - (a.scans?.at(-1)?.discoveryScore || 0)).slice(0, 5);
      const mappings = await map(watch.map(p => p.ticker)), live = await quotes(Object.values(mappings.mapped));
      const state = { version: 1, positions: {} }, positions = [], signals = [];
      await Promise.all(watch.map(async candidate => {
        const id = `${date}|${candidate.ticker}`, key = mappings.mapped[candidate.ticker];
        const previous = body.previousState?.version === 1 ? body.previousState.positions?.[id] : null;
        if (previous) state.positions[id] = previous;
        if (previous?.signal) { positions.push({ ticker: candidate.ticker, status: 'signal_latched' }); return; }
        const quote = live[key], fresh = quoteFreshness(quote, { nowMs: at.getTime() });
        if (!key || !fresh.fresh || quote.symbol !== candidate.ticker) { positions.push({ ticker: candidate.ticker, status: 'unusable_price' }); return; }
        try {
          const result = liveResearchEntry(await candles(key), quote, { now: at, regime: context.pick.regime, firstSeenAt: candidate.scans?.[0]?.ts });
          const signal = result.status === 'setup' ? { id: `${id}|consolidation-v1`, ticker: candidate.ticker,
            ...result, instrumentKey: key, mode: 'entry-research-only', productionGatesPassed: false } : null;
          state.positions[id] = { lastTradeAt: quote.lastTradeAt, signal };
          positions.push({ ticker: candidate.ticker, ...result }); if (signal) signals.push(signal);
        } catch { positions.push({ ticker: candidate.ticker, status: 'candles_unavailable' }); }
      }));
      // Keep latched signals for the whole session even if ranking temporarily drops a name.
      for (const [id, value] of Object.entries(body.previousState?.positions || {})) {
        if (id.startsWith(date + '|') && value.signal && !state.positions[id]) state.positions[id] = value;
      }
      const incomplete = positions.some(p => ['unusable_price', 'candles_unavailable'].includes(p.status));
      return res.status(incomplete ? 502 : 200).json({ status: incomplete ? 'research_incomplete' : 'researched',
        mode: 'read-only-shadow', paperTrading: true, positions, signals, nextState: state,
        note: 'experimental signals are recorded separately; no position opened and no production gate bypassed' });
    } catch { return res.status(502).json({ status: 'research_unavailable' }); }
  };
}

export default createEntryResearchHandler();
