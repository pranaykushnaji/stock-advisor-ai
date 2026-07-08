// api/_sector.js
// Sector confirmation (directive: "sector momentum must influence every recommendation";
// "avoid isolated outperformers"). v1: map each liquid NSE name to a sector, then measure that
// sector's strength from TODAY's snapshot universe — average move + breadth of its members. A
// candidate in a broadly-strong sector scores higher; an isolated mover in a weak sector is
// penalized. Phase 2 will swap the peer-derived score for real NSE sectoral-index returns.

const SECTOR_MAP = {
  // Banks
  HDFCBANK:'Bank', ICICIBANK:'Bank', SBIN:'Bank', AXISBANK:'Bank', KOTAKBANK:'Bank', INDUSINDBK:'Bank',
  BANKBARODA:'Bank', PNB:'Bank', CANBK:'Bank', FEDERALBNK:'Bank', AUBANK:'Bank', IDFCFIRSTB:'Bank', BANDHANBNK:'Bank', YESBANK:'Bank',
  // NBFC / Financials
  BAJFINANCE:'Financials', BAJAJFINSV:'Financials', CHOLAFIN:'Financials', SHRIRAMFIN:'Financials', MUTHOOTFIN:'Financials',
  LICHSGFIN:'Financials', RECLTD:'Financials', PFC:'Financials', ABCAPITAL:'Financials', SBILIFE:'Financials', HDFCLIFE:'Financials',
  POLICYBZR:'Financials', PAYTM:'Financials', '360ONE':'Financials', PNBHOUSING:'Financials',
  // IT
  TCS:'IT', INFY:'IT', WIPRO:'IT', HCLTECH:'IT', TECHM:'IT', LTIM:'IT', PERSISTENT:'IT', COFORGE:'IT', MPHASIS:'IT',
  OFSS:'IT', LTTS:'IT', KPITTECH:'IT', TATAELXSI:'IT',
  // Auto
  MARUTI:'Auto', TATAMOTORS:'Auto', 'M&M':'Auto', 'BAJAJ-AUTO':'Auto', HEROMOTOCO:'Auto', EICHERMOT:'Auto', ASHOKLEY:'Auto',
  TVSMOTOR:'Auto', BHARATFORG:'Auto', MRF:'Auto', BALKRISIND:'Auto', MOTHERSON:'Auto',
  // Pharma / Health
  SUNPHARMA:'Pharma', DRREDDY:'Pharma', CIPLA:'Pharma', DIVISLAB:'Pharma', APOLLOHOSP:'Pharma', MAXHEALTH:'Pharma', FORTIS:'Pharma',
  // FMCG
  HINDUNILVR:'FMCG', ITC:'FMCG', NESTLEIND:'FMCG', BRITANNIA:'FMCG', TATACONSUM:'FMCG', DABUR:'FMCG', MARICO:'FMCG', JUBLFOOD:'FMCG', PAGEIND:'FMCG',
  // Metal
  TATASTEEL:'Metal', JSWSTEEL:'Metal', HINDALCO:'Metal', VEDL:'Metal', JINDALSTEL:'Metal', SAIL:'Metal', NMDC:'Metal', NATIONALUM:'Metal', HINDZINC:'Metal', APLAPOLLO:'Metal',
  // Energy / Oil & Gas
  RELIANCE:'Energy', ONGC:'Energy', BPCL:'Energy', IOC:'Energy', HINDPETRO:'Energy', GAIL:'Energy', PETRONET:'Energy', IGL:'Energy', GUJGASLTD:'Energy', COALINDIA:'Energy',
  // Cement
  ULTRACEMCO:'Cement', GRASIM:'Cement', AMBUJACEM:'Cement', ACC:'Cement', DALBHARAT:'Cement', SHREECEM:'Cement',
  // Realty
  DLF:'Realty', GODREJPROP:'Realty', OBEROIRLTY:'Realty', PHOENIXLTD:'Realty', PRESTIGE:'Realty', LODHA:'Realty',
  // Power
  NTPC:'Power', POWERGRID:'Power', TATAPOWER:'Power', TORNTPOWER:'Power', NHPC:'Power', ADANIPOWER:'Power', ADANIGREEN:'Power', JSWENERGY:'Power', SUZLON:'Power',
  // Infra / Capital Goods / Defence
  LT:'Infra', SIEMENS:'Infra', ABB:'Infra', CUMMINSIND:'Infra', POLYCAB:'Infra', HAVELLS:'Infra', VOLTAS:'Infra', CROMPTON:'Infra',
  DIXON:'Infra', BEL:'Defence', HAL:'Defence', MAZDOCK:'Defence', BHEL:'Infra', GMRAIRPORT:'Infra', IRCTC:'Infra', IRFC:'Infra', RVNL:'Infra', CONCOR:'Infra',
  // Chemicals
  PIIND:'Chemicals', SRF:'Chemicals', DEEPAKNTR:'Chemicals', AARTIIND:'Chemicals', UPL:'Chemicals', PIDILITIND:'Chemicals',
  // Telecom
  BHARTIARTL:'Telecom', INDUSTOWER:'Telecom', TATACOMM:'Telecom',
  // Paints
  ASIANPAINT:'Paints', BERGEPAINT:'Paints',
  // Consumer / Retail / Misc
  DMART:'Retail', TRENT:'Retail', TITAN:'Retail', NYKAA:'Retail', ETERNAL:'Retail',
  ADANIENT:'Infra', ADANIPORTS:'Logistics', NAUKRI:'IT',
};

export function sectorOf(symbol) { return SECTOR_MAP[String(symbol || '').toUpperCase()] || 'UNKNOWN'; }

// Build Map(sector -> {score 0-100, avgPChange, breadth%, count}) from the snapshot universe rows.
export function sectorStrength(universeRows) {
  const bySec = new Map();
  for (const r of (universeRows || [])) {
    const sec = sectorOf(r.symbol);
    if (sec === 'UNKNOWN' || typeof r.pChange !== 'number') continue;
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(r.pChange);
  }
  const out = new Map();
  for (const [sec, arr] of bySec) {
    if (!arr.length) continue;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const up = arr.filter(x => x > 0).length / arr.length;
    const score = Math.max(0, Math.min(100, 50 + avg * 4 + (up - 0.5) * 40));
    out.set(sec, { score: +score.toFixed(0), avgPChange: +avg.toFixed(2), breadth: +(up * 100).toFixed(0), count: arr.length });
  }
  return out;
}

// Sector score (0-100) for one candidate; 50 (neutral) if the sector is unknown or thin.
export function sectorScoreFor(symbol, strengthMap) {
  const s = strengthMap.get(sectorOf(symbol));
  return (s && s.count >= 3) ? s.score : 50;
}
