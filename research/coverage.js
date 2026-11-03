// Preview research only. Membership is not a trading signal or permission to buy.
export const CONSTITUENT_SOURCES = Object.freeze({
  broad: 'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv',
  mid: 'https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv',
  small: 'https://www.niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv',
});

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(field.trim()); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseConstituents(text) {
  const [headers, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  const required = ['Company Name', 'Industry', 'Symbol', 'Series', 'ISIN Code'];
  if (!headers || required.some(k => !headers.includes(k))) throw new Error('Invalid official constituent schema');
  const seen = new Set();
  return rows.map(row => Object.fromEntries(headers.map((k, i) => [k, row[i]])))
    .filter(r => r.Series === 'EQ').map(r => ({ symbol: r.Symbol, name: r['Company Name'],
      sector: r.Industry, isin: r['ISIN Code'] })).filter(r => {
      // Corporate-action placeholders occur in official lists. Retain them visibly as
      // non-tradable members; never manufacture an instrument key for a dummy ISIN.
      const placeholder = /^DUMMY/.test(r.symbol || '') && /^DUM[A-Z0-9]+$/.test(r.isin || '');
      if (!/^[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(r.symbol || '') || (!/^IN[A-Z0-9]{10}$/.test(r.isin || '') && !placeholder)) throw new Error('Invalid member identity');
      if (seen.has(r.symbol)) throw new Error('Duplicate official member');
      seen.add(r.symbol); return true;
    });
}

export function buildResearchUniverse({ broad, mid, small, instruments, fetchedAt, sources = CONSTITUENT_SOURCES }) {
  if (!Array.isArray(broad) || !Array.isArray(mid) || !Array.isArray(small) || !Array.isArray(instruments)
    || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Incomplete coverage inputs');
  const midSet = new Set(mid.map(r => r.isin)), smallSet = new Set(small.map(r => r.isin));
  if ([...midSet].some(isin => smallSet.has(isin))) throw new Error('Conflicting size-index membership');
  const bySymbol = new Map();
  for (const r of instruments) {
    if (r.segment !== 'NSE_EQ' || r.instrument_type !== 'EQ' || !/^IN[A-Z0-9]{10}$/.test(r.isin || '') || r.instrument_key !== `NSE_EQ|${r.isin}`) continue;
    const list = bySymbol.get(r.trading_symbol) || [];
    list.push(r); bySymbol.set(r.trading_symbol, list);
  }
  const unique = new Map();
  for (const r of [...broad, ...mid, ...small]) {
    const existing = unique.get(r.isin);
    if (existing && existing.symbol !== r.symbol) throw new Error('Conflicting symbol for one ISIN');
    unique.set(r.isin, r);
  }
  const members = [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).map(r => {
    const rows = bySymbol.get(r.symbol) || [];
    const matches = rows.filter(i => i.isin === r.isin);
    const keys = [...new Set(rows.map(i => i.instrument_key))];
    const mapped = matches.length > 0 && keys.length === 1;
    return { ...r, marketCapBucket: midSet.has(r.isin) ? 'mid' : smallSet.has(r.isin) ? 'small' : 'other',
      instrumentKey: mapped ? matches[0].instrument_key : null,
      mappingStatus: mapped ? 'mapped' : rows.length ? 'identity-mismatch-or-ambiguous' : 'unmapped',
      eligibleToTrade: false };
  });
  return { version: 'research-universe-v1', fetchedAt, mode: 'registry-only', sources,
    historicalMembershipAvailable: false, productionEnabled: false,
    summary: { members: members.length, mapped: members.filter(r => r.instrumentKey).length,
      mid: members.filter(r => r.marketCapBucket === 'mid').length,
      small: members.filter(r => r.marketCapBucket === 'small').length,
      unmapped: members.filter(r => !r.instrumentKey).length }, members,
    limitations: ['Current index membership cannot be used as historical membership in a backtest.',
      'Registry coverage is not live scan coverage. Liquidity, spread, surveillance, fresh prices and setup checks are still required.',
      'Size labels describe index membership, not independently calculated market capitalization.'] };
}

export function quoteBatches(members, size = 250) {
  if (!Number.isInteger(size) || size < 1 || size > 500) throw new Error('Quote batch must be 1–500');
  const keys = [...new Set(members.map(r => r.instrumentKey).filter(Boolean))];
  return Array.from({ length: Math.ceil(keys.length / size) }, (_, i) => keys.slice(i * size, (i + 1) * size));
}
