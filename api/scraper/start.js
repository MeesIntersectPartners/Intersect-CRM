const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('../../lib/kvk');
const { bestaatAl } = require('../../lib/supabase');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }

function getDb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

async function bepaalStrategie(focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Nederlandse KvK expert. Vertaal naar zoekparameters voor: "${focusgebied}"
JSON only: {"gemeenten":["<10 brede Nederlandse gemeenten>"],"sbi_prefix":["<brede 2-cijferige SBI prefixes>"],"min_medewerkers":<integer, standaard 10>}` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) {
    return { gemeenten: ['Amsterdam','Rotterdam','Den Haag','Utrecht','Eindhoven','Groningen','Tilburg','Breda','Arnhem','Nijmegen'], sbi_prefix: null, min_medewerkers: 10 };
  }
}

async function beoordeelLead(bedrijf, opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{ role: 'user', content: `B2B sales expert. Intersect verkoopt voor "${opdrachtgever}".
Zoekopdracht: "${focusgebied}"
Bedrijf: ${bedrijf.organisatie} | Sector: ${bedrijf.sector||'?'} | ${bedrijf.medewerkers_raw||'?'} mw | ${bedrijf.regio||'?'} | Website: ${bedrijf.website||'geen'}
JSON only: {"score":<1-10>,"reden":"<max 10 woorden>","haakje":"<1-2 zinnen gespreksstarter voor mail of bel, null als score onder 7>"}` }]
    });
    const txt = r.content[0].text.trim().replace(/```json|```/g,'').trim();
    return JSON.parse(txt);
  } catch(e) {
    return { score: 5, reden: 'Niet beoordeeld', haakje: null };
  }
}

async function slaLeadOp(db, lead, opdrachtgever, focusgebied) {
  const { error } = await db.from('scraper_results').insert({
    opdrachtgever,
    focusgebied,
    status: 'ter_beoordeling',
    organisatie: lead.organisatie,
    sector: lead.sector || '',
    segment: lead.segment || '',
    website: lead.website || '',
    adres: lead.adres || '',
    regio: lead.regio || '',
    medewerkers: lead.medewerkers_raw || '',
    kvk_nummer: lead.kvk_nummer || '',
    linkedin: lead.linkedin || '',
    telefoon: lead.telefoon || '',
    email: lead.email || '',
    contact_naam: lead.contactpersoon?.naam || '',
    contact_titel: lead.contactpersoon?.titel || '',
    contact_telefoon: lead.contactpersoon?.telefoon || '',
    score: lead.score || 0,
    reden: lead.reden || '',
    haakje: lead.haakje || '',
    notitie: `[${opdrachtgever}] ${lead.haakje || lead.reden || ''}`,
  });
  if (error) console.warn('[save] fout:', error.message);
  return !error;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.CRON_SECRET;
  if (req.headers.authorization !== `Bearer ${secret}` && req.body?.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { opdrachtgever, focusgebied, limit = 20 } = req.body || {};
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit) || 20, 100);
  const db = getDb();
  const start = Date.now();
  const verwerkt = new Set();
  let opgeslagen = 0;
  let bekeken = 0;

  // Stuur direct terug dat we gestart zijn — vercel blijft draaien op de achtergrond
  // We sturen de response pas als we klaar zijn (maxDuration: 300)

  console.log(`[Start] ${opdrachtgever} | ${focusgebied} | doel: ${DOEL}`);

  const strategie = await bepaalStrategie(focusgebied);
  const gemeenten = strategie?.gemeenten || GEMEENTEN.slice(0, 8);
  const sbiPrefix = strategie?.sbi_prefix || null;
  const minMw = strategie?.min_medewerkers || 10;

  console.log(`[Strategie] ${gemeenten.join(',')} | SBI: ${sbiPrefix?.join(',') || 'breed'}`);

  for (const gemeente of gemeenten) {
    if (opgeslagen >= DOEL || Date.now() - start > 260000) break;

    const zoek = await zoekBedrijven(gemeente, 1);
    if (!zoek?.resultaten?.length) continue;
    console.log(`[KvK] ${gemeente}: ${zoek.resultaten.length} resultaten`);

    // Filter kandidaten op naam — geen profielcall nodig
    const kandidaten = zoek.resultaten.filter(r => {
      if (verwerkt.has(r.kvkNummer)) return false;
      const nL = (r.naam || '').toLowerCase();
      return !SKIP_NAMEN.some(s => nL.includes(s));
    });

    for (const r of kandidaten) {
      if (opgeslagen >= DOEL || Date.now() - start > 260000) break;
      if (verwerkt.has(r.kvkNummer)) continue;
      verwerkt.add(r.kvkNummer);
      bekeken++;

      try {
        await wacht(500); // Rustig aan — voorkomt KvK rate limiting
        const profiel = await getBedrijfsProfiel(r.kvkNummer);
        const bedrijf = parseBedrijf(r, profiel);

        // Medewerkers filter
        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < minMw) continue;

        // SBI filter
        if (sbiPrefix?.length) {
          const codes = (profiel?.sbiActiviteiten || []).map(x => String(x.sbiCode || x));
          if (!codes.some(c => sbiPrefix.some(p => c.startsWith(p)))) continue;
        } else {
          if (!isSBIInteressant(profiel?.sbiActiviteiten || [])) continue;
        }

        // Al in CRM?
        if (await bestaatAl(bedrijf.kvk_nummer, bedrijf.website)) continue;

        // Al in scraper_results?
        const { data: bestaand } = await db.from('scraper_results')
          .select('id').eq('kvk_nummer', bedrijf.kvk_nummer || '')
          .eq('status', 'ter_beoordeling').maybeSingle();
        if (bestaand) continue;

        // Claude beoordeling
        const beoordeling = await beoordeelLead(bedrijf, opdrachtgever, focusgebied);

        // Alleen score 7+ opslaan
        if (beoordeling.score < 7) {
          console.log(`[skip] ${bedrijf.organisatie} score:${beoordeling.score}`);
          continue;
        }

        const lead = {
          ...bedrijf,
          score: beoordeling.score,
          reden: beoordeling.reden,
          haakje: beoordeling.haakje,
          contactpersoon: null,
          linkedin: null,
          email: null,
          telefoon: null,
        };

        const success = await slaLeadOp(db, lead, opdrachtgever, focusgebied);
        if (success) {
          opgeslagen++;
          console.log(`[+] ${bedrijf.organisatie} score:${beoordeling.score} (${opgeslagen}/${DOEL})`);
        }

      } catch(e) {
        console.warn(`[fout] ${r.naam}: ${e.message}`);
      }
    }

    await wacht(1000); // Extra pauze tussen gemeenten
  }

  const duur = Math.round((Date.now() - start) / 1000);
  console.log(`[Klaar] ${opgeslagen} leads opgeslagen in ${duur}s (${bekeken} bekeken)`);

  return res.status(200).json({
    success: true,
    opgeslagen,
    bekeken,
    duur_seconden: duur,
  });
};
