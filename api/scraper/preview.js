const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('../../lib/kvk');
const { scrapeWebsite } = require('../../lib/scraper');
const { bestaatAl } = require('../../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

// Stap 1: Claude vertaalt focusgebied naar KvK zoekparameters
async function bepaalZoekStrategie(opdrachtgever, focusgebied) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `Je bent expert in de Nederlandse KvK database en SBI-codes.

Sales agency Intersect verkoopt namens "${opdrachtgever}" en zoekt:
"${focusgebied}"

Geef ALLEEN dit JSON object terug:
{
  "sbi_codes": ["<2-4 cijferige SBI codes die het beste passen, max 6>"],
  "gemeenten": ["<Nederlandse gemeenten relevant voor deze sector, max 8>"],
  "min_medewerkers": <integer, 0 als niet relevant>,
  "uitleg": "<één zin: wat zoeken we exact>"
}

SBI code referentie:
6201-6209 = software/IT, 6311 = dataverwerking, 6419 = holdings/fintech
6492 = overige kredietverlening, 6619 = overige financiële diensten
7010 = holdings, 7021-7022 = management consultancy
7311-7312 = reclame/marketing bureaus, 7320 = marktonderzoek
7410 = design, 7810-7830 = recruitment/HR/uitzend
5829 = software publishing, 6202 = IT consultancy
9001-9004 = podiumkunsten/evenementen, 9102 = musea/cultuur` }],
    });
    const txt = response.content[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const s = JSON.parse(txt);
    console.log('[Strategie]', s.uitleg);
    return s;
  } catch(e) {
    console.warn('[Strategie] fout:', e.message);
    return null;
  }
}

