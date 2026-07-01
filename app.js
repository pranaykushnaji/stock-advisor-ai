// ─── State ───
let bouquet=[],history=[],currentAnalysis=null;
const SK={KEY:'sa_api_key',BOUQUET:'sa_bouquet2',HISTORY:'sa_history2',PROVIDER:'sa_provider',THEME:'sa_theme'};
function load(){try{bouquet=JSON.parse(localStorage.getItem(SK.BOUQUET)||'[]');}catch{bouquet=[];}try{history=JSON.parse(localStorage.getItem(SK.HISTORY)||'[]');}catch{history=[];}updateBadge();}
function save(){localStorage.setItem(SK.BOUQUET,JSON.stringify(bouquet));localStorage.setItem(SK.HISTORY,JSON.stringify(history));updateBadge();}
function getKey(){return localStorage.getItem(SK.KEY)||'';}
function saveKey(k){localStorage.setItem(SK.KEY,k);}
function getProvider(){return localStorage.getItem(SK.PROVIDER)||'groq';}
function saveProvider(p){localStorage.setItem(SK.PROVIDER,p);}
function updateBadge(){const b=document.getElementById('bouquet-badge');if(b)b.textContent=bouquet.length||'';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ─── Theme ───
function initTheme(){const s=localStorage.getItem(SK.THEME);setTheme(s||(matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'));}
function setTheme(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem(SK.THEME,t);document.getElementById('theme-icon-dark').style.display=t==='dark'?'block':'none';document.getElementById('theme-icon-light').style.display=t==='light'?'block':'none';}
document.getElementById('theme-toggle').addEventListener('click',()=>{setTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');});

// ─── Tabs ───
function switchTab(n){document.querySelectorAll('.nav-item').forEach(e=>e.classList.toggle('active',e.dataset.tab===n));document.querySelectorAll('.tab-pane').forEach(e=>e.classList.toggle('active',e.id==='tab-'+n));if(n==='bouquet')renderBouquet();if(n==='history')renderHistory();if(n==='dashboard')renderDashboard();if(n==='daily')renderDailyTab(sotdPick);}
document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

// ─── Modal ───
const modal=document.getElementById('api-modal'),keyInput=document.getElementById('api-key-input'),keyError=document.getElementById('key-error'),providerSelect=document.getElementById('provider-select');
function openModal(){keyInput.value=getKey();providerSelect.value=getProvider();updateHint();keyError.textContent='';modal.classList.add('open');setTimeout(()=>keyInput.focus(),200);}
function closeModal(){modal.classList.remove('open');}
function updateHint(){const h=document.getElementById('provider-hint'),p=providerSelect.value;h.innerHTML=p==='groq'?'<ol class="setup-steps"><li>Go to <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a></li><li>Sign up free</li><li>Create API Key → paste below (<code>gsk_</code>)</li></ol>':'<ol class="setup-steps"><li>Go to <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a></li><li>Create API Key → paste below</li></ol>';}
providerSelect?.addEventListener('change',updateHint);
document.getElementById('settings-btn').addEventListener('click',openModal);
document.getElementById('modal-close').addEventListener('click',closeModal);
document.getElementById('modal-cancel').addEventListener('click',closeModal);
modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
document.getElementById('toggle-key').addEventListener('click',()=>{const h=keyInput.type==='password';keyInput.type=h?'text':'password';document.getElementById('toggle-key').textContent=h?'Hide':'Show';});
document.getElementById('save-key-btn').addEventListener('click',()=>{const k=keyInput.value.trim(),p=providerSelect.value;if(!k){keyError.textContent='Enter a key.';return;}if(p==='groq'&&!k.startsWith('gsk_')){keyError.textContent='Groq keys start with "gsk_"';return;}saveKey(k);saveProvider(p);closeModal();showToast('API key saved!');document.getElementById('result-area').innerHTML='';});

// ─── Multi-Agent AI Prompt ───
const AGENT_PROMPT=`You are a multi-agent stock analysis system with 4 specialist AI agents. For the given stock, each agent performs independent analysis and returns a score 0-100.

Return ONLY valid JSON (no markdown):
{
  "ticker": "SYMBOL",
  "fullName": "Full Company Name",
  "sector": "Sector",
  "verdict": "BUY" or "HOLD" or "AVOID",
  "estimatedUpside": "15-25%" or "5-10%" etc,
  "riskLevel": "Low" or "Medium" or "High",
  "horizon": "3-6 months" or "6-12 months" or "1-2 years",
  "agents": {
    "fundamental": {
      "score": 0-100,
      "positives": ["Revenue CAGR 24%", "ROCE improving to 18%", "Debt reduced 30% YoY"],
      "negatives": ["High PE of 48x", "Low dividend yield"]
    },
    "news": {
      "score": 0-100,
      "positives": ["Won ₹1000 Cr government tender", "Promoter increased holding 2%"],
      "negatives": ["Sector facing regulatory headwinds"]
    },
    "technical": {
      "score": 0-100,
      "positives": ["Trading above 50DMA and 200DMA", "RSI at 62 - bullish momentum"],
      "negatives": ["Near resistance at ₹1450"]
    },
    "risk": {
      "score": 0-100,
      "positives": ["Strong cash position", "No pledged promoter shares"],
      "negatives": ["Small-cap volatility", "Low institutional holding"]
    }
  },
  "summary": "2-3 sentence overall AI summary combining all agent views",
  "priceContext": "CMP ₹182, 52-week range ₹120-210, PE 48x"
}

RULES:
- Each agent score must be 0-100 based on actual analysis
- Use REAL financial data and metrics where possible
- Each agent must have at least 2 positives and 1 negative (be honest about risks)
- verdict: BUY if weighted score > 70, HOLD if 50-70, AVOID if < 50
- Be specific with numbers — revenue growth %, PE ratio, debt figures, actual news
- Return ONLY the JSON`;

// ─── Confidence Calculator (NOT from LLM) ───
const WEIGHTS={fundamental:0.35,news:0.25,technical:0.20,risk:0.20};

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

// ─── API calls ───
async function callGroq(key,stock){
  const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'openai/gpt-oss-120b',messages:[{role:'system',content:AGENT_PROMPT},{role:'user',content:`Analyze this stock with all 4 agents: "${stock}"`}],temperature:0.3,max_tokens:3000})});
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(r.status===401?'Invalid Groq key':e?.error?.message||`Error ${r.status}`);}
  return(await r.json())?.choices?.[0]?.message?.content||'';
}
async function callGemini(key,stock){
  const p=AGENT_PROMPT+`\nAnalyze: "${stock}"`;
  for(const m of['gemini-2.0-flash-lite','gemini-2.0-flash']){
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:p}]}],generationConfig:{temperature:0.3,maxOutputTokens:1500}})});
    if(r.ok)return(await r.json())?.candidates?.[0]?.content?.parts?.[0]?.text||'';
    if(r.status===429||r.status===404)continue;
    const e=await r.json().catch(()=>({}));throw new Error(`Gemini: ${e?.error?.message||r.status}`);
  }
  throw new Error('Gemini rate limited. Switch to Groq.');
}
async function callAI(stock){
  const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stock})});
  const d=await r.json().catch(()=>({}));
  if(r.ok&&d.raw)return d.raw;
  throw new Error(d.error||'Server error — please try again');
}

