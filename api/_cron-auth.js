// Shared fail-closed authentication for every endpoint that can mutate project data.
// A missing CRON_SECRET is a server configuration error, never permission to run publicly.
export function requireCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'CRON_SECRET not configured' });
    return false;
  }

  const auth = req.headers.authorization || '';
  const bearer = auth.replace(/^Bearer\s+/i, '');
  // Query-key support is retained for the existing manual diagnostic links. Scheduled callers
  // use Authorization headers so the secret does not appear in normal request URLs.
  const provided = bearer || req.query?.key || '';
  if (provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
