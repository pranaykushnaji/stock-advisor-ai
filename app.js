// ─── State ───
let bouquet = [], history = [], currentAnalysis = null;

const STORAGE_KEYS = { KEY: 'sa_gemini_key', BOUQUET: 'sa_bouquet', HISTORY: 'sa_history' };

function loadState() {
  try { bouquet = JSON.parse(localStorage.getItem(STORAGE_KEYS.BOUQUET) || '[]'); } catch { bouquet = []; }
  try { history = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]'); } catch { history = []; }
  updateBadge();
}

function saveState() {
  localStorage.setItem(STORAGE_KEYS.BOUQUET, JSON.stringify(bouquet));
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
  updateBadge();
}

function getKey() { return localStorage.getItem(STORAGE_KEYS.KEY) || ''; }
function saveKey(k) { localStorage.setItem(STORAGE_KEYS.KEY, k); }

function updateBadge() {
  const b = document.getElementById('bouquet-badge');
  if (b) b.textContent = bouquet.length || '';
}

// ─── Tabs ───
function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.toggle('active', el.id === 'tab-' + name));
  if (name === 'bouquet') renderBouquet();
  if (name === 'history') renderHistory();
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─── API Modal ───
const modal = document.getElementById('api-modal');
const keyInput = document.getElementById('api-key-input');
const toggleBtn = document.getElementById('toggle-key');
const keyError = document.getElementById('key-error');

function openModal() {
  keyInput.value = getKey();
  keyError.textContent = '';
  modal.classList.add('open');
  setTimeout(() => keyInput.focus(), 200);
}
function closeModal() { modal.classList.remove('open'); }

document.getElementById('settings-btn').addEventListener('click', openModal);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

toggleBtn.addEventListener('click', () => {
  const isHidden = keyInput.type === 'password';
  keyInput.type = isHidden ? 'text' : 'password';
  toggleBtn.textContent = isHidden ? 'Hide' : 'Show';
});

document.getElementById('save-key-btn').addEventListener('click', () => {
  const k = keyInput.value.trim();
  if (!k) { keyError.textContent = 'Please enter a key.'; return; }
  if (!k.startsWith('AIza') && !k.startsWith('AQ.')) { keyError.textContent = 'Key doesn\'t look right — it should start with "AIza" or "AQ." — double check.'; return; }
  saveKey(k);
  closeModal();
  showToast('API key saved! Start analyzing stocks.');
});

// ─── Rate limit countdown + auto retry ───
function showCountdown(area, stockName, key, prompt) {
  let secs = 62;
  area.innerHTML = `<div class="result-card" style="border-left:3px solid var(--amber);">
    <div style="font-size:15px;font-weight:600;margin-bottom:8px;">⏳ Rate limit hit — auto-retrying in <span id="cd-num">${secs}</span>s</div>
    <div style="font-size:13px;color:var(--text2);margin-bottom:14px;">Google Gemini free tier allows 15 requests/minute. Waiting for reset…</div>
    <div style="background:var(--bg3);border-radius:var(--radius);height:6px;overflow:hidden;">
      <div id="cd-bar" style="height:100%;background:var(--amber);width:100%;transition:width 1s linear;"></div>
    </div>
    <button class="btn btn-ghost" style="margin-top:14px;" onclick="cancelCountdown()">Cancel</button>
  </div>`;
  
  window._cdCancelled = false;
  const interval = setInterval(async () => {
    if (window._cdCancelled) { clearInterval(interval); return; }
    secs--;
    const numEl = document.getElementById('cd-num');
    const barEl = document.getElementById('cd-bar');
    if (numEl) numEl.textContent = secs;
    if (barEl) barEl.style.width = (secs / 62 * 100) + '%';
    if (secs <= 0) {
      clearInterval(interval);
      if (!window._cdCancelled) {
        // Auto retry
        area.innerHTML = `<div class="loading-wrap"><div class="spinner"></div><p>Retrying <strong>${stockName}</strong>…</p></div>`;
        await doAnalyze(stockName, key, prompt, area);
      }
    }
  }, 1000);
  window._cdInterval = interval;
}

function cancelCountdown() {
  window._cdCancelled = true;
  if (window._cdInterval) clearInterval(window._cdInterval);
  document.getElementById('result-area').innerHTML = '<p style="color:var(--text3);padding:8px 0;font-size:14px;">Cancelled. Try again when ready.</p>';
}

