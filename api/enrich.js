// Vercel Serverless Function — hides SEARCHAPI_API_KEY from the client.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { name, location, extra = {} } = body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });

  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ results: [], note: 'SEARCHAPI_API_KEY not set — skipping research.' });
  }

  const queries = buildQueries(name, location, extra);
  const results = [];

  await Promise.all(queries.map(async (q) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const url = `https://www.searchapi.io/api/v1/search?engine=google&num=6&q=${encodeURIComponent(q)}&api_key=${apiKey}`;
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const data = await r.json();
      (data.organic_results || []).forEach((item) => {
        if (item?.title && item?.link) {
          results.push({ title: item.title, snippet: item.snippet || '', link: item.link });
        }
      });
    } catch (e) {
      console.error('SearchAPI query failed:', q, e.message);
    }
  }));

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    if (!seen.has(r.link)) { seen.add(r.link); deduped.push(r); }
    if (deduped.length >= 12) break;
  }

  return res.status(200).json({ results: deduped });
}

function buildQueries(name, location, extra) {
  const base = location ? `"${name}" ${location}` : `"${name}"`;
  const qs = [base, `"${name}" linkedin OR github OR portfolio`];
  if (extra.school) qs.push(`"${name}" ${extra.school}`);
  if (extra.skills) qs.push(`"${name}" ${String(extra.skills).split(',')[0]}`);
  return qs.slice(0, 4);
}
