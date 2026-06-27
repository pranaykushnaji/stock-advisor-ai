// ─── State ───
let bouquet=[], history=[], currentAnalysis=null;
const SK={KEY:'sa_api_key',BOUQUET:'sa_bouquet',HISTORY:'sa_history',PROVIDER:'sa_provider',THEME:'sa_theme'};

function loadState(){
  try{bouquet=JSON.parse(localStorage.getItem(SK.BOUQUET)||'[]');}catch{bouquet=[];}
  try{history=JSON.parse(localStorage.getItem(SK.HISTORY)||'[]');}catch{history=[];}
  updateBadge();
}
function saveState(){
  localStorage.setItem(SK.BOUQUET,JSON.stringify(bouquet));
  localStorage.setItem(SK.HISTORY,JSON.stringify(history));
  updateBadge();
}
function getKey(){return localStorage.getItem(SK.KEY)||'';}
function saveKey(k){localStorage.setItem(SK.KEY,k);}
function getProvider(){return localStorage.getItem(SK.PROVIDER)||'groq';}
function saveProvider(p){localStorage.setItem(SK.PROVIDER,p);}
function updateBadge(){const b=document.getElementById('bouquet-badge');if(b)b.textContent=bouquet.length||'';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ─── Theme ───
function initTheme(){
  const saved=localStorage.getItem(SK.THEME);
  const theme=saved||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');
  setTheme(theme);
}
function setTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem(SK.THEME,t);
  document.getElementById('theme-icon-dark').style.display=t==='dark'?'block':'none';
  document.getElementById('theme-icon-light').style.display=t==='light'?'block':'none';
}
document.getElementById('theme-toggle').addEventListener('click',()=>{
  const cur=document.documentElement.getAttribute('data-theme');
  setTheme(cur==='dark'?'light':'dark');
});

// ─── Tabs ───
function switchTab(name){
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.tab===name));
  document.querySelectorAll('.tab-pane').forEach(el=>el.classList.toggle('active',el.id==='tab-'+name));
  if(name==='bouquet')renderBouquet();
  if(name==='history')renderHistory();
}
document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));

// ─── Modal ───
const modal=document.getElementById('api-modal'),keyInput=document.getElementById('api-key-input'),
  toggleBtn=document.getElementById('toggle-key'),keyError=document.getElementById('key-error'),
  providerSelect=document.getElementById('provider-select');

function openModal(){
  keyInput.value=getKey();providerSelect.value=getProvider();updateModalHint();keyError.textContent='';
  modal.classList.add('open');setTimeout(()=>keyInput.focus(),200);
}
function closeModal(){modal.classList.remove('open');}
function updateModalHint(){
  const h=document.getElementById('provider-hint'),p=providerSelect.value;
  h.innerHTML=p==='groq'
    ?'<ol class="setup-steps"><li>Go to <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a></li><li>Sign up free (Google/GitHub)</li><li>Click <strong>"Create API Key"</strong></li><li>Paste below (starts with <code>gsk_</code>)</li></ol>'
    :'<ol class="setup-steps"><li>Go to <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a></li><li>Sign in with Google</li><li>Click <strong>"Create API Key"</strong></li><li>Paste below</li></ol>';
}
providerSelect?.addEventListener('change',updateModalHint);
document.getElementById('settings-btn').addEventListener('click',openModal);
document.getElementById('modal-close').addEventListener('click',closeModal);
document.getElementById('modal-cancel').addEventListener('click',closeModal);
modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
toggleBtn.addEventListener('click',()=>{const h=keyInput.type==='password';keyInput.type=h?'text':'password';toggleBtn.textContent=h?'Hide':'Show';});

document.getElementById('save-key-btn').addEventListener('click',()=>{
  const k=keyInput.value.trim(),p=providerSelect.value;
  if(!k){keyError.textContent='Please enter a key.';return;}
  if(p==='groq'&&!k.startsWith('gsk_')){keyError.textContent='Groq keys start with "gsk_"';return;}
  saveKey(k);saveProvider(p);closeModal();showToast('API key saved!');
  document.getElementById('result-area').innerHTML='';
});