// Stap 2: Claude beoordeelt individuele lead
async function beoordeelLead(bedrijf, scrapeData, opdrachtgever, focusgebied) {
  const signalen = scrapeData ? [
    scrapeData.heeftVacatures ? `Actief werven (${scrapeData.vacatureAantal} vacatures)` : null,
    scrapeData.heeftCultuurSignaal ? 'Communiceert over beleving/cultuur' : null,
    scrapeData.bestContact ? `Contact: ${scrapeData.bestContact.naam} (${scrapeData.bestContact.titel||'?'})` : null,
  ].filter(Boolean).join('\n') : 'Geen websitedata';

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: `B2B sales expert voor Intersect.

OPDRACHTGEVER: ${opdrachtgever}
ZOEKOPDRACHT: ${focusgebied}

BEDRIJF: ${bedrijf.organisatie}
Sector: ${bedrijf.sector||'?'} | ${bedrijf.medewerkers_raw||'?'} medewerkers | ${bedrijf.regio||'?'}
Website: ${bedrijf.website||'geen'} | Signalen: ${signalen}

JSON only: {"score":<1-10>,"reden":"<één zin>","haakje":"<1-2 zinnen opener voor mail/bel, null als score<6>"}` }],
    });
    const txt = response.content[0]?.text?.trim().replace(/```json|```/g,'').trim();
    return JSON.parse(txt);
  } catch(e) {
    return { score: 5, reden: 'Beoordeling mislukt', haakje: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}` || req.body?.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });

  const { opdrachtgever, focusgebied, limit = 10 } = req.body || {};
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit)||10, 20);
  const resultaten = [];
  const verwerkt = new Set();
  const start = Date.now();

  // Stap 1: Claude bepaalt zoekstrategie
  const strategie = await bepaalZoekStrategie(opdrachtgever, focusgebied);
  const zoekSBI = strategie?.sbi_codes?.length ? strategie.sbi_codes : null;
  const zoekGemeenten = strategie?.gemeenten?.length ? strategie.gemeenten : GEMEENTEN.slice(0,5);
  const minMedewerkers = strategie?.min_medewerkers || 10;

  console.log(`[Search] SBI:${zoekSBI?.join(',')||'standaard'} Gemeenten:${zoekGemeenten.join(',')} Min:${minMedewerkers}`);

  // Bouw zoeklijst: als SBI codes beschikbaar, zoek per SBI+gemeente combinatie
  const zoekLijst = [];
  if (zoekSBI && zoekSBI.length) {
    for (const sbi of zoekSBI.slice(0,4)) {
      for (const gemeente of zoekGemeenten.slice(0,4)) {
        zoekLijst.push({ gemeente, sbi });
      }
      zoekLijst.push({ gemeente: null, sbi }); // ook heel NL
    }
  } else {
    for (const gemeente of zoekGemeenten) {
      zoekLijst.push({ gemeente, sbi: null });
    }
  }

  for (const { gemeente, sbi } of zoekLijst) {
    if (resultaten.length >= DOEL || Date.now()-start > 50000) break;

    const zoek = await zoekBedrijven(gemeente, 1, sbi);
    if (!zoek?.resultaten?.length) continue;
    console.log(`[KvK] ${zoek.resultaten.length} resultaten — ${gemeente||'NL'} SBI:${sbi||'-'}`);

    for (const r of zoek.resultaten) {
      if (resultaten.length >= DOEL || Date.now()-start > 50000) break;
      if (verwerkt.has(r.kvkNummer)) continue;
      verwerkt.add(r.kvkNummer);

      try {
        const profiel = await getBedrijfsProfiel(r.kvkNummer);
        await wacht(150);
        const bedrijf = parseBedrijf(r, profiel);

        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < minMedewerkers) continue;

        // Als we op SBI gezocht hebben, vertrouw die match — anders standaard filter
        if (!sbi && !isSBIInteressant(profiel?.sbiActiviteiten || r?.sbiActiviteiten || [])) continue;

        const nL = (bedrijf.organisatie||'').toLowerCase();
        if (SKIP_NAMEN.some(s => nL.includes(s))) continue;
        if (await bestaatAl(bedrijf.kvk_nummer, bedrijf.website)) continue;

        let scrapeData = null;
        if (bedrijf.website) {
          try {
            scrapeData = await Promise.race([
              scrapeWebsite(bedrijf.website),
              new Promise((_,rj) => setTimeout(() => rj(new Error('timeout')), 5000))
            ]);
          } catch(e) {}
        }

        const beoordeling = await beoordeelLead(bedrijf, scrapeData, opdrachtgever, focusgebied);
        if (beoordeling.score < 5) continue; // Skip slechte matches direct

        resultaten.push({
          organisatie: bedrijf.organisatie, sector: bedrijf.sector, segment: bedrijf.segment,
          website: bedrijf.website, adres: bedrijf.adres, regio: bedrijf.regio,
          medewerkers_raw: bedrijf.medewerkers_raw, kvk_nummer: bedrijf.kvk_nummer,
          telefoon: scrapeData?.telefoon||null, linkedin: scrapeData?.linkedin||null,
          email: scrapeData?.bestContact?.email || scrapeData?.directEmail||null,
          contactpersoon: scrapeData?.bestContact||null,
          score: beoordeling.score, reden: beoordeling.reden, haakje: beoordeling.haakje,
          notitie: `[${opdrachtgever}] ${beoordeling.haakje||beoordeling.reden||''}`,
        });
        console.log(`[+] ${bedrijf.organisatie} score:${beoordeling.score}`);
      } catch(e) { console.warn('[fout]', r?.naam, e.message); }
      await wacht(200);
    }
  }

  resultaten.sort((a,b) => (b.score||0)-(a.score||0));

  return res.status(200).json({
    success: true,
    count: resultaten.length,
    duur_seconden: Math.round((Date.now()-start)/1000),
    strategie: strategie ? { uitleg: strategie.uitleg, sbi_codes: strategie.sbi_codes, gemeenten: strategie.gemeenten } : null,
    leads: resultaten,
  });
};