function parseResult(raw,query){
  let c=raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  // Strip any reasoning/thinking prefix before the JSON
  const firstBrace=c.indexOf('{');
  if(firstBrace>0)c=c.slice(firstBrace);
  // Find the matching closing brace for the first opening brace
  let depth=0,endIdx=-1;
  for(let i=0;i<c.length;i++){
    if(c[i]==='{')depth++;
    else if(c[i]==='}'){depth--;if(depth===0){endIdx=i;break;}}
  }
  let jsonStr;
  if(endIdx>0){jsonStr=c.slice(0,endIdx+1);}
  else{
    // Truncated response — try to salvage
    const m=c.match(/\{[\s\S]*\}/);
    if(!m)throw new Error('Response incomplete — please try again');
    jsonStr=m[0];
  }
  let d;
  try{d=JSON.parse(jsonStr);}
  catch(e){throw new Error('Could not parse analysis — please try again');}
  if(!d.ticker)throw new Error('Incomplete analysis — please try again');
  // Recompute agent scores from sub-metrics (deterministic), then confidence
  recomputeAgentScores(d.agents);
  d.confidence=computeConfidence(d.agents);
  d.verdict=computeVerdict(d.confidence);
  d.analyzedAt=new Date().toISOString();d.query=query;
  return d;
}

