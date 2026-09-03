import { enforceRateLimit, setPublicCache } from './_public-api.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!enforceRateLimit(req, res, { scope: 'news', limit: 60, windowMs: 10 * 60 * 1000 })) return;
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: 'query required' });
  setPublicCache(res, 300, 900);

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' stock')}&hl=en-IN&gl=IN&ceid=IN:en`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let response;
    try {
      response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    // Parse RSS XML
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 8) {
      const itemXml = match[1];
      const title = (itemXml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (itemXml.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const source = (itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';

      if (title) {
        items.push({
          title: title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
          link: link.replace(/<!\[CDATA\[|\]\]>/g, ''),
          pubDate,
          source: source.replace(/<!\[CDATA\[|\]\]>/g, '')
        });
      }
    }

    return res.status(200).json({ articles: items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
