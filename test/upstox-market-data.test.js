import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mapNseSymbols, fetchLtp, fetchFullQuotes, fetchOneMinuteCandles, quoteFreshness,
  _resetInstrumentCacheForTests } from '../api/_upstox-market-data.js';

const key = 'NSE_EQ|INE745G01043';
const record = { trading_symbol: 'MCX', segment: 'NSE_EQ', instrument_type: 'EQ', isin: 'INE745G01043', instrument_key: key };
const at = Date.parse('2026-11-03T05:30:00Z');
const quote = { price: 100, lastTradeAt: new Date(at - 1000).toISOString(), responseAt: new Date(at).toISOString() };

test('official instrument mapping excludes derivatives, wrong ISINs and ambiguous cash equities', async () => {
  const d = await mapNseSymbols(['mcx.NS', 'ABC', 'MISSING'], { instruments: [record,
    { ...record, trading_symbol: 'ABC', instrument_key: 'NSE_EQ|INE000A01018', isin: 'INE000A01018' },
    { ...record, trading_symbol: 'ABC', instrument_key: 'NSE_EQ|INE001A01018', isin: 'INE001A01018' },
    { ...record, trading_symbol: 'MISSING', segment: 'NSE_FO' },
    { ...record, trading_symbol: 'MISSING', isin: 'WRONG' },
  ] });
  assert.deepEqual(d, { mapped: { MCX: key }, unresolved: ['MISSING'], ambiguous: ['ABC'] });
});

test('raw gzip master downloads work and warm calls reuse the cache', async () => {
  _resetInstrumentCacheForTests(); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(gzipSync(JSON.stringify([record]))); };
  assert.equal((await mapNseSymbols(['MCX'], { fetchImpl, nowMs: at })).mapped.MCX, key);
  await mapNseSymbols(['MCX'], { fetchImpl, nowMs: at + 60000 });
  assert.equal(calls, 1); _resetInstrumentCacheForTests();
});

test('full quote joins by instrument token and preserves exchange timestamps', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/v3\/market-quote\/quotes\?/);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.ok(!options.method || options.method === 'GET');
    return Response.json({ status: 'success', data: {
      'NSE_EQ:MCX': { instrument_token: key, symbol: 'MCX', last_price: 100, last_trade_time: String(at - 1000), timestamp: new Date(at).toISOString() },
      'unrequested': { instrument_token: 'NSE_EQ|INE001A01018', last_price: 999 },
    } });
  };
  const q = await fetchFullQuotes([key], { token: 'test-token', fetchImpl });
  assert.deepEqual(Object.keys(q), [key]); assert.equal(q[key].lastTradeAt, quote.lastTradeAt);
  assert.equal(quoteFreshness(q[key], { nowMs: at }).fresh, true);
});

test('quote freshness requires last trade time; a new HTTP response cannot revive an old trade', () => {
  assert.equal(quoteFreshness({ ...quote, lastTradeAt: new Date(at - 120000).toISOString() }, { nowMs: at }).fresh, false);
  assert.equal(quoteFreshness({ price: 100, responseAt: quote.responseAt }, { nowMs: at }).fresh, false);
  assert.equal(quoteFreshness({ ...quote, lastTradeAt: new Date(at + 60000).toISOString() }, { nowMs: at }).fresh, false);
  assert.equal(quoteFreshness({ ...quote, responseAt: new Date(at - 120000).toISOString() }, { nowMs: at }).fresh, false);
});

test('adapter rejects malformed keys/dates and sanitizes provider errors', async () => {
  await assert.rejects(fetchLtp(['MCX']), /instrument keys/);
  await assert.rejects(fetchOneMinuteCandles(key, '2026-02-30', '2026-03-01'), /calendar date/);
  await assert.rejects(fetchOneMinuteCandles(key, '2026-11-03', '2026-11-02'), /must not exceed/);
  await assert.rejects(fetchFullQuotes([key], { token: 'test', fetchImpl: async () => new Response('SECRET VENDOR BODY', { status: 401 }) }), /^Error: Upstox market data HTTP 401$/);
});

test('one-minute history uses the documented V3 route and only GET', async () => {
  const data = await fetchOneMinuteCandles(key, '2026-11-02', '2026-11-03', { token: 'test', fetchImpl: async (url, opts) => {
    assert.match(url, /\/v3\/historical-candle\/NSE_EQ%7CINE745G01043\/minutes\/1\/2026-11-03\/2026-11-02$/);
    assert.equal(opts.method, undefined); return Response.json({ status: 'success', data: { candles: [['2026-11-02T09:15:00+05:30', 100, 102, 99, 101, 500, 0]] } });
  } }); assert.equal(data.length, 1);
});