// ─── Stock Analysis ───
async function analyzeStock() {
  const input = document.getElementById('stock-input').value.trim();
  if (!input) return;

  const key = getKey();
  if (!key) { openModal(); return; }

  const btn = document.getElementById('analyze-btn');
  const area = document.getElementById('result-area');

  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzing…`;
  area.innerHTML = `<div class="loading-wrap"><div class="spinner"></div><p>Researching <strong>${esc(input)}</strong>…</p></div>`;

  const prompt = `You are an expert stock market analyst specializing in Indian and global equities. Analyze this stock: "${input}".

Return ONLY a valid JSON object. No markdown, no explanation, no text before or after. Exactly this structure:
{
  "ticker": "NSE/BSE ticker or short name",
  "fullName": "Full legal company name",
  "sector": "Primary sector / industry",
  "verdict": "BUY" or "HOLD" or "AVOID",
  "confidence": integer from 0 to 100,
  "summary": "3 sentence analysis covering business strength, current situation, and why you gave this verdict",
  "bullPoints": ["positive factor 1", "positive factor 2", "positive factor 3"],
  "bearPoints": ["risk or concern 1", "risk or concern 2"],
  "catalysts": ["specific recent news or catalyst 1", "specific recent news or catalyst 2"],
  "timeHorizon": "Short-term (1-3 months)" or "Medium-term (3-12 months)" or "Long-term (1+ years)",
  "priceContext": "Current price range, P/E, valuation note, and analyst target if known"
}

Rules:
- Be specific with real data — mention actual metrics, recent earnings, real news
- If the stock is unknown/fictional set verdict HOLD, confidence 20, explain in summary
- verdict must be exactly "BUY", "HOLD", or "AVOID"
- confidence must be a number 0-100
- Return ONLY the JSON object, nothing else`;

  await doAnalyze(input, key, prompt, area);

  btn.disabled = false;
  btn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg> Analyze`;
}

