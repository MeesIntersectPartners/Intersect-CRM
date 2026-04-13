const { createClient } = require('@supabase/supabase-js');

function getClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}` || req.body?.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });

  const { leads } = req.body || {};
  if (!leads?.length) return res.status(400).json({ error: 'Geen leads meegegeven' });

  const db = getClient();
  const opgeslagen = [];
  const fouten = [];

  for (const lead of leads) {
    const naamDelen = (lead.contactpersoon?.naam || '').trim().split(' ');
    const record = {
      name: lead.organisatie,
      status: 'lead',
      sector: lead.sector || '',
      segment: lead.segment || '',
      website: lead.website || '',
      linkedin: lead.linkedin || '',
      phone: lead.telefoon || '',
      kvk: lead.kvk_nummer || '',
      address: lead.adres || '',
      address_url: lead.adres ? `https://www.google.com/maps/search/?q=${encodeURIComponent(lead.adres)}` : '',
      pipeline_stage: 'Nieuw',
      value: null,
      owner: 'MA',
      note: lead.notitie || '',
      color_index: 0,
      added_date: new Date().toISOString().split('T')[0],
      contact_first: naamDelen[0] || '',
      contact_last: naamDelen.slice(1).join(' ') || '',
      contact_role: lead.contactpersoon?.titel || '',
      contact_phone: lead.contactpersoon?.telefoon || '',
      contact_email: lead.email || '',
    };

    const { data, error } = await db.from('accounts').insert(record).select('id').single();
    if (error) {
      console.error('[save] fout:', error.message, lead.organisatie);
      fouten.push({ naam: lead.organisatie, fout: error.message });
    } else {
      opgeslagen.push({ id: data.id, naam: lead.organisatie });
    }
  }

  return res.status(200).json({ success: true, opgeslagen: opgeslagen.length, fouten: fouten.length, leads: opgeslagen });
};
