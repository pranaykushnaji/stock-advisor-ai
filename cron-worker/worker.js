// Cloudflare Worker — the single punctual scheduler for StockAdvisor AI.
//
// Why this exists: GitHub's scheduled Actions fire hours late and drop runs on low-traffic
// repos. This Worker is the reliable clock instead. It does NOT do the work itself — it just
// fires HTTPS triggers at exact times:
//   • NSE snapshot  -> triggers the GitHub Actions workflow (the GitHub runner does the
//                      actual NSE fetch; NSE blocks Vercel/Cloudflare datacenter IPs).
//   • everything else -> calls the Vercel endpoints with the CRON_SECRET.
//
// Secrets (set with `wrangler secret put`, never committed):
//   CRON_SECRET   – same value your Vercel endpoints check
//   GITHUB_TOKEN  – fine-grained PAT for pranaykushnaji/stock-advisor-ai, Actions: read+write
// Vars (in wrangler.toml, not secret):
//   VERCEL_BASE, GITHUB_REPO, GITHUB_WORKFLOW
//
// Holidays: the Vercel endpoints already self-skip on weekends/NSE holidays (they return
// "skipped"), and re-firing the snapshot on a holiday is harmless — so the Worker doesn't
// need its own holiday calendar. It only avoids weekends (the cron is Mon–Fri).

const SELL = { kind: 'vercel', path: '/api/sell-check' };
const BUY  = { kind: 'vercel', path: '/api/stock-of-the-day' };
const SNAP = { kind: 'github' };

// Exact firing table, keyed by "HH:MM" in UTC (IST = UTC + 5:30).
// The cron trigger ticks every 5 minutes across the market window; the handler acts only
// when the current HH:MM matches a row here, so timing is precise to the tick.
//
// BUY now runs hourly (not once at 14:30) so a genuine opportunity mid-session isn't missed.
// Each buy-scan is preceded by its own NSE snapshot refresh ~15 min earlier, so the volume/
// filing data it reads is never more than ~15-20 min stale. SELL (sell-check) is unchanged —
// still hourly at :10 past, independent of the buy cadence.
const SCHEDULE = {
  // ---- Morning capture (research early, act at the open) ----
  '02:15': SNAP,                                             // 07:45 IST — overnight-filings snapshot
  '02:35': { kind: 'vercel', path: '/api/premarket' },       // 08:05 IST — pre-market research → watchlist
  '03:55': { kind: 'vercel', path: '/api/open-scan' },       // 09:25 IST — early entries from the watchlist
  '04:10': SELL,                                             // 09:40 IST — early sell-check for open entries

  '03:15': SNAP,   // 08:45 IST — pre-open snapshot (surveillance/announcements refresh)

  '04:15': SNAP,   // 09:45 IST — snapshot ahead of the first buy-scan
  '04:30': BUY,    // 10:00 IST — buy-scan #1 (first hour of real post-open volume)
  '04:40': SELL,   // 10:10 IST — sell-check #1

  '05:15': SNAP,   // 10:45 IST
  '05:30': BUY,    // 11:00 IST — buy-scan #2
  '05:40': SELL,   // 11:10 IST — sell-check #2

  '06:15': SNAP,   // 11:45 IST
  '06:30': BUY,    // 12:00 IST — buy-scan #3
  '06:40': SELL,   // 12:10 IST — sell-check #3

  '07:15': SNAP,   // 12:45 IST
  '07:30': BUY,    // 13:00 IST — buy-scan #4
  '07:40': SELL,   // 13:10 IST — sell-check #4

  '08:15': SNAP,   // 13:45 IST
  '08:30': BUY,    // 14:00 IST — buy-scan #5
  '08:40': SELL,   // 14:10 IST — sell-check #5

  '09:15': SNAP,   // 14:45 IST
  '09:30': BUY,    // 15:00 IST — buy-scan #6 (last — leaves 30 min before close to settle)
  '09:40': SELL,   // 15:10 IST — sell-check #6

  '10:10': { kind: 'vercel', path: '/api/refresh-prices' }, // 15:40 IST — final EOD price refresh
  '10:40': { kind: 'vercel', path: '/api/analytics' },       // 16:10 IST — forward-eval rejected picks + LLM vetoes (Phase 3)
};

function hhmm(date) {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

// Trigger the GitHub Actions workflow that fetches NSE data.
async function triggerGithub(env) {
  const repo = env.GITHUB_REPO;
  const wf = env.GITHUB_WORKFLOW || 'nse-snapshot.yml';
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'stock-advisor-cron-worker', // GitHub API requires a User-Agent
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  // A successful dispatch returns 204 No Content.
  return { ok: r.status === 204, status: r.status, body: r.status === 204 ? '' : await r.text() };
}

// Trigger a Vercel endpoint with the shared cron secret.
async function triggerVercel(env, path) {
  const r = await fetch(`${env.VERCEL_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.CRON_SECRET}` },
  });
  return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 500) };
}

async function runJob(env, entry) {
  if (entry.kind === 'github') return triggerGithub(env);
  if (entry.kind === 'vercel') return triggerVercel(env, entry.path);
  return { ok: false, status: 0, body: `unknown job kind: ${entry.kind}` };
}

