// ─── State ───
let bouquet=[],history=[],currentAnalysis=null;
const SK={BOUQUET:'sa_bouquet2',HISTORY:'sa_history2',THEME:'sa_theme'};
function load(){try{bouquet=JSON.parse(localStorage.getItem(SK.BOUQUET)||'[]');}catch{bouquet=[];}try{history=JSON.parse(localStorage.getItem(SK.HISTORY)||'[]');}catch{history=[];}updateBadge();}
function save(){localStorage.setItem(SK.BOUQUET,JSON.stringify(bouquet));localStorage.setItem(SK.HISTORY,JSON.stringify(history));updateBadge();}
function updateBadge(){const b=document.getElementById('bouquet-badge');if(b)b.textContent=bouquet.length||'';}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
// Escape a URL for safe use in href — only allow http/https, block javascript: etc.
function safeUrl(u){const s=String(u==null?'':u).trim();if(/^https?:\/\//i.test(s))return esc(s);return '#';}

// ─── Theme ───
function initTheme(){const s=localStorage.getItem(SK.THEME);setTheme(s||(matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'));}
function setTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem(SK.THEME,t);document.getElementById('theme-icon-dark').style.display=t==='dark'?'block':'none';document.getElementById('theme-icon-light').style.display=t==='light'?'block':'none';}
document.getElementById('theme-toggle').addEventListener('click',()=>{setTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');});

// ─── Tabs ───
function switchTab(n){document.querySelectorAll('.nav-item').forEach(e=>e.classList.toggle('active',e.dataset.tab===n));document.querySelectorAll('.tab-pane').forEach(e=>e.classList.toggle('active',e.id==='tab-'+n));if(n==='bouquet')renderBouquet();if(n==='dashboard')renderDashboard();if(n==='daily')renderDailyTab(sotdPick);if(n==='tracker')renderTracker();}
document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

// ─── FACTOR-BASED SCORING (research-backed) ───
// Four factors with decades of academic evidence. Momentum & Low-Vol are computed
// from REAL price data; Quality & Value come from fundamentals (LLM).
// Weights reflect India risk-adjusted premia (NSE Multi-Factor whitepaper, Gulaq).
const FACTOR_WEIGHTS={momentum:0.30,quality:0.28,value:0.22,lowVol:0.20};

// Legacy agent weights (kept for backward-compat with old stored picks)
const WEIGHTS={fundamental:0.35,news:0.25,technical:0.20,risk:0.20};

// --- Real factor math from price history ---
function periodReturn(closes,lookbackDays,skipDays){
  if(!closes||closes.length<lookbackDays+skipDays+1)return null;
  const end=closes.length-1-skipDays,start=end-lookbackDays;
  if(start<0||end<=start)return null;
  const p0=closes[start],p1=closes[end];
  if(!p0||!p1||p0<=0)return null;
  return((p1-p0)/p0)*100;
}
function annualizedVol(closes){
  if(!closes||closes.length<30)return null;
  const rets=[];
  for(let i=1;i<closes.length;i++){if(closes[i]!=null&&closes[i-1]!=null&&closes[i-1]>0)rets.push((closes[i]-closes[i-1])/closes[i-1]);}
  if(rets.length<20)return null;
  const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
  const variance=rets.reduce((a,b)=>a+(b-mean)**2,0)/rets.length;
  return Math.sqrt(variance)*Math.sqrt(252)*100;
}
function scoreMomentum(mom){if(mom==null)return null;return Math.max(0,Math.min(100,Math.round(50+mom*1.15)));}
function scoreLowVol(vol){if(vol==null)return null;return Math.max(0,Math.min(100,Math.round(115-vol*2.05)));}
function computeRealFactors(chart){
  const closes=(chart?.close||[]).filter(v=>v!=null&&!isNaN(v));
  if(closes.length<30)return{momentum:{score:null},lowVol:{score:null},dataPoints:closes.length};
  // Skip the most-recent ~1 month only if we have enough history; else skip less
  const skip=closes.length>=150?21:closes.length>=90?10:0;
  const m3=periodReturn(closes,63,skip),m6=periodReturn(closes,126,skip),m12=periodReturn(closes,252,skip);
  // If even 3-month isn't available, fall back to whatever lookback the data allows
  let avail=[m3,m6,m12].filter(v=>v!=null);
  if(!avail.length){
    const lb=Math.min(closes.length-1,Math.max(20,Math.floor(closes.length*0.6)));
    const fb=periodReturn(closes,lb,0);
    if(fb!=null)avail=[fb];
  }
  const momRaw=avail.length?avail.reduce((a,b)=>a+b,0)/avail.length:null;
  const vol=annualizedVol(closes);
  return{
    momentum:{score:scoreMomentum(momRaw),raw:momRaw!=null?+momRaw.toFixed(1):null,m3:m3!=null?+m3.toFixed(1):null,m6:m6!=null?+m6.toFixed(1):null,m12:m12!=null?+m12.toFixed(1):null},
    lowVol:{score:scoreLowVol(vol),vol:vol!=null?+vol.toFixed(1):null},
    dataPoints:closes.length
  };
}
function computeFactorComposite(factors){
  let total=0,wSum=0;
  for(const[k,w]of Object.entries(FACTOR_WEIGHTS)){const s=factors[k]?.score;if(s!=null&&!isNaN(s)){total+=s*w;wSum+=w;}}
  return wSum>0?Math.round(total/wSum):50;
}

// Sub-metric weights for each agent (research-backed) — must sum to 1.0 per agent
const SUB_WEIGHTS={
  fundamental:{revenueGrowth:0.20,roce:0.20,roe:0.15,debtToEquity:0.15,margins:0.15,valuation:0.15},
  news:{recentCatalysts:0.35,institutionalActivity:0.25,sectorTrend:0.25,sentiment:0.15},
  technical:{trend:0.35,momentum_rsi:0.25,macd:0.25,volume_support:0.15},
  risk:{debtRisk:0.30,pledgedShares:0.25,volatility:0.25,concentration:0.20}
};

// Recompute each agent score from its sub-scores (deterministic, not LLM-guessed)
function recomputeAgentScores(agents){
  if(!agents)return;
  for(const[agentKey,subW]of Object.entries(SUB_WEIGHTS)){
    const agent=agents[agentKey];
    if(!agent||!agent.subScores)continue;
    // Detect scale: if EVERY sub-score is <=10, the model used a 0-10 scale — normalize to 0-100
    const vals=Object.keys(subW).map(m=>agent.subScores[m]).filter(v=>v!=null&&!isNaN(v));
    const isScale10=vals.length>0&&vals.every(v=>v<=10);
    if(isScale10){
      for(const metric of Object.keys(subW)){
        const v=agent.subScores[metric];
        if(v!=null&&!isNaN(v))agent.subScores[metric]=v*10;
      }
    }
    let total=0,wSum=0;
    for(const[metric,weight]of Object.entries(subW)){
      const v=agent.subScores[metric];
      if(v!=null&&!isNaN(v)){total+=v*weight;wSum+=weight;}
    }
    if(wSum>0)agent.score=Math.round(total/wSum);
  }
}

function computeConfidence(agents){
  if(!agents)return 50;
  let total=0,wSum=0;
  for(const[k,w]of Object.entries(WEIGHTS)){
    if(agents[k]?.score!=null){total+=agents[k].score*w;wSum+=w;}
  }
  return wSum>0?Math.round(total/wSum):50;
}

function computeVerdict(confidence){
  if(confidence>=70)return'BUY';
  if(confidence>=50)return'HOLD';
  return'AVOID';
}

// Universal score: handles both new factor picks and legacy agent picks.
function universalScore(item){
  if(item.composite!=null)return item.composite;
  if(item.confidence!=null)return item.confidence;
  if(item.factors)return computeFactorComposite(item.factors);
  if(item.agents){recomputeAgentScores(item.agents);return computeConfidence(item.agents);}
  return 50;
}

// ─── API call (server-side, key stored on server) ───
async function callAI(stock){
  const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stock})});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.raw)return d.raw;
  throw new Error(d.error||'Server error — please try again');
}

function parseResult(raw,query,chart){
  let c=raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  const firstBrace=c.indexOf('{');
  if(firstBrace>0)c=c.slice(firstBrace);
  let depth=0,endIdx=-1;
  for(let i=0;i<c.length;i++){
    if(c[i]==='{')depth++;
    else if(c[i]==='}'){depth--;if(depth===0){endIdx=i;break;}}
  }
  let jsonStr;
  if(endIdx>0){jsonStr=c.slice(0,endIdx+1);}
  else{const m=c.match(/\{[\s\S]*\}/);if(!m)throw new Error('Response incomplete — please try again');jsonStr=m[0];}
  let d;
  try{d=JSON.parse(jsonStr);}
  catch(e){throw new Error('Could not parse analysis — please try again');}
  if(!d.ticker)throw new Error('Incomplete analysis — please try again');
  d=buildFactorModel(d,chart);
  d.analyzedAt=new Date().toISOString();d.query=query;
  return d;
}

// Merge LLM fundamental factors (quality, value) with REAL price-based factors
// (momentum, lowVol), normalize scales, and compute the composite.
function buildFactorModel(d,chart){
  // NEW SHAPE: analyze.js now computes all factors + composite server-side and tags
  // fundamentalsSource. Trust it directly — don't re-derive or clobber the scores.
  if(d.fundamentalsSource){
    d.confidence=d.composite; // keep field name for existing UI
    if(d.verdict==null)d.verdict=computeVerdict(d.composite);
    return d;
  }
  // LEGACY SHAPE (old stored analyses): re-derive as before.
  const llm=d.factors||{};
  // Normalize any 0-10 scale sub-scores the model may have returned
  normalizeFactorSubs(llm.quality);
  normalizeFactorSubs(llm.value);
  // Recompute quality/value from their sub-scores deterministically
  recomputeFactorScore(llm.quality,QUALITY_SUBW);
  recomputeFactorScore(llm.value,VALUE_SUBW);
  // Compute real momentum & low-vol from price history
  const real=computeRealFactors(chart);
  d.factors={
    momentum:real.momentum,
    quality:llm.quality||{score:null},
    value:llm.value||{score:null},
    lowVol:real.lowVol
  };
  d.factorDataPoints=real.dataPoints||0;
  d.composite=computeFactorComposite(d.factors);
  d.confidence=d.composite; // keep field name for existing UI
  d.verdict=computeVerdict(d.composite);
  return d;
}

const QUALITY_SUBW={roe:0.25,roce:0.25,debtToEquity:0.20,earningsStability:0.15,margins:0.15};
const VALUE_SUBW={peRatio:0.35,pbRatio:0.25,pegRatio:0.25,dividendYield:0.15};

function normalizeFactorSubs(factor){
  if(!factor||!factor.subScores)return;
  const vals=Object.values(factor.subScores).filter(v=>v!=null&&!isNaN(v));
  if(vals.length&&vals.every(v=>v<=10)){
    for(const k of Object.keys(factor.subScores)){const v=factor.subScores[k];if(v!=null&&!isNaN(v))factor.subScores[k]=v*10;}
  }
}
function recomputeFactorScore(factor,subW){
  if(!factor||!factor.subScores)return;
  let total=0,wSum=0;
  for(const[m,w]of Object.entries(subW)){const v=factor.subScores[m];if(v!=null&&!isNaN(v)){total+=v*w;wSum+=w;}}
  if(wSum>0)factor.score=Math.round(total/wSum);
}

// Fetch price data with a per-day cache. If a live fetch fails (Yahoo 403 + AV miss),
// fall back to the last good cached series so momentum/volatility still compute.
async function fetchStock(sym,range){
  const key='px_'+sym.toUpperCase()+'_'+(range||'3mo');
  const today=new Date().toISOString().slice(0,10);
  try{
    const r=await fetch(`/api/stock?symbol=${encodeURIComponent(sym)}${range?'&range='+range:''}`);
    if(r.ok){
      const data=await r.json();
      // Cache good responses that carry real history
      if(data?.chart?.close?.length){
        try{localStorage.setItem(key,JSON.stringify({date:today,data}));}catch{}
      }
      return data;
    }
  }catch{}
  // Live fetch failed — reuse last good cached series if we have one
  try{
    const cached=JSON.parse(localStorage.getItem(key)||'null');
    if(cached?.data?.chart?.close?.length){
      cached.data._stale=true; // mark so callers can note it's cached
      return cached.data;
    }
  }catch{}
  return null;
}
async function fetchNews(q){try{const r=await fetch(`/api/news?q=${encodeURIComponent(q)}`);return r.ok?(await r.json()).articles||[]:[];}catch{return[];}}

// ─── Analyze ───
async function analyzeStock(){
  const input=document.getElementById('stock-input').value.trim();if(!input)return;
  const btn=document.getElementById('analyze-btn'),area=document.getElementById('result-area');
  btn.disabled=true;btn.innerHTML='<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzing…';
  area.innerHTML=`<div class="loading-wrap"><div class="spinner"></div><p>Running factor analysis on <strong>${esc(input)}</strong>…</p><p style="font-size:12px;color:var(--text3);">Momentum · Quality · Value · Low-Volatility</p></div>`;
  try{
    // First get the AI analysis (it resolves the correct ticker) + news in parallel
    const[raw,news]=await Promise.all([callAI(input),fetchNews(input)]);
    // Parse to get the resolved ticker, THEN fetch prices by ticker (not the typed name).
    // Typing "Infosys" must map to INFY.NS — the LLM knows this, the raw input doesn't.
    let prelim;try{prelim=JSON.parse((raw.match(/\{[\s\S]*\}/)||['{}'])[0]);}catch{prelim={};}
    const priceSym=prelim.ticker||input;
    const stockData=await fetchStock(priceSym,'1y');
    const d=parseResult(raw,input,stockData?.chart);
    currentAnalysis=d;history.unshift(d);if(history.length>100)history=history.slice(0,100);save();
    renderResult(d,area,stockData,news);
  }catch(err){
    area.innerHTML=`<div class="error-card"><div class="error-title">⚠ Analysis failed</div><div class="error-msg">${esc(err.message)}</div></div>`;
  }finally{btn.disabled=false;btn.innerHTML='<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg> Analyze';}
}

// ─── Render Agent Card ───
const METRIC_LABELS={
  // Quality factor
  roe:'ROE',roce:'ROCE',debtToEquity:'Debt/Equity',earningsStability:'Earnings Stability',margins:'Margins',
  // Value factor
  peRatio:'P/E Ratio',pbRatio:'P/B Ratio',pegRatio:'PEG Ratio',dividendYield:'Dividend Yield',
  // Legacy (old stored picks)
  revenueGrowth:'Revenue Growth',valuation:'Valuation',
  recentCatalysts:'Catalysts',institutionalActivity:'Institutional',sectorTrend:'Sector Trend',sentiment:'Sentiment',
  trend:'Trend (DMA)',momentum_rsi:'RSI Momentum',macd:'MACD',volume_support:'Volume/Support',
  debtRisk:'Debt Risk',pledgedShares:'Pledged Shares',volatility:'Volatility',concentration:'Diversification'
};

function agentCard(name,icon,data,color){
  if(!data)return'';
  const barW=Math.min(100,Math.max(0,data.score||0));
  let subHtml='';
  if(data.subScores){
    subHtml=`<div class="sub-metrics">${Object.entries(data.subScores).map(([k,v])=>{
      const sc=Math.round(v||0);
      return`<div class="sub-metric"><span class="sm-label">${METRIC_LABELS[k]||k}</span><div class="sm-bar"><div class="sm-fill" style="width:${sc}%;background:${scoreColor(sc)};"></div></div><span class="sm-val">${sc}</span></div>`;
    }).join('')}</div>`;
  }
  return`<div class="agent-card">
    <div class="agent-header"><span class="agent-icon">${icon}</span><span class="agent-name">${name}</span><span class="agent-score" style="color:${color};">${data.score}/100</span></div>
    <div class="agent-bar"><div class="agent-bar-fill" style="width:${barW}%;background:${color};"></div></div>
    ${subHtml}
    <div class="agent-points">
      ${(data.positives||[]).map(p=>`<div class="agent-point"><span class="ap-icon ap-pos">✔</span><span>${esc(p)}</span></div>`).join('')}
      ${(data.negatives||[]).map(p=>`<div class="agent-point"><span class="ap-icon ap-neg">✖</span><span>${esc(p)}</span></div>`).join('')}
    </div>
  </div>`;
}

function scoreColor(s){return s>=70?'var(--green)':s>=50?'var(--amber)':'var(--red)';}

function renderResult(d,area,stockData,news){
  // Legacy shim: old picks have .agents but no .factors — map them so they still render
  if(!d.factors&&d.agents){
    const a=d.agents;
    d.factors={
      momentum:{score:a.technical?.score??null,subScores:a.technical?.subScores,positives:a.technical?.positives,negatives:a.technical?.negatives},
      quality:{score:a.fundamental?.score??null,subScores:a.fundamental?.subScores,positives:a.fundamental?.positives,negatives:a.fundamental?.negatives},
      value:{score:a.risk?.score??null,subScores:a.risk?.subScores,positives:a.risk?.positives,negatives:a.risk?.negatives},
      lowVol:{score:a.news?.score??null,subScores:a.news?.subScores,positives:a.news?.positives,negatives:a.news?.negatives}
    };
    if(d.composite==null)d.composite=d.confidence??computeFactorComposite(d.factors);
  }
  const conf=d.confidence??d.composite;
  const vClass=d.verdict==='BUY'?'buy':d.verdict==='AVOID'?'avoid':'hold';
  const vBadge=d.verdict==='BUY'?'verdict-buy':d.verdict==='AVOID'?'verdict-avoid':'verdict-hold';

  let priceHtml='';
  if(stockData&&stockData.price!=null){
    const hasChange=stockData.change!=null&&!isNaN(stockData.change)&&stockData.changePercent!=null&&!isNaN(stockData.changePercent);
    const chg=stockData.change>=0;
    const changeHtml=hasChange
      ?`<span class="stock-change ${chg?'up':'down'}">${chg?'+':''}${stockData.change} (${chg?'+':''}${stockData.changePercent}%)</span>`
      :'';
    priceHtml=`<div class="stock-price-row"><span class="stock-price">${stockData.currency==='INR'?'₹':'$'}${stockData.price.toFixed(2)}</span>
      ${changeHtml}
      <span style="font-size:12px;color:var(--text3);">${stockData.exchange||''}</span></div>`;
  }

  let chartHtml='';
  if(stockData?.chart?.close?.length){chartHtml=`<div class="chart-container"><div class="chart-header"><span class="chart-title">Price History (3M)</span></div><canvas class="chart-canvas" id="price-chart"></canvas></div>`;}

  let newsHtml='';
  if(news?.length){newsHtml=`<div class="news-box"><div class="section-title">📰 Latest News</div>${news.slice(0,5).map(n=>`<div class="news-item"><a href="${safeUrl(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><span class="news-source">${esc(n.source)}</span></div>`).join('')}</div>`;}

  const F=d.factors||{};
  // Factor-weighted composite breakdown
  const compBreakdown=`<div class="conf-breakdown"><div class="section-title">Factor Composite (Weighted)</div>
    <div class="conf-weights">
      ${Object.entries(FACTOR_WEIGHTS).map(([k,w])=>{const s=F[k]?.score;const shown=s==null?0:s;const weighted=s==null?'—':Math.round(s*w);const label={momentum:'Momentum',quality:'Quality',value:'Value',lowVol:'Low Volatility'}[k];return`<div class="cw-row"><span class="cw-label">${label}</span><span class="cw-weight">${Math.round(w*100)}%</span><div class="cw-bar"><div class="cw-fill" style="width:${shown}%;background:${scoreColor(shown)};"></div></div><span class="cw-score">${s==null?'n/a':s+' → '+weighted}</span></div>`;}).join('')}
      <div class="cw-row cw-total"><span class="cw-label"><strong>Composite Score</strong></span><span class="cw-weight"></span><div class="cw-bar"><div class="cw-fill" style="width:${conf}%;background:${scoreColor(conf)};"></div></div><span class="cw-score"><strong>${conf}</strong></span></div>
    </div></div>`;

  area.innerHTML=`<div class="result-card ${vClass}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
      <div><div class="stock-name">${esc(d.ticker)}</div><div class="stock-meta">${esc(d.fullName)} · ${esc(d.sector)}</div></div>
      <div style="text-align:right;">
        <span class="verdict-badge ${vBadge}" style="font-size:16px;padding:6px 18px;">${d.verdict}</span>
        <div class="conf-big" style="margin-top:6px;color:${scoreColor(conf)};">${conf}</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-top:2px;">Factor Score</div>
      </div>
    </div>
    ${priceHtml}
    ${d.fundamentalsSource?`<div style="margin:8px 0;"><span class="pill" style="font-size:11px;${d.fundamentalsSource==='estimated'?'background:rgba(192,106,75,0.12);color:var(--accent);':'background:rgba(127,166,99,0.12);color:var(--green);'}">${d.fundamentalsSource==='estimated'?'⚠ Price-only — fundamentals unavailable':'✓ Real fundamentals ('+esc(d.fundamentalsSource)+')'}</span></div>`:''}
    <div class="meta-pills">
      <span class="pill">📅 ${esc(d.horizon||'Medium-term')}</span>
      <span class="pill pill-${(d.riskLevel||'Medium').toLowerCase()}">⚡ ${esc(d.riskLevel||'Medium')} Risk</span>
      <span class="pill pill-green">📈 Est. Upside: ${esc(d.estimatedUpside||'N/A')}</span>
    </div>
    <p class="summary">${esc(d.summary)}</p>
    ${chartHtml}
    <div class="section-title" style="margin-bottom:12px;">🎯 Factor Analysis</div>
    <div class="agents-grid">
      ${factorCard('Momentum','🚀',F.momentum,'#C67C4E',momentumDetail(F.momentum))}
      ${factorCard('Quality','💎',F.quality,'#7FA663',null)}
      ${factorCard('Value','🏷️',F.value,'#6E8CA0',null)}
      ${factorCard('Low Volatility','🛡️',F.lowVol,'#A88BA3',volDetail(F.lowVol,d.annualizedVol))}
    </div>
    ${compBreakdown}
    ${d.newsSummary?`<div class="news-box"><div class="section-title">📰 News Context</div><p style="font-size:13px;color:var(--text2);line-height:1.6;">${esc(d.newsSummary)}</p></div>`:''}
    ${newsHtml}
    <div class="valuation-box"><span>Valuation: </span>${esc(d.priceContext||(d.fundamentals?`PE ${d.fundamentals.peRatio??'n/a'} · P/B ${d.fundamentals.pbRatio??'n/a'} · ROE ${d.fundamentals.roe!=null?d.fundamentals.roe+'%':'n/a'} · D/E ${d.fundamentals.debtToEquity??'n/a'}`:''))}</div>
    <div class="action-row">
      <button class="btn btn-green" onclick="approvePick()">✓ Add to Bouquet (₹10,000)</button>
      <button class="btn btn-red" onclick="skipPick()">✕ Skip</button>
      <button class="btn btn-ghost" onclick="resetAdvisor()">↺ New Search</button>
    </div></div>`;

  if(stockData?.chart?.close?.length)setTimeout(()=>drawChart(stockData.chart),100);
}

// Momentum detail line — shows the real computed returns
function momentumDetail(m){
  if(!m||m.score==null)return '<div style="font-size:11px;color:var(--text3);">Insufficient price history for momentum</div>';
  const parts=[];
  // New shape: m.detail.{r3,r6,r12} as decimals. Legacy: m.m3/m6/m12 as percents.
  const d=m.detail;
  const pct=(v)=>+(v*100).toFixed(1);
  if(d){
    if(d.r3!=null)parts.push(`3M ${d.r3>=0?'+':''}${pct(d.r3)}%`);
    if(d.r6!=null)parts.push(`6M ${d.r6>=0?'+':''}${pct(d.r6)}%`);
    if(d.r12!=null)parts.push(`12M ${d.r12>=0?'+':''}${pct(d.r12)}%`);
  } else {
    if(m.m3!=null)parts.push(`3M ${m.m3>=0?'+':''}${m.m3}%`);
    if(m.m6!=null)parts.push(`6M ${m.m6>=0?'+':''}${m.m6}%`);
    if(m.m12!=null)parts.push(`12M ${m.m12>=0?'+':''}${m.m12}%`);
  }
  if(!parts.length)return '<div style="font-size:11px;color:var(--text3);">Score from fundamentals (price history limited)</div>';
  return `<div class="factor-detail">📈 Real price momentum: ${parts.join(' · ')}</div>`;
}
function volDetail(lv,annualizedVol){
  if(!lv||lv.score==null)return '<div style="font-size:11px;color:var(--text3);">Insufficient data for volatility</div>';
  const v=annualizedVol!=null?annualizedVol:lv.vol; // new shape passes top-level annualizedVol
  if(v==null)return '<div style="font-size:11px;color:var(--text3);">Volatility unavailable</div>';
  return `<div class="factor-detail">📊 Annualized volatility: ${v}% ${v<18?'(low — stable)':v<30?'(moderate)':'(high)'}</div>`;
}

// Factor card renderer — like agentCard but for factors, with optional real-data detail
function factorCard(name,icon,data,color,detailHtml){
  if(!data)return'';
  const hasScore=data.score!=null;
  const barW=hasScore?Math.min(100,Math.max(0,data.score)):0;
  let subHtml='';
  if(data.subScores){
    subHtml=`<div class="sub-metrics">${Object.entries(data.subScores).map(([k,v])=>{
      const sc=Math.round(v||0);
      return`<div class="sub-metric"><span class="sm-label">${METRIC_LABELS[k]||k}</span><div class="sm-bar"><div class="sm-fill" style="width:${sc}%;background:${scoreColor(sc)};"></div></div><span class="sm-val">${sc}</span></div>`;
    }).join('')}</div>`;
  }
  return`<div class="agent-card">
    <div class="agent-header"><span class="agent-icon">${icon}</span><span class="agent-name">${name}</span><span class="agent-score" style="color:${color};">${hasScore?data.score+'/100':'n/a'}</span></div>
    <div class="agent-bar"><div class="agent-bar-fill" style="width:${barW}%;background:${color};"></div></div>
    ${detailHtml||''}
    ${subHtml}
    <div class="agent-points">
      ${(data.positives||[]).map(p=>`<div class="agent-point"><span class="ap-icon ap-pos">✔</span><span>${esc(p)}</span></div>`).join('')}
      ${(data.negatives||[]).map(p=>`<div class="agent-point"><span class="ap-icon ap-neg">✖</span><span>${esc(p)}</span></div>`).join('')}
    </div>
  </div>`;
}

// ─── Chart ───
function drawChart(cd){
  const canvas=document.getElementById('price-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height,pad={t:10,r:10,b:24,l:50};
  const closes=cd.close.filter(v=>v!=null);if(!closes.length)return;
  const min=Math.min(...closes)*0.98,max=Math.max(...closes)*1.02,xStep=(W-pad.l-pad.r)/(closes.length-1);
  const s=getComputedStyle(document.documentElement);
  ctx.strokeStyle=s.getPropertyValue('--chart-grid').trim();ctx.lineWidth=0.5;
  for(let i=0;i<5;i++){const y=pad.t+(H-pad.t-pad.b)*i/4;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke();ctx.fillStyle=s.getPropertyValue('--text3').trim();ctx.font='10px sans-serif';ctx.textAlign='right';ctx.fillText((max-(max-min)*i/4).toFixed(0),pad.l-6,y+3);}
  ctx.beginPath();ctx.strokeStyle=s.getPropertyValue('--chart-line').trim();ctx.lineWidth=2;ctx.lineJoin='round';
  closes.forEach((v,i)=>{const x=pad.l+i*xStep,y=pad.t+(1-(v-min)/(max-min))*(H-pad.t-pad.b);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
  ctx.stroke();const lx=pad.l+(closes.length-1)*xStep,g=ctx.createLinearGradient(0,pad.t,0,H-pad.b);
  g.addColorStop(0,s.getPropertyValue('--chart-line').trim()+'40');g.addColorStop(1,s.getPropertyValue('--chart-line').trim()+'00');
  ctx.lineTo(lx,H-pad.b);ctx.lineTo(pad.l,H-pad.b);ctx.closePath();ctx.fillStyle=g;ctx.fill();
}

// ─── Compare ───
document.getElementById('compare-btn')?.addEventListener('click',async()=>{
  const a=document.getElementById('compare-a').value.trim(),b=document.getElementById('compare-b').value.trim();
  if(!a||!b)return;const area=document.getElementById('compare-result');
  area.innerHTML=`<div class="loading-wrap"><div class="spinner"></div><p>Comparing <strong>${esc(a)}</strong> vs <strong>${esc(b)}</strong> on 4 factors…</p></div>`;
  try{
    const[rA,sA,rB,sB]=await Promise.all([callAI(a),fetchStock(a,'1y'),callAI(b),fetchStock(b,'1y')]);
    const dA=parseResult(rA,a,sA?.chart),dB=parseResult(rB,b,sB?.chart);
    const FL={momentum:'Momentum',quality:'Quality',value:'Value',lowVol:'Low Vol'};
    const miniCard=d=>{const F=d.factors||{};return`<div class="result-card ${d.verdict==='BUY'?'buy':d.verdict==='AVOID'?'avoid':'hold'}">
      <div style="display:flex;justify-content:space-between;"><div><div class="stock-name" style="font-size:18px;">${esc(d.ticker)}</div><div class="stock-meta">${esc(d.fullName)}</div></div>
      <div style="text-align:right;"><span class="verdict-badge ${d.verdict==='BUY'?'verdict-buy':d.verdict==='AVOID'?'verdict-avoid':'verdict-hold'}">${d.verdict}</span><div style="font-size:24px;font-weight:700;color:${scoreColor(d.composite)};">${d.composite}</div></div></div>
      <div class="meta-pills" style="margin-top:12px;"><span class="pill">📈 ${esc(d.estimatedUpside||'N/A')}</span><span class="pill">⚡ ${esc(d.riskLevel||'Medium')}</span></div>
      <div class="agents-mini">${['momentum','quality','value','lowVol'].map(k=>{const s=F[k]?.score;const shown=s==null?0:s;return`<div class="am-row"><span>${FL[k]}</span><div class="am-bar"><div style="width:${shown}%;background:${scoreColor(shown)};height:100%;border-radius:3px;"></div></div><span>${s==null?'—':s}</span></div>`;}).join('')}</div>
      <p class="summary" style="margin-top:12px;font-size:13px;">${esc(d.summary)}</p></div>`;};
    const winner=dA.composite>dB.composite?dA:dB;
    area.innerHTML=`<div class="result-card" style="border-left:3px solid var(--accent);margin-bottom:16px;padding:14px 20px;">
      <span style="font-size:14px;">🏆 <strong>${esc(winner.ticker)}</strong> wins with factor score ${winner.composite} vs ${(winner===dA?dB:dA).composite}</span></div>
      <div class="compare-grid">${miniCard(dA)}${miniCard(dB)}</div>`;
  }catch(err){area.innerHTML=`<div class="error-card"><div class="error-title">⚠ Failed</div><div class="error-msg">${esc(err.message)}</div></div>`;}
});

// ─── Bouquet with real entry price ───
async function approvePick(){
  if(!currentAnalysis)return;
  if(bouquet.find(b=>b.ticker===currentAnalysis.ticker)){showToast(currentAnalysis.ticker+' already in bouquet','warn');return;}
  const ticker=currentAnalysis.ticker;
  const entry={...currentAnalysis,addedAt:new Date().toISOString(),investedAmount:10000};
  // Capture real entry price now so returns are real, not simulated
  const sd=await fetchStock(ticker);
  if(sd&&sd.price!=null){
    entry.entryPrice=+sd.price.toFixed(2);
    entry.currentPrice=+sd.price.toFixed(2);
    entry.shares=+(10000/sd.price).toFixed(3);
    entry.prevClose=sd.previousClose??null;
    entry.yahooSymbol=sd.symbol||null;
    entry.lastPriceUpdate=new Date().toISOString();
    entry.entryPriceProvisional=false;
  }
  bouquet.push(entry);save();showToast(ticker+' added with ₹10,000 virtual investment! 🌸');
  const area=document.getElementById('result-area');const n=document.createElement('div');n.className='result-card';n.style.cssText='border-left:3px solid var(--green);display:flex;align-items:center;gap:10px;';
  n.innerHTML=`<span style="font-size:20px">✅</span><span><strong>${esc(ticker)}</strong> added with ₹10,000${entry.entryPrice?' @ ₹'+entry.entryPrice:''}. Check <strong>My Bouquet</strong>.</span>`;area.appendChild(n);
}
function skipPick(){currentAnalysis=null;document.getElementById('result-area').innerHTML='<p style="color:var(--text3);padding:8px 0;">Skipped.</p>';}
function resetAdvisor(){currentAnalysis=null;document.getElementById('result-area').innerHTML='';document.getElementById('stock-input').value='';document.getElementById('stock-input').focus();}

// Returns real % gain if we have prices, else null (never fabricated)
function realGain(item){
  if(item.entryPrice&&item.currentPrice&&item.entryPrice>0){
    return+(((item.currentPrice-item.entryPrice)/item.entryPrice)*100).toFixed(1);
  }
  return null;
}
// Back-compat alias — some call sites still reference simGain
function simGain(item){const g=realGain(item);return g==null?0:g;}

let personalPricesFetchedAt=0;
async function refreshPersonalPrices(){
  const withEntry=bouquet.filter(b=>b.entryPrice&&b.yahooSymbol);
  if(!withEntry.length)return;
  if(Date.now()-personalPricesFetchedAt<60000)return; // throttle to once/min
  personalPricesFetchedAt=Date.now();
  await Promise.all(withEntry.map(async b=>{
    try{
      const sd=await fetchStock(b.yahooSymbol||b.ticker);
      if(sd&&sd.price!=null){
        b.currentPrice=+sd.price.toFixed(2);
        b.todayChangePct=(sd.changePercent!=null&&!isNaN(sd.changePercent))?sd.changePercent:b.todayChangePct;
        b.lastPriceUpdate=new Date().toISOString();
      }
    }catch{}
  }));
  save();
}

const COLORS=['#C67C4E','#7FA663','#D19A5B','#A88BA3','#6E8CA0','#B4663A','#C25B4E','#9C8E7F','#8C6F87','#5E7D45'];

let projectBouquet=[];
let projectBouquetFetchedAt=0;
async function getProjectBouquet(force){
  const stale=Date.now()-projectBouquetFetchedAt>60000; // refetch if older than 60s
  if(force||stale||!projectBouquet.length){
    const fresh=await fetchProjectBouquet();
    if(fresh.length||force){projectBouquet=fresh;projectBouquetFetchedAt=Date.now();}
  }
  return projectBouquet;
}
let bouquetView='all'; // 'all' | 'daily' | 'personal'

async function renderBouquet(){
  const el=document.getElementById('bouquet-content');
  // Fetch shared project bouquet (daily picks) — TTL-aware, refreshes if stale
  await getProjectBouquet();
  // Refresh personal picks' live prices (they live in localStorage, not touched by the cron)
  await refreshPersonalPrices();
  // Closed/realized trades (daily picks that were sold) — shown below open holdings
  const realizedTrades=bouquetView==='personal'?[]:await fetchRealized();

  // Tag sources
  const dailyPicks=projectBouquet.map(b=>({...b,source:'daily'}));
  const personalPicks=bouquet.map(b=>({...b,source:'personal'}));
  let combined;
  if(bouquetView==='daily')combined=dailyPicks;
  else if(bouquetView==='personal')combined=personalPicks;
  else combined=[...dailyPicks,...personalPicks];

  const toggle=`<div style="display:flex;gap:6px;margin-bottom:18px;">
    ${[['all','All'],['daily','⭐ Daily Picks'],['personal','My Picks']].map(([v,l])=>`<button class="btn ${bouquetView===v?'btn-primary':'btn-ghost'}" style="padding:7px 14px;font-size:13px;" onclick="setBouquetView('${v}')">${l}</button>`).join('')}</div>`;

  if(!combined.length){el.innerHTML=toggle+'<div class="empty-state"><div class="empty-icon">🌸</div><h3>No stocks yet</h3><p>Daily picks are added automatically each morning. Analyze a stock to add your own.</p></div>'+renderRealizedSection(realizedTrades);return;}

  const work=combined;
  // A pick is "pending" ONLY if it has no entry price yet. If it has an entry but no
  // current price (e.g. a refresh got rate-limited), treat current = entry (0% so far)
  // rather than showing "updating" — the entry is locked, the return is just 0 until refresh.
  const gainInfo=work.map(item=>{
    if(!item.entryPrice||item.entryPrice<=0)return{gain:0,real:false,pending:true};
    const cur=item.currentPrice||item.entryPrice;
    const g=+(((cur-item.entryPrice)/item.entryPrice)*100).toFixed(1);
    return{gain:g,real:true,pending:false};
  });
  const totalInvested=work.reduce((a,b)=>a+(b.investedAmount||10000),0);
  const totalValue=work.reduce((a,b,i)=>a+(b.investedAmount||10000)*(1+(gainInfo[i].pending?0:gainInfo[i].gain)/100),0);
  const totalReturn=((totalValue-totalInvested)/totalInvested*100).toFixed(1);
  const sectors={};work.forEach(b=>{const s=b.sector||'Other';sectors[s]=(sectors[s]||0)+1;});
  const sectorEntries=Object.entries(sectors).sort((a,b)=>b[1]-a[1]);

  let pieHtml='';
  if(sectorEntries.length>1){
    let angle=0;const total=work.length;
    const slices=sectorEntries.map((s,i)=>{const pct=s[1]/total;const start=angle;angle+=pct*360;
      const sr=(start-90)*Math.PI/180,er=(angle-90)*Math.PI/180;
      const x1=50+40*Math.cos(sr),y1=50+40*Math.sin(sr),x2=50+40*Math.cos(er),y2=50+40*Math.sin(er);
      return{path:`<path d="M50,50 L${x1},${y1} A40,40 0 ${pct>0.5?1:0},1 ${x2},${y2} Z" fill="${COLORS[i%COLORS.length]}"/>`,label:s[0],count:s[1],color:COLORS[i%COLORS.length]};
    });
    pieHtml=`<div class="sector-chart"><div class="section-title">Sector Breakdown</div><div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
      <svg viewBox="0 0 100 100" width="120" height="120">${slices.map(s=>s.path).join('')}</svg>
      <div class="sector-legend">${slices.map(s=>`<div class="sector-legend-item"><div class="sector-dot" style="background:${s.color};"></div>${esc(s.label)} (${s.count})</div>`).join('')}</div></div></div>`;
  }

  const allReal=work.every((_,i)=>gainInfo[i].real);
  const valueLabel=allReal?'Current Value':'Current Value (partial)';

  el.innerHTML=toggle+`<div class="summary-tiles">
    <div class="summary-tile"><div class="tile-num">${work.length}</div><div class="tile-lbl">Stocks</div></div>
    <div class="summary-tile"><div class="tile-num">₹${totalInvested.toLocaleString('en-IN')}</div><div class="tile-lbl">Invested</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:${parseFloat(totalReturn)>=0?'var(--green)':'var(--red)'};">₹${Math.round(totalValue).toLocaleString('en-IN')}</div><div class="tile-lbl">${valueLabel}</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:${parseFloat(totalReturn)>=0?'var(--green)':'var(--red)'};">${parseFloat(totalReturn)>=0?'+':''}${totalReturn}%</div><div class="tile-lbl">Total Return</div></div>
  </div>${pieHtml}
  <div class="bouquet-list">${work.map((item,i)=>{
    const gi=gainInfo[i];
    const days=Math.max(1,Math.floor((Date.now()-new Date(item.addedAt||item.date).getTime())/86400000));
    const vB=item.verdict==='BUY'?'verdict-buy':item.verdict==='AVOID'?'verdict-avoid':'verdict-hold';
    const srcTag=item.source==='daily'?'<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:6px;">⭐ DAILY</span>':'';
    const pendingTag=item.status==='SELL_PENDING'?`<span class="sell-pending-tag" title="${esc(item.exitReason||'')}">● SELL PENDING</span>`:'';
    const removeBtn=item.source==='personal'?`<button class="bi-remove" onclick="removePersonalPick('${esc(item.ticker)}')">✕</button>`:'<span style="width:28px;"></span>';
    let metaLine,gainCell;
    if(gi.pending){
      metaLine=`${days}d · entry price updating…`;
      gainCell=`<div class="bi-gain" style="color:var(--text3);font-size:12px;">—</div>`;
    }else{
      const shares=item.shares||(item.entryPrice>0?(item.investedAmount||10000)/item.entryPrice:0);
      const cur=item.currentPrice||item.entryPrice;
      const todayTxt=item.todayChangePct!=null?` · today ${item.todayChangePct>=0?'+':''}${item.todayChangePct}%`:'';
      metaLine=`${shares.toFixed(2)} sh @ ₹${item.entryPrice} → ₹${cur}${todayTxt}`;
      gainCell=`<div class="bi-gain ${gi.gain>=0?'up':'down'}">${gi.gain>0?'+':''}${gi.gain}%</div>`;
    }
    return`<div class="bouquet-item${item.status==='SELL_PENDING'?' bi-pending':''}"><div class="bi-info"><div class="bi-ticker">${esc(item.ticker)}${srcTag}${pendingTag}</div>
      <div class="bi-meta">${metaLine}${item.status==='SELL_PENDING'&&item.exitReason?` · <em style="color:var(--accent);">${esc(item.exitReason)}</em>`:''}</div></div>
      <span class="verdict-badge ${vB}" style="font-size:11px;padding:2px 10px;">${item.verdict}</span>
      ${gainCell}
      ${removeBtn}</div>`;
  }).join('')}<div class="sim-note">Real NSE prices · ₹10,000 per pick · educational tracking only${(()=>{const lu=work.map(w=>w.lastPriceUpdate).filter(Boolean).sort().pop();return lu?' · updated '+timeAgo(lu):'';})()}</div></div>`+renderRealizedSection(realizedTrades);
}
function timeAgo(iso){const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);if(s<3600)return Math.max(1,Math.floor(s/60))+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function setBouquetView(v){bouquetView=v;renderBouquet();}
function removePersonalPick(ticker){const i=bouquet.findIndex(b=>b.ticker===ticker);if(i>=0){bouquet.splice(i,1);save();renderBouquet();}}
function removePick(i){bouquet.splice(i,1);save();renderBouquet();}

// ─── Dashboard ───
async function renderDashboard(){
  const el=document.getElementById('dashboard-content');
  // Pull the shared daily picks (real performance) alongside personal analysis history
  const daily=await getProjectBouquet();
  const pricedDaily=daily.filter(d=>d.entryPrice&&d.currentPrice&&d.entryPrice>0);

  const hasHistory=history.length>=1;
  const hasDaily=daily.length>=1;
  if(!hasHistory&&!hasDaily){el.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div><h3>Need more data</h3><p>Analyze stocks or wait for daily picks to see performance stats.</p></div>';return;}

  // Real daily-pick performance
  let dailyPerfHtml='';
  if(hasDaily){
    const realGains=pricedDaily.map(d=>((d.currentPrice-d.entryPrice)/d.entryPrice)*100);
    const dWins=realGains.filter(g=>g>0).length;
    const dWinRate=realGains.length?Math.round(dWins/realGains.length*100):0;
    const dAvg=realGains.length?(realGains.reduce((a,b)=>a+b,0)/realGains.length):0;
    const totalInv=pricedDaily.length*10000;
    const totalVal=pricedDaily.reduce((a,d)=>a+10000*(1+((d.currentPrice-d.entryPrice)/d.entryPrice)),0);
    const totalRet=totalInv?((totalVal-totalInv)/totalInv*100):0;
    const best=realGains.length?Math.max(...realGains):0;
    const worst=realGains.length?Math.min(...realGains):0;
    // Alpha: how much the picks beat (or lagged) the Nifty over the same periods
    const withNifty=pricedDaily.filter(d=>d.niftyAtEntry&&d.niftyNow&&d.niftyAtEntry>0);
    let alphaHtml='';
    if(withNifty.length){
      const pickRet=withNifty.map(d=>((d.currentPrice-d.entryPrice)/d.entryPrice)*100);
      const niftyRet=withNifty.map(d=>((d.niftyNow-d.niftyAtEntry)/d.niftyAtEntry)*100);
      const avgPick=pickRet.reduce((a,b)=>a+b,0)/pickRet.length;
      const avgNifty=niftyRet.reduce((a,b)=>a+b,0)/niftyRet.length;
      const alpha=avgPick-avgNifty;
      const beatCount=pickRet.filter((r,i)=>r>niftyRet[i]).length;
      alphaHtml=`<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">📈 vs Nifty 50 Benchmark</div>
        <div class="dash-metrics">
          <div class="dm-item"><div class="dm-val" style="color:${avgPick>=0?'var(--green)':'var(--red)'};">${avgPick>=0?'+':''}${avgPick.toFixed(1)}%</div><div class="dm-lbl">Picks Avg</div></div>
          <div class="dm-item"><div class="dm-val" style="color:${avgNifty>=0?'var(--green)':'var(--red)'};">${avgNifty>=0?'+':''}${avgNifty.toFixed(1)}%</div><div class="dm-lbl">Nifty Avg</div></div>
          <div class="dm-item"><div class="dm-val" style="color:${alpha>=0?'var(--green)':'var(--red)'};">${alpha>=0?'+':''}${alpha.toFixed(1)}%</div><div class="dm-lbl">Alpha (edge)</div></div>
          <div class="dm-item"><div class="dm-val">${beatCount}/${withNifty.length}</div><div class="dm-lbl">Beat Market</div></div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:10px;line-height:1.5;">${alpha>=0?'✓ Picks are outperforming the index':'⚠ Picks are lagging the index — the market would have done better'} over the same periods.</div>
      </div>`;
    }
    dailyPerfHtml=`<div class="result-card" style="margin-bottom:16px;border-top:2px solid var(--accent);">
      <div class="section-title">⭐ Daily Picks — Real Performance</div>
      <div class="dash-metrics">
        <div class="dm-item"><div class="dm-val">${daily.length}</div><div class="dm-lbl">Total Picks</div></div>
        <div class="dm-item"><div class="dm-val" style="color:${dWinRate>=50?'var(--green)':'var(--red)'};">${dWinRate}%</div><div class="dm-lbl">Win Rate (real)</div></div>
        <div class="dm-item"><div class="dm-val" style="color:${totalRet>=0?'var(--green)':'var(--red)'};">${totalRet>=0?'+':''}${totalRet.toFixed(1)}%</div><div class="dm-lbl">Total Return</div></div>
        <div class="dm-item"><div class="dm-val" style="color:${dAvg>=0?'var(--green)':'var(--red)'};">${dAvg>=0?'+':''}${dAvg.toFixed(1)}%</div><div class="dm-lbl">Avg / Pick</div></div>
      </div>
      ${pricedDaily.length?`<div style="display:flex;gap:16px;margin-top:14px;font-size:12px;color:var(--text3);">
        <span>🟢 Best: <strong style="color:var(--green);">+${best.toFixed(1)}%</strong></span>
        <span>🔴 Worst: <strong style="color:var(--red);">${worst.toFixed(1)}%</strong></span>
        <span>💰 ₹${Math.round(totalVal).toLocaleString('en-IN')} of ₹${totalInv.toLocaleString('en-IN')}</span>
      </div>`:'<div style="font-size:12px;color:var(--text3);margin-top:12px;">Prices updating — real returns appear after the next market close.</div>'}
      ${alphaHtml}
    </div>`;
  }

  // Personal analysis stats (verdict distribution + confidence)
  let personalHtml='';
  if(hasHistory){
    const buys=history.filter(h=>h.verdict==='BUY'),holds=history.filter(h=>h.verdict==='HOLD'),avoids=history.filter(h=>h.verdict==='AVOID');
    const avgConf=Math.round(history.reduce((a,h)=>a+(h.confidence||0),0)/history.length);
    const highConf=history.filter(h=>h.confidence>=80);
    personalHtml=`<div class="summary-tiles">
      <div class="summary-tile"><div class="tile-num">${history.length}</div><div class="tile-lbl">Analyzed</div></div>
      <div class="summary-tile"><div class="tile-num" style="color:var(--green);">${buys.length}</div><div class="tile-lbl">BUY</div></div>
      <div class="summary-tile"><div class="tile-num" style="color:var(--amber);">${holds.length}</div><div class="tile-lbl">HOLD</div></div>
      <div class="summary-tile"><div class="tile-num" style="color:var(--red);">${avoids.length}</div><div class="tile-lbl">AVOID</div></div>
    </div>
    <div class="result-card" style="margin-bottom:16px;">
      <div class="section-title">📊 Your Analysis Stats</div>
      <div class="dash-metrics">
        <div class="dm-item"><div class="dm-val">${avgConf}%</div><div class="dm-lbl">Avg Confidence</div></div>
        <div class="dm-item"><div class="dm-val">${highConf.length}</div><div class="dm-lbl">High Conf (80%+)</div></div>
        <div class="dm-item"><div class="dm-val">${buys.length}</div><div class="dm-lbl">Buy Signals</div></div>
        <div class="dm-item"><div class="dm-val">${history.length}</div><div class="dm-lbl">Total</div></div>
      </div>
    </div>
    <div class="result-card"><div class="section-title">🎯 Confidence Distribution</div>
      <div class="conf-dist">${[[90,100,'🔥'],[80,89,'🟢'],[70,79,'🟡'],[60,69,'🟠'],[0,59,'🔴']].map(([lo,hi,em])=>{
        const count=history.filter(h=>h.confidence>=lo&&h.confidence<=hi).length;
        const pct=history.length?Math.round(count/history.length*100):0;
        return`<div class="cd-row"><span class="cd-label">${em} ${lo}-${hi}%</span><div class="cd-bar"><div style="width:${pct}%;background:${lo>=70?'var(--green)':lo>=50?'var(--amber)':'var(--red)'};height:100%;border-radius:3px;"></div></div><span class="cd-count">${count} (${pct}%)</span></div>`;
      }).join('')}</div></div>`;
  }

  el.innerHTML=dailyPerfHtml+personalHtml+`<div class="disclaimer-box">📌 Returns shown are for educational tracking only. Daily-pick returns use real NSE prices; this is not investment advice.</div>`;
}


// ─── Export ───
document.getElementById('export-csv-btn')?.addEventListener('click',async()=>{
  await getProjectBouquet();
  const rows=[...projectBouquet.map(b=>({...b,src:'Daily'})),...bouquet.map(b=>({...b,src:'Personal'}))];
  if(!rows.length){showToast('No stocks','warn');return;}
  // Prevent CSV injection: prefix cells that start with = + - @ with a quote
  const cell=v=>{let s=String(v==null?'':v);if(/^[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  let csv='Source,Ticker,Company,Sector,Verdict,Confidence,EntryPrice,CurrentPrice,Shares,Return%,TodayChange%,Invested,Value,Added\n';
  rows.forEach(b=>{
    const g=realGain(b);const amt=b.investedAmount||10000;
    const val=g!=null?Math.round(amt*(1+g/100)):amt;
    const conf=universalScore(b);
    csv+=[cell(b.src),cell(b.ticker),cell(b.fullName||''),cell(b.sector||''),cell(b.verdict||''),cell(conf),cell(b.entryPrice||''),cell(b.currentPrice||''),cell(b.shares||''),cell(g!=null?g:''),cell(b.todayChangePct!=null?b.todayChangePct:''),cell(amt),cell(val),cell(b.addedAt||b.date||'')].join(',')+'\n';
  });
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`stockadvisor-${new Date().toISOString().slice(0,10)}.csv`;a.click();showToast('CSV exported!');
});

// ─── Toast ───
function showToast(msg,type='success'){let t=document.getElementById('toast');if(!t){t=document.createElement('div');t.className='toast';t.id='toast';document.body.appendChild(t);}t.textContent=msg;t.style.borderLeftColor=type==='warn'?'var(--amber)':'var(--green)';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}

// ─── Events ───
document.getElementById('stock-input').addEventListener('keydown',e=>{if(e.key==='Enter')analyzeStock();});
document.getElementById('analyze-btn').addEventListener('click',analyzeStock);

// ═══ STOCK OF THE DAY ═══
let sotdPick=null;

async function fetchDailyPick(){
  try{
    const r=await fetch('/data/daily-pick.json?t='+Date.now());
    if(!r.ok)return null;
    const d=await r.json();
    return d.pick||null;
  }catch{return null;}
}

async function fetchProjectBouquet(){
  try{
    const r=await fetch('/data/project-bouquet.json?t='+Date.now());
    if(!r.ok)return[];
    const d=await r.json();
    return d.bouquet||[];
  }catch{return[];}
}

async function fetchRealized(){
  try{
    const r=await fetch('/data/realized.json?t='+Date.now());
    if(!r.ok)return[];
    const d=await r.json();
    return Array.isArray(d.trades)?d.trades:[];
  }catch{return[];}
}
function renderRealizedSection(trades){
  if(!trades||!trades.length)return'';
  const total=trades.reduce((a,t)=>a+(t.realizedPnl||0),0);
  const tc=total>=0?'var(--green)':'var(--red)';
  const rows=[...trades].reverse().map(t=>{
    const pc=t.realizedPnlPct>=0?'up':'down';
    const srcBadge=`<span class="rz-src">${esc((t.exitSource||'auto').toUpperCase())}</span>`;
    return`<div class="rz-item"><div class="rz-info">
      <div class="rz-ticker">${esc(t.ticker)} <span class="rz-dates">${esc(t.entryDate||'')} → ${esc(t.exitDate||'')}</span></div>
      <div class="rz-meta">₹${t.entryPrice} → ₹${t.exitPrice}${t.exitReason?` · ${srcBadge}<em>${esc(t.exitReason)}</em>`:''}</div></div>
      <div class="rz-pnl ${pc}">${t.realizedPnlPct>=0?'+':''}${t.realizedPnlPct}%</div></div>`;
  }).join('');
  return`<div class="realized-section">
    <div class="rz-head"><div class="section-title" style="margin:0;">Realized</div>
      <div class="rz-total">Booked P&L <strong style="color:${tc};">${total>=0?'+':''}₹${Math.round(total).toLocaleString('en-IN')}</strong></div></div>
    <div class="realized-list">${rows}</div></div>`;
}

async function checkSotd(){
  const pick=await fetchDailyPick();
  sotdPick=pick||null;
  // Only a real, actionable buy is "NEW" — a no-trade scan has nothing to pop up.
  const isRealPick=pick&&pick.ticker&&!pick.noTrade&&!pick.entryRejected;
  const badge=document.getElementById('daily-badge');
  if(badge)badge.textContent=isRealPick?'NEW':'';
  if(isRealPick){
    const seen=localStorage.getItem('sotd_seen');
    if(seen!==pick.date)showSotdPopup(pick);
  }
  // Always (re)render the AI Pick tab — it features the latest bought stock or the watchlist.
  renderDailyTab(pick);
}

function showSotdPopup(pick){
  const body=document.getElementById('sotd-body');
  const conf=universalScore(pick);
  if(pick.composite==null)pick.composite=conf;
  if(!pick.verdict)pick.verdict=computeVerdict(conf);
  body.innerHTML=`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">${pick.date} · AI Pick</div>
      <div class="stock-name" style="font-size:30px;">${esc(pick.ticker)}</div>
      <div class="stock-meta">${esc(pick.fullName)} · ${esc(pick.sector)}</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:16px;">
        <span class="verdict-badge verdict-buy" style="font-size:15px;padding:6px 18px;">${pick.verdict}</span>
        <div class="conf-big" style="color:${scoreColor(conf)};">${conf}</div>
      </div>
    </div>
    <div class="valuation-box" style="margin-bottom:16px;"><span>Why today: </span>${esc(pick.whyToday||pick.summary)}</div>
    <p class="summary" style="margin-bottom:16px;">${esc(pick.summary)}</p>
    <div class="meta-pills" style="justify-content:center;margin-bottom:18px;">
      <span class="pill pill-green">📈 ${esc(pick.estimatedUpside||'')}</span>
      <span class="pill pill-${(pick.riskLevel||'Medium').toLowerCase()}">⚡ ${esc(pick.riskLevel||'')} Risk</span>
      <span class="pill">📅 ${esc(pick.horizon||'')}</span>
    </div>
    <div style="background:var(--accent-dim);border:1px solid var(--border-glow);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--text2);text-align:center;margin-bottom:18px;">
      ✓ Auto-added to the project portfolio with ₹${Number(pick.investedAmount||10000).toLocaleString('en-IN')} paper investment
    </div>
    <button class="btn btn-primary" style="width:100%;" onclick="dismissSotd();switchTab('daily');">View Full Analysis →</button>`;
  document.getElementById('sotd-modal').classList.add('open');
}

function dismissSotd(){
  document.getElementById('sotd-modal').classList.remove('open');
  if(sotdPick)localStorage.setItem('sotd_seen',sotdPick.date);
  const badge=document.getElementById('daily-badge');
  if(badge)badge.textContent='';
}

// Quality-momentum factor labels (the shape the hourly buy-scan now emits).
const QM_FACTOR_LABELS=[['momentum','Momentum'],['relStrength','Rel. Strength'],['volume','Volume'],['catalyst','Catalyst'],['technicals','Technicals'],['sector','Sector']];

// Featured "AI Pick" card — renders the latest bought stock (or a fresh pick) using the
// quality-momentum fields the engine actually produces (confidence, per-signal scores,
// catalyst, regime, reward/risk, live return). Works for both a bouquet entry and a raw pick.
function featuredPickCard(p){
  const conf=Math.round(p.effectiveConfidence??p.confidence??p.composite??universalScore(p));
  const verdict=p.entryRejected?'NOT TRADED':(p.entryPrice?'ACTIVE':(p.verdict||computeVerdict(conf)));
  const vBadge=verdict==='BUY'?'verdict-buy':verdict==='AVOID'?'verdict-avoid':'verdict-hold';
  const vClass=verdict==='BUY'?'buy':verdict==='AVOID'?'avoid':'hold';
  const cur=p.currentPrice||p.entryPrice;
  const gain=(p.entryPrice&&cur&&p.entryPrice>0)?((cur-p.entryPrice)/p.entryPrice*100):null;
  const F=p.factors||{};
  const factorRows=QM_FACTOR_LABELS.map(([k,lbl])=>{
    const raw=F[k]; const s=(raw&&typeof raw==='object')?raw.score:raw;
    if(s==null)return '';
    const shown=Math.max(0,Math.min(100,s));
    return`<div class="cw-row"><span class="cw-label">${lbl}</span><div class="cw-bar"><div class="cw-fill" style="width:${shown}%;background:${scoreColor(shown)};"></div></div><span class="cw-score">${s}</span></div>`;
  }).join('');
  const cat=p.catalyst;
  const catHtml=(cat&&cat.type)?`<div class="valuation-box"><span>Catalyst: </span>${esc(cat.type)}${cat.verification?` · <strong style="color:${cat.verification==='VERIFIED'?'var(--green)':'var(--amber)'};">${esc(cat.verification)}</strong>`:''}${cat.summary?` — ${esc(cat.summary)}`:''}</div>`:'';
  const priceHtml=p.entryPrice?`<div class="stock-price-row"><span class="stock-price">₹${cur}</span>${gain!=null?`<span class="stock-change ${gain>=0?'up':'down'}">${gain>=0?'+':''}${gain.toFixed(2)}%</span>`:''}<span style="font-size:12px;color:var(--text3);">entry ₹${p.entryPrice}</span></div>`:'';
  const pills=[
    p.entryLane==='momentum'?`<span class="pill pill-medium">⚡ Momentum entry · tighter stops</span>`:'',
    p.regime?`<span class="pill">🌐 ${esc(p.regime)} market</span>`:'',
    (p.rewardRisk&&p.rewardRisk.rr)?`<span class="pill pill-green">⚖ R/R ${p.rewardRisk.rr}</span>`:'',
    p.riskLevel?`<span class="pill pill-${String(p.riskLevel).toLowerCase()}">⚡ ${esc(p.riskLevel)} Risk</span>`:'',
    p.estimatedUpside?`<span class="pill">📈 ${esc(p.estimatedUpside)}</span>`:''
  ].filter(Boolean).join('');
  return`<div class="result-card ${vClass}">
    <div class="ai-pick-head">
      <div style="min-width:0;">
        <div class="pick-eyebrow"><span class="pick-live">Latest AI Pick</span>${p.date?' · '+esc(p.date):''}</div>
        <div class="stock-name" style="margin-top:8px;">${esc(p.ticker)}</div>
        <div class="stock-meta">${esc(p.fullName||'')}${p.sector?' · '+esc(p.sector):''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <span class="verdict-badge ${vBadge}">${verdict}</span>
        <div class="conf-big" style="color:${scoreColor(conf)};margin-top:8px;">${conf}</div>
        <div class="pick-eyebrow" style="margin-top:2px;">Confidence</div>
      </div>
    </div>
    ${priceHtml}
    ${pills?`<div class="meta-pills">${pills}</div>`:''}
    ${p.entryRejected?`<div class="valuation-box"><span>Not entered: </span>${esc(p.entryRejected)}</div>`:''}
    ${p.whyToday?`<div class="valuation-box"><span>Why: </span>${esc(p.whyToday)}</div>`:''}
    ${p.summary?`<p class="summary">${esc(p.summary)}</p>`:''}
    ${catHtml}
    ${factorRows?`<div class="conf-breakdown"><div class="section-title">Signal Breakdown</div><div class="conf-weights">${factorRows}</div></div>`:''}
  </div>`;
}

// "No trade" view — the engine is selective, so most scans hold out. Surface the top-5
// candidates it evaluated (ranked by effective confidence) with WHY each fell short.
function consideredCard(pick){
  const list=[...(pick.considered||[])]
    .sort((a,b)=>((b.effectiveConfidence??b.confidence??0)-(a.effectiveConfidence??a.confidence??0)))
    .slice(0,5);
  const rows=list.map((c,i)=>{
    const conf=Math.round(c.effectiveConfidence??c.confidence??0);
    const relvol=c.relVol!=null?(+c.relVol).toFixed(1)+'×':'—';
    const cat=c.catalyst?esc(c.catalyst):'no catalyst';
    const ver=c.verification&&c.verification!=='UNVERIFIED'?' · '+esc(c.verification):'';
    const inst=c.institutional!=null?Math.round(c.institutional):'—';
    return`<div class="cand-row">
      <div class="cand-rank">${i+1}</div>
      <div class="cand-main"><div class="cand-tkr">${esc(c.ticker)}</div>
        <div class="cand-sub">RVOL ${relvol} · ${cat}${ver}${c.negative?' · ⚠ negative':''}</div></div>
      <div class="cand-metrics"><div class="cand-conf" style="color:${scoreColor(conf)};">${conf}</div><div class="cand-lbl">conf</div></div>
      <div class="cand-metrics"><div class="cand-conf">${inst}</div><div class="cand-lbl">inst</div></div>
    </div>`;
  }).join('')||'<div style="color:var(--text3);font-size:13px;padding:8px 0;">No candidates in the last scan.</div>';
  return`<div class="result-card hold">
    <div class="pick-eyebrow" style="color:var(--amber);">◆ No trade right now</div>
    <div class="stock-name" style="font-size:21px;margin:8px 0 4px;">Top candidates being watched</div>
    <div class="stock-meta" style="margin-bottom:16px;">${esc(pick.reason||"Holding out for a verified catalyst plus confirmed volume.")}</div>
    <div class="cand-list">${rows}</div>
    ${pick.market?`<div class="valuation-box" style="margin-top:16px;"><span>Market: </span>${esc(pick.market)}</div>`:''}
  </div>`;
}

// AI Pick tab: feature the LATEST stock actually added to the bouquet; if none, show the
// engine's current top-5 watchlist from the latest scan. History table below either way.
async function renderDailyTab(pick){
  const el=document.getElementById('daily-content');
  const picks=await getProjectBouquet();
  // Most-recent buy = latest by date, then addedAt.
  const sorted=[...picks].sort((a,b)=>(String(b.date||'')+String(b.addedAt||'')).localeCompare(String(a.date||'')+String(a.addedAt||'')));
  const latest=sorted[0]||null;

  let html='';
  if(latest){
    html+=featuredPickCard(latest);
    // If the most recent SCAN found no new trade, still surface what it's watching now.
    if(pick&&pick.noTrade&&Array.isArray(pick.considered)&&pick.considered.length){
      html+=consideredCard(pick);
    }
  } else if(pick&&Array.isArray(pick.considered)&&pick.considered.length){
    html+=consideredCard(pick);
  } else if(pick&&!pick.noTrade&&pick.ticker){
    html+=featuredPickCard(pick);
  } else {
    html+='<div class="empty-state"><div class="empty-icon">🤖</div><h3>No pick yet</h3><p>The engine scans every market hour and only buys on a verified catalyst with confirmed volume. Nothing has qualified yet.</p></div>';
  }
  el.innerHTML=html;
  // POTD history table + consolidated totals.
  el.insertAdjacentHTML('beforeend', buildPotdHistory(picks));
}

function buildPotdHistory(picks){
  if(!picks||!picks.length)return '';
  // Sort newest first by date
  const sorted=[...picks].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  let totalInvested=0,totalCurrent=0,pricedCount=0;
  const rows=sorted.map(p=>{
    const invested=p.investedAmount||10000;
    const hasPrice=p.entryPrice&&p.currentPrice&&p.entryPrice>0;
    const g=hasPrice?((p.currentPrice-p.entryPrice)/p.entryPrice)*100:null;
    const curVal=hasPrice?invested*(1+g/100):invested;
    totalInvested+=invested;
    totalCurrent+=curVal;
    if(hasPrice)pricedCount++;
    const gClass=g==null?'':g>=0?'up':'down';
    const gTxt=g==null?'<span style="color:var(--text3);">—</span>':`<span class="${g>=0?'pf-up':'pf-down'}">${g>=0?'+':''}${g.toFixed(2)}%</span>`;
    const entryTxt=p.entryPrice?'₹'+p.entryPrice.toLocaleString('en-IN'):'—';
    const curTxt=p.currentPrice?'₹'+p.currentPrice.toLocaleString('en-IN'):'—';
    return `<tr>
      <td class="pf-date">${esc(p.date||'')}</td>
      <td class="pf-name">${esc(p.ticker||'')}</td>
      <td class="pf-num">${entryTxt}</td>
      <td class="pf-num">${curTxt}</td>
      <td class="pf-num" style="text-align:right;">${gTxt}</td>
    </tr>`;
  }).join('');

  const totalG=totalInvested>0?((totalCurrent-totalInvested)/totalInvested)*100:0;
  const totalClass=totalG>=0?'pf-up':'pf-down';

  return `<div class="result-card" style="margin-top:20px;">
    <div class="section-title">📜 Active AI Positions</div>
    <div class="potd-table-wrap">
      <table class="potd-table">
        <thead><tr>
          <th>Date</th><th>Stock</th><th>Entry</th><th>Current</th><th style="text-align:right;">Gain</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="potd-totals">
      <div class="pt-item"><div class="pt-lbl">Total Invested</div><div class="pt-val">₹${Math.round(totalInvested).toLocaleString('en-IN')}</div></div>
      <div class="pt-item"><div class="pt-lbl">Current Value</div><div class="pt-val ${totalClass}">₹${Math.round(totalCurrent).toLocaleString('en-IN')}</div></div>
      <div class="pt-item"><div class="pt-lbl">Total Return</div><div class="pt-val ${totalClass}">${totalG>=0?'+':''}${totalG.toFixed(2)}%</div></div>
    </div>
    ${pricedCount<sorted.length?`<div style="font-size:11px;color:var(--text3);margin-top:10px;">${sorted.length-pricedCount} pick(s) awaiting price — totals update after the 3:40 PM IST refresh.</div>`:''}
    <div class="disclaimer-box" style="margin-top:14px;">📌 Confidence-sized paper positions · real NSE prices · educational tracking only, not investment advice.</div>
  </div>`;
}

// ─── Init ───
initTheme();load();
checkSotd();
// First-visit disclaimer (financial tool — require acknowledgment once)
(function(){
  const seen=localStorage.getItem('disclaimer_ack');
  const modal=document.getElementById('disclaimer-modal');
  const ok=document.getElementById('disclaimer-ok');
  if(modal&&ok&&!seen){modal.classList.add('open');ok.focus();ok.addEventListener('click',()=>{localStorage.setItem('disclaimer_ack','1');modal.classList.remove('open');});}
})();

// Keyboard-safe dialogs: keep Tab focus inside the active modal and allow Escape on dismissible
// dialogs. The first-visit disclaimer still requires explicit acknowledgement.
document.addEventListener('keydown',e=>{
  const overlay=document.querySelector('.modal-overlay.open');
  if(!overlay)return;
  if(e.key==='Escape'&&overlay.id!=='disclaimer-modal'){
    e.preventDefault();
    if(overlay.id==='sotd-modal')dismissSotd();else overlay.classList.remove('open');
    return;
  }
  if(e.key!=='Tab')return;
  const focusable=[...overlay.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')];
  if(!focusable.length)return;
  const first=focusable[0],last=focusable[focusable.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
});
// ---- Cron Tracker tab: did every scheduled job run, and what did it decide (stock-wise) ----
const CRON_LOG_URL='https://stock-advisor-cron.pranaykushnaji.workers.dev/log';
async function renderTracker(){
  const el=document.getElementById('tracker-content');if(!el)return;
  el.innerHTML='<div class="empty-state"><p>Loading run history…</p></div>';
  const j=async(u)=>{try{const r=await fetch(u,{cache:'no-store'});return r.ok?await r.json():null;}catch{return null;}};
  const [log,snap,bouq,real,intel]=await Promise.all([j(CRON_LOG_URL),j('/data/nse-snapshot.json?t='+Date.now()),j('/data/project-bouquet.json?t='+Date.now()),j('/data/realized.json?t='+Date.now()),j('/data/news-intel.json?t='+Date.now())]);
  const runs=Array.isArray(log)?log:[];
  const IST={timeZone:'Asia/Kolkata'};
  const istDate=d=>new Date(d).toLocaleDateString('en-CA',IST);
  const istTime=d=>new Date(d).toLocaleTimeString('en-GB',{...IST,hour:'2-digit',minute:'2-digit'});
  const toMin=t=>{const[a,b]=t.split(':');return +a*60+ +b;};
  const today=istDate(Date.now());
  const dow=new Date().toLocaleDateString('en-US',{...IST,weekday:'short'});
  const isWeekend=(dow==='Sat'||dow==='Sun');
  const todayRuns=runs.filter(r=>istDate(r.ts)===today);
  const nowMin=toMin(istTime(Date.now()));
  const firstLoggedMin=todayRuns.length?Math.min(...todayRuns.map(r=>toMin(istTime(r.ts)))):9999;
  function outcome(r){const s=r.summary||{};
    if(r.job==='nse-snapshot')return s.dispatched?'snapshot triggered':'dispatch failed';
    if(r.job==='sell-check'){const sold=s.sold||0,held=(s.positions||[]).filter(p=>p.result==='hold').length,soldT=(s.closed||[]).map(c=>c.ticker).join(', ');return `checked ${(s.positions||[]).length} · held ${held}${sold?` · SOLD ${sold} (${soldT})`:''}`;}
    if(r.job==='stock-of-the-day'){if(s.pick)return `picked ${s.pick.ticker} (score ${s.pick.composite})`;if(s.entryRejected)return `not traded — ${s.entryRejected}`;if(s.reason)return `No Trade — ${s.reason}`;return s.status||'ran';}
    if(r.job==='refresh-prices')return `updated ${s.updated||0}${s.closed?` · booked ${s.closed}`:''}`;
    if(r.job==='premarket')return s.watchlist?`watchlist: ${(s.watchlist||[]).join(', ')||'empty'}`:(s.status||'ran');
    if(r.job==='open-scan')return s.pick?`BOUGHT ${s.pick.ticker} @ ₹${s.pick.entry} (${s.pick.lane} lane)`:(s.reason||s.status||'no entry');
    return s.status||(s.ok?'ok':'?');}
  // Matches the deployed Cloudflare Worker schedule (morning capture + hourly engine): overnight
  // snapshot 07:45, pre-market research 08:05, open scan 09:25, then hourly snapshot :45 /
  // buy-scan :00 / sell-check :10, EOD refresh + analytics. Keep in sync with
  // cron-worker/worker.js — a mismatch here shows phantom "missed" rows.
  const EXPECTED=[
    {t:'07:45',job:'nse-snapshot',label:'Snapshot · overnight filings'},
    {t:'08:05',job:'premarket',label:'Pre-market research'},
    {t:'09:25',job:'open-scan',label:'Open scan · early entries'},
    {t:'09:40',job:'sell-check',label:'Sell-check · early'},
    {t:'08:45',job:'nse-snapshot',label:'Snapshot · pre-open'},
    {t:'09:45',job:'nse-snapshot',label:'Snapshot'},
    {t:'10:00',job:'stock-of-the-day',label:'Buy scan'},
    {t:'10:10',job:'sell-check',label:'Sell-check'},
    {t:'10:45',job:'nse-snapshot',label:'Snapshot'},
    {t:'11:00',job:'stock-of-the-day',label:'Buy scan'},
    {t:'11:10',job:'sell-check',label:'Sell-check'},
    {t:'11:45',job:'nse-snapshot',label:'Snapshot'},
    {t:'12:00',job:'stock-of-the-day',label:'Buy scan'},
    {t:'12:10',job:'sell-check',label:'Sell-check'},
    {t:'12:45',job:'nse-snapshot',label:'Snapshot'},
    {t:'13:00',job:'stock-of-the-day',label:'Buy scan'},
    {t:'13:10',job:'sell-check',label:'Sell-check'},
    {t:'13:45',job:'nse-snapshot',label:'Snapshot'},
    {t:'14:00',job:'stock-of-the-day',label:'Buy scan'},
    {t:'14:10',job:'sell-check',label:'Sell-check'},
    {t:'14:45',job:'nse-snapshot',label:'Snapshot'},
    {t:'15:00',job:'stock-of-the-day',label:'Buy scan'},
    {t:'15:10',job:'sell-check',label:'Sell-check'},
    {t:'15:40',job:'refresh-prices',label:'Final price refresh'},
    {t:'16:10',job:'analytics',label:'Analytics · learn from rejects'}
  ];
  const schedRows=EXPECTED.slice().sort((a,b)=>toMin(a.t)-toMin(b.t)).map(e=>{
    const em=toMin(e.t);const hit=todayRuns.find(r=>r.job===e.job&&Math.abs(toMin(istTime(r.ts))-em)<=12&&!r._used);if(hit)hit._used=true;
    let st,cls,detail='';
    if(hit&&hit.summary?.ok!==false){st='✓ ran';cls='ok';detail=outcome(hit)+' · '+istTime(hit.ts);}
    else if(hit){st='✗ failed';cls='bad';detail=outcome(hit)+' · '+istTime(hit.ts);}
    else if(isWeekend){st='— closed';cls='muted';}
    else if(em>nowMin+5){st='⏳ upcoming';cls='muted';}
    else if(em<firstLoggedMin){st='— pre-logging';cls='muted';}
    else{st='✗ missed';cls='bad';}
    return `<tr><td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${e.t}</td><td>${e.label}</td><td><span class="trk-pill trk-${cls}">${st}</span></td><td style="color:var(--text2);font-size:12px;">${detail}</td></tr>`;
  }).join('');
  const diag=snap?.diag||{};
  const snapHtml=`<div class="trk-card"><div class="trk-h">📸 NSE Snapshot health</div>
    <div class="trk-kv"><span>Last fetched</span><b>${snap?.fetchedAt?istTime(snap.fetchedAt)+' IST · '+timeAgo(snap.fetchedAt):'never'}</b></div>
    <div class="trk-kv"><span>Universe</span><b>${diag.universeCount||diag.moversCount||0} stocks</b></div>
    <div class="trk-kv"><span>Sources OK</span><b>${['marketStatus','largeDeals','deliveryData'].filter(k=>diag[k]).length}/3</b></div>
    <div class="trk-kv"><span>Surveillance list</span><b>${(snap?.data?.surveillance||[]).length} names</b></div>
    <div class="trk-kv"><span>Claude web research</span><b class="${intel?.generatedAt&&(Date.now()-Date.parse(intel.generatedAt))<=20*3600000?'trk-up':'trk-down'}">${intel?.generatedAt?timeAgo(intel.generatedAt):'missing'}${intel?.generatedAt&&(Date.now()-Date.parse(intel.generatedAt))>20*3600000?' · stale':''}</b></div></div>`;
  const logRows=runs.slice(0,25).map(r=>`<tr><td style="white-space:nowrap;color:var(--text2);font-size:12px;">${istDate(r.ts)===today?'':istDate(r.ts).slice(5)+' '}${istTime(r.ts)}</td><td><b>${r.job}</b>${r.trigger==='manual'?' <span class="trk-pill trk-muted">manual</span>':''}</td><td style="font-size:12px;">${outcome(r)}</td></tr>`).join('')||'<tr><td colspan="3" style="color:var(--text2);">No runs logged yet.</td></tr>';
  const posRows=(bouq?.bouquet||[]).map(p=>{const pnl=p.entryPrice&&p.currentPrice?((p.currentPrice-p.entryPrice)/p.entryPrice*100):null;const cls=pnl==null?'':pnl>=0?'up':'down';return `<tr><td><b>${p.ticker}</b></td><td>${p.status||'OPEN'}</td><td style="font-variant-numeric:tabular-nums;">₹${p.entryPrice??'—'}</td><td style="font-variant-numeric:tabular-nums;">₹${p.currentPrice??'—'}</td><td style="font-variant-numeric:tabular-nums;">₹${p.peakPrice??'—'}</td><td class="trk-${cls}" style="font-variant-numeric:tabular-nums;">${pnl==null?'—':(pnl>=0?'+':'')+pnl.toFixed(1)+'%'}</td><td style="color:var(--text2);font-size:12px;">${p.lastPriceUpdate?timeAgo(p.lastPriceUpdate):'—'}</td></tr>`;}).join('')||'<tr><td colspan="7" style="color:var(--text2);">No open positions.</td></tr>';
  const exitRows=(real?.trades||[]).slice(-8).reverse().map(t=>`<tr><td><b>${t.ticker}</b></td><td style="color:var(--text2);font-size:12px;">${t.entryDate} → ${t.exitDate}</td><td class="trk-${t.realizedPnlPct>=0?'up':'down'}" style="font-variant-numeric:tabular-nums;">${t.realizedPnlPct>=0?'+':''}${t.realizedPnlPct}%</td><td style="color:var(--text2);font-size:12px;">${t.exitReason||''}</td></tr>`).join('')||'<tr><td colspan="4" style="color:var(--text2);">No closed trades yet.</td></tr>';
  el.innerHTML=`<div class="trk-note">Now ${istTime(Date.now())} IST (${dow})${isWeekend?' · <b>weekend — market closed</b>':''} · crons run Mon–Fri, NSE hours</div>
   <div class="trk-card"><div class="trk-h">⏱️ Today's schedule — ${today}</div><table class="trk-tbl"><thead><tr><th>IST</th><th>Job</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${schedRows}</tbody></table></div>
   ${snapHtml}
   <div class="trk-card"><div class="trk-h">📜 Recent runs (Cloudflare scheduler log)</div><table class="trk-tbl"><thead><tr><th>Time IST</th><th>Job</th><th>Outcome</th></tr></thead><tbody>${logRows}</tbody></table></div>
   <div class="trk-card"><div class="trk-h">📦 Open positions (stock-wise)</div><table class="trk-tbl"><thead><tr><th>Stock</th><th>Status</th><th>Entry</th><th>Now</th><th>Peak</th><th>P&amp;L</th><th>Updated</th></tr></thead><tbody>${posRows}</tbody></table></div>
   <div class="trk-card"><div class="trk-h">✅ Recent exits</div><table class="trk-tbl"><thead><tr><th>Stock</th><th>Held</th><th>Result</th><th>Reason</th></tr></thead><tbody>${exitRows}</tbody></table></div>`;
}

// Show welcome message
document.getElementById('result-area').innerHTML=`<div class="result-card" style="border-left:3px solid var(--accent);display:flex;align-items:flex-start;gap:16px;">
  <div style="font-size:32px">🤖</div><div><div style="font-size:15px;font-weight:600;margin-bottom:6px;">Welcome to StockAdvisor AI</div>
  <div style="font-size:13px;color:var(--text2);line-height:1.7;">Type any stock name above and hit <strong>Analyze</strong> for an evidence-based factor analysis with a computed composite score.<br><br>
  <strong>4 research-backed factors</strong> — Momentum · Quality · Value · Low-Volatility. Momentum &amp; volatility are computed from real price data; quality &amp; value from fundamentals. The composite is a weighted mean, not an LLM guess.</div></div></div>`;
