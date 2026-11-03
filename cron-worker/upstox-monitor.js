// Separate, opt-in shadow scheduler. Durable Object serializes requests across isolates;
// KV is deliberately not used as a lock because KV is eventually consistent.
export function isMonitorMinute(date) {
  const day = date.getUTCDay(), min = date.getUTCHours() * 60 + date.getUTCMinutes();
  return day >= 1 && day <= 5 && min >= 225 && min < 600; // 09:15 <= IST < 15:30
}

function targetBase(env) {
  let url;
  try { url = new URL(env.UPSTOX_MONITOR_BASE); } catch { throw new Error('monitor preview URL missing'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || url.origin === 'https://stock-advisor-ai-omega.vercel.app'
    || url.origin === env.VERCEL_BASE) throw new Error('monitor requires a separate HTTPS preview origin');
  return url.origin;
}

export async function dispatchMonitor(env, scheduledTime, channel = 'positions') {
  if (!['positions', 'entries'].includes(channel)) throw new Error('invalid monitor channel');
  if (env[channel === 'entries' ? 'ENTRY_SETUP_RESEARCH_ENABLED' : 'UPSTOX_MONITOR_ENABLED'] !== 'true') return { status: 'disabled' };
  if (!env.UPSTOX_MONITOR || !env.CRON_SECRET) throw new Error('monitor durable object or secret missing');
  targetBase(env); // validate before any network activity
  const stub = env.UPSTOX_MONITOR.get(env.UPSTOX_MONITOR.idFromName(`${channel}-shadow-v1`));
  const response = await stub.fetch('https://monitor.internal/tick', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduledTime, channel }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`shadow monitor HTTP ${response.status}`);
  return result;
}

export async function monitorHistory(env, channel = 'positions') {
  if (!env.UPSTOX_MONITOR) return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  return env.UPSTOX_MONITOR.get(env.UPSTOX_MONITOR.idFromName(`${channel}-shadow-v1`)).fetch('https://monitor.internal/history');
}

export class UpstoxMonitor {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    // Serialize the whole read -> remote evaluation -> commit, including awaits. A transaction
    // alone cannot safely include remote HTTP. Re-evaluation after a crash has no trade effect.
    const next = this.queue.then(() => this.handle(request));
    this.queue = next.catch(() => {});
    return next;
  }

  async handle(request) {
    const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    const url = new URL(request.url);
    if (url.pathname === '/history' && request.method === 'GET') {
      const keys = await this.storage.get('historyKeys') || [];
      const rows = await this.storage.get(keys.slice(-30));
      return json([...rows.values()].reverse());
    }
    if (url.pathname !== '/tick' || request.method !== 'POST') return json({ error: 'unknown route' }, 404);
    let input;
    try { input = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
    const channel = input.channel || 'positions';
    if (!['positions', 'entries'].includes(channel)) return json({ error: 'invalid channel' }, 400);
    if (this.env[channel === 'entries' ? 'ENTRY_SETUP_RESEARCH_ENABLED' : 'UPSTOX_MONITOR_ENABLED'] !== 'true') return json({ status: 'disabled' });
    const ms = input.scheduledTime;
    if (!Number.isFinite(ms)) return json({ error: 'invalid scheduled time' }, 400);
    const slotMs = Math.floor(ms / 60000) * 60000;
    if (Math.abs(Date.now() - slotMs) > 90000) return json({ status: 'expired_slot' }, 409);
    if (!isMonitorMinute(new Date(slotMs))) return json({ status: 'skipped', reason: 'outside-regular-session' });
    const lastSlot = await this.storage.get('lastSlot');
    if (lastSlot != null && slotMs <= lastSlot) return json({ status: 'duplicate_or_old_slot', slot: new Date(slotMs).toISOString() });
    const base = targetBase(this.env);
    const previousState = await this.storage.get('shadowState') || {};
    const headers = { Authorization: `Bearer ${this.env.CRON_SECRET}`, 'Content-Type': 'application/json' };
    if (this.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = this.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    let response, report;
    try {
      response = await fetch(`${base}/api/${channel === 'entries' ? 'entry-research' : 'minute-monitor'}`, { method: 'POST', headers,
        body: JSON.stringify({ slot: new Date(slotMs).toISOString(), previousState }),
        signal: AbortSignal.timeout(45000) });
      report = await response.json();
    } catch { return json({ status: 'monitor_unavailable' }, 502); }
    const accepted = ['monitored', 'monitor_incomplete', 'no_open_positions', 'researched', 'research_incomplete'].includes(report.status)
      && report.mode === 'read-only-shadow' && report.nextState?.version === 1;
    // Partial fresh observations are useful even if another position is stale. Keep them once
    // per minute; errors with no trustworthy transition leave the slot retryable.
    if (!accepted) return json({ status: 'monitor_failed', downstreamStatus: response.status }, 502);
    const sampleKey = `sample:${new Date(slotMs).toISOString()}`;
    const record = { slot: new Date(slotMs).toISOString(), status: report.status, httpStatus: response.status,
      positions: report.positions || [], signals: report.signals || [], recordedAt: new Date().toISOString() };
    await this.storage.transaction(async txn => {
      const keys = await txn.get('historyKeys') || [];
      keys.push(sampleKey);
      const expired = keys.splice(0, Math.max(0, keys.length - 400));
      await txn.put({ shadowState: report.nextState, lastSlot: slotMs, historyKeys: keys, [sampleKey]: record });
      if (expired.length) await txn.delete(expired);
    });
    return json({ status: report.status, slot: record.slot, signals: record.signals.length,
      incomplete: ['monitor_incomplete', 'research_incomplete'].includes(report.status) });
  }
}