// ─── Analysis prompt ───
const PROMPT=`You are an expert stock market analyst. Analyze this stock for investment.
Return ONLY valid JSON — no markdown, no explanation:
{"ticker":"SYMBOL","fullName":"Company Name","sector":"Sector","verdict":"BUY/HOLD/AVOID","confidence":0-100,"summary":"3 sentences","bullPoints":["p1","p2","p3"],"bearPoints":["r1","r2"],"catalysts":["news1","news2"],"timeHorizon":"Short-term/Medium-term/Long-term","priceContext":"valuation note"}
Be specific. Use real data. verdict must be BUY, HOLD, or AVOID. Return ONLY JSON.`;

// ─── API calls ───
async function callGroq(key,stock){
  const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
    body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'system',content:PROMPT},{role:'user',content:`Analyze: "${stock}"`}],temperature:0.4,max_tokens:1200})
  });
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(r.status===401?'Invalid Groq key. Update in API Settings.':e?.error?.message||`Error ${r.status}`);}
  return(await r.json())?.choices?.[0]?.message?.content||'';
}
async function callGemini(key,stock){
  const p=PROMPT+`\nAnalyze: "${stock}"`;
  for(const m of['gemini-2.0-flash-lite','gemini-2.0-flash']){
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{parts:[{text:p}]}],generationConfig:{temperature:0.4,maxOutputTokens:1200}})
    });
    if(r.ok)return(await r.json())?.candidates?.[0]?.content?.parts?.[0]?.text||'';
    if(r.status===429||r.status===404)continue;
    const e=await r.json().catch(()=>({}));throw new Error(`Gemini: ${e?.error?.message||r.status}`);
  }
  throw new Error('Gemini rate limited. Wait or switch to Groq.');
}

async function callAI(stock){
  const key=getKey(),p=getProvider();
  if(!key){openModal();throw new Error('No API key');}
  return p==='groq'?callGroq(key,stock):callGemini(key,stock);
}

function parseAnalysis(raw,query){
  const c=raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  const m=c.match(/\{[\s\S]*\}/);
  if(!m)throw new Error('No JSON in response');
  const d=JSON.parse(m[0]);
  if(!d.ticker||!d.verdict)throw new Error('Incomplete analysis');
  return{...d,analyzedAt:new Date().toISOString(),query};
}

