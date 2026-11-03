// Read-only Upstox market-data adapter. Never logs credentials or calls order APIs.
const API_BASE = 'https://api.upstox.com';
export const NSE_INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const INSTRUMENT_CACHE_MS = 6 * 60 * 60 * 1000;
let instrumentCache = null;

function accessToken(explicit) {
  const value = explicit || process.env.UPSTOX_ACCESS_TOKEN;
  if (!value) throw new Error('UPSTOX_ACCESS_TOKEN is not configured');
  return value;
}

async function apiRequest(path, { fetchImpl = fetch, token } = {}) {
  const response = await fetchImpl(API_BASE + path, {
    headers: { Authorization: `Bearer ${accessToken(token)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Upstox market data HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'success' || !body.data) throw new Error('Invalid Upstox market-data response');
  return body.data;
}

function cleanSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
}

function validInstrumentKey(value) {
  return typeof value === 'string' && /^NSE_(EQ|INDEX)\|[^|]+$/.test(value);
}

async function loadNseInstruments({ fetchImpl = fetch, nowMs = Date.now(), instruments } = {}) {
  if (Array.isArray(instruments)) return instruments;
  if (instrumentCache && nowMs - instrumentCache.loadedAt < INSTRUMENT_CACHE_MS) return instrumentCache.rows;
  const response = await fetchImpl(NSE_INSTRUMENTS_URL, {
    headers: { Accept: 'application/json, application/gzip' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Upstox instrument master HTTP ${response.status}`);
  // The .gz asset may be a raw gzip file without Content-Encoding. Detect both cases.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = compressed
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('Invalid Upstox NSE instrument master');
  instrumentCache = { loadedAt: nowMs, rows };
  return rows;
}

// Resolve exact NSE cash-equity symbols using the official daily BOD JSON; never guess by
// company name, exchange token, or a similar ticker. Non-EQ series fail closed.
export async function mapNseSymbols(symbols, options = {}) {
  const wanted = [...new Set((symbols || []).map(cleanSymbol).filter(Boolean))];
  if (!wanted.length) return { mapped: {}, unresolved: [], ambiguous: [] };
  if (wanted.length > 500) throw new Error('Expected at most 500 NSE symbols');
  const rows = await loadNseInstruments(options);
  const candidates = new Map(wanted.map(s => [s, []]));
  for (const row of rows) {
    const symbol = cleanSymbol(row.trading_symbol);
    if (!candidates.has(symbol) || row.segment !== 'NSE_EQ' || row.instrument_type !== 'EQ'
      || !/^NSE_EQ\|IN[A-Z0-9]{10}$/.test(row.instrument_key) || row.instrument_key !== `NSE_EQ|${row.isin}`) continue;
    candidates.get(symbol).push(row);
  }
  const mapped = {}, unresolved = [], ambiguous = [];
  for (const symbol of wanted) {
    const rowsForSymbol = candidates.get(symbol) || [];
    const keys = [...new Set(rowsForSymbol.map(r => r.instrument_key))];
    if (keys.length === 1) mapped[symbol] = keys[0];
    else if (!keys.length) unresolved.push(symbol);
    else ambiguous.push(symbol);
  }
  return { mapped, unresolved, ambiguous };
}

function validateKeys(instrumentKeys, limit) {
  if (!Array.isArray(instrumentKeys) || instrumentKeys.length === 0) return [];
  const keys = [...new Set(instrumentKeys)];
  if (keys.length > limit || keys.some(k => !validInstrumentKey(k))) {
    throw new Error(`Expected 1-${limit} valid Upstox NSE instrument keys`);
  }
  return keys;
}

// Retained for diagnostics. V3 adds volume/cp, but not a last-trade timestamp; automated
// stale-price protection must use fetchFullQuotes() instead.
export async function fetchLtp(instrumentKeys, options = {}) {
  const keys = validateKeys(instrumentKeys, 500);
  if (!keys.length) return {};
  return apiRequest(`/v3/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(','))}`, options);
}

// Full quotes include both response timestamp and last_trade_time. Return a stable map keyed
// by instrument_token; never trust Upstox's display-key spelling for joins.
export async function fetchFullQuotes(instrumentKeys, options = {}) {
  const keys = validateKeys(instrumentKeys, 500);
  if (!keys.length) return {};
  const raw = await apiRequest(`/v3/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`, options);
  const out = {};
  for (const quote of Object.values(raw)) {
    const key = quote?.instrument_token;
    if (!keys.includes(key) || !Number.isFinite(quote.last_price) || !(quote.last_price > 0)) continue;
    const lastTradeMs = Number(quote.last_trade_time);
    out[key] = {
      instrumentKey: key,
      symbol: cleanSymbol(quote.symbol),
      price: Number(quote.last_price),
      lastTradeAt: Number.isFinite(lastTradeMs) && lastTradeMs > 0 && lastTradeMs < 8.64e15 ? new Date(lastTradeMs).toISOString() : null,
      responseAt: Number.isFinite(Date.parse(quote.timestamp)) ? new Date(quote.timestamp).toISOString() : null,
      volume: Number.isFinite(Number(quote.volume)) ? Number(quote.volume) : null,
      previousClose: Number.isFinite(Number(quote.prev_close_price)) ? Number(quote.prev_close_price) : null,
    };
  }
  return out;
}

// From/to use YYYY-MM-DD. Candles are research data, not assumed executable fills.
export async function fetchOneMinuteCandles(instrumentKey, from, to, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Invalid date');
  if ([from, to].some(d => !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) throw new Error('Invalid calendar date');
  if (from > to) throw new Error('from must not exceed to');
  if (!validInstrumentKey(instrumentKey)) throw new Error('Missing or invalid instrument key');
  const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/1/${to}/${from}`;
  const data = await apiRequest(path, options);
  if (!Array.isArray(data.candles)) throw new Error('Missing candle array');
  return data.candles;
}

export async function fetchIntradayOneMinuteCandles(instrumentKey, options = {}) {
  if (!validInstrumentKey(instrumentKey)) throw new Error('Missing or invalid instrument key');
  const data = await apiRequest(`/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/1`, options);
  if (!Array.isArray(data.candles)) throw new Error('Missing candle array');
  return data.candles;
}

export function quoteFreshness(quote, { nowMs = Date.now(), maxAgeMs = 90_000, futureToleranceMs = 15_000 } = {}) {
  const tradedMs = Date.parse(quote?.lastTradeAt || '');
  if (!Number.isFinite(quote?.price) || !(quote?.price > 0) || !Number.isFinite(tradedMs)) return { fresh: false, reason: 'missing price or trade timestamp', ageMs: null };
  const ageMs = nowMs - tradedMs;
  if (ageMs < -futureToleranceMs) return { fresh: false, reason: 'future trade timestamp', ageMs };
  if (ageMs > maxAgeMs) return { fresh: false, reason: `stale quote (${Math.round(ageMs / 1000)}s old)`, ageMs };
  const responseMs = Date.parse(quote.responseAt || '');
  if (!Number.isFinite(responseMs) || nowMs - responseMs > maxAgeMs || responseMs - nowMs > futureToleranceMs
    || tradedMs - responseMs > futureToleranceMs) return { fresh: false, reason: 'invalid or stale response timestamp', ageMs };
  return { fresh: true, reason: 'fresh', ageMs };
}

export function _resetInstrumentCacheForTests() { instrumentCache = null; }
