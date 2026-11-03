import test from 'node:test';
import assert from 'node:assert/strict';
import sell from '../api/sell-check.js';
import refresh from '../api/refresh-prices.js';
import { validateQuote } from '../api/_quote-validation.js';

const at = new Date('2026-11-03T06:00:00Z');
const meta = () => ({ regularMarketPrice: 100, regularMarketTime: at.getTime() / 1000 - 30,
  currency: 'INR', symbol: 'TEST.NS', marketState: 'REGULAR' });

test('quote contract rejects stale, future, missing, non-INR and wrong instrument data', () => {
  assert.ok(validateQuote(meta(), 'TEST', at));
  for (const patch of [{ regularMarketTime: at.getTime() / 1000 - 301 },
    { regularMarketTime: at.getTime() / 1000 + 31 }, { regularMarketTime: undefined },
    { currency: 'USD' }, { currency: undefined }, { symbol: 'OTHER.NS' },
    { symbol: 'TEST' }, { symbol: undefined }, { regularMarketPrice: NaN }]) {
    assert.equal(validateQuote({ ...meta(), ...patch }, 'TEST', at), null);
  }
  assert.equal(validateQuote({ ...meta(), regularMarketTime: Date.parse('2026-11-02T09:59:00Z') / 1000 }, 'TEST', at), null);
  assert.ok(validateQuote({ ...meta(), symbol: 'ETERNAL.NS' }, 'ZOMATO', at));
  const close = Date.parse('2026-11-03T10:00:00Z') / 1000;
  assert.ok(validateQuote({ ...meta(), regularMarketTime: close }, 'TEST', new Date('2026-11-03T12:00:00Z')));
  assert.equal(validateQuote(meta(), 'TEST', new Date('2026-11-03T12:00:00Z')), null);
});

async function scenario(options, check) {
  const nativeDate = globalThis.Date, savedFetch = globalThis.fetch;
  // Tests run with an empty environment; only synthetic credentials are installed here.
  const env = { ...process.env };
  globalThis.Date = class extends nativeDate {
    constructor(...args) { super(...(args.length ? args : [at.getTime()])); }
    static now() { return at.getTime(); }
  };
  process.env.CRON_SECRET = 'preview-test'; process.env.GITHUB_TOKEN = 'preview-test';
  if (options.filing || options.intel) process.env.GROQ_API_KEY = 'preview-test';
  const item = { ticker: 'TEST', date: '2026-11-03', addedAt: '2026-11-03T04:00:00Z',
    lastThesisUpdate: '2026-11-03T04:00:00Z', entryPrice: 100, currentPrice: 100, peakPrice: 100,
    shares: 10, initialStopPrice: 95, initialStopPct: 5, initialTrailPct: 4,
    thesisScore: options.intel ? 90 : 50, ...(options.pending ? { status: 'SELL_PENDING', provisionalExitPrice: 98 } : {}) };
  const files = { 'data/project-bouquet.json': { bouquet: [item] }, 'data/realized.json': { trades: [{ ticker: 'OLD', entryDate: '2026-10-01' }] },
    'data/nse-snapshot.json': { data: { announcements: options.filing ? [{ symbol: 'TEST', subject: 'Material new contract', date: '03-Nov-2026 10:45:00' }] : [] } },
    'data/news-intel.json': options.intel ? { generatedAt: '2026-11-03T05:30:00Z', items: [{ ticker: 'TEST', direction: 'negative', materiality: 8, publishedAt: '2026-11-03T05:10:00Z' }] } : {} };
  const puts = []; let classifications = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('query1.finance.yahoo.com')) return Response.json({ chart: { result: [{
      meta: { ...meta(), regularMarketPrice: options.price ?? 100, ...options.quote }, timestamp: [at.getTime() / 1000],
      indicators: { quote: [{ close: Array(30).fill(100), high: [100], open: [100] }] } }] } });
    if (String(url).includes('api.groq.com')) {
      const classifier = JSON.parse(opts.body).messages[0].content.includes('event classifier');
      if (classifier) classifications++;
      if (classifier && options.classificationFailure) return Response.json({}, { status: 503 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(classifier
        ? { catalyst_type: 'No catalyst', confidence: 90, direction: 'bullish', impact_score: 0, evidence_article_ids: [] }
        : { verdict: 'HOLD', reason: 'test' }) } }] });
    }
    const path = String(url).split('/contents/')[1];
    assert.ok(Object.hasOwn(files, path));
    if (opts.method === 'PUT') {
      puts.push(path); files[path] = JSON.parse(Buffer.from(JSON.parse(opts.body).content, 'base64').toString());
      return Response.json({});
    }
    if (path === 'data/realized.json' && options.ledgerStatus) return Response.json({}, { status: options.ledgerStatus });
    const content = path === 'data/realized.json' && options.badLedger !== undefined ? options.badLedger : JSON.stringify(files[path]);
    return Response.json({ sha: 'test-sha', content: Buffer.from(content).toString('base64') });
  };
  const run = async () => {
    const res = { status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
    await (options.refresh ? refresh : sell)({ query: { force: 'true' }, headers: { authorization: 'Bearer preview-test' } }, res);
    return res;
  };
  try { await check({ files, puts, run, count: () => classifications }); }
  finally { globalThis.Date = nativeDate; globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); }
}