// ─── Fetch stock data ───
async function fetchStockData(symbol){
  try{
    const r=await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}`);
    if(!r.ok)return null;
    return await r.json();
  }catch{return null;}
}

// ─── Fetch news ───
async function fetchNews(query){
  try{
    const r=await fetch(`/api/news?q=${encodeURIComponent(query)}`);
    if(!r.ok)return[];
    const d=await r.json();
    return d.articles||[];
  }catch{return[];}
}

// ─── Stock Analysis ───
async function analyzeStock(){
  const input=document.getElementById('stock-input').value.trim();
  if(!input)return;
  const btn=document.getElementById('analyze-btn'),area=document.getElementById('result-area');
  btn.disabled=true;btn.innerHTML='<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzing…';
  area.innerHTML=`<div class="loading-wrap"><div class="spinner"></div><p>Researching <strong>${esc(input)}</strong>…</p></div>`;

  try{
    // Run AI analysis + stock data + news in parallel
    const [rawText,stockData,news]=await Promise.all([
      callAI(input),
      fetchStockData(input),
      fetchNews(input)
    ]);
    const parsed=parseAnalysis(rawText,input);
    currentAnalysis=parsed;
    history.unshift(parsed);if(history.length>100)history=history.slice(0,100);
    saveState();
    renderResult(parsed,area,stockData,news);
  }catch(err){
    area.innerHTML=`<div class="error-card"><div class="error-title">⚠ Analysis failed</div><div class="error-msg">${esc(err.message)}</div>
      ${err.message.includes('key')?'<br><button class="btn btn-ghost" onclick="openModal()" style="margin-top:8px;">Update API Key</button>':''}</div>`;
  }finally{
    btn.disabled=false;btn.innerHTML='<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg> Analyze';
  }
}

// ─── Render result ───
function renderResult(d,area,stockData,news){
  const vClass=d.verdict==='BUY'?'buy':d.verdict==='AVOID'?'avoid':'hold';
  const vBadge=d.verdict==='BUY'?'verdict-buy':d.verdict==='AVOID'?'verdict-avoid':'verdict-hold';
  const confColor=d.confidence>=70?'var(--green)':d.confidence>=45?'var(--amber)':'var(--red)';

  let priceHtml='';
  if(stockData){
    const chgClass=stockData.change>=0?'up':'down';
    const chgSign=stockData.change>=0?'+':'';
    priceHtml=`<div class="stock-price-row">
      <span class="stock-price">${stockData.currency==='INR'?'₹':'$'}${stockData.price?.toFixed(2)}</span>
      <span class="stock-change ${chgClass}">${chgSign}${stockData.change} (${chgSign}${stockData.changePercent}%)</span>
      <span style="font-size:12px;color:var(--text3);">${stockData.exchange}</span>
    </div>`;
  }

  let chartHtml='';
  if(stockData?.chart?.close?.length){
    chartHtml=`<div class="chart-container">
      <div class="chart-header"><span class="chart-title">Price History (3 months)</span></div>
      <canvas class="chart-canvas" id="price-chart"></canvas>
    </div>`;
  }

  let newsHtml='';
  if(news&&news.length){
    newsHtml=`<div class="news-box"><div class="section-title">Latest News</div>
      ${news.slice(0,5).map(n=>`<div class="news-item"><a href="${esc(n.link)}" target="_blank">${esc(n.title)}</a><span class="news-source">${esc(n.source)}</span></div>`).join('')}
    </div>`;
  }

  area.innerHTML=`<div class="result-card ${vClass}">
    <div class="stock-name">${esc(d.ticker)}</div>
    <div class="stock-meta">${esc(d.fullName)} · ${esc(d.sector)}</div>
    ${priceHtml}
    <div class="verdict-row"><span class="verdict-badge ${vBadge}">${esc(d.verdict)}</span>
      <div class="conf-bar"><div class="conf-fill" id="conf-fill" style="width:0%;background:${confColor};"></div></div>
      <span class="conf-label">${Math.round(d.confidence)}%</span></div>
    <div class="horizon-label">${esc(d.timeHorizon||'')}</div>
    <p class="summary">${esc(d.summary)}</p>
    ${chartHtml}${newsHtml}
    ${d.catalysts?.length?`<div class="catalysts-box"><div class="section-title">Recent Catalysts</div>
      ${d.catalysts.map(c=>`<div class="point-item"><div class="point-dot dot-amber"></div><span>${esc(c)}</span></div>`).join('')}</div>`:''}
    <div class="section-grid">
      <div class="section-box"><div class="section-title">Bull Case</div>
        ${(d.bullPoints||[]).map(b=>`<div class="point-item"><div class="point-dot dot-green"></div><span>${esc(b)}</span></div>`).join('')}</div>
      <div class="section-box"><div class="section-title">Bear Case / Risks</div>
        ${(d.bearPoints||[]).map(b=>`<div class="point-item"><div class="point-dot dot-red"></div><span>${esc(b)}</span></div>`).join('')}</div>
    </div>
    <div class="valuation-box"><span>Valuation: </span>${esc(d.priceContext||'')}</div>
    <div class="action-row">
      <button class="btn btn-green" onclick="approvePick()">✓ Add to Bouquet</button>
      <button class="btn btn-red" onclick="skipPick()">✕ Skip</button>
      <button class="btn btn-ghost" onclick="resetAdvisor()">↺ New Search</button>
    </div></div>`;

  setTimeout(()=>{const f=document.getElementById('conf-fill');if(f)f.style.width=d.confidence+'%';},100);
  if(stockData?.chart?.close?.length)drawChart(stockData.chart);
}

// ─── Draw chart (canvas) ───
function drawChart(chartData){
  const canvas=document.getElementById('price-chart');
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  const rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height,pad={t:10,r:10,b:24,l:50};

  const closes=chartData.close.filter(v=>v!=null);
  if(!closes.length)return;
  const min=Math.min(...closes)*0.98,max=Math.max(...closes)*1.02;
  const xStep=(W-pad.l-pad.r)/(closes.length-1);

  const style=getComputedStyle(document.documentElement);
  const gridColor=style.getPropertyValue('--chart-grid').trim();
  const lineColor=style.getPropertyValue('--chart-line').trim();
  const textColor=style.getPropertyValue('--text3').trim();

  // Grid
  ctx.strokeStyle=gridColor;ctx.lineWidth=0.5;
  for(let i=0;i<5;i++){
    const y=pad.t+(H-pad.t-pad.b)*i/4;
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke();
    const val=max-(max-min)*i/4;
    ctx.fillStyle=textColor;ctx.font='10px sans-serif';ctx.textAlign='right';
    ctx.fillText(val.toFixed(0),pad.l-6,y+3);
  }

  // Line
  ctx.beginPath();ctx.strokeStyle=lineColor;ctx.lineWidth=2;ctx.lineJoin='round';
  closes.forEach((v,i)=>{
    const x=pad.l+i*xStep,y=pad.t+(1-(v-min)/(max-min))*(H-pad.t-pad.b);
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  ctx.stroke();

  // Gradient fill
  const lastX=pad.l+(closes.length-1)*xStep;
  const grad=ctx.createLinearGradient(0,pad.t,0,H-pad.b);
  grad.addColorStop(0,lineColor+'40');grad.addColorStop(1,lineColor+'00');
  ctx.lineTo(lastX,H-pad.b);ctx.lineTo(pad.l,H-pad.b);ctx.closePath();
  ctx.fillStyle=grad;ctx.fill();
}

// ─── Compare ───
document.getElementById('compare-btn').addEventListener('click',async()=>{
  const a=document.getElementById('compare-a').value.trim();
  const b=document.getElementById('compare-b').value.trim();
  if(!a||!b)return;
  const area=document.getElementById('compare-result');
  area.innerHTML=`<div class="loading-wrap"><div class="spinner"></div><p>Comparing <strong>${esc(a)}</strong> vs <strong>${esc(b)}</strong>…</p></div>`;

  try{
    const[rA,rB]=await Promise.all([callAI(a),callAI(b)]);
    const dA=parseAnalysis(rA,a),dB=parseAnalysis(rB,b);
    const vBadge=v=>v==='BUY'?'verdict-buy':v==='AVOID'?'verdict-avoid':'verdict-hold';
    const confColor=c=>c>=70?'var(--green)':c>=45?'var(--amber)':'var(--red)';
    const card=d=>`<div class="result-card ${d.verdict==='BUY'?'buy':d.verdict==='AVOID'?'avoid':'hold'}">
      <div class="stock-name" style="font-size:18px;">${esc(d.ticker)}</div>
      <div class="stock-meta">${esc(d.fullName)}</div>
      <div class="verdict-row" style="margin-top:12px;"><span class="verdict-badge ${vBadge(d.verdict)}">${d.verdict}</span>
        <div class="conf-bar"><div class="conf-fill" style="width:${d.confidence}%;background:${confColor(d.confidence)};"></div></div>
        <span class="conf-label">${d.confidence}%</span></div>
      <p class="summary" style="margin-top:12px;">${esc(d.summary)}</p>
      <div style="margin-top:12px;"><div class="section-title">Bull Case</div>
        ${(d.bullPoints||[]).map(b=>`<div class="point-item"><div class="point-dot dot-green"></div><span>${esc(b)}</span></div>`).join('')}</div>
      <div style="margin-top:12px;"><div class="section-title">Risks</div>
        ${(d.bearPoints||[]).map(b=>`<div class="point-item"><div class="point-dot dot-red"></div><span>${esc(b)}</span></div>`).join('')}</div>
    </div>`;

    const winner=dA.confidence>dB.confidence?dA:dB;
    area.innerHTML=`<div class="result-card" style="border-left:3px solid var(--accent);margin-bottom:16px;padding:16px 20px;">
      <div style="font-size:14px;color:var(--text2);">🏆 <strong>${esc(winner.ticker)}</strong> scores higher with ${winner.confidence}% confidence (${winner.verdict})</div>
    </div><div class="compare-grid">${card(dA)}${card(dB)}</div>`;
  }catch(err){
    area.innerHTML=`<div class="error-card"><div class="error-title">⚠ Compare failed</div><div class="error-msg">${esc(err.message)}</div></div>`;
  }
});

// ─── Bouquet ───
function approvePick(){
  if(!currentAnalysis)return;
  if(bouquet.find(b=>b.ticker===currentAnalysis.ticker)){showToast(currentAnalysis.ticker+' already in bouquet','warn');return;}
  bouquet.push({...currentAnalysis,addedAt:new Date().toISOString()});
  saveState();showToast(currentAnalysis.ticker+' added to bouquet! 🌸');
  const area=document.getElementById('result-area');
  const n=document.createElement('div');n.className='result-card';n.style.cssText='border-left:3px solid var(--green);display:flex;align-items:center;gap:10px;';
  n.innerHTML=`<span style="font-size:20px">✅</span><span><strong>${esc(currentAnalysis.ticker)}</strong> added. Check <strong>My Bouquet</strong>.</span>`;
  area.appendChild(n);
}
function skipPick(){currentAnalysis=null;document.getElementById('result-area').innerHTML='<p style="color:var(--text3);padding:8px 0;font-size:14px;">Skipped.</p>';}
function resetAdvisor(){currentAnalysis=null;document.getElementById('result-area').innerHTML='';document.getElementById('stock-input').value='';document.getElementById('stock-input').focus();}

function simGain(item){
  const days=Math.max(1,Math.floor((Date.now()-new Date(item.addedAt).getTime())/86400000));
  const seed=item.ticker.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const dir=item.verdict==='BUY'?1:item.verdict==='AVOID'?-0.6:0.05;
  const cf=(item.confidence-50)/50;
  const noise=(Math.sin(seed*0.17+days*0.09)+Math.cos(seed*0.31+days*0.05))*0.5;
  return+((dir*cf*0.30+noise*0.10)*(days/365)*100).toFixed(1);
}

const SECTOR_COLORS=['#4f8ef7','#22c87a','#f5a623','#f05b5b','#a855f7','#06b6d4','#ec4899','#84cc16','#f97316','#6366f1'];

function renderBouquet(){
  const el=document.getElementById('bouquet-content');
  if(!bouquet.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">🌸</div><h3>Your bouquet is empty</h3><p>Analyze a stock and click "Add to Bouquet".</p></div>';return;}

  const gains=bouquet.map(simGain),avg=(gains.reduce((a,b)=>a+b,0)/gains.length).toFixed(1),wins=gains.filter(g=>g>0).length;

  // Sector breakdown
  const sectors={};
  bouquet.forEach(b=>{const s=b.sector||'Other';sectors[s]=(sectors[s]||0)+1;});
  const sectorEntries=Object.entries(sectors).sort((a,b)=>b[1]-a[1]);
  const total=bouquet.length;
  let pieHtml='';
  if(sectorEntries.length>1){
    let angle=0;
    const slices=sectorEntries.map((s,i)=>{
      const pct=s[1]/total;const start=angle;angle+=pct*360;
      const startRad=(start-90)*Math.PI/180,endRad=(angle-90)*Math.PI/180;
      const x1=50+40*Math.cos(startRad),y1=50+40*Math.sin(startRad);
      const x2=50+40*Math.cos(endRad),y2=50+40*Math.sin(endRad);
      const large=pct>0.5?1:0;
      const color=SECTOR_COLORS[i%SECTOR_COLORS.length];
      return{path:`<path d="M50,50 L${x1},${y1} A40,40 0 ${large},1 ${x2},${y2} Z" fill="${color}"/>`,label:s[0],count:s[1],color,pct};
    });
    pieHtml=`<div class="sector-chart"><div class="section-title">Sector Breakdown</div>
      <div style="display:flex;align-items:center;gap:20px;">
        <svg viewBox="0 0 100 100" width="120" height="120">${slices.map(s=>s.path).join('')}</svg>
        <div class="sector-legend">${slices.map(s=>`<div class="sector-legend-item"><div class="sector-dot" style="background:${s.color};"></div>${esc(s.label)} (${s.count})</div>`).join('')}</div>
      </div></div>`;
  }

  el.innerHTML=`
    <div class="summary-tiles">
      <div class="summary-tile"><div class="tile-num">${bouquet.length}</div><div class="tile-lbl">Stocks</div></div>
      <div class="summary-tile"><div class="tile-num" style="color:${parseFloat(avg)>=0?'var(--green)':'var(--red)'};">${parseFloat(avg)>=0?'+':''}${avg}%</div><div class="tile-lbl">Avg sim. return</div></div>
      <div class="summary-tile"><div class="tile-num">${wins}<span style="font-size:16px;color:var(--text3);">/${bouquet.length}</span></div><div class="tile-lbl">In profit</div></div>
      <div class="summary-tile clickable" onclick="document.getElementById('portfolio-modal').classList.add('open')"><div class="tile-num">💰</div><div class="tile-lbl">Simulate Portfolio</div></div>
    </div>
    ${pieHtml}
    <div class="bouquet-list">
      ${bouquet.map((item,i)=>{
        const g=gains[i],gStr=(g>0?'+':'')+g+'%';
        const days=Math.max(1,Math.floor((Date.now()-new Date(item.addedAt).getTime())/86400000));
        const vBadge=item.verdict==='BUY'?'verdict-buy':item.verdict==='AVOID'?'verdict-avoid':'verdict-hold';
        return`<div class="bouquet-item"><div class="bi-info"><div class="bi-ticker">${esc(item.ticker)}</div>
          <div class="bi-meta">${days}d ago · ${Math.round(item.confidence)}% conf · ${esc(item.sector||'')}</div></div>
          <span class="verdict-badge ${vBadge}" style="font-size:11px;padding:2px 10px;">${item.verdict}</span>
          <div class="bi-gain ${g>=0?'up':'down'}">${gStr}</div>
          <button class="bi-remove" onclick="removePick(${i})" title="Remove">✕</button></div>`;
      }).join('')}
      <div class="sim-note">Simulated returns · Not real portfolio data</div>
    </div>`;
}

function removePick(i){bouquet.splice(i,1);saveState();renderBouquet();}

// ─── Portfolio Simulator ───
function runSimulation(){
  const amt=parseFloat(document.getElementById('sim-amount').value)||100000;
  if(!bouquet.length){document.getElementById('sim-result').innerHTML='<p style="color:var(--text3);">Add stocks to bouquet first.</p>';return;}
  const perStock=amt/bouquet.length;
  const rows=bouquet.map(item=>{
    const g=simGain(item);const val=perStock*(1+g/100);const profit=val-perStock;
    return{ticker:item.ticker,invested:perStock,value:val,profit,gain:g,verdict:item.verdict};
  });
  const totalVal=rows.reduce((a,r)=>a+r.value,0);
  const totalProfit=totalVal-amt;
  const totalGain=((totalProfit/amt)*100).toFixed(1);

  document.getElementById('sim-result').innerHTML=`
    <div style="background:var(--bg3);border-radius:var(--radius);padding:16px;margin-bottom:12px;text-align:center;">
      <div style="font-size:12px;color:var(--text3);">If you invested ₹${amt.toLocaleString('en-IN')}</div>
      <div style="font-size:28px;font-weight:700;color:${totalProfit>=0?'var(--green)':'var(--red)'};">₹${Math.round(totalVal).toLocaleString('en-IN')}</div>
      <div style="font-size:14px;color:${totalProfit>=0?'var(--green)':'var(--red)'};">${totalProfit>=0?'+':''}₹${Math.round(totalProfit).toLocaleString('en-IN')} (${totalProfit>=0?'+':''}${totalGain}%)</div>
    </div>
    <table class="sim-table"><thead><tr><th>Stock</th><th>Invested</th><th>Value</th><th>Return</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td><strong>${esc(r.ticker)}</strong></td><td>₹${Math.round(r.invested).toLocaleString('en-IN')}</td>
        <td>₹${Math.round(r.value).toLocaleString('en-IN')}</td>
        <td style="color:${r.gain>=0?'var(--green)':'var(--red)'};">${r.gain>=0?'+':''}${r.gain}%</td></tr>`).join('')}
    </tbody></table>`;
}