async function fetchStock(sym){try{const r=await fetch(`/api/stock?symbol=${encodeURIComponent(sym)}`);return r.ok?await r.json():null;}catch{return null;}}
async function fetchNews(q){try{const r=await fetch(`/api/news?q=${encodeURIComponent(q)}`);return r.ok?(await r.json()).articles||[]:[];}catch{return[];}}

// ─── Analyze ───
async function analyzeStock(){
  const input=document.getElementById('stock-input').value.trim();if(!input)return;
  const btn=document.getElementById('analyze-btn'),area=document.getElementById('result-area');
  btn.disabled=true;btn.innerHTML='<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzing…';
  area.innerHTML=`<div class="loading-wrap"><div class="spinner"></div><p>Running 4 AI agents on <strong>${esc(input)}</strong>…</p><p style="font-size:12px;color:var(--text3);">Fundamental · News · Technical · Risk</p></div>`;
  try{
    const[raw,stockData,news]=await Promise.all([callAI(input),fetchStock(input),fetchNews(input)]);
    const d=parseResult(raw,input);
    currentAnalysis=d;history.unshift(d);if(history.length>100)history=history.slice(0,100);save();
    renderResult(d,area,stockData,news);
  }catch(err){
    area.innerHTML=`<div class="error-card"><div class="error-title">⚠ Analysis failed</div><div class="error-msg">${esc(err.message)}</div></div>`;
  }finally{btn.disabled=false;btn.innerHTML='<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg> Analyze';}
}

