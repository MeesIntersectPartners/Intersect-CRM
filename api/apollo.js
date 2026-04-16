const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekMetTitel(company, title) {
  const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({
      q_organization_name: company,
      person_titles: [title],
      per_page: 1,
      page: 1
    })
  });
  const data = await r.json().catch(() => ({}));
  return data.people?.[0] || null;
}

async function enrichPersoon(personId) {
  const r = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({
      id: personId,
      reveal_personal_emails: false,
      reveal_phone_number: false
    })
  });
  const data = await r.json().catch(() => ({}));
  return data.person || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyNames, titles } = req.body;
  if (!companyNames?.length) return res.status(400).json({ error: 'companyNames is verplicht' });
  if (!titles?.length) return res.status(400).json({ error: 'Selecteer minimaal één functietitel' });

  const results = [];

  for (const company of companyNames) {
    let gevonden = null;

    // Stap 1: zoek persoon per titel in prioriteitsvolgorde
    for (const title of titles) {
      try {
        const persoon = await zoekMetTitel(company, title);
        if (persoon) { gevonden = persoon; break; }
      } catch(e) { continue; }
    }

    if (!gevonden) {
      results.push({ company, people: [], geenMatch: true });
      continue;
    }

    // Stap 2: enrich om volledige naam + e-mail te krijgen (kost 1 credit)
    let volledig = null;
    if (gevonden.id) {
      try {
        volledig = await enrichPersoon(gevonden.id);
      } catch(e) {}
    }

    const p = volledig || gevonden;
    results.push({
      company,
      people: [{
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.first_name || '—',
        title: p.title || gevonden.title || '',
        email: p.email || '',
        phone: p.sanitized_phone || '',
        linkedin: p.linkedin_url || '',
        company: p.organization?.name || company,
        website: p.organization?.website_url || '',
        sector: p.organization?.industry || ''
      }]
    });
  }

  res.json({ results });
}
