// Lead scraper — Claude + web search als motor
// OpenKVK volledig vervangen, dedup op naam + website + DB
// POST /api/scraper?action=start|results  GET ?action=status

let voegAccountToe, bestaatAl, createClient, Anthropic;
try {
  ({ voegAccountToe, bestaatAl } = require('../../lib/supabase'));
  ({ createClient } = require('@supabase/supabase-js'));
  Anthropic = require('@anthropic-ai/sdk');
  console.log('[Init] Modules geladen');
} catch(e) {
  console.error('[Init] Fout:', e.message);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function getDb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }

function extractDomein(website) {
  try {
    if (!website) return null;
    const url = website.startsWith('http') ? website : 'https://' + website;
    return new URL(url).hostname.replace('www.', '').toLowerCase();
  } catch { return null; }
}

// Haal alle bekende bedrijven op uit CRM + scraper history voor dedup
async function haalBekendeCompanies(db) {
  const [{ data: accounts }, { data: scraper }] = await Promise.all([
    db.from('accounts').select('name, website').limit(5000),
    db.from('scraper_results').select('organisatie, website').limit(5000),
  ]);

  const namen = new Set([
    ...(accounts || []).map(a => a.name?.toLowerCase().trim()).filter(Boolean),
    ...(scraper || []).map(a => a.organisatie?.toLowerCase().trim()).filter(Boolean),
  ]);

  const websites = new Set([
    ...(accounts || []).map(a => extractDomein(a.website)).filter(Boolean),
    ...(scraper || []).map(a => extractDomein(a.website)).filter(Boolean),
  ]);

  return { namen, websites };
}

// Hoofdzoekopdracht — twee stappen: zoek vrijuit, converteer daarna naar JSON
async function zoekBedrijven(opdrachtgever, focusgebied, limit, goedgekeurd, bekendeNamen) {
  const voorbeeldTekst = goedgekeurd?.length
    ? `\nEerder goedgekeurde leads (gebruik als kwaliteitsrichtlijn):\n${goedgekeurd.map(l => `- ${l.organisatie} | ${l.sector || '?'} | ${l.regio || '?'}`).join('\n')}`
    : '';

  const bekendeStr = [...bekendeNamen].slice(0, 40).join(', ');
  const bekendeNamenTekst = bekendeStr
    ? `\nDeze bedrijven zijn al bekend — NIET opnemen: ${bekendeStr}`
    : '';

  // Stap 1: zoek en analyseer vrijuit via web search
  const zoekPrompt = `Je bent een B2B sales researcher voor Intersect.
Zoek via web search naar ${limit} concrete Nederlandse bedrijven voor opdrachtgever "${opdrachtgever}".
Focusgebied: "${focusgebied}"
${voorbeeldTekst}
${bekendeNamenTekst}

Doe meerdere gerichte zoekopdrachten. Varieer: branche + stad, vacatures, groeilijsten, nieuws, LinkedIn, etc.
Beschrijf per bedrijf dat je vindt: naam, website, stad, sector, geschat aantal medewerkers, waarom het past, en een specifieke gespreksopener.
Wees streng: alleen bedrijven die echt passen op sector, grootte én locatie.`;

  const zoekResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: zoekPrompt }],
  });

  const zoekTekst = (zoekResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  if (!zoekTekst.trim()) throw new Error('Geen output van zoekstap');
  console.log(`[Search] Zoekstap klaar, ${zoekTekst.length} tekens`);

  // Stap 2: converteer naar JSON (geen tools, puur formattering)
  const jsonResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system: 'Je converteert bedrijfsinformatie naar een JSON array. Geef ALLEEN de JSON array terug. Begin met [ en eindig met ]. Geen tekst eromheen.',
    messages: [{
      role: 'user',
      content: `Converteer de onderstaande bedrijfsinformatie naar een JSON array.
Score 1-10 (7+ = goed genoeg, streng zijn).
Haakje = specifieke gespreksopener gebaseerd op de gevonden info (null als score < 7).

Structuur per bedrijf:
{"naam":"...","website":"...","stad":"...","sector":"...","score":8,"reden":"max 10 woorden","haakje":"opener of null"}

Bedrijfsinformatie:
${zoekTekst}

Geef ALLEEN de JSON array:`
    }],
  });

  const jsonTekst = (jsonResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const start = jsonTekst.indexOf('[');
  const eind = jsonTekst.lastIndexOf(']');
  if (start === -1 || eind === -1) {
    throw new Error('Geen JSON in conversiestap: ' + jsonTekst.substring(0, 300));
  }

  const jsonStr = jsonTekst.substring(start, eind + 1);
  try {
    return JSON.parse(jsonStr);
  } catch(e) {
    const schoon = jsonStr.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '');
    return JSON.parse(schoon);
  }
}