// ─── Render Agent Card ───
const METRIC_LABELS={
  revenueGrowth:'Revenue Growth',roce:'ROCE',roe:'ROE',debtToEquity:'Debt/Equity',margins:'Margins',valuation:'Valuation',
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
  const conf=d.confidence;
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
  if(news?.length){newsHtml=`<div class="news-box"><div class="section-title">📰 Latest News</div>${news.slice(0,5).map(n=>`<div class="news-item"><a href="${esc(n.link)}" target="_blank">${esc(n.title)}</a><span class="news-source">${esc(n.source)}</span></div>`).join('')}</div>`;}

  const ag=d.agents||{};
  const confBreakdown=`<div class="conf-breakdown"><div class="section-title">Confidence Breakdown (Weighted)</div>
    <div class="conf-weights">
      ${Object.entries(WEIGHTS).map(([k,w])=>{const s=ag[k]?.score||0;const weighted=Math.round(s*w);return`<div class="cw-row"><span class="cw-label">${k.charAt(0).toUpperCase()+k.slice(1)}</span><span class="cw-weight">${Math.round(w*100)}%</span><div class="cw-bar"><div class="cw-fill" style="width:${s}%;background:${scoreColor(s)};"></div></div><span class="cw-score">${s} → ${weighted}</span></div>`;}).join('')}
      <div class="cw-row cw-total"><span class="cw-label"><strong>Total Confidence</strong></span><span class="cw-weight"></span><div class="cw-bar"><div class="cw-fill" style="width:${conf}%;background:${scoreColor(conf)};"></div></div><span class="cw-score"><strong>${conf}%</strong></span></div>
    </div></div>`;

  area.innerHTML=`<div class="result-card ${vClass}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
      <div><div class="stock-name">${esc(d.ticker)}</div><div class="stock-meta">${esc(d.fullName)} · ${esc(d.sector)}</div></div>
      <div style="text-align:right;">
        <span class="verdict-badge ${vBadge}" style="font-size:16px;padding:6px 18px;">${d.verdict}</span>
        <div class="conf-big" style="margin-top:6px;color:${scoreColor(conf)};">${conf}<span style="font-size:18px;color:var(--text3);">%</span></div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-top:2px;">Confidence</div>
      </div>
    </div>
    ${priceHtml}
    <div class="meta-pills">
      <span class="pill">📅 ${esc(d.horizon||'Medium-term')}</span>
      <span class="pill pill-${(d.riskLevel||'Medium').toLowerCase()}">⚡ ${esc(d.riskLevel||'Medium')} Risk</span>
      <span class="pill pill-green">📈 Est. Upside: ${esc(d.estimatedUpside||'N/A')}</span>
    </div>
    <p class="summary">${esc(d.summary)}</p>
    ${chartHtml}
    <div class="section-title" style="margin-bottom:12px;">🤖 Multi-Agent Analysis</div>
    <div class="agents-grid">
      ${agentCard('Fundamental Analyst','📊',ag.fundamental,'#4f8ef7')}
      ${agentCard('News Analyst','📰',ag.news,'#22c87a')}
      ${agentCard('Technical Analyst','📈',ag.technical,'#f5a623')}
      ${agentCard('Risk Analyst','🛡️',ag.risk,'#a855f7')}
    </div>
    ${confBreakdown}
    ${newsHtml}
    <div class="valuation-box"><span>Valuation: </span>${esc(d.priceContext||'')}</div>
    <div class="action-row">
      <button class="btn btn-green" onclick="approvePick()">✓ Add to Bouquet (₹10,000)</button>
      <button class="btn btn-red" onclick="skipPick()">✕ Skip</button>
      <button class="btn btn-ghost" onclick="resetAdvisor()">↺ New Search</button>
    </div></div>`;

  if(stockData?.chart?.close?.length)setTimeout(()=>drawChart(stockData.chart),100);
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
  area.innerHTML=`<div class="loading-wrap"><div class="spinner"></div><p>Comparing <strong>${esc(a)}</strong> vs <strong>${esc(b)}</strong> with 8 AI agents…</p></div>`;
  try{
    const[rA,rB]=await Promise.all([callAI(a),callAI(b)]);
    const dA=parseResult(rA,a),dB=parseResult(rB,b);
    const miniCard=d=>{const ag=d.agents||{};return`<div class="result-card ${d.verdict==='BUY'?'buy':d.verdict==='AVOID'?'avoid':'hold'}">
      <div style="display:flex;justify-content:space-between;"><div><div class="stock-name" style="font-size:18px;">${esc(d.ticker)}</div><div class="stock-meta">${esc(d.fullName)}</div></div>
      <div style="text-align:right;"><span class="verdict-badge ${d.verdict==='BUY'?'verdict-buy':d.verdict==='AVOID'?'verdict-avoid':'verdict-hold'}">${d.verdict}</span><div style="font-size:24px;font-weight:700;color:${scoreColor(d.confidence)};">${d.confidence}%</div></div></div>
      <div class="meta-pills" style="margin-top:12px;"><span class="pill">📈 ${esc(d.estimatedUpside||'N/A')}</span><span class="pill">⚡ ${esc(d.riskLevel||'Medium')}</span></div>
      <div class="agents-mini">${['fundamental','news','technical','risk'].map(k=>`<div class="am-row"><span>${k.charAt(0).toUpperCase()+k.slice(1)}</span><div class="am-bar"><div style="width:${ag[k]?.score||0}%;background:${scoreColor(ag[k]?.score||0)};height:100%;border-radius:3px;"></div></div><span>${ag[k]?.score||0}</span></div>`).join('')}</div>
      <p class="summary" style="margin-top:12px;font-size:13px;">${esc(d.summary)}</p></div>`;};
    const winner=dA.confidence>dB.confidence?dA:dB;
    area.innerHTML=`<div class="result-card" style="border-left:3px solid var(--accent);margin-bottom:16px;padding:14px 20px;">
      <span style="font-size:14px;">🏆 <strong>${esc(winner.ticker)}</strong> wins with ${winner.confidence}% confidence vs ${(winner===dA?dB:dA).confidence}%</span></div>
      <div class="compare-grid">${miniCard(dA)}${miniCard(dB)}</div>`;
  }catch(err){area.innerHTML=`<div class="error-card"><div class="error-title">⚠ Failed</div><div class="error-msg">${esc(err.message)}</div></div>`;}
});

