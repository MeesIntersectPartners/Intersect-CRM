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
      messages: [{ role: 'user', content: `Nederlandse KvK expert. Vertaal naar zoekparameters voor: "${focusgebied}"
JSON only: {"gemeenten":["<8 brede gemeenten>"],"sbi_prefix":["<brede 2-cijferige SBI prefixes>"],"min_medewerkers":<integer>}` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) {
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
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'Verplicht: opdrachtgever en focusgebied' });

  const DOEL = Math.min(parseInt(limit)||10, 20);
  const start = Date.now();
  const log = [];

  try {
    const s = await bepaalStrategie(focusgebied);
    log.push(`Strategie: ${s.gemeenten?.join(',')} | SBI: ${s.sbi_prefix?.join(',') || 'breed'}`);

    const kandidaten = []; // Bedrijven die initiële filter passeren — nog zonder profiel
    const verwerkt = new Set();

    // STAP 1: Zoek per gemeente, filter op naam/SBI uit zoekresultaat direct
    // Haal GEEN profiel op in deze stap — voorkomt rate limiting
    for (const gemeente of (s.gemeenten || GEMEENTEN.slice(0,6))) {
      if (kandidaten.length >= DOEL * 5 || Date.now()-start > 20000) break;

      const zoek = await zoekBedrijven(gemeente, 1);
      if (!zoek?.resultaten?.length) { log.push(`${gemeente}: 0`); continue; }
      log.push(`${gemeente}: ${zoek.resultaten.length} resultaten`);

      for (const r of zoek.resultaten) {
        if (verwerkt.has(r.kvkNummer)) continue;
        verwerkt.add(r.kvkNummer);

        // Snelle naam check
        const nL = (r.naam||'').toLowerCase();
        if (SKIP_NAMEN.some(x => nL.includes(x))) continue;

        // SBI check op zoekresultaat data (als beschikbaar)
        if (s.sbi_prefix?.length && r.sbiActiviteiten?.length) {
          const codes = r.sbiActiviteiten.map(x => String(x.sbiCode||x));
          if (!codes.some(c => s.sbi_prefix.some(p => c.startsWith(p)))) continue;
        }

        kandidaten.push(r);
      }
      await wacht(500); // Rustig aan tussen gemeente calls
    }

    log.push(`${kandidaten.length} kandidaten na initiele filter`);

    // STAP 2: Haal profiel op voor max DOEL*2 kandidaten — met ruime pauze
    const resultaten = [];
    const kandidatenSlice = kandidaten.slice(0, DOEL * 3);

    for (const r of kandidatenSlice) {
      if (resultaten.length >= DOEL || Date.now()-start > 45000) break;

      try {
        await wacht(600); // 600ms tussen profielcalls — voorkomt rate limiting
        const profiel = await getBedrijfsProfiel(r.kvkNummer);
        const bedrijf = parseBedrijf(r, profiel);

        // Medewerkers filter
        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < (s.min_medewerkers||10)) continue;

        // SBI nafilter op profiel data
        if (s.sbi_prefix?.length) {
          const codes = (profiel?.sbiActiviteiten || []).map(x => String(x.sbiCode||x));
          if (!codes.some(c => s.sbi_prefix.some(p => c.startsWith(p)))) continue;
        } else {
          if (!isSBIInteressant(profiel?.sbiActiviteiten || [])) continue;
        }

        const alInCrm = await bestaatAl(bedrijf.kvk_nummer, bedrijf.website);

        resultaten.push({
          organisatie: bedrijf.organisatie, sector: bedrijf.sector, segment: bedrijf.segment,
          website: bedrijf.website, adres: bedrijf.adres, regio: bedrijf.regio,
          medewerkers_raw: bedrijf.medewerkers_raw, kvk_nummer: bedrijf.kvk_nummer,
          linkedin: null, telefoon: null, email: null, contactpersoon: null,
          score: 7, reden: bedrijf.sector || 'Passende sector',
          haakje: null, al_in_crm: alInCrm,
          notitie: `[${opdrachtgever}] ${bedrijf.sector||''} — via scraper`,
        });
        log.push(`+ ${bedrijf.organisatie} (${bedrijf.regio||'?'}, ${bedrijf.medewerkers_raw||'?'} mw)`);

      } catch(e) {
        log.push(`profiel fout ${r.kvkNummer}: ${e.message}`);
      }
    }

    log.push(`Klaar: ${resultaten.length} leads in ${Math.round((Date.now()-start)/1000)}s`);

    return res.status(200).json({
      success: true, count: resultaten.length,
      duur_seconden: Math.round((Date.now()-start)/1000),
      debug_log: log,
      strategie: { gemeenten: s.gemeenten, sbi_prefix: s.sbi_prefix },
      leads: resultaten,
    });

  } catch(e) {
    return res.status(500).json({ success: false, error: e.message, debug_log: log });
  }
};
