const APOLLO_KEY = 'Nvr6epqnYBswDYPlNx4CrQ';

const ALLE_TITELS = [
  'CEO', 'Founder', 'Co-Founder', 'Directeur', 'Managing Director',
  'Managing Partner', 'Director', 'Owner', 'Eigenaar', 'DGA',
  'CCO', 'CMO', 'CFO', 'COO', 'CTO', 'President', 'Partner',
  'General Manager', 'Commercial Director', 'Sales Director',
  'VP Sales', 'VP Marketing', 'Head of Sales', 'Head of Business Development',
  'Bestuurder', 'Gedelegeerd Bestuurder', 'Zaakvoerder'
];

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
      const r = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
        body: JSON.stringify({
          person_titles: ALLE_TITELS,
          organization_names: [company],
          contact_email_status: ['verified'],
          per_page: 5
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
    } catch (e) {
      results.push({ company, people: [], error: e.message });
    }
  }

  res.json({ results });
}