async function doAnalyze(input, key, prompt, area) {
  try {
    // Try multiple models as fallback — flash-lite has highest free limits
    const models = ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    let res, lastErr;

    for (const model of models) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
        })
      });

      if (res.ok) break; // success, stop trying
      if (res.status === 429) {
        lastErr = '429';
        continue; // rate limited, try next model
      }
      break; // other error, stop
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;
      const status = res.status;
      if (status === 400) throw new Error(`Invalid request or API key. Details: ${msg}`);
      if (status === 403) throw new Error(`API key rejected (403). Go to aistudio.google.com and make sure your key is active. Details: ${msg}`);
      if (status === 429) { showCountdown(area, input, key, prompt); return; }
      if (status === 404) throw new Error(`Model not found (404). Try refreshing. Details: ${msg}`);
      throw new Error(`API error ${status}: ${msg}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('Empty response from Gemini. Please try again.');

    const cleaned = rawText.replace(/\`\`\`json\s*/gi, '').replace(/\`\`\`\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse Gemini response. Please try again.');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.ticker || !parsed.verdict) throw new Error('Incomplete analysis returned. Please try again.');

    currentAnalysis = { ...parsed, analyzedAt: new Date().toISOString(), query: input };
    history.unshift(currentAnalysis);
    if (history.length > 100) history = history.slice(0, 100);
    saveState();
    renderResult(parsed, area);

  } catch (err) {
    area.innerHTML = `<div class="error-card">
      <div class="error-title">⚠ Analysis failed</div>
      <div class="error-msg">${esc(err.message)}</div>
      ${err.message.includes('key') ? `<br><button class="btn btn-ghost" onclick="openModal()" style="margin-top:8px;">Update API Key</button>` : ''}
    </div>`;
  }
}

function renderResult(d, area) {
  const vClass = d.verdict === 'BUY' ? 'buy' : d.verdict === 'AVOID' ? 'avoid' : 'hold';
  const vBadge = d.verdict === 'BUY' ? 'verdict-buy' : d.verdict === 'AVOID' ? 'verdict-avoid' : 'verdict-hold';
  const confColor = d.confidence >= 70 ? '#22c87a' : d.confidence >= 45 ? '#f5a623' : '#f05b5b';

  area.innerHTML = `
    <div class="result-card ${vClass}">
      <div class="stock-name">${esc(d.ticker)}</div>
      <div class="stock-meta">${esc(d.fullName)} &middot; ${esc(d.sector)}</div>

      <div class="verdict-row">
        <span class="verdict-badge ${vBadge}">${esc(d.verdict)}</span>
        <div class="conf-bar">
          <div class="conf-fill" id="conf-fill" style="width:0%;background:${confColor};"></div>
        </div>
        <span class="conf-label">${Math.round(d.confidence)}%</span>
      </div>
      <div class="horizon-label">${esc(d.timeHorizon || '')}</div>

      <p class="summary">${esc(d.summary)}</p>

      ${d.catalysts && d.catalysts.length ? `
        <div class="catalysts-box">
          <div class="section-title">Recent Catalysts</div>
          ${d.catalysts.map(c => `<div class="point-item"><div class="point-dot dot-amber"></div><span>${esc(c)}</span></div>`).join('')}
        </div>` : ''}

      <div class="section-grid">
        <div class="section-box">
          <div class="section-title">Bull Case</div>
          ${(d.bullPoints || []).map(b => `<div class="point-item"><div class="point-dot dot-green"></div><span>${esc(b)}</span></div>`).join('')}
        </div>
        <div class="section-box">
          <div class="section-title">Bear Case / Risks</div>
          ${(d.bearPoints || []).map(b => `<div class="point-item"><div class="point-dot dot-red"></div><span>${esc(b)}</span></div>`).join('')}
        </div>
      </div>

      <div class="valuation-box">
        <span>Valuation: </span>${esc(d.priceContext || '')}
      </div>

      <div class="action-row">
        <button class="btn btn-green" onclick="approvePick()">✓ Add to Bouquet</button>
        <button class="btn btn-red" onclick="skipPick()">✕ Skip</button>
        <button class="btn btn-ghost" onclick="resetAdvisor()">↺ New Search</button>
      </div>
    </div>`;

  setTimeout(() => {
    const fill = document.getElementById('conf-fill');
    if (fill) fill.style.width = d.confidence + '%';
  }, 100);
}

// ─── Bouquet actions ───
function approvePick() {
  if (!currentAnalysis) return;
  if (bouquet.find(b => b.ticker === currentAnalysis.ticker)) {
    showToast(`${currentAnalysis.ticker} is already in your bouquet.`, 'warn');
    return;
  }
  bouquet.push({ ...currentAnalysis, addedAt: new Date().toISOString() });
  saveState();
  showToast(`${currentAnalysis.ticker} added to your bouquet! 🌸`);
  const area = document.getElementById('result-area');
  const note = document.createElement('div');
  note.className = 'result-card';
  note.style.cssText = 'border-left:3px solid var(--green);display:flex;align-items:center;gap:10px;';
  note.innerHTML = `<span style="font-size:20px">✅</span><span><strong>${esc(currentAnalysis.ticker)}</strong> added to your bouquet. Switch to <strong>My Bouquet</strong> to track its simulated growth.</span>`;
  area.appendChild(note);
}

function skipPick() {
  currentAnalysis = null;
  document.getElementById('result-area').innerHTML = '<p style="color:var(--text3);padding:8px 0;font-size:14px;">Skipped. Enter another stock to analyze.</p>';
}

function resetAdvisor() {
  currentAnalysis = null;
  document.getElementById('result-area').innerHTML = '';
  document.getElementById('stock-input').value = '';
  document.getElementById('stock-input').focus();
}

// ─── Simulated gain ───
function simGain(item) {
  const days = Math.max(1, Math.floor((Date.now() - new Date(item.addedAt).getTime()) / 86400000));
  const seed = item.ticker.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const dir = item.verdict === 'BUY' ? 1 : item.verdict === 'AVOID' ? -0.6 : 0.05;
  const cf = (item.confidence - 50) / 50;
  const noise = (Math.sin(seed * 0.17 + days * 0.09) + Math.cos(seed * 0.31 + days * 0.05)) * 0.5;
  return +((dir * cf * 0.30 + noise * 0.10) * (days / 365) * 100).toFixed(1);
}

// ─── Render Bouquet ───
function renderBouquet() {
  const el = document.getElementById('bouquet-content');
  if (!bouquet.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🌸</div><h3>Your bouquet is empty</h3><p>Analyze a stock and click "Add to Bouquet" to track it here.</p></div>`;
    return;
  }
  const gains = bouquet.map(simGain);
  const avg = (gains.reduce((a, b) => a + b, 0) / gains.length).toFixed(1);
  const wins = gains.filter(g => g > 0).length;

  el.innerHTML = `
    <div class="summary-tiles">
      <div class="summary-tile">
        <div class="tile-num">${bouquet.length}</div>
        <div class="tile-lbl">Stocks tracked</div>
      </div>
      <div class="summary-tile">
        <div class="tile-num" style="color:${parseFloat(avg) >= 0 ? 'var(--green)' : 'var(--red)'}">${parseFloat(avg) >= 0 ? '+' : ''}${avg}%</div>
        <div class="tile-lbl">Avg simulated return</div>
      </div>
      <div class="summary-tile">
        <div class="tile-num">${wins}<span style="font-size:16px;color:var(--text3)">/${bouquet.length}</span></div>
        <div class="tile-lbl">In simulated profit</div>
      </div>
    </div>
    <div class="bouquet-list">
      ${bouquet.map((item, i) => {
        const g = gains[i];
        const gStr = (g > 0 ? '+' : '') + g + '%';
        const days = Math.max(1, Math.floor((Date.now() - new Date(item.addedAt).getTime()) / 86400000));
        const vBadge = item.verdict === 'BUY' ? 'verdict-buy' : item.verdict === 'AVOID' ? 'verdict-avoid' : 'verdict-hold';
        return `<div class="bouquet-item">
          <div class="bi-info">
            <div class="bi-ticker">${esc(item.ticker)}</div>
            <div class="bi-meta">Added ${days}d ago &middot; ${Math.round(item.confidence)}% confidence</div>
          </div>
          <span class="verdict-badge ${vBadge}">${item.verdict}</span>
          <div class="bi-gain ${g >= 0 ? 'up' : 'down'}">${gStr}</div>
          <button class="bi-remove" onclick="removePick(${i})" title="Remove">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>`;
      }).join('')}
      <div class="sim-note">Simulated returns only — based on verdict direction & confidence. Not real portfolio data.</div>
    </div>`;
}

