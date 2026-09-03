import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/sell-check.js';

async function runSell(price, { failRiskWrite = false } = {}) {
  const savedFetch = globalThis.fetch;
  const env = { CRON_SECRET: process.env.CRON_SECRET, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GROQ_API_KEY: process.env.GROQ_API_KEY };
  process.env.CRON_SECRET = 'test-only'; process.env.GITHUB_TOKEN = 'test-only'; delete process.env.GROQ_API_KEY;
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const files = {
    'data/project-bouquet.json': { bouquet: [{ ticker: 'TEST', date: today, entryPrice: 100, currentPrice: 100, peakPrice: 100,
      shares: 10, initialStopPrice: 95, initialStopPct: 5, initialTrailPct: 4, riskSource: 'entry' }] },
    'data/nse-snapshot.json': { data: { announcements: [] } },
    'data/news-intel.json': {}, 'data/realized.json': { trades: [] },
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://query1.finance.yahoo.com/')) return Response.json({ chart: { result: [{
      meta: { regularMarketPrice: price, currency: 'INR' }, timestamp: [Date.now() / 1000],
      indicators: { quote: [{ close: Array(30).fill(100), high: [130] }] },
    }] } });
    const path = String(url).split('/contents/')[1];
    assert.ok(Object.hasOwn(files, path), `unexpected request: ${url}`);
    if (options.method === 'PUT') {
      if (failRiskWrite && path === 'data/project-bouquet.json') return Response.json({}, { status: 409 });
      files[path] = JSON.parse(Buffer.from(JSON.parse(options.body).content, 'base64').toString());
      return Response.json({});
    }
    return Response.json({ sha: 'mock-sha', content: Buffer.from(JSON.stringify(files[path])).toString('base64') });
  };
  const res = { statusCode: null, body: null, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } };
  try {
    await handler({ query: { force: 'true' }, headers: { authorization: 'Bearer test-only' } }, res);
    return { files, res };
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(env)) { if (value == null) delete process.env[key]; else process.env[key] = value; }
  }
}

test('sell handler persists held-position risk state without using a pre-entry daily high', async () => {
  const { files, res } = await runSell(103);
  assert.equal(res.statusCode, 200); assert.equal(res.body.sold, 0);
  const p = files['data/project-bouquet.json'].bouquet[0];
  assert.equal(p.peakPrice, 103); assert.equal(p.initialStopPrice, 95);
  assert.equal(p.currentPrice, 103); assert.ok(p.lastPriceUpdate);
});

test('sell handler books actual observed fill, preserves trigger, then removes position', async () => {
  const { files, res } = await runSell(94);
  assert.equal(res.statusCode, 200);
  assert.equal(files['data/project-bouquet.json'].bouquet.length, 0);
  const trade = files['data/realized.json'].trades[0];
  assert.equal(trade.exitPrice, 94); assert.equal(trade.triggerPrice, 95);
  assert.equal(trade.realizedPnl, -60);
});

test('failure to persist peak/stop state is loud, not a successful green run', async () => {
  await assert.rejects(runSell(103, { failRiskWrite: true }), /risk state persistence failed/);
});

test('unverified extreme moves are an actionable failure, not a silent HOLD', async () => {
  const { files, res } = await runSell(70);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.positions[0].result, 'price_unverified');
  assert.equal(files['data/realized.json'].trades.length, 0);
  assert.equal(files['data/project-bouquet.json'].bouquet[0].peakPrice, 100);
});
