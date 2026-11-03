import { requireCronAuth } from './_cron-auth.js';
import { mapNseSymbols, fetchFullQuotes, quoteFreshness } from './_upstox-market-data.js';
import { evaluateMonitor, monitorSession } from './_minute-monitor.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';
async function readHoldings() {
  if (!process.env.GITHUB_TOKEN) throw new Error('holdings-access-not-configured');
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/data/project-bouquet.json?ref=main`, {
    method: 'GET', headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('holdings-read-failed');
  const body = await r.json();
  const parsed = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
  if (!Array.isArray(parsed.bouquet)) throw new Error('invalid-holdings');
  return parsed.bouquet.filter(p => !p.status || p.status === 'OPEN');
}

export function createMonitorHandler({ read = readHoldings, map = mapNseSymbols, quotes = fetchFullQuotes,
  now = () => new Date(), env = process.env } = {}) {
  return async function handler(req, res) {
    res.setHeader?.('Cache-Control', 'no-store');
    if (!requireCronAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    if (env.UPSTOX_MONITOR_ENABLED !== 'true') return res.status(200).json({ status: 'disabled', mode: 'read-only-shadow' });
    if (!env.UPSTOX_ACCESS_TOKEN) return res.status(503).json({ status: 'not_configured', reason: 'UPSTOX_ACCESS_TOKEN missing' });
    let body = req.body || {};
    try { if (typeof body === 'string') body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 128000) {
      return res.status(400).json({ error: 'invalid monitor payload' });
    }
    const at = now();
    try {
      // Explicit authenticated connection test works after hours and does no risk evaluation.
      if (body.mode === 'connection-test') {
        const symbols = body.symbols;
        if (!Array.isArray(symbols) || !symbols.length || symbols.length > 3 || symbols.some(s => !/^[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(s))) {
          return res.status(400).json({ error: 'connection test requires 1-3 NSE symbols' });
        }
        const m = await map(symbols), q = await quotes(Object.values(m.mapped));
        const missing = Object.values(m.mapped).filter(k => !q[k]);
        return res.status(missing.length || m.unresolved.length || m.ambiguous.length ? 502 : 200).json({
          status: 'connection_test', mode: 'read-only-shadow', mapping: m, missing,
          quotes: Object.values(q).map(x => ({ ...x, freshness: quoteFreshness(x, { nowMs: at.getTime() }) })),
        });
      }
      const session = monitorSession(at);
      if (!session.open) return res.status(200).json({ status: 'skipped', reason: session.reason, mode: 'read-only-shadow' });
      if (body.slot && (!Number.isFinite(Date.parse(body.slot)) || Math.abs(at.getTime() - Date.parse(body.slot)) > 90000)) {
        return res.status(409).json({ status: 'expired_slot' });
      }
      const positions = await read();
      if (positions.length > 50 || positions.some(p => !/^[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(p.ticker || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || ''))) {
        return res.status(502).json({ status: 'invalid_holdings' });
      }
      if (!positions.length) return res.status(200).json({ status: 'no_open_positions', mode: 'read-only-shadow', nextState: { version: 1, positions: {} }, positions: [], signals: [] });
      const mapped = await map(positions.map(p => p.ticker));
      const live = await quotes(Object.values(mapped.mapped));
      const result = evaluateMonitor(positions, live, mapped.mapped, body.previousState, { now: at });
      return res.status(result.status === 'monitor_incomplete' ? 502 : 200).json({ ...result, mapping: { unresolved: mapped.unresolved, ambiguous: mapped.ambiguous } });
    } catch {
      // Provider errors can contain credentials/headers. Only report a stable safe error.
      return res.status(502).json({ status: 'market_data_unavailable', mode: 'read-only-shadow', reason: 'check Upstox authorization, endpoint entitlement, instrument master and provider availability' });
    }
  };
}

export default createMonitorHandler();