// ─── Export CSV ───
document.getElementById('export-csv-btn').addEventListener('click',()=>{
  if(!bouquet.length){showToast('No stocks to export','warn');return;}
  const gains=bouquet.map(simGain);
  let csv='Ticker,Company,Sector,Verdict,Confidence,Simulated Return,Added Date\n';
  bouquet.forEach((b,i)=>{
    csv+=`${b.ticker},"${b.fullName||''}","${b.sector||''}",${b.verdict},${b.confidence}%,${gains[i]}%,${b.addedAt}\n`;
  });
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`stock-bouquet-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();URL.revokeObjectURL(url);
  showToast('CSV exported!');
});

// ─── History ───
function renderHistory(){
  const el=document.getElementById('history-content');
  if(!history.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><h3>No history yet</h3></div>';return;}
  el.innerHTML=`<div class="history-list">${history.slice(0,50).map(item=>{
    const ds=new Date(item.analyzedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const vB=item.verdict==='BUY'?'verdict-buy':item.verdict==='AVOID'?'verdict-avoid':'verdict-hold';
    const inB=bouquet.some(b=>b.ticker===item.ticker);
    return`<div class="history-item"><div class="hi-ticker">${esc(item.ticker)} <span style="font-size:12px;color:var(--text3);font-weight:400;">${esc(item.fullName||'')}</span></div>
      <span class="verdict-badge ${vB}" style="font-size:11px;padding:2px 10px;">${item.verdict}</span>
      <span style="font-size:12px;color:var(--text3);">${Math.round(item.confidence)}%</span>
      <span class="hi-date">${ds}</span>${inB?'<span class="hi-bouquet">✓</span>':''}</div>`;
  }).join('')}</div>`;
}
document.getElementById('clear-history-btn').addEventListener('click',()=>{if(history.length&&confirm('Clear all history?')){history=[];saveState();renderHistory();}});

// ─── Toast ───
function showToast(msg,type='success'){
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.className='toast';t.id='toast';document.body.appendChild(t);}
  t.textContent=msg;t.style.borderLeftColor=type==='warn'?'var(--amber)':'var(--green)';
  t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);
}

// ─── Events ───
document.getElementById('stock-input').addEventListener('keydown',e=>{if(e.key==='Enter')analyzeStock();});
document.getElementById('analyze-btn').addEventListener('click',analyzeStock);

// ─── Init ───
initTheme();loadState();
if(!getKey()){
  setTimeout(()=>{
    document.getElementById('result-area').innerHTML=`<div class="result-card" style="border-left:3px solid var(--accent);display:flex;align-items:flex-start;gap:16px;">
      <div style="font-size:32px">🔑</div><div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Add your free API key to get started</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:14px;"><strong>Recommended: Groq</strong> — free, fast, 14,400 req/day.<br>Get key at <a href="https://console.groq.com/keys" target="_blank" style="color:var(--accent);">console.groq.com/keys</a></div>
      <button class="btn btn-primary" onclick="openModal()">Setup API Key →</button></div></div>`;
  },100);
}
