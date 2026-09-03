// Best-effort per-instance protection for public read/analysis endpoints. Vercel may run several
// isolated instances, so this is not a substitute for an account-level firewall rule, but it
// prevents one browser/client from accidentally burning through free API quotas on a warm worker.
const buckets = globalThis.__stockAdvisorRateBuckets || new Map();
globalThis.__stockAdvisorRateBuckets = buckets;

function clientKey(req, scope) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return `${scope}:${ip}`;
}

export function enforceRateLimit(req, res, { scope = 'public', limit = 30, windowMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  const key = clientKey(req, scope);
  let row = buckets.get(key);
  if (!row || now >= row.resetAt) row = { count: 0, resetAt: now + windowMs };
  row.count++;
  buckets.set(key, row);

  // Prevent an indefinitely-growing map on a long-lived instance.
  if (buckets.size > 2000) {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }

  const remaining = Math.max(0, limit - row.count);
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(row.resetAt / 1000)));
  if (row.count <= limit) return true;

  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((row.resetAt - now) / 1000))));
  res.status(429).json({ error: 'Too many requests — please wait a few minutes and try again.' });
  return false;
}

export function setPublicCache(res, seconds, staleSeconds = seconds * 2) {
  res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=${staleSeconds}`);
}