function removePick(i) {
  const ticker = bouquet[i]?.ticker;
  bouquet.splice(i, 1);
  saveState();
  renderBouquet();
  if (ticker) showToast(`${ticker} removed from bouquet.`, 'warn');
}

// ─── Render History ───
function renderHistory() {
  const el = document.getElementById('history-content');
  if (!history.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><h3>No history yet</h3><p>Analyzed stocks will appear here.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="history-list">
    ${history.slice(0, 50).map(item => {
      const ds = new Date(item.analyzedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const vBadge = item.verdict === 'BUY' ? 'verdict-buy' : item.verdict === 'AVOID' ? 'verdict-avoid' : 'verdict-hold';
      const inB = bouquet.some(b => b.ticker === item.ticker);
      return `<div class="history-item">
        <div class="hi-ticker">${esc(item.ticker)} <span style="font-size:12px;color:var(--text3);font-weight:400;">${esc(item.fullName || '')}</span></div>
        <span class="verdict-badge ${vBadge}">${item.verdict}</span>
        <span style="font-size:12px;color:var(--text3);margin-left:4px;">${Math.round(item.confidence)}%</span>
        <span class="hi-date">${ds}</span>
        ${inB ? '<span class="hi-bouquet">✓ In bouquet</span>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

document.getElementById('clear-history-btn').addEventListener('click', () => {
  if (!history.length) return;
  if (confirm('Clear all analysis history?')) {
    history = [];
    saveState();
    renderHistory();
  }
});

// ─── Toast ───
function showToast(msg, type = 'success') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.borderLeftColor = type === 'warn' ? 'var(--amber)' : 'var(--green)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── Helpers ───
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Search on Enter ───
document.getElementById('stock-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') analyzeStock();
});
document.getElementById('analyze-btn').addEventListener('click', analyzeStock);

// ─── Init ───
loadState();
if (!getKey()) {
  setTimeout(() => {
    const area = document.getElementById('result-area');
    area.innerHTML = `<div class="result-card" style="border-left:3px solid var(--accent);display:flex;align-items:flex-start;gap:16px;">
      <div style="font-size:32px">🔑</div>
      <div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Add your free Gemini API key to get started</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:14px;">Google Gemini has a free tier with 1,500 requests/day — no credit card needed.</div>
        <button class="btn btn-primary" onclick="openModal()">Setup API Key →</button>
      </div>
    </div>`;
  }, 100);
}
