// POST /api/scraper?action=start|save|results
// GET  /api/scraper?action=status

let zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven, bestaatAl, createClient, Anthropic;
try {
  ({ zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven } = require('../../lib/openkvk'));
  ({ bestaatAl } = require('../../lib/supabase'));
  ({ createClient } = require('@supabase/supabase-js'));
  Anthropic = require('@anthropic-ai/sdk');
  console.log('[Init] Alle modules geladen');
} catch(e) {
  console.error('[Init] Module laad fout:', e.message);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }
function getDb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel',
  'vereniging van eigen','v.v.e.','vve ','stichting','buurtvereniging'];

async function bepaalStrategie(opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 600,
      messages: [{ role: 'user', content: `Nederlandse KvK/B2B sales expert.
Intersect verkoopt voor "${opdrachtgever}" en zoekt: "${focusgebied}"
JSON only (geen uitleg erbuiten):
{
  "zoekwoorden": ["<2-4 Nederlandse zoektermen voor OpenKVK, bijv. 'software','IT advies','automatisering'>"],
  "gemeenten": ["<max 6 gemeenten in het doelgebied>"],
  "uitleg": "<één zin>"
}
Zoekwoorden moeten aansluiten bij de bedrijfsnamen die je zoekt. Kies specifieke branchetermen.` }]
    });
    const parsed = JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
    // Zorg voor fallbacks
    if (!parsed.zoekwoorden?.length) parsed.zoekwoorden = ['software', 'IT'];
    if (!parsed.gemeenten?.length) parsed.gemeenten = ['Amsterdam', 'Rotterdam', 'Utrecht', 'Den Haag'];
    return parsed;
  } catch(e) {
    console.warn('[Strategie] Fallback:', e.message);
    return {
      zoekwoorden: ['software', 'IT advies'],
      gemeenten: ['Amsterdam', 'Rotterdam', 'Den Haag', 'Utrecht'],
      uitleg: 'Standaard IT-strategie'
    };
  }
}

async function beoordeelLead(bedrijf, opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: `Je bent een kritische B2B sales filter voor Intersect.
Opdrachtgever: "${opdrachtgever}" | Zoekopdracht: "${focusgebied}"

Bedrijf:
- Naam: ${bedrijf.organisatie}
- Sector: ${bedrijf.sector || 'onbekend'}
- Locatie: ${bedrijf.regio || 'onbekend'}
- Website: ${bedrijf.website || 'geen'}

Scoringsregels — wees STRENG:
- 8-10: Naam/sector sluit DUIDELIJK aan bij zoekopdracht (bijv. "Software BV", "IT Consultancy")
- 7:   Redelijke match, enige twijfel
- 4-6: Twijfelgeval of onvoldoende info
- 1-3: Verkeerde sector, VvE, stichting, horeca, retail, zorg, bouw, of geen info

Geef NOOIT 7+ alleen op basis van locatie of naam die niet branche-specifiek is.
Het haakje moet CONCREET zijn — vermeld iets specifieks over hun naam of sector. Geen generieke zinnen.

JSON only: {"score":<1-10>,"reden":"<max 10 woorden>","haakje":"<1-2 zinnen persoonlijke opener, null als score<7>"}` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) { return { score: 5, reden: 'Niet beoordeeld', haakje: null }; }
}

