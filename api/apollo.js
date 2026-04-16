const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

async function zoekBedrijfId(company) {
  // Probeer accounts/search endpoint
  const r = await fetch('https://api.apollo.io/api/v1/accounts/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
    body: JSON.stringify({ q_organization_name: company, per_page: 1, page: 1 })
  });
  const data = await r.json().catch(() => ({}));
  console.log(`Bedrijf lookup [${company}]: status=${r.status} accounts=${data.accounts?.length} error=${data.error}`);
  return { id: data.accounts?.[0]?.id || null, status: r.status, error: data.error, raw: JSON.stringify(data).slice(0, 200) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyNames, titles } = req.body;
  if (!companyNames?.length) return res.status(400).json({ error: 'companyNames is verplicht' });

  // Test met eerste bedrijf om te zien wat Apollo teruggeeft
  const testBedrijf = companyNames[0];
  const debug = await zoekBedrijfId(testBedrijf);

  res.json({ 
    debug,
    testBedrijf,
    results: companyNames.map(c => ({ company: c, people: [], geenMatch: true }))
  });
}
