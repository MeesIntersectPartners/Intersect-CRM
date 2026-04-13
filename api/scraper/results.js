const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}` || req.body?.secret === secret || req.query.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (req.method === 'GET') {
    // Haal leads op die wachten op beoordeling
    const { data, error } = await db.from('scraper_results')
      .select('*')
      .eq('status', 'ter_beoordeling')
      .order('score', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, leads: data || [] });
  }

  if (req.method === 'POST') {
    // Sla geselecteerde leads op als account in CRM, rest afwijzen
    const { doorsturen, afwijzen } = req.body || {};

    const { createClient: sbCreate } = require('@supabase/supabase-js');
    const dbAccounts = sbCreate(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    let opgeslagen = 0;
    const fouten = [];

    // Doorsturen naar accounts
    for (const lead of (doorsturen || [])) {
      const naamDelen = (lead.contact_naam || '').trim().split(' ');
      const record = {
        name: lead.organisatie, status: 'lead',
        sector: lead.sector || '', segment: lead.segment || '',
        website: lead.website || '', linkedin: lead.linkedin || '',
        phone: lead.telefoon || '', kvk: lead.kvk_nummer || '',
        address: lead.adres || '',
        address_url: lead.adres ? `https://www.google.com/maps/search/?q=${encodeURIComponent(lead.adres)}` : '',
        pipeline_stage: 'Nieuw', value: null, owner: 'MA',
        note: lead.notitie || '', color_index: 0,
        added_date: new Date().toISOString().split('T')[0],
        contact_first: naamDelen[0] || '', contact_last: naamDelen.slice(1).join(' ') || '',
        contact_role: lead.contact_titel || '', contact_phone: lead.contact_telefoon || '',
        contact_email: lead.email || '',
      };
      const { error } = await dbAccounts.from('accounts').insert(record);
      if (error) fouten.push(lead.organisatie);
      else opgeslagen++;

      // Update status
      await db.from('scraper_results').update({ status: 'doorgestuurd' }).eq('id', lead.id);
    }

    // Afwijzen
    for (const id of (afwijzen || [])) {
      await db.from('scraper_results').update({ status: 'afgewezen' }).eq('id', id);
    }

    return res.status(200).json({ success: true, opgeslagen, fouten: fouten.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
