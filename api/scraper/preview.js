const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('../../lib/kvk');
const { bestaatAl } = require('../../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

async function bepaalStrategie(focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `Nederlandse KvK expert. Vertaal naar zoekparameters:
"${focusgebied}"

JSON only:
{
  "gemeenten": ["<8 brede Nederlandse gemeenten>"],
  "sbi_prefix": ["<1-3 brede SBI prefixes bijv '62','63','70'>"],
  "min_medewerkers": <10 standaard>
}` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) {
    console.warn('[strategie fout]', e.message);
    return { gemeenten: ['Amsterdam','Rotterdam','Den Haag','Utrecht','Eindhoven','Groningen','Tilburg','Breda'], sbi_prefix: null, min_medewerkers: 10 };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.CRON_SECRET;
  if (req.headers.authorization !== `Bearer ${secret}` && req.body?.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { opdrachtgever, focusgebied, limit = 10 } = req.body || {};
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit)||10, 20);
  const start = Date.now();
  const log = []; // debug log

  try {
    // Stap 1: strategie
    const s = await bepaalStrategie(focusgebied);
    log.push(`Strategie: gemeenten=${s.gemeenten?.join(',')}, SBI=${s.sbi_prefix?.join(',')}`);

    const resultaten = [];
    const verwerkt = new Set();

    for (const gemeente of (s.gemeenten || GEMEENTEN.slice(0,6))) {
      if (resultaten.length >= DOEL || Date.now()-start > 40000) break;

      let zoek = null;
      try {
        zoek = await zoekBedrijven(gemeente, 1);
      } catch(e) {
        log.push(`KvK fout ${gemeente}: ${e.message}`);
        continue;
      }

      if (!zoek?.resultaten?.length) {
        log.push(`${gemeente}: 0 resultaten`);
        continue;
      }
      log.push(`${gemeente}: ${zoek.resultaten.length} resultaten`);

      for (const r of zoek.resultaten) {
        if (resultaten.length >= DOEL || Date.now()-start > 40000) break;
        if (verwerkt.has(r.kvkNummer)) continue;
        verwerkt.add(r.kvkNummer);

        try {
          const profiel = await getBedrijfsProfiel(r.kvkNummer);
          await wacht(80);
          const bedrijf = parseBedrijf(r, profiel);

          // Medewerkers
          if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < (s.min_medewerkers||10)) continue;

          // SBI filter
          const sbiCodes = (profiel?.sbiActiviteiten || r?.sbiActiviteiten || []).map(x => String(x.sbiCode || x));
          if (s.sbi_prefix?.length) {
            if (!sbiCodes.some(c => s.sbi_prefix.some(p => c.startsWith(p)))) continue;
          } else {
            if (!isSBIInteressant(profiel?.sbiActiviteiten || r?.sbiActiviteiten || [])) continue;
          }

          // Naam filter
          const nL = (bedrijf.organisatie||'').toLowerCase();
          if (SKIP_NAMEN.some(x => nL.includes(x))) continue;

          const alInCrm = await bestaatAl(bedrijf.kvk_nummer, bedrijf.website);

          resultaten.push({
            organisatie: bedrijf.organisatie,
            sector: bedrijf.sector, segment: bedrijf.segment,
            website: bedrijf.website, adres: bedrijf.adres, regio: bedrijf.regio,
            medewerkers_raw: bedrijf.medewerkers_raw, kvk_nummer: bedrijf.kvk_nummer,
            linkedin: null, telefoon: null, email: null, contactpersoon: null,
            score: 7, reden: bedrijf.sector || 'Overeenkomende sector',
            haakje: null, al_in_crm: alInCrm,
            notitie: `[${opdrachtgever}] Via scraper — ${bedrijf.sector||''}`,
          });
          log.push(`+ ${bedrijf.organisatie} (${bedrijf.regio})`);

        } catch(e) { log.push(`fout ${r?.naam}: ${e.message}`); }
        await wacht(80);
      }
    }

    log.push(`Klaar: ${resultaten.length} leads in ${Math.round((Date.now()-start)/1000)}s`);

    return res.status(200).json({
      success: true,
      count: resultaten.length,
      duur_seconden: Math.round((Date.now()-start)/1000),
      debug_log: log,
      strategie: { gemeenten: s.gemeenten, sbi_prefix: s.sbi_prefix },
      leads: resultaten,
    });

  } catch(e) {
    log.push(`FATALE FOUT: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message, debug_log: log });
  }
};
