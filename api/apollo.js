const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekPersonen(company, titles) {
  const body = {
    q_organization_name: company,
    organization_locations: ['Netherlands', 'Belgium'],
    per_page: 10,
    page: 1
  };
  if (titles?.length) body.person_titles = titles;

  const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return data.people || [];
}

function priorityScore(person, titles) {
  if (!titles?.length) return 0;
  const t = (person.title || '').toLowerCase();
  for (let i = 0; i < titles.length; i++) {
    if (t.includes(titles[i].toLowerCase())) return titles.length - i;
  }
  return 0;
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
      const people = await zoekPersonen(company, titles);

      if (!people.length) {
        results.push({ company, people: [], geenMatch: true });
        continue;
      }

      people.sort((a, b) => priorityScore(b, titles) - priorityScore(a, titles));
      const p = people[0];

      results.push({
        company,
        people: [{
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.first_name || '—',
          title: p.title || '',
          email: p.email || '',
          phone: p.sanitized_phone || '',
          linkedin: p.linkedin_url || '',
          company: p.organization?.name || company,
          website: p.organization?.website_url || '',
          sector: p.organization?.industry || ''
        }]
      });
    } catch (e) {
      results.push({ company, people: [], error: e.message });
    }
  }

  res.json({ results });
}
