const { createClient } = require('@supabase/supabase-js');

let supabase;

function getClient() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

async function bestaatAl(kvkNummer, website) {
  const db = getClient();

  if (kvkNummer) {
    const { data } = await db
      .from('accounts')
      .select('id')
      .eq('kvk', kvkNummer)
      .maybeSingle();
    if (data) return true;
  }

  if (website) {
    const domein = extractDomein(website);
    if (domein) {
      const { data } = await db
        .from('accounts')
        .select('id')
        .ilike('website', `%${domein}%`)
        .maybeSingle();
      if (data) return true;
    }
  }

  return false;
}

function extractDomein(website) {
  try {
    const url = website.startsWith('http') ? website : 'https://' + website;
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return null;
  }
}

async function voegAccountToe(lead) {
  const db = getClient();

  // Splits contactpersoon naam in voor- en achternaam
  const contactNaam = lead.contactpersoon?.naam || '';
  const naamDelen = contactNaam.trim().split(' ');
  const voornaam = naamDelen[0] || '';
  const achternaam = naamDelen.slice(1).join(' ') || '';

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
    contact_first: voornaam,
    contact_last: achternaam,
    contact_role: lead.contactpersoon?.titel || '',
    contact_phone: lead.contactTelefoon || '',
    contact_email: lead.email || '',
  };

  const { data, error } = await db
    .from('accounts')
    .insert(record)
    .select('id')
    .single();

  if (error) {
    console.error('[Supabase] Fout bij invoegen:', error.message, record.name);
    return null;
  }

  return data.id;
}

async function getStats() {
  const db = getClient();
  const { count } = await db
    .from('accounts')
    .select('*', { count: 'exact', head: true });
  return { totaal_leads: count };
}

module.exports = { bestaatAl, voegAccountToe, getStats };