// ─── Bouquet with real entry price ───
function approvePick(){
  if(!currentAnalysis)return;
  if(bouquet.find(b=>b.ticker===currentAnalysis.ticker)){showToast(currentAnalysis.ticker+' already in bouquet','warn');return;}
  const entry={...currentAnalysis,addedAt:new Date().toISOString(),investedAmount:10000};
  bouquet.push(entry);save();showToast(currentAnalysis.ticker+' added with ₹10,000 virtual investment! 🌸');
  const area=document.getElementById('result-area');const n=document.createElement('div');n.className='result-card';n.style.cssText='border-left:3px solid var(--green);display:flex;align-items:center;gap:10px;';
  n.innerHTML=`<span style="font-size:20px">✅</span><span><strong>${esc(currentAnalysis.ticker)}</strong> added with ₹10,000. Check <strong>My Bouquet</strong>.</span>`;area.appendChild(n);
}
function skipPick(){currentAnalysis=null;document.getElementById('result-area').innerHTML='<p style="color:var(--text3);padding:8px 0;">Skipped.</p>';}
function resetAdvisor(){currentAnalysis=null;document.getElementById('result-area').innerHTML='';document.getElementById('stock-input').value='';document.getElementById('stock-input').focus();}

function simGain(item){
  // If we have real entry + current prices, use the REAL return
  if(item.entryPrice&&item.currentPrice&&item.entryPrice>0){
    return+(((item.currentPrice-item.entryPrice)/item.entryPrice)*100).toFixed(1);
  }
  // Otherwise fall back to simulated formula
  const days=Math.max(1,Math.floor((Date.now()-new Date(item.addedAt||item.date).getTime())/86400000));
  const seed=(item.ticker||'XX').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const dir=item.verdict==='BUY'?1:item.verdict==='AVOID'?-0.6:0.05;
  let conf=item.confidence;
  if(conf==null&&item.agents)conf=computeConfidence(item.agents);
  if(conf==null)conf=65;
  const cf=(conf-50)/50;
  const noise=(Math.sin(seed*0.17+days*0.09)+Math.cos(seed*0.31+days*0.05))*0.5;
  return+((dir*cf*0.30+noise*0.10)*(days/365)*100).toFixed(1);
}

const COLORS=['#4f8ef7','#22c87a','#f5a623','#f05b5b','#a855f7','#06b6d4','#ec4899','#84cc16','#f97316','#6366f1'];

let projectBouquet=[];
let bouquetView='all'; // 'all' | 'daily' | 'personal'