for (const refreshMode of [false, true]) {
  for (const quote of [{ currency: 'USD' }, { symbol: 'OTHER.NS' }, { regularMarketTime: at.getTime() / 1000 - 86400 }]) {
    test(`${refreshMode ? 'refresh' : 'sell'} rejects invalid quote ${JSON.stringify(quote)}`, async () => {
      await scenario({ refresh: refreshMode, quote, price: 94, pending: refreshMode }, async ({ files, puts, run }) => {
        const r = await run(); assert.equal(r.code, 502); assert.equal(puts.length, 0);
        assert.equal(files['data/project-bouquet.json'].bouquet[0].currentPrice, 100);
        assert.equal(files['data/realized.json'].trades.length, 1);
      });
    });
  }
  for (const badLedger of ['{invalid', '{}', 'null', '{"trades":{}}']) {
    test(`${refreshMode ? 'refresh' : 'sell'} refuses malformed existing ledger ${badLedger}`, async () => {
      await scenario({ refresh: refreshMode, pending: refreshMode, price: 94, badLedger }, async ({ files, puts, run }) => {
        const r = await run(); assert.equal(r.code, 502); assert.ok(!puts.includes('data/realized.json'));
        assert.equal(files['data/project-bouquet.json'].bouquet.length, 1);
      });
    });
  }
  test(`${refreshMode ? 'refresh' : 'sell'} retains provider timestamp on accepted quote`, async () => {
    await scenario({ refresh: refreshMode }, async ({ files, run }) => {
      assert.equal((await run()).code, 200);
      const p = files['data/project-bouquet.json'].bouquet[0];
      assert.equal(p.quoteTimestamp, '2026-11-03T05:59:30.000Z');
      assert.equal(p.quoteCurrency, 'INR'); assert.equal(p.quoteSymbol, 'TEST.NS');
      assert.notEqual(p.quoteTimestamp, p.lastPriceUpdate);
    });
  });
  test(`${refreshMode ? 'refresh' : 'sell'} refuses unreadable existing ledger`, async () => {
    await scenario({ refresh: refreshMode, pending: refreshMode, price: 94, ledgerStatus: 503 }, async ({ puts, run }) => {
      assert.equal((await run()).code, 502); assert.ok(!puts.includes('data/realized.json'));
    });
  });
}

test('classification failure remains retryable across runs', async () => {
  await scenario({ filing: true, classificationFailure: true }, async ({ files, run, count }) => {
    await run(); await run(); assert.equal(count(), 2);
    assert.equal(files['data/project-bouquet.json'].bouquet[0].lastThesisUpdate, '2026-11-03T04:00:00Z');
    assert.equal(files['data/project-bouquet.json'].bouquet[0].lastFilingUpdate, undefined);
  });
});

test('intel cannot consume an unclassified filing; successful filing is not repeated', async () => {
  await scenario({ filing: true, intel: true }, async ({ files, run, count }) => {
    await run(); await run(); assert.equal(count(), 1);
    const p = files['data/project-bouquet.json'].bouquet[0];
    assert.equal(p.lastIntelUpdate, '2026-11-03T05:10:00.000Z');
    assert.equal(p.lastFilingUpdate, '2026-11-03T05:15:00.000Z'); assert.equal(p.thesisScore, 60);
  });
});

test('intel damage does not hide a failed filing or repeat its own damage', async () => {
  await scenario({ filing: true, intel: true, classificationFailure: true }, async ({ files, run, count }) => {
    await run(); await run(); assert.equal(count(), 2);
    const p = files['data/project-bouquet.json'].bouquet[0];
    assert.equal(p.thesisScore, 60); assert.equal(p.lastFilingUpdate, '2026-11-03T04:00:00.000Z');
  });
});

test('booked exit retains the provider timestamp separately from its booking time', async () => {
  await scenario({ price: 94 }, async ({ files, run }) => {
    assert.equal((await run()).code, 200);
    const trade = files['data/realized.json'].trades.at(-1);
    assert.equal(trade.quoteTimestamp, '2026-11-03T05:59:30.000Z');
    assert.equal(trade.quoteSymbol, 'TEST.NS'); assert.notEqual(trade.quoteTimestamp, trade.exitAt);
  });
});