// Exact timing is useful only if a one-off network wobble cannot erase the job. Retry boundedly;
// downstream endpoints are idempotent and daily/session de-duplication prevents duplicate buys.
async function runJobWithRetry(env, entry, attempts = 3) {
  let last = { ok: false, status: 0, body: 'not attempted' };
  for (let i = 1; i <= attempts; i++) {
    try { last = await runJob(env, entry); }
    catch (e) { last = { ok: false, status: 0, body: String(e?.message || e) }; }
    if (last.ok) return { ...last, attempts: i };
    if (i < attempts) await new Promise(resolve => setTimeout(resolve, i * 1500));
  }
  return { ...last, attempts };
}

function jobName(entry) {
  return entry.kind === 'github' ? 'nse-snapshot' : (entry.path || '').replace('/api/', '');
}

// Extract a compact, stock-wise outcome from a downstream response for the Tracker.
function summarize(job, res) {
  const out = { httpStatus: res.status, ok: res.ok, attempts: res.attempts || 1 };
  if (job === 'nse-snapshot') { out.dispatched = res.ok; return out; }
  let b = null; try { b = JSON.parse(res.body); } catch (e) {}
  if (!b) { out.raw = (res.body || '').slice(0, 140); return out; }
  out.status = b.status;
  if (job === 'sell-check') {
    out.sold = b.sold;
    out.positions = (b.positions || []).map(p => ({ ticker: p.ticker, result: p.result, price: p.price }));
    if (b.closed && b.closed.length) out.closed = b.closed;
  } else if (job === 'stock-of-the-day') {
    if (b.reason) out.reason = b.reason;
    if (b.pick && b.pick.ticker) out.pick = { ticker: b.pick.ticker, composite: b.pick.composite };
    if (b.entryRejected) out.entryRejected = b.entryRejected;
    if (b.considered) out.considered = b.considered;
  } else if (job === 'refresh-prices') {
    out.updated = b.updated; out.total = b.total; if (b.closed) out.closed = b.closed;
  } else if (job === 'premarket') {
    out.watchlist = b.watchlist; out.overnight = b.verifiedOvernightCatalysts;
  } else if (job === 'open-scan') {
    if (b.pick) out.pick = { ticker: b.pick.ticker, lane: b.lane, entry: b.pick.entryPrice };
    else out.reason = b.status;
  }
  return out;
}

// Append a run to the KV log (newest first, capped). Never throws.
async function logRun(env, entry) {
  if (!env.CRON_LOG) return;
  try {
    const raw = await env.CRON_LOG.get('runs');
    const runs = raw ? JSON.parse(raw) : [];
    runs.unshift(entry);
    await env.CRON_LOG.put('runs', JSON.stringify(runs.slice(0, 150)));
  } catch (e) { /* logging must never break a run */ }
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export default {
  // Fires on the cron schedule in wrangler.toml.
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    // Belt-and-braces weekend guard: the cron expression already says mon-fri, but Cloudflare's
    // day-of-week numbering (1=Sunday) once silently skewed the schedule (Fri 2026-07-10 ran
    // nothing) — so never trust the expression alone. IST == UTC+5:30 and the window is
    // mid-day IST, so UTC day == IST day here.
    const dow = now.getUTCDay(); // 0=Sun .. 6=Sat
    if (dow === 0 || dow === 6) return;
    const key = hhmm(now);
    const entry = SCHEDULE[key];
    if (!entry) return; // a tick with nothing scheduled — do nothing
    const res = await runJobWithRetry(env, entry);
    const job = jobName(entry);
    console.log(`[cron ${key}] ${job} -> ${res.status} ${res.ok ? 'OK' : 'FAIL'} ${res.body}`);
    await logRun(env, { ts: new Date().toISOString(), hhmm: key, job, trigger: 'cron', summary: summarize(job, res) });
  },

  // Manual test endpoint. Prefer an Authorization: Bearer header; query-key compatibility is
  // retained only for existing diagnostics.
  // Valid jobs: nse-snapshot, stock-of-the-day, refresh-prices, sell-check, capture-open
  async fetch(request, env) {
    const url = new URL(request.url);

    // Public run-log for the Tracker tab (CORS-open, read-only).
    if (url.pathname === '/log') {
      const raw = env.CRON_LOG ? await env.CRON_LOG.get('runs') : null;
      return new Response(raw || '[]', { headers: CORS });
    }

    if (url.pathname !== '/run') {
      return new Response('StockAdvisor cron worker. /log shows run history; POST /run?job=<name> with Authorization: Bearer <secret> to test.', { status: 200 });
    }
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if ((bearer || url.searchParams.get('key')) !== env.CRON_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const job = url.searchParams.get('job');
    const MAP = {
      'nse-snapshot': { kind: 'github' },
      'stock-of-the-day': { kind: 'vercel', path: '/api/stock-of-the-day' },
      'refresh-prices': { kind: 'vercel', path: '/api/refresh-prices' },
      'sell-check': { kind: 'vercel', path: '/api/sell-check' },
      'capture-open': { kind: 'vercel', path: '/api/capture-open' },
      'analytics': { kind: 'vercel', path: '/api/analytics' },
      'premarket': { kind: 'vercel', path: '/api/premarket' },
      'open-scan': { kind: 'vercel', path: '/api/open-scan' },
    };
    const entry = MAP[job];
    if (!entry) return new Response(`unknown job "${job}". Valid: ${Object.keys(MAP).join(', ')}`, { status: 400 });
    const res = await runJobWithRetry(env, entry);
    await logRun(env, { ts: new Date().toISOString(), hhmm: hhmm(new Date()), job, trigger: 'manual', summary: summarize(job, res) });
    return new Response(JSON.stringify({ job, ...res }, null, 2), { status: res.ok ? 200 : 502, headers: CORS });
  },
};