async function renderBouquet(){
  const el=document.getElementById('bouquet-content');
  // Fetch shared project bouquet (daily picks)
  if(!projectBouquet.length){projectBouquet=await fetchProjectBouquet();}

  // Tag sources
  const dailyPicks=projectBouquet.map(b=>({...b,source:'daily'}));
  const personalPicks=bouquet.map(b=>({...b,source:'personal'}));
  let combined;
  if(bouquetView==='daily')combined=dailyPicks;
  else if(bouquetView==='personal')combined=personalPicks;
  else combined=[...dailyPicks,...personalPicks];

  const toggle=`<div style="display:flex;gap:6px;margin-bottom:18px;">
    ${[['all','All'],['daily','⭐ Daily Picks'],['personal','My Picks']].map(([v,l])=>`<button class="btn ${bouquetView===v?'btn-primary':'btn-ghost'}" style="padding:7px 14px;font-size:13px;" onclick="setBouquetView('${v}')">${l}</button>`).join('')}</div>`;

  if(!combined.length){el.innerHTML=toggle+'<div class="empty-state"><div class="empty-icon">🌸</div><h3>No stocks yet</h3><p>Daily picks are added automatically each morning. Analyze a stock to add your own.</p></div>';return;}

  const work=combined;
  const gains=work.map(simGain),totalInvested=work.reduce((a,b)=>a+(b.investedAmount||10000),0);
  const totalValue=work.reduce((a,b,i)=>a+(b.investedAmount||10000)*(1+gains[i]/100),0);
  const totalReturn=((totalValue-totalInvested)/totalInvested*100).toFixed(1);
  const wins=gains.filter(g=>g>0).length;
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

  el.innerHTML=toggle+`<div class="summary-tiles">
    <div class="summary-tile"><div class="tile-num">${work.length}</div><div class="tile-lbl">Stocks</div></div>
    <div class="summary-tile"><div class="tile-num">₹${totalInvested.toLocaleString('en-IN')}</div><div class="tile-lbl">Invested</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:${parseFloat(totalReturn)>=0?'var(--green)':'var(--red)'};">₹${Math.round(totalValue).toLocaleString('en-IN')}</div><div class="tile-lbl">Current Value (sim)</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:${parseFloat(totalReturn)>=0?'var(--green)':'var(--red)'};">${parseFloat(totalReturn)>=0?'+':''}${totalReturn}%</div><div class="tile-lbl">Total Return</div></div>
  </div>${pieHtml}
  <div class="bouquet-list">${work.map((item,i)=>{
    const g=gains[i],gStr=(g>0?'+':'')+g+'%',amt=item.investedAmount||10000,val=Math.round(amt*(1+g/100));
    const days=Math.max(1,Math.floor((Date.now()-new Date(item.addedAt).getTime())/86400000));
    const vB=item.verdict==='BUY'?'verdict-buy':item.verdict==='AVOID'?'verdict-avoid':'verdict-hold';
    const srcTag=item.source==='daily'?'<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:6px;">⭐ DAILY</span>':'';
    const removeBtn=item.source==='personal'?`<button class="bi-remove" onclick="removePersonalPick('${esc(item.ticker)}')">✕</button>`:'<span style="width:28px;"></span>';
    const hasReal=item.entryPrice&&item.currentPrice;
    const metaLine=hasReal
      ?`${days}d · ₹${item.entryPrice} → ₹${item.currentPrice}${item.lastPriceUpdate?' · live':''}`
      :`${days}d · ₹${amt.toLocaleString('en-IN')} → ₹${val.toLocaleString('en-IN')}${item.confidence?' · '+item.confidence+'% conf':''}`;
    return`<div class="bouquet-item"><div class="bi-info"><div class="bi-ticker">${esc(item.ticker)}${srcTag}</div>
      <div class="bi-meta">${metaLine}</div></div>
      <span class="verdict-badge ${vB}" style="font-size:11px;padding:2px 10px;">${item.verdict}</span>
      <div class="bi-gain ${g>=0?'up':'down'}">${gStr}</div>
      ${removeBtn}</div>`;
  }).join('')}<div class="sim-note">Simulated returns · ₹10,000 per stock · Not real money</div></div>`;
}
function setBouquetView(v){bouquetView=v;renderBouquet();}
function removePersonalPick(ticker){const i=bouquet.findIndex(b=>b.ticker===ticker);if(i>=0){bouquet.splice(i,1);save();renderBouquet();}}
function removePick(i){bouquet.splice(i,1);save();renderBouquet();}

