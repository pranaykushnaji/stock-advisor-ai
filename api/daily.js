import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const type = req.query.type || 'latest';

    if (type === 'bouquet') {
      const bouquet = (await kv.get('project_bouquet')) || [];
      return res.status(200).json({ bouquet });
    }

    // Default: latest pick
    const latest = await kv.get('sotd:latest');
    return res.status(200).json({ pick: latest || null });
  } catch (e) {
    // KV not configured yet — return empty gracefully
    return res.status(200).json({ pick: null, bouquet: [], note: 'storage_unavailable' });
  }
}
