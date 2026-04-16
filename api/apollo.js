const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekPersonen(company) {
  const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({
      q_organization_name: company,
      person_locations: ['Netherlands', 'Belgium'],
      person_seniorities: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'director', 'manager'],
      per_page: 10,
      page: 1
    })
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
  return -1; // Geen match
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
      // Haal mensen op zonder titelfilter — Apollo filtert op seniority en locatie
      const people = await zoekPersonen(company);

      if (people.length) {
        // Sorteer: eerst mensen die matchen met jouw titels in volgorde van prioriteit
        // Dan de rest op seniority
        const metPrio = people.filter(p => priorityScore(p, titles) >= 0);
        const zonderPrio = people.filter(p => priorityScore(p, titles) < 0);

        metPrio.sort((a, b) => priorityScore(b, titles) - priorityScore(a, titles));

        // Als iemand matcht op prioriteit → pak die. Anders geen resultaat.
        const kandidaten = titles?.length ? metPrio : people;

        if (!kandidaten.length) {
          results.push({ company, people: [], geenMatch: true });
          continue;
        }

        const p = kandidaten[0];
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
