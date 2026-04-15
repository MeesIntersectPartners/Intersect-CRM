const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyNames, titles } = req.body;
  if (!companyNames?.length) return res.status(400).json({ error: 'companyNames is verplicht' });

  const results = [];

  for (const company of companyNames) {
    try {
      const body = {
        organization_names: [company],
        person_locations: ['Netherlands', 'Belgium'],
        per_page: 3,
        page: 1
      };

      // Voeg titels toe als ze meegegeven zijn
      if (titles?.length) {
        body.person_titles = titles;
      }

      const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
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
      try { data = JSON.parse(rawText); } catch(e) { data = {}; }

      // Als geen resultaat met company filter, probeer zonder maar wel met locatie+titel
      let people = data.people || [];
      if (!people.length && titles?.length) {
        const r2 = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'x-api-key': APOLLO_KEY
          },
          body: JSON.stringify({
            q_organization_name: company,
            person_titles: titles,
            person_locations: ['Netherlands', 'Belgium'],
            per_page: 3,
            page: 1
          })
        });
        const data2 = await r2.json().catch(() => ({}));
        people = data2.people || [];
      }

      const mapped = people.map(p => ({
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
        people: mapped,
        _debug: { status: r.status, total: data.pagination?.total_entries, error: data.error }
      });

    } catch (e) {
      results.push({ company, people: [], _debug: { error: e.message } });
    }
  }

  res.json({ results });
}
