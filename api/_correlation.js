// api/_correlation.js
// V2 PORTFOLIO CORRELATION / CONCENTRATION GUARD — before every buy, check how correlated the
// candidate is with what's already held, via sector (from _sector.js) plus a THEME map that
// captures correlations sectors miss (a defence PSU and a railway PSU are different "sectors"
// but the same trade). Deterministic mapping — true price-correlation math would need one
// price-history fetch per holding per scan; the sector/theme proxy captures the bulk of Indian
// market co-movement at zero cost. Verdicts: ok | reduce (halve size) | reject.

import { sectorOf } from './_sector.js';

// Thematic clusters that trade together regardless of formal sector.
const THEME_MAP = {
  // Defence
  HAL: 'defence', BEL: 'defence', MAZDOCK: 'defence', BDL: 'defence', COCHINSHIP: 'defence', BEML: 'defence',
  // Railways
  RVNL: 'railways', IRFC: 'railways', IRCTC: 'railways', CONCOR: 'railways', TITAGARH: 'railways', RAILTEL: 'railways', IRCON: 'railways',
  // Power / renewables build-out
  SUZLON: 'renewables', PREMIERENE: 'renewables', ADANIGREEN: 'renewables', TATAPOWER: 'renewables', JSWENERGY: 'renewables', NHPC: 'renewables', SJVN: 'renewables', INOXWIND: 'renewables',
  // EV / new-age auto
  TATAMOTORS: 'ev', OLECTRA: 'ev', EXIDEIND: 'ev', AMARAJABAT: 'ev', SONACOMS: 'ev',
  // PSU banks (tighter cluster than "Bank")
  SBIN: 'psu-bank', BANKBARODA: 'psu-bank', PNB: 'psu-bank', CANBK: 'psu-bank', UNIONBANK: 'psu-bank', INDIANB: 'psu-bank',
  // New-age platforms
  PAYTM: 'platform', NYKAA: 'platform', POLICYBZR: 'platform', ETERNAL: 'platform', SWIGGY: 'platform', DELHIVERY: 'platform',
  // Steel/metals momentum cluster
  TATASTEEL: 'steel', JSWSTEEL: 'steel', SAIL: 'steel', JINDALSTEL: 'steel', NMDC: 'steel',
};

export function themeOf(symbol) { return THEME_MAP[String(symbol || '').toUpperCase()] || null; }

// Assess a candidate against currently-open positions.
// Returns { action: 'ok'|'reduce'|'reject', factor, reason }.
//   - 2+ open positions already share the candidate's sector OR theme → reject
//   - exactly 1 shares it → reduce (halve the position)
// Unknown sector + no theme → ok (never block on missing data).
export function concentrationCheck(symbol, openPositions = []) {
  const sym = String(symbol || '').toUpperCase();
  const sec = sectorOf(sym);
  const theme = themeOf(sym);
  let secCount = 0, themeCount = 0;
  for (const p of openPositions) {
    const ps = String(p.ticker || '').toUpperCase();
    if (ps === sym) continue;
    if (sec !== 'UNKNOWN' && sectorOf(ps) === sec) secCount++;
    if (theme && themeOf(ps) === theme) themeCount++;
  }
  const worst = Math.max(secCount, themeCount);
  const via = themeCount >= secCount && theme ? `theme:${theme}` : `sector:${sec}`;
  if (worst >= 2) return { action: 'reject', factor: 0, reason: `concentration: already ${worst} open positions in ${via}` };
  if (worst === 1) return { action: 'reduce', factor: 0.5, reason: `concentration: 1 open position in ${via} — size halved` };
  return { action: 'ok', factor: 1, reason: null };
}
