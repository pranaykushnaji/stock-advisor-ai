import { quoteFreshness } from '../api/_upstox-market-data.js';

// A breadth diagnostic, not a buy screen. No synthetic RVOL, institutional signal or edge.
export function summarizeQuoteCoverage(manifest, quotes, at = new Date()) {
  const rows = manifest.members.filter(m => m.instrumentKey).map(m => {
    const quote = quotes[m.instrumentKey];
    const identity = quote?.instrumentKey === m.instrumentKey && quote?.symbol === m.symbol;
    const fresh = identity ? quoteFreshness(quote, {nowMs: at.getTime()}) : {fresh: false,reason:'missing or mismatched quote'};
    return { ticker:m.symbol,name:m.name,sector:m.sector,marketCapBucket:m.marketCapBucket,
      instrumentKey:m.instrumentKey,received:identity, fresh:fresh.fresh,priceStatus:fresh.reason,
      observedAt:identity?quote.lastTradeAt:null,price:identity?quote.price:null,
      dayChangePct:identity && quote.previousClose>0?(quote.price/quote.previousClose-1)*100:null,
      spreadBps:identity?quote.spreadBps:null,upperCircuit:identity?quote.upperCircuit:null,
      lowerCircuit:identity?quote.lowerCircuit:null,volume:identity?quote.volume:null,
      averagePrice:identity?quote.averagePrice:null,dayHigh:identity?quote.dayHigh:null,
      dayLow:identity?quote.dayLow:null,relativeVolume:null,eligibleToTrade:false };
  });
  return {version:'quote-coverage-v1',asOf:at.toISOString(),mode:'read-only-diagnostic',productionEnabled:false,
    registryAsOf:manifest.fetchedAt,summary:{requested:rows.length,received:rows.filter(r=>r.received).length,
      fresh:rows.filter(r=>r.fresh).length,mid:rows.filter(r=>r.marketCapBucket==='mid').length,
      small:rows.filter(r=>r.marketCapBucket==='small').length},rows,
    limitations:['Quotes alone do not establish liquidity history, relative volume, setup confirmation or expected return.',
      'After-hours quotes are stale for entry purposes. This diagnostic never opens a position.']};
}
