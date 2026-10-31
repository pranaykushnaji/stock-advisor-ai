// Read-only Upstox market-data adapter. Never logs credentials or places orders.
const BASE = 'https://api.upstox.com';
function token() {
  const value = process.env.UPSTOX_ACCESS_TOKEN;
  if (!value) throw new Error('UPSTOX_ACCESS_TOKEN is not configured');
  return value;
}
async function request(path, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(BASE + path, {
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Upstox market data HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'success' || !body.data) throw new Error('Invalid Upstox market-data response');
  return body.data;
}
// instrumentKeys must be official Upstox instrument_key values, not NSE ticker symbols.
export async function fetchLtp(instrumentKeys, options = {}) {
  if (!Array.isArray(instrumentKeys) || instrumentKeys.length === 0) return {};
  if (instrumentKeys.length > 50 || instrumentKeys.some(k => typeof k !== 'string' || !k)) {
    throw new Error('Expected 1-50 Upstox instrument keys');
  }
  return request(`/v2/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKeys.join(','))}`, options);
}
// From/to use YYYY-MM-DD. Returns exchange-provided candles; do not assume executable fills.
export async function fetchOneMinuteCandles(instrumentKey, from, to, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Invalid date');
  if (from > to) throw new Error('from must not exceed to');
  if (!instrumentKey || typeof instrumentKey !== 'string') throw new Error('Missing instrument key');
  const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/1/${to}/${from}`;
  const data = await request(path, options);
  if (!Array.isArray(data.candles)) throw new Error('Missing candle array');
  return data.candles;
}
