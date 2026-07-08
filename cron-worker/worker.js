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

// Exact firing table, keyed by "HH:MM" in UTC (IST = UTC + 5:30).
// The cron trigger ticks every 5 minutes across the market window; the handler acts only
// when the current HH:MM matches a row here, so timing is precise to the tick.
const SCHEDULE = {
  '03:15': { kind: 'github' },                                // 08:45 IST — NSE snapshot (pre-open)
  '06:30': { kind: 'github' },                                // 12:00 IST — NSE snapshot (midday)
  '08:45': { kind: 'github' },                                // 14:15 IST — NSE snapshot (pre-pick: ~85% of the day's volume in)
  '09:00': { kind: 'vercel', path: '/api/stock-of-the-day' }, // 14:30 IST — pick, on near-full-day volume so the 1.8x filter is valid
  '04:40': SELL,                                              // 10:10 IST — hourly sell-check
  '05:40': SELL,                                              // 11:10 IST
  '06:40': SELL,                                              // 12:10 IST
  '07:40': SELL,                                              // 13:10 IST
  '08:40': SELL,                                              // 14:10 IST
  '09:40': SELL,                                              // 15:10 IST
  '10:10': { kind: 'vercel', path: '/api/refresh-prices' },    // 15:40 IST — refresh + book exits
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

export default {
  // Fires on the cron schedule in wrangler.toml.
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    const key = hhmm(now);
    const entry = SCHEDULE[key];
    if (!entry) return; // a tick with nothing scheduled — do nothing
    const res = await runJob(env, entry);
    console.log(`[cron ${key}] ${entry.kind}${entry.path || ''} -> ${res.status} ${res.ok ? 'OK' : 'FAIL'} ${res.body}`);
  },

  // Manual test endpoint (for the "verify before switching off GitHub" step):
  //   https://<worker-url>/run?job=sell-check&key=<CRON_SECRET>
  // Valid jobs: nse-snapshot, stock-of-the-day, refresh-prices, sell-check, capture-open
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('StockAdvisor cron worker. Use /run?job=<name>&key=<CRON_SECRET> to test.', { status: 200 });
    }
    if (url.searchParams.get('key') !== env.CRON_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const job = url.searchParams.get('job');
    const MAP = {
      'nse-snapshot': { kind: 'github' },
      'stock-of-the-day': { kind: 'vercel', path: '/api/stock-of-the-day' },
      'refresh-prices': { kind: 'vercel', path: '/api/refresh-prices' },
      'sell-check': { kind: 'vercel', path: '/api/sell-check' },
      'capture-open': { kind: 'vercel', path: '/api/capture-open' },
    };
    const entry = MAP[job];
    if (!entry) return new Response(`unknown job "${job}". Valid: ${Object.keys(MAP).join(', ')}`, { status: 400 });
    const res = await runJob(env, entry);
    return new Response(JSON.stringify({ job, ...res }, null, 2), {
      status: res.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
