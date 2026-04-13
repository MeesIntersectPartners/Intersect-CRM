const { zoekBedrijvenOpenKVK, parseOpenKVKBedrijf } = require('../../lib/openkvk');
const { bepaalSegment, isSBIInteressant } = require('../../lib/kvk');
const { bestaatAl } = require('../../lib/supabase');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }
function getDb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

// Claude bepaalt SBI codes + gemeenten op basis van focusgebied
async function bepaalStrategie(opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `Nederlandse KvK/SBI expert.

Intersect verkoopt voor "${opdrachtgever}" en zoekt:
"${focusgebied}"

Geef ALLEEN dit JSON terug:
{
  "sbi_codes": ["<exacte 4-6 cijferige SBI codes, max 8>"],
  "gemeenten": ["<max 10 relevante Nederlandse gemeenten>"],
  "min_medewerkers": <integer>,
  "uitleg": "<één zin>"
}

SBI referentie (gebruik volledige codes):
6201=maatwerksoftware, 6202=IT-advies, 6209=overige IT, 6311=dataverwerking,
6419=holdings/fintech, 6492=overige kredietverlening, 6619=overige financieel,
7010=holdings-management, 7021=PR-advies, 7022=management-advies,
7311=reclamebureau, 7312=media-advies, 7320=marktonderzoek,
7410=design, 7420=fotografie, 7810=arbeidsbemiddeling, 7820=uitzendbureau,
9001=podiumkunsten, 9002=uitvoerende kunst, 9003=kunstondersteuning,
9004=circussen-events, 5829=software-publishing, 6420=holdings` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) {
    console.warn('[strategie fout]', e.message);
    return { sbi_codes: ['6201','6202','7311','7022'], gemeenten: ['Amsterdam','Rotterdam','Den Haag','Utrecht','Eindhoven'], min_medewerkers: 10, uitleg: 'Standaard' };
  }
}

// Claude beoordeelt lead — score 7+ is goed
async function beoordeelLead(bedrijf, opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{ role: 'user', content: `Intersect verkoopt voor "${opdrachtgever}".
Zoekopdracht: "${focusgebied}"
Bedrijf: ${bedrijf.organisatie} | Sector: ${bedrijf.sector||'?'} | ${bedrijf.medewerkers_raw||'?'} mw | ${bedrijf.regio||'?'} | Website: ${bedrijf.website||'geen'}
JSON only: {"score":<1-10>,"reden":"<max 10 woorden>","haakje":"<1-2 zinnen gespreksstarter voor eerste contact, null als score<7>"}` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) {
    return { score: 5, reden: 'Niet beoordeeld', haakje: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.CRON_SECRET;
  if (req.headers.authorization !== `Bearer ${secret}` && req.body?.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { opdrachtgever, focusgebied, limit = 20 } = req.body || {};
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit)||20, 100);
  const db = getDb();
  const start = Date.now();
  const verwerkt = new Set();
  let opgeslagen = 0;
  let bekeken = 0;

  console.log(`[Start] ${opdrachtgever} | ${focusgebied} | doel: ${DOEL}`);

  // Stap 1: Claude bepaalt zoekstrategie
  const strategie = await bepaalStrategie(opdrachtgever, focusgebied);
  console.log(`[Strategie] ${strategie.uitleg}`);
  console.log(`[SBI] ${strategie.sbi_codes?.join(', ')}`);
  console.log(`[Gemeenten] ${strategie.gemeenten?.join(', ')}`);

  // Stap 2: Zoek per SBI code via OpenKVK — direct gefilterd, geen losse profielcalls
  for (const sbi of (strategie.sbi_codes || [])) {
    if (opgeslagen >= DOEL || Date.now()-start > 250000) break;

    for (const gemeente of (strategie.gemeenten || [])) {
      if (opgeslagen >= DOEL || Date.now()-start > 250000) break;

      const data = await zoekBedrijvenOpenKVK({ sbiCode: sbi, gemeente, size: 100 });
      if (!data?._embedded?.rechtspersoon?.length) {
        console.log(`[OpenKVK] SBI:${sbi} ${gemeente}: 0`);
        continue;
      }

      const resultaten = data._embedded.rechtspersoon;
      console.log(`[OpenKVK] SBI:${sbi} ${gemeente}: ${resultaten.length} bedrijven`);

      for (const r of resultaten) {
        if (opgeslagen >= DOEL || Date.now()-start > 250000) break;

        const kvkNr = r.kvk_nummer;
        if (!kvkNr || verwerkt.has(kvkNr)) continue;
        verwerkt.add(kvkNr);
        bekeken++;

        const bedrijf = parseOpenKVKBedrijf(r);
        bedrijf.segment = bepaalSegment([{ sbiCode: bedrijf.sbi_code }]);

        // Naam filter
        const nL = (bedrijf.organisatie||'').toLowerCase();
        if (SKIP_NAMEN.some(s => nL.includes(s))) continue;

        // Medewerkers filter
        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < (strategie.min_medewerkers||10)) continue;

        // Al in CRM?
        if (await bestaatAl(bedrijf.kvk_nummer, bedrijf.website)) continue;

        // Al in scraper_results?
        const { data: bestaand } = await db.from('scraper_results')
          .select('id').eq('kvk_nummer', kvkNr).eq('status','ter_beoordeling').maybeSingle();
        if (bestaand) continue;

        // Claude beoordeling
        const beoordeling = await beoordeelLead(bedrijf, opdrachtgever, focusgebied);
        if (beoordeling.score < 7) {
          console.log(`[skip] ${bedrijf.organisatie} score:${beoordeling.score}`);
          continue;
        }

        // Opslaan in scraper_results
        const { error } = await db.from('scraper_results').insert({
          opdrachtgever, focusgebied, status: 'ter_beoordeling',
          organisatie: bedrijf.organisatie, sector: bedrijf.sector,
          segment: bedrijf.segment, website: bedrijf.website,
          adres: bedrijf.adres, regio: bedrijf.regio,
          medewerkers: bedrijf.medewerkers_raw, kvk_nummer: bedrijf.kvk_nummer,
          telefoon: bedrijf.telefoon, score: beoordeling.score,
          reden: beoordeling.reden, haakje: beoordeling.haakje,
          notitie: `[${opdrachtgever}] ${beoordeling.haakje||beoordeling.reden||''}`,
        });

        if (!error) {
          opgeslagen++;
          console.log(`[+] ${bedrijf.organisatie} score:${beoordeling.score} (${opgeslagen}/${DOEL})`);
        }

        await wacht(100); // Kleine pauze — OpenKVK heeft geen rate limiting maar netjes blijven
      }

      await wacht(300); // Pauze tussen gemeente calls
    }
  }

  const duur = Math.round((Date.now()-start)/1000);
  console.log(`[Klaar] ${opgeslagen} leads in ${duur}s (${bekeken} bekeken)`);

  return res.status(200).json({ success: true, opgeslagen, bekeken, duur_seconden: duur });
};
