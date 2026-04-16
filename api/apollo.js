const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekBedrijfId(company) {
  const r = await fetch('https://api.apollo.io/api/v1/accounts/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({ q_organization_name: company, per_page: 1, page: 1 })
  });
  const data = await r.json().catch(() => ({}));
  return data.accounts?.[0]?.id || null;
}

async function zoekPersoonInBedrijf(organizationId, title) {
  const body = { organization_ids: [organizationId], per_page: 1, page: 1 };
  if (title) body.person_titles = [title];
  const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return data.people || [];
}

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
      const orgId = await zoekBedrijfId(company);
      if (!orgId) { results.push({ company, people: [], geenMatch: true }); continue; }

      let gevonden = null;

      if (titles?.length) {
        // Zoek per titel in prioriteitsvolgorde
        for (const title of titles) {
          const people = await zoekPersoonInBedrijf(orgId, title);
          if (people.length) { gevonden = people[0]; break; }
        }
      }
      // Geen match op titel — pak de eerste persoon sowieso
      if (!gevonden) {
        const people = await zoekPersoonInBedrijf(orgId, null);
        if (people.length) gevonden = people[0];
      }

      if (gevonden) {
        const p = gevonden;
        results.push({
          company,
          people: [{
            name: [p.first_name, p.last_name].filter(Boolean).join(' '),
            title: p.title || '',
            email: p.email || '',
            phone: p.sanitized_phone || '',
            linkedin: p.linkedin_url || '',
            company: p.organization?.name || company,
            website: p.organization?.website_url || '',
            sector: p.organization?.industry || ''
          }]
        });
      } else {
        results.push({ company, people: [], geenMatch: true });
      }
    } catch (e) {
      results.push({ company, people: [], error: e.message });
    }
  }

  res.json({ results });
}