// ─── Dashboard ───
function renderDashboard(){
  const el=document.getElementById('dashboard-content');
  if(history.length<3){el.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div><h3>Need more data</h3><p>Analyze at least 3 stocks to see performance stats.</p></div>';return;}
  const buys=history.filter(h=>h.verdict==='BUY'),holds=history.filter(h=>h.verdict==='HOLD'),avoids=history.filter(h=>h.verdict==='AVOID');
  const avgConf=Math.round(history.reduce((a,h)=>a+h.confidence,0)/history.length);
  const highConf=history.filter(h=>h.confidence>=80);
  const bGains=bouquet.map(simGain),winRate=bGains.length?Math.round(bGains.filter(g=>g>0).length/bGains.length*100):0;
  const avgReturn=bGains.length?(bGains.reduce((a,b)=>a+b,0)/bGains.length).toFixed(1):0;

  el.innerHTML=`<div class="summary-tiles">
    <div class="summary-tile"><div class="tile-num">${history.length}</div><div class="tile-lbl">Total Analyzed</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:var(--green);">${buys.length}</div><div class="tile-lbl">BUY Calls</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:var(--amber);">${holds.length}</div><div class="tile-lbl">HOLD</div></div>
    <div class="summary-tile"><div class="tile-num" style="color:var(--red);">${avoids.length}</div><div class="tile-lbl">AVOID</div></div>
  </div>
  <div class="result-card" style="margin-bottom:16px;">
    <div class="section-title">📊 Performance Metrics</div>
    <div class="dash-metrics">
      <div class="dm-item"><div class="dm-val">${avgConf}%</div><div class="dm-lbl">Avg Confidence</div></div>
      <div class="dm-item"><div class="dm-val">${highConf.length}</div><div class="dm-lbl">High Confidence (80%+)</div></div>
      <div class="dm-item"><div class="dm-val" style="color:${winRate>=50?'var(--green)':'var(--red)'};">${winRate}%</div><div class="dm-lbl">Win Rate (bouquet)</div></div>
      <div class="dm-item"><div class="dm-val" style="color:${parseFloat(avgReturn)>=0?'var(--green)':'var(--red)'};">${parseFloat(avgReturn)>=0?'+':''}${avgReturn}%</div><div class="dm-lbl">Avg Return (sim)</div></div>
    </div>
  </div>
  <div class="result-card"><div class="section-title">🎯 Confidence Distribution</div>
    <div class="conf-dist">${[[90,100,'🔥'],[80,89,'🟢'],[70,79,'🟡'],[60,69,'🟠'],[0,59,'🔴']].map(([lo,hi,em])=>{
      const count=history.filter(h=>h.confidence>=lo&&h.confidence<=hi).length;
      const pct=Math.round(count/history.length*100);
      return`<div class="cd-row"><span class="cd-label">${em} ${lo}-${hi}%</span><div class="cd-bar"><div style="width:${pct}%;background:${lo>=70?'var(--green)':lo>=50?'var(--amber)':'var(--red)'};height:100%;border-radius:3px;"></div></div><span class="cd-count">${count} (${pct}%)</span></div>`;
    }).join('')}</div></div>`;
}

// ─── History ───
function renderHistory(){
  const el=document.getElementById('history-content');
  if(!history.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><h3>No history</h3></div>';return;}
  el.innerHTML=`<div class="history-list">${history.slice(0,50).map(item=>{
    const ds=new Date(item.analyzedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const vB=item.verdict==='BUY'?'verdict-buy':item.verdict==='AVOID'?'verdict-avoid':'verdict-hold';
    const inB=bouquet.some(b=>b.ticker===item.ticker);
    return`<div class="history-item"><div class="hi-ticker">${esc(item.ticker)} <span style="font-size:12px;color:var(--text3);font-weight:400;">${esc(item.fullName||'')}</span></div>
      <span class="verdict-badge ${vB}" style="font-size:11px;padding:2px 10px;">${item.verdict}</span>
      <span style="font-size:12px;color:${scoreColor(item.confidence)};">${item.confidence}%</span>
      <span class="hi-date">${ds}</span>${inB?'<span class="hi-bouquet">✓</span>':''}</div>`;
  }).join('')}</div>`;
}
document.getElementById('clear-history-btn')?.addEventListener('click',()=>{if(history.length&&confirm('Clear history?')){history=[];save();renderHistory();}});

// ─── Export ───
document.getElementById('export-csv-btn')?.addEventListener('click',()=>{
  if(!bouquet.length){showToast('No stocks','warn');return;}
  const gains=bouquet.map(simGain);
  let csv='Ticker,Company,Sector,Verdict,Confidence,Fundamental,News,Technical,Risk,Sim Return,Invested,Value,Added\n';
  bouquet.forEach((b,i)=>{const ag=b.agents||{};const amt=b.investedAmount||10000;
    csv+=`${b.ticker},"${b.fullName||''}","${b.sector||''}",${b.verdict},${b.confidence}%,${ag.fundamental?.score||''},${ag.news?.score||''},${ag.technical?.score||''},${ag.risk?.score||''},${gains[i]}%,${amt},${Math.round(amt*(1+gains[i]/100))},${b.addedAt}\n`;
  });
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`bouquet-${new Date().toISOString().slice(0,10)}.csv`;a.click();showToast('CSV exported!');
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

function todayKey(){
  const now=new Date();
  const ist=new Date(now.getTime()+(5.5*3600*1000)-(now.getTimezoneOffset()*60000));
  return ist.toISOString().slice(0,10);
}

async function checkSotd(){
  const pick=await fetchDailyPick();
  if(!pick)return;
  sotdPick=pick;
  // Badge on nav
  const badge=document.getElementById('daily-badge');
  if(badge)badge.textContent='NEW';
  // Show popup once per day
  const seen=localStorage.getItem('sotd_seen');
  if(seen!==pick.date){
    showSotdPopup(pick);
  }
  // Pre-render daily tab
  renderDailyTab(pick);
}

function showSotdPopup(pick){
  const body=document.getElementById('sotd-body');
  const conf=computeConfidence(pick.agents);
  body.innerHTML=`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">${pick.date} · Today's Top Pick</div>
      <div class="stock-name" style="font-size:30px;">${esc(pick.ticker)}</div>
      <div class="stock-meta">${esc(pick.fullName)} · ${esc(pick.sector)}</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:16px;">
        <span class="verdict-badge verdict-buy" style="font-size:15px;padding:6px 18px;">${pick.verdict}</span>
        <div class="conf-big" style="color:${scoreColor(conf)};">${conf}<span style="font-size:18px;color:var(--text3);">%</span></div>
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
      ✓ Auto-added to the project bouquet with ₹10,000 virtual investment
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

function renderDailyTab(pick){
  const el=document.getElementById('daily-content');
  if(!pick){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">⭐</div><h3>No pick yet</h3><p>The Stock of the Day is generated every morning at 9 AM IST.</p></div>';
    return;
  }
  // Reuse the full analysis card renderer
  pick.confidence=computeConfidence(pick.agents);
  pick.verdict=computeVerdict(pick.confidence);
  renderResult(pick,el,null,null);
  // Prepend the "why today" banner
  const banner=document.createElement('div');
  banner.className='result-card';
  banner.style.cssText='border-top:2px solid var(--accent);margin-bottom:16px;';
  banner.innerHTML=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;"><span style="font-size:22px;">⭐</span><div><div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:16px;">Picked for ${esc(pick.date)}</div><div style="font-size:12px;color:var(--text3);">Compared across 30+ Indian large & mid-caps</div></div></div><div style="font-size:14px;color:var(--text2);line-height:1.7;">${esc(pick.whyToday||'')}</div>`;
  el.insertBefore(banner,el.firstChild);
}

// ─── Init ───
initTheme();load();
checkSotd();
// Show welcome message
document.getElementById('result-area').innerHTML=`<div class="result-card" style="border-left:3px solid var(--accent);display:flex;align-items:flex-start;gap:16px;">
  <div style="font-size:32px">🤖</div><div><div style="font-size:15px;font-weight:600;margin-bottom:6px;">Welcome to StockAdvisor AI</div>
  <div style="font-size:13px;color:var(--text2);line-height:1.7;">Type any stock name above and hit <strong>Analyze</strong> to get a multi-agent AI analysis with computed confidence scores.<br><br>
  <strong>4 AI agents</strong> — Fundamental · News · Technical · Risk — each score independently, then confidence is calculated mathematically.</div></div></div>`;