async function handleStart(req, res) {
  const { opdrachtgever, focusgebied, limit = 20 } = req.body || {};
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit) || 20, 100);
  const db = getDb();
  const start = Date.now();
  const verwerkt = new Set(); // KvK-nummers al gezien (dedup over alle queries heen)
  let opgeslagen = 0, bekeken = 0;

  console.log(`[Start] ${opdrachtgever} | ${focusgebied} | doel:${DOEL}`);
  const strategie = await bepaalStrategie(opdrachtgever, focusgebied);
  console.log(`[Strategie] ${strategie.uitleg}`);
  console.log(`[Zoekwoorden] ${strategie.zoekwoorden.join(', ')}`);
  console.log(`[Gemeenten] ${strategie.gemeenten.join(', ')}`);

  // Loop: zoekwoord × gemeente — zodat OpenKVK al gefilterd teruggeeft
  outer:
  for (const zoekwoord of strategie.zoekwoorden) {
    for (const gemeente of strategie.gemeenten) {
      if (opgeslagen >= DOEL || Date.now() - start > 230000) break outer;

      const data = await zoekBedrijvenOpenKVK({ gemeente, zoekwoord, size: 100 });
      const resultaten = getBedrijven(data);
      console.log(`[OpenKVK] "${zoekwoord} ${gemeente}": ${resultaten.length}`);
      if (!resultaten.length) continue;

      for (const r of resultaten) {
        if (opgeslagen >= DOEL || Date.now() - start > 230000) break;
        const kvkNr = r.dossiernummer;
        if (!kvkNr || verwerkt.has(kvkNr)) continue;
        verwerkt.add(kvkNr);
        bekeken++;

        const bedrijf = parseOpenKVKBedrijf(r);

        // Naam-filter (snelle skip voor duidelijk irrelevante entiteiten)
        const nL = (bedrijf.organisatie || '').toLowerCase();
        if (SKIP_NAMEN.some(s => nL.includes(s))) continue;

        // Duplicaat-check in DB
        if (await bestaatAl(bedrijf.kvk_nummer, bedrijf.website)) continue;
        const { data: bestaand } = await db.from('scraper_results')
          .select('id').eq('kvk_nummer', kvkNr).eq('status', 'ter_beoordeling').maybeSingle();
        if (bestaand) continue;

        // Claude beoordeling
        const beoordeling = await beoordeelLead(bedrijf, opdrachtgever, focusgebied);
        if (beoordeling.score < 7) {
          console.log(`[skip] ${bedrijf.organisatie} ${beoordeling.score} — ${beoordeling.reden}`);
          continue;
        }

        const { error } = await db.from('scraper_results').insert({
          opdrachtgever, focusgebied, status: 'ter_beoordeling',
          organisatie:  bedrijf.organisatie,
          sector:       bedrijf.sector    || '',
          segment:      bedrijf.sbi_code  || '',
          website:      bedrijf.website   || '',
          adres:        bedrijf.adres     || '',
          regio:        gemeente,
          medewerkers:  '',
          kvk_nummer:   bedrijf.kvk_nummer,
          telefoon:     bedrijf.telefoon  || '',
          score:        beoordeling.score,
          reden:        beoordeling.reden,
          haakje:       beoordeling.haakje || '',
          notitie:      `[${opdrachtgever}] ${beoordeling.haakje || beoordeling.reden || ''}`,
        });
        if (!error) {
          opgeslagen++;
          console.log(`[+] ${bedrijf.organisatie} | score:${beoordeling.score} | ${beoordeling.reden} (${opgeslagen}/${DOEL})`);
        }
        await wacht(100);
      }
      await wacht(400);
    }
  }

  const duur = Math.round((Date.now() - start) / 1000);
  console.log(`[Klaar] ${opgeslagen} leads in ${duur}s (${bekeken} uniek bekeken)`);
  return res.status(200).json({ success: true, opgeslagen, bekeken, duur_seconden: duur });
}

async function handleStatus(req, res) {
  const db = getDb();
  const { count } = await db.from('scraper_results')
    .select('*', { count: 'exact', head: true }).eq('status', 'ter_beoordeling');
  return res.status(200).json({ wachtend: count || 0 });
}

async function handleResults(req, res) {
  const db = getDb();
  if (req.method === 'GET') {
    const { data, error } = await db.from('scraper_results')
      .select('*').eq('status', 'ter_beoordeling').order('score', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, leads: data || [] });
  }
  const { doorsturen, afwijzen } = req.body || {};
  let opgeslagen = 0;
  const fouten = [];
  for (const lead of (doorsturen || [])) {
    const naamDelen = (lead.contact_naam || '').trim().split(' ');
    const { error } = await db.from('accounts').insert({
      name: lead.organisatie, status: 'lead',
      sector: lead.sector || '', segment: lead.segment || '',
      website: lead.website || '', linkedin: lead.linkedin || '',
      phone: lead.telefoon || '', kvk: lead.kvk_nummer || '',
      address: lead.adres || '',
      address_url: lead.adres ? `https://www.google.com/maps/search/?q=${encodeURIComponent(lead.adres)}` : '',
      pipeline_stage: 'Nieuw', value: null, owner: 'MA',
      note: lead.notitie || '', color_index: 0,
      added_date: new Date().toISOString().split('T')[0],
      contact_first: naamDelen[0] || '',
      contact_last: naamDelen.slice(1).join(' ') || '',
      contact_role: lead.contact_titel || '',
      contact_phone: lead.contact_telefoon || '',
      contact_email: lead.email || '',
    });
    if (error) fouten.push(lead.organisatie);
    else {
      opgeslagen++;
      await db.from('scraper_results').update({ status: 'doorgestuurd' }).eq('id', lead.id);
    }
  }
  for (const id of (afwijzen || [])) {
    await db.from('scraper_results').update({ status: 'afgewezen' }).eq('id', id);
  }
  return res.status(200).json({ success: true, opgeslagen, fouten: fouten.length });
}

module.exports = async function handler(req, res) {
  console.log('[Handler]', req.method, req.url, 'body:', JSON.stringify(req.body || {}).substring(0, 100));
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}`
    || req.body?.secret === secret
    || req.query?.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });

  const action = req.query.action || req.body?.action;
  console.log('[Action]', action);
  if (action === 'start')   return handleStart(req, res);
  if (action === 'status')  return handleStatus(req, res);
  if (action === 'results') return handleResults(req, res);
  return res.status(400).json({ error: 'Geef action mee: start|status|results' });
};
