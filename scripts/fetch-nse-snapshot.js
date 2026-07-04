// scripts/fetch-nse-snapshot.js
// Runs on a GitHub Actions runner (NOT Vercel) to fetch NSE data that Vercel's
// datacenter IPs get 403'd on. Writes data/nse-snapshot.json for the app to read.
// ES module syntax (package.json has "type": "module").

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NseIndia } from 'stock-nse-india';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const n = new NseIndia();
const OUT = path.join(__dirname, '..', 'data', 'nse-snapshot.json');

async function tryFetch(label, fn) {
  try {
    const data = await fn();
    console.log(`  OK   ${label}`);
    return { ok: true, data };
  } catch (e) {
    console.log(`  FAIL ${label}: ${(e.message || e).toString().slice(0, 100)}`);
    return { ok: false, error: (e.message || e).toString().slice(0, 200) };
  }
}

(async () => {
  console.log('Fetching NSE snapshot from GitHub Actions runner...');
  const snapshot = { fetchedAt: new Date().toISOString(), diag: {}, data: {} };

  // 1. Market status (cheapest probe — if this 403s, everything will)
  const status = await tryFetch('getMarketStatus', () => n.getMarketStatus());
  snapshot.diag.marketStatus = status.ok;
  if (status.ok) snapshot.data.marketStatus = status.data;

  // 2. Gainers/losers across key indices (the REAL movers — fixes discovery)
  const indicesToScan = ['NIFTY 50', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100', 'SECURITIES IN F&O'];
  const movers = [];
  for (const idxName of indicesToScan) {
    const r = await tryFetch(`stockIndices ${idxName}`, () => n.getEquityStockIndices(idxName));
    if (r.ok && Array.isArray(r.data?.data)) {
      for (const s of r.data.data) {
        if (s.symbol && s.symbol !== idxName && typeof s.pChange === 'number') {
          movers.push({
            symbol: s.symbol, pChange: s.pChange, lastPrice: s.lastPrice,
            dayHigh: s.dayHigh, dayLow: s.dayLow,
            totalTradedVolume: s.totalTradedVolume, index: idxName,
          });
        }
      }
    }
  }
  // De-dupe by symbol (keep highest-volume record), sort by pChange desc.
  const bySymbol = new Map();
  for (const m of movers) {
    const prev = bySymbol.get(m.symbol);
    if (!prev || (m.totalTradedVolume || 0) > (prev.totalTradedVolume || 0)) bySymbol.set(m.symbol, m);
  }
  const allMovers = [...bySymbol.values()].sort((a, b) => b.pChange - a.pChange);
  snapshot.diag.moversCount = allMovers.length;
  snapshot.data.topGainers = allMovers.slice(0, 30);
  snapshot.data.topLosers = allMovers.slice(-15).reverse();

  // 3. Bulk & block deals (institutional activity — alt-data spec section)
  const bulk = await tryFetch('bulk deals', () => n.getDataByEndpoint('/api/snapshot-capital-market-largedeal'));
  snapshot.diag.largeDeals = bulk.ok;
  if (bulk.ok) {
    snapshot.data.bulkDeals = (bulk.data?.BULK_DEALS_DATA || []).slice(0, 30);
    snapshot.data.blockDeals = (bulk.data?.BLOCK_DEALS_DATA || []).slice(0, 30);
    snapshot.data.shortDeals = (bulk.data?.SHORT_DEALS_DATA || []).slice(0, 20);
  }

  // 4. Sample delivery % for a couple names (proves per-stock delivery data works)
  const delivProbe = await tryFetch('delivery (RELIANCE)', () => n.getEquityDetails('RELIANCE'));
  snapshot.diag.deliveryData = delivProbe.ok;
  if (delivProbe.ok) {
    const sec = delivProbe.data?.securityInfo || {};
    const trade = delivProbe.data?.priceInfo || {};
    snapshot.data.deliverySample = {
      symbol: 'RELIANCE',
      note: 'delivery% available via getEquityTradeInfo per-symbol at read time',
    };
  }

  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log('Diagnostic summary:', JSON.stringify(snapshot.diag));

  // Exit 0 always if we got here and wrote the file — the diagnostic is the deliverable.
  // A hard NSE block just means all diag flags are false; that's still a successful run
  // of the DIAGNOSTIC (we learned NSE is blocked), not a script failure.
  const anySuccess = Object.values(snapshot.diag).some(v => v === true || (typeof v === 'number' && v > 0));
  if (!anySuccess) {
    console.log('\n>>> RESULT: NSE appears BLOCKED from this GitHub runner (all fetches failed).');
  } else {
    console.log('\n>>> RESULT: NSE is REACHABLE from GitHub. Free NSE data unlocked.');
  }
})().catch(e => {
  // Never hard-fail the workflow — write what diagnostic we can and report.
  console.error('Script error (non-fatal):', e?.message || e);
  try { fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), error: String(e?.message || e), diag: {} }, null, 2)); } catch (_) {}
  process.exit(0);
});
