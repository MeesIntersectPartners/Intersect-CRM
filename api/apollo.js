const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekPersoon(company, titles) {
  const body = {
    q_organization_name: company,
    person_locations: ['Netherlands', 'Belgium'],
    per_page: 5,
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

function scorePersonForPriority(person, prioriteit) {
  const title = (person.title || '').toLowerCase();
  for (let i = 0; i < prioriteit.length; i++) {
    if (title.includes(prioriteit[i].toLowerCase())) {
      return prioriteit.length - i;
    }
  }
  return -1; // Geen match op prioriteitslijst
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
      // Zoek alleen op de aangevinkte titels — geen fallback
      const people = titles?.length
        ? await zoekPersoon(company, titles)
        : await zoekPersoon(company, null);

      // Filter alleen mensen waarvan de titel echt matcht met een aangevinkte titel
      const matches = titles?.length
        ? people.filter(p => scorePersonForPriority(p, titles) >= 0)
        : people;

      if (matches.length) {
        // Sorteer op prioriteit en pak de beste
        matches.sort((a, b) => scorePersonForPriority(b, titles || []) - scorePersonForPriority(a, titles || []));
        const p = matches[0];
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
