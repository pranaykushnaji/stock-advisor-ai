// api/_fundamentals.js
// Real fundamentals with graceful degradation:
//   FMP (best: real computed ratios) -> Yahoo quoteSummary (no key) -> null (LLM estimates, flagged)
// Every metric is returned source-tagged so the pipeline knows what's real vs estimated.
//
// Returns: { source, fields: { roe, roce, debtToEquity, netMargin, ebitdaMargin,
//            earningsGrowth, peRatio, pbRatio, pegRatio, dividendYield, sector }, partial }
// Any field may be null if unavailable from that source.

async function fetchWithTimeout(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const TICKER_ALIASES = {
  'ZOMATO': 'ETERNAL', 'MOTHERSUMI': 'MOTHERSON', 'MINDTREE': 'LTIM',
};
function resolveAlias(sym) {
  const u = (sym || '').toUpperCase().replace(/\.(NS|BO)$/, '');
  return TICKER_ALIASES[u] || u;
}

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'object' ? v.raw : v;
  return (typeof n === 'number' && isFinite(n)) ? n : null;
}

// ---- Source 1: Financial Modeling Prep (needs FMP_KEY) ----
// Free tier returns TTM ratios as clean JSON. Ratios come as decimals (0.18 = 18%).
async function fromFMP(base, apiKey) {
  if (!apiKey) return null;
  const sym = `${base}.NS`;
  try {
    const [ratiosR, profileR] = await Promise.all([
      fetchWithTimeout(`https://financialmodelingprep.com/api/v3/ratios-ttm/${sym}?apikey=${apiKey}`, {}, 7000),
      fetchWithTimeout(`https://financialmodelingprep.com/api/v3/profile/${sym}?apikey=${apiKey}`, {}, 7000),
    ]);
    if (!ratiosR.ok) return null;
    const ratios = (await ratiosR.json())?.[0];
    if (!ratios || typeof ratios !== 'object') return null;
    const profile = profileR.ok ? (await profileR.json())?.[0] : null;

    const pct = (x) => (num(x) != null ? +(num(x) * 100).toFixed(2) : null); // decimal -> %
    const fields = {
      roe: pct(ratios.returnOnEquityTTM),
      roce: pct(ratios.returnOnCapitalEmployedTTM),
      debtToEquity: num(ratios.debtEquityRatioTTM),
      netMargin: pct(ratios.netProfitMarginTTM),
      ebitdaMargin: pct(ratios.ebitdaMarginTTM ?? ratios.operatingProfitMarginTTM),
      earningsGrowth: null, // not in ratios-ttm; left for Yahoo/LLM
      peRatio: num(ratios.peRatioTTM),
      pbRatio: num(ratios.priceToBookRatioTTM),
      pegRatio: num(ratios.pegRatioTTM),
      dividendYield: pct(ratios.dividendYieldTTM),
      sector: profile?.sector || null,
    };
    const has = Object.values(fields).filter(v => v != null).length;
    if (has < 3) return null; // too thin to trust
    return { source: 'fmp', fields, partial: has < 8 };
  } catch (e) { return null; }
}

// ---- Source 2: Yahoo quoteSummary (no key, but needs a crumb+cookie) ----
async function yahooCrumb() {
  try {
    const r = await fetchWithTimeout('https://fc.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    const cookie = r.headers.get('set-cookie');
    if (!cookie) return null;
    const cr = await fetchWithTimeout('https://query1.finance.yahoo.com/v1/test/getcrumb',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie } }, 5000);
    const crumb = await cr.text();
    if (!crumb || crumb.includes('<')) return null;
    return { crumb, cookie };
  } catch (e) { return null; }
}

async function fromYahoo(base) {
  try {
    const auth = await yahooCrumb();
    if (!auth) return null;
    const modules = 'financialData,defaultKeyStatistics,summaryDetail,assetProfile';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${base}.NS?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': auth.cookie } }, 7000);
    if (!r.ok) return null;
    const result = (await r.json())?.quoteSummary?.result?.[0];
    if (!result) return null;
    const fd = result.financialData || {};
    const ks = result.defaultKeyStatistics || {};
    const sd = result.summaryDetail || {};
    const ap = result.assetProfile || {};

    const pct = (x) => (num(x) != null ? +(num(x) * 100).toFixed(2) : null);
    const fields = {
      roe: pct(fd.returnOnEquity),
      roce: null, // Yahoo doesn't expose ROCE directly
      debtToEquity: num(fd.debtToEquity) != null ? +(num(fd.debtToEquity) / 100).toFixed(2) : null, // Yahoo gives % form
      netMargin: pct(fd.profitMargins),
      ebitdaMargin: pct(fd.ebitdaMargins),
      earningsGrowth: pct(fd.earningsGrowth),
      peRatio: num(sd.trailingPE) ?? num(ks.forwardPE),
      pbRatio: num(ks.priceToBook),
      pegRatio: num(ks.pegRatio),
      dividendYield: pct(sd.dividendYield),
      sector: ap.sector || null,
    };
    const has = Object.values(fields).filter(v => v != null).length;
    if (has < 3) return null;
    return { source: 'yahoo', fields, partial: has < 8 };
  } catch (e) { return null; }
}

// ---- Public: fetch with fallback chain ----
export async function fetchFundamentals(symbol, { fmpKey } = {}) {
  const base = resolveAlias(symbol);
  let data = await fromFMP(base, fmpKey);
  if (!data) data = await fromYahoo(base);
  if (!data) {
    // Nothing real available — return an empty shell flagged as estimated.
    return {
      source: 'estimated',
      fields: {
        roe: null, roce: null, debtToEquity: null, netMargin: null, ebitdaMargin: null,
        earningsGrowth: null, peRatio: null, pbRatio: null, pegRatio: null,
        dividendYield: null, sector: null,
      },
      partial: true,
    };
  }
  return data;
}
