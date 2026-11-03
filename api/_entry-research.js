// Experimental, pure research setup. No production caller places a trade from this result.
// Uses completed 5-minute candles, a bounded consolidation breakout above session VWAP, and
// next-candle opening execution. Daily +7% is never treated as a captured return.
export const RESEARCH_SETUP = Object.freeze({ version: 'consolidation-v1', bars: 6,
  maxRangePct: 2, minVolumeRatio: 1.5, maxAboveVwapPct: 2, maxEntryGapPct: 0.75 });

export function completedFiveMinuteBars(candles, now = new Date()) {
  const today = new Date(now.getTime() + 19800000).toISOString().slice(0, 10), buckets = new Map();
  for (const row of candles) {
    const ms = Date.parse(row?.[0]);
    if (!Number.isFinite(ms) || ms + 60000 > now.getTime() || new Date(ms + 19800000).toISOString().slice(0, 10) !== today
      || row.slice(1, 5).length !== 4 || !row.slice(1, 5).every(x => Number.isFinite(x) && x > 0)
      || !Number.isFinite(row[5]) || row[5] < 0) continue;
    const min = new Date(ms + 19800000).getUTCHours() * 60 + new Date(ms + 19800000).getUTCMinutes();
    if (min < 555 || min >= 930 || ms % 60000 !== 0) continue;
    const bucket = Math.floor(ms / 300000) * 300000;
    if (!buckets.has(bucket)) buckets.set(bucket, new Map());
    buckets.get(bucket).set(ms, row);
  }
  return [...buckets].sort((a, b) => a[0] - b[0]).flatMap(([ms, rows]) => {
    const ordered = [...rows].sort((a, b) => a[0] - b[0]);
    if (ordered.length !== 5 || ordered.some(([t], i) => t !== ms + i * 60000)) return [];
    const r = ordered.map(([, row]) => row);
    return [{ ms, open: r[0][1], high: Math.max(...r.map(x => x[2])), low: Math.min(...r.map(x => x[3])),
      close: r.at(-1)[4], volume: r.reduce((s, x) => s + x[5], 0) }];
  });
}

export function liveResearchEntry(candles, quote, { now = new Date(), regime, firstSeenAt } = {}) {
  const bars = completedFiveMinuteBars(candles, now), boundary = Math.floor(now.getTime() / 300000) * 300000;
  if (now.getTime() - boundary > 90000 || !bars.length || bars.at(-1).ms + 300000 !== boundary) {
    return { status: 'unavailable', reason: 'latest completed five-minute candle is unavailable or too old' };
  }
  // The next candle has only just started. Use the current timestamped quote as a proposed
  // shadow price; never borrow the eventual opening price from a future historical candle.
  const current = { ms: boundary, open: quote.price, high: quote.price, low: quote.price, close: quote.price, volume: 0 };
  const result = findResearchEntry([...bars, current], { regime,
    notBefore: new Date(Math.max(Date.parse(firstSeenAt) || 0, boundary)).toISOString() });
  return result.status === 'setup' ? { ...result, entryAt: quote.lastTradeAt, execution: 'shadow-quote-only' } : result;
}

export function findResearchEntry(bars, { notBefore, regime, params = RESEARCH_SETUP } = {}) {
  if (!['bullish', 'neutral'].includes(regime)) return { status: 'blocked', reason: `regime ${regime}` };
  const threshold = Date.parse(notBefore);
  if (!Number.isFinite(threshold)) return { status: 'unavailable', reason: 'missing signal timestamp' };
  let pv = 0, volume = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i];
    pv += ((b.high + b.low + b.close) / 3) * b.volume; volume += b.volume;
    if (i < params.bars || b.ms + 300000 < threshold || volume <= 0) continue;
    const prior = bars.slice(i - params.bars, i);
    if (prior.some((r, j) => j > 0 && r.ms - prior[j - 1].ms !== 300000)
      || b.ms - prior.at(-1).ms !== 300000 || bars[i + 1].ms - b.ms !== 300000) continue;
    const hi = Math.max(...prior.map(r => r.high)), lo = Math.min(...prior.map(r => r.low));
    const avgVol = prior.reduce((s, r) => s + r.volume, 0) / prior.length;
    const vwap = pv / volume;
    if (!(lo > 0 && avgVol > 0) || (hi / lo - 1) * 100 > params.maxRangePct
      || b.close <= hi || b.volume / avgVol < params.minVolumeRatio
      || b.close < vwap || (b.close / vwap - 1) * 100 > params.maxAboveVwapPct) continue;
    const next = bars[i + 1];
    // Gap handling is checked at the proposed fill time, not at the prior signal candle.
    if (next.open < hi || (next.open / b.close - 1) * 100 > params.maxEntryGapPct) continue;
    return { status: 'setup', signalAt: new Date(b.ms + 300000).toISOString(),
      entryAt: new Date(next.ms).toISOString(), entryPrice: next.open, entryIndex: i + 1,
      breakoutLevel: hi, supportLevel: lo, vwap, volumeRatio: b.volume / avgVol,
      setupVersion: params.version };
  }
  return { status: 'no_setup', reason: 'no confirmed consolidation breakout with bounded extension and volume' };
}

export function replayResearchExit(bars, entry, { stopPct, trailPct, activationPct = trailPct, frictionBps = 30 } = {}) {
  if (entry.status !== 'setup' || !(stopPct > 0) || !(trailPct > 0)) return null;
  const price = entry.entryPrice, initialStop = price * (1 - stopPct / 100);
  let peak = price, trailing = 0;
  const finish = (b, fill, reason) => ({ exitAt: new Date(b.ms + 300000).toISOString(),
    fillPrice: fill, reason, grossReturnPct: (fill / price - 1) * 100,
    netReturnPct: (fill / price - 1) * 100 - frictionBps / 100,
    frictionBps, model: 'assumed-open-low-high-close-5m' });
  for (const b of bars.slice(entry.entryIndex)) {
    let floor = Math.max(initialStop, trailing);
    if (b.open <= floor) return finish(b, b.open, 'gap through stop');
    if (b.low <= floor) return finish(b, floor, 'initial or prior trailing stop');
    peak = Math.max(peak, b.high);
    if ((peak / price - 1) * 100 >= activationPct) trailing = Math.max(trailing, peak * (1 - trailPct / 100));
    floor = Math.max(initialStop, trailing);
    if (b.close <= floor) return finish(b, floor, 'trail after observed high (assumed path)');
  }
  return bars.length ? finish(bars.at(-1), bars.at(-1).close, 'same-session research horizon') : null;
}
