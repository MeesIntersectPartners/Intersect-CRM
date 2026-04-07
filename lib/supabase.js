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

// Controleer of een bedrijf al in het CRM staat (op KvK-nummer of website)
async function bestaatAl(kvkNummer, website) {
  const db = getClient();

  // Check op KvK-nummer
  if (kvkNummer) {
    const { data } = await db
      .from('accounts')
      .select('id')
      .eq('kvk_nummer', kvkNummer)
      .maybeSingle();
    if (data) return true;
  }

  // Check op website als fallback
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

// Voeg een nieuw account toe aan Supabase
async function voegAccountToe(lead) {
  const db = getClient();

  const record = {
    // Bedrijfsinfo
    organisatie: lead.organisatie,
    sector: lead.sector,
    website: lead.website,
    regio: lead.regio,
    medewerkers: lead.medewerkers_raw,
    opgericht: lead.opgericht,
    kvk_nummer: lead.kvk_nummer,
    rechtsvorm: lead.rechtsvorm,

    // Contactpersoon
    contactpersoon: lead.contactpersoon?.naam || null,
    functietitel: lead.contactpersoon?.titel || null,
    contact_prioriteit: lead.contactpersoon?.prioriteit || null,
    email: lead.email || null,
    telefoon: lead.telefoon || null,

    // Scraper metadata
    notitie: lead.notitie || null,
    bron: 'scraper',
    status: 'nieuw',
    partner: process.env.PARTNER_NAAM || 'Audio Obscura',

    // Tijdstempel
    scraper_datum: new Date().toISOString(),
  };

  const { data, error } = await db
    .from('accounts')
    .insert(record)
    .select('id')
    .single();

  if (error) {
    console.error('[Supabase] Fout bij invoegen:', error.message, record.organisatie);
    return null;
  }

  return data.id;
}

// Haal statistieken op voor logging
async function getStats() {
  const db = getClient();
  const { count } = await db
    .from('accounts')
    .select('*', { count: 'exact', head: true })
    .eq('bron', 'scraper');
  return { totaal_scraper_leads: count };
}

module.exports = { bestaatAl, voegAccountToe, getStats };
