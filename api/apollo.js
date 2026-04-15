const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekPerTitel(company, title) {
  const r = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({
      organization_names: [company],
      person_titles: [title],
      person_locations: ['Netherlands', 'Belgium'],
      per_page: 1,
      page: 1
    })
  });
  const data = await r.json().catch(() => ({}));
  return data.people?.[0] || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyNames, titles } = req.body;
  if (!companyNames?.length) return res.status(400).json({ error: 'companyNames is verplicht' });

  const titelsInVolgorde = titles?.length ? titles : ['CEO', 'Founder', 'Directeur', 'Managing Director'];
  const results = [];

  for (const company of companyNames) {
    let gevonden = null;

    // Zoek in volgorde van prioriteit — stop bij eerste match
    for (const title of titelsInVolgorde) {
      try {
        const persoon = await zoekPerTitel(company, title);
        if (persoon) {
          gevonden = persoon;
          break;
        }
      } catch(e) {
        continue;
      }
    }

    if (gevonden) {
      results.push({
        company,
        people: [{
          name: [gevonden.first_name, gevonden.last_name].filter(Boolean).join(' '),
          title: gevonden.title || '',
          email: gevonden.email || '',
          phone: gevonden.sanitized_phone || '',
          linkedin: gevonden.linkedin_url || '',
          company: gevonden.organization?.name || company,
          website: gevonden.organization?.website_url || '',
          sector: gevonden.organization?.industry || ''
        }]
      });
    } else {
      results.push({ company, people: [], geenMatch: true });
    }
  }

  res.json({ results });
}
