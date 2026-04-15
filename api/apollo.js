const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyNames } = req.body;
  if (!companyNames?.length) return res.status(400).json({ error: 'companyNames is verplicht' });

  const results = [];

  for (const company of companyNames) {
    try {
      const body = {
        q_organization_name: company,
        page: 1,
        per_page: 5
      };

      const r = await fetch('https://api.apollo.io/v1/people/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-api-key': APOLLO_KEY
        },
        body: JSON.stringify(body)
      });

      const rawText = await r.text();
      let data;
      try { data = JSON.parse(rawText); } catch(e) { data = { parseError: rawText.slice(0, 200) }; }

      const people = (data.people || []).map(p => ({
        name: [p.first_name, p.last_name].filter(Boolean).join(' '),
        title: p.title || '',
        email: p.email || '',
        phone: p.sanitized_phone || '',
        linkedin: p.linkedin_url || '',
        company: p.organization?.name || company,
        website: p.organization?.website_url || '',
        sector: p.organization?.industry || ''
      }));

      results.push({
        company,
        people,
        _debug: {
          status: r.status,
          total: data.pagination?.total_entries,
          error: data.error,
          message: data.message,
          raw: rawText.slice(0, 300)
        }
      });
    } catch (e) {
      results.push({ company, people: [], _debug: { error: e.message } });
    }
  }

  res.json({ results });
}
