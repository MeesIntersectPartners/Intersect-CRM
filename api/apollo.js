export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { apiKey, companyNames, titles } = req.body;
  if (!apiKey || !companyNames?.length) return res.status(400).json({ error: 'apiKey en companyNames zijn verplicht' });

  const results = [];
  for (const company of companyNames) {
    try {
      const r = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          person_titles: titles?.length ? titles : ['CEO', 'Founder', 'Directeur', 'Managing Director', 'Co-Founder', 'Managing Partner'],
          organization_names: [company],
          contact_email_status: ['verified'],
          per_page: 3
        })
      });
      const data = await r.json();
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
      results.push({ company, people });
    } catch(e) {
      results.push({ company, people: [], error: e.message });
    }
  }
  res.json({ results });
}