async function handleStart(req, res) {
  const { opdrachtgever, focusgebied, limit = 20 } = req.body || {};
  if (!opdrachtgever || !focusgebied) {
    return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });
  }

  const DOEL = Math.min(parseInt(limit) || 20, 50);
  const db = getDb();
  const start = Date.now();

  console.log(`[Start] ${opdrachtgever} | ${focusgebied} | doel:${DOEL}`);

  // Eerder goedgekeurde leads als kwaliteitsvoorbeeld
  const { data: goedgekeurd } = await db.from('scraper_results')
    .select('organisatie, sector, regio')
    .eq('opdrachtgever', opdrachtgever)
    .eq('status', 'doorgestuurd')
    .order('created_at', { ascending: false })
    .limit(8);

  // Bekende bedrijven ophalen voor dedup
  const { namen: bekendeNamen, websites: bekendeWebsites } = await haalBekendeCompanies(db);
  console.log(`[Dedup] ${bekendeNamen.size} bekende namen`);

  // Claude zoekt
  let gevonden;
  try {
    gevonden = await zoekBedrijven(opdrachtgever, focusgebied, DOEL, goedgekeurd, bekendeNamen);
    console.log(`[Search] ${gevonden.length} kandidaten ontvangen`);
  } catch(e) {
    console.error('[Search] Fout:', e.message);
    return res.status(500).json({ error: 'Zoekfout: ' + e.message });
  }

  let opgeslagen = 0;

  for (const bedrijf of gevonden) {
    if (!bedrijf.naam || bedrijf.score < 7) continue;

    const naam = bedrijf.naam.toLowerCase().trim();
    const domein = extractDomein(bedrijf.website);

    // Dedup: naam
    if (bekendeNamen.has(naam)) {
      console.log(`[skip-naam] ${bedrijf.naam}`);
      continue;
    }

    // Dedup: website
    if (domein && bekendeWebsites.has(domein)) {
      console.log(`[skip-web] ${bedrijf.naam}`);
      continue;
    }

    // Dedup: extra DB-check via bestaatAl
    if (await bestaatAl(null, bedrijf.website)) {
      console.log(`[skip-db] ${bedrijf.naam}`);
      continue;
    }

    const { error } = await db.from('scraper_results').insert({
      opdrachtgever,
      focusgebied,
      status:      'ter_beoordeling',
      organisatie: bedrijf.naam,
      sector:      bedrijf.sector   || '',
      segment:     '',
      website:     bedrijf.website  || '',
      adres:       '',
      regio:       bedrijf.stad     || '',
      medewerkers: '',
      kvk_nummer:  null,
      telefoon:    '',
      score:       bedrijf.score,
      reden:       bedrijf.reden    || '',
      haakje:      bedrijf.haakje   || '',
      notitie:     `[${opdrachtgever}] ${bedrijf.haakje || bedrijf.reden || ''}`,
    });

    if (!error) {
      opgeslagen++;
      bekendeNamen.add(naam);
      if (domein) bekendeWebsites.add(domein);
      console.log(`[+] ${bedrijf.naam} | score:${bedrijf.score} | ${bedrijf.sector || '?'}`);
    }
  }

  const duur = Math.round((Date.now() - start) / 1000);
  console.log(`[Klaar] ${opgeslagen} leads in ${duur}s`);
  return res.status(200).json({ success: true, opgeslagen, duur_seconden: duur });
}

async function handleStatus(req, res) {
  const db = getDb();
  const { count } = await db.from('scraper_results')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'ter_beoordeling');
  return res.status(200).json({ wachtend: count || 0 });
}

async function handleResults(req, res) {
  const db = getDb();

  if (req.method === 'GET') {
    const { data, error } = await db.from('scraper_results')
      .select('*')
      .eq('status', 'ter_beoordeling')
      .order('score', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, leads: data || [] });
  }

  // POST: doorsturen naar CRM of afwijzen
  const { doorsturen, afwijzen } = req.body || {};
  let opgeslagen = 0;
  const fouten = [];

  for (const lead of (doorsturen || [])) {
    const id = await voegAccountToe({
      ...lead,
      contactpersoon: {
        naam:  lead.contact_naam  || '',
        titel: lead.contact_rol   || '',
      },
      contactTelefoon: lead.contact_telefoon || '',
      email:           lead.contact_email    || '',
    });

    if (id) {
      opgeslagen++;
      await db.from('scraper_results').update({ status: 'doorgestuurd' }).eq('id', lead.id);
    } else {
      fouten.push(lead.organisatie);
    }
  }

  for (const id of (afwijzen || [])) {
    await db.from('scraper_results').update({ status: 'afgewezen' }).eq('id', id);
  }

  return res.status(200).json({ success: true, opgeslagen, fouten: fouten.length });
}

module.exports = async function handler(req, res) {
  console.log('[Handler]', req.method, req.url);
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}`
    || req.body?.secret === secret
    || req.query?.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });

  const action = req.query.action || req.body?.action;
  if (action === 'start')   return handleStart(req, res);
  if (action === 'status')  return handleStatus(req, res);
  if (action === 'results') return handleResults(req, res);
  return res.status(400).json({ error: 'Geef action mee: start|status|results' });
};
