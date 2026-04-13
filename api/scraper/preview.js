const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('../../lib/kvk');
const { scrapeWebsite } = require('../../lib/scraper');
const { bestaatAl } = require('../../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stap 1: Claude vertaalt het focusgebied naar concrete KvK zoekparameters
async function bepaalZoekStrategie(opdrachtgever, focusgebied) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `Je bent een expert in de Nederlandse KvK database en SBI-codes.

Een sales agency verkoopt namens "${opdrachtgever}" en wil de volgende leads vinden:
"${focusgebied}"

Vertaal dit naar concrete KvK zoekparameters. Geef ALLEEN dit JSON object terug:
{
  "sbi_codes": ["<2-4 cijferige SBI codes die het beste passen, max 8>"],
  "gemeenten": ["<Nederlandse gemeenten om in te zoeken, max 10, relevant voor de zoekopdracht>"],
  "min_medewerkers": <minimum aantal medewerkers als integer, 0 als niet relevant>,
  "uitleg": "<één zin: wat zoeken we precies>"
}

Voorbeelden van SBI codes:
- 6492/6619 = payment processing / fintech
- 6201/6209 = software ontwikkeling
- 7311/7312 = reclame en marketing
- 7010/7021 = management consultancy
- 7810/7820 = recruitment / HR
- 6201 = custom software
- 6311 = dataverwerking
- 9001/9002 = evenementen / podiumkunsten
- 7022 = overig bedrijfsadvies
- 7411 = design

Gebruik ook gemeenten die passen bij de sector (bijv. Amsterdam voor fintech/tech, Eindhoven voor tech/industrie).` }],
    });
    const txt = response.content[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const strategie = JSON.parse(txt);
    console.log('[Strategie]', strategie.uitleg);
    console.log('[SBI codes]', strategie.sbi_codes?.join(', '));
    console.log('[Gemeenten]', strategie.gemeenten?.join(', '));
    return strategie;
  } catch(e) {
    console.warn('[Strategie] Claude fout:', e.message, '— gebruik standaard filters');
    return null;
  }
}

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

async function beoordeelLead(bedrijf, scrapeData, opdrachtgever, focusgebied) {
  const signalen = scrapeData ? [
    scrapeData.heeftVacatures ? `Actief werven (${scrapeData.vacatureAantal} vacatures)` : null,
    scrapeData.heeftCultuurSignaal ? 'Communiceert over beleving/cultuur' : null,
    scrapeData.heeftNieuws ? 'Actief blog/nieuws' : null,
    scrapeData.bestContact ? `Contact: ${scrapeData.bestContact.naam} (${scrapeData.bestContact.titel||'?'})` : null,
  ].filter(Boolean).join('\n') : 'Geen websitedata';

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: `Je bent B2B sales expert voor Intersect (sales agency NL).

OPDRACHTGEVER: ${opdrachtgever}
FOCUSGEBIED: ${focusgebied}

BEDRIJF:
Naam: ${bedrijf.organisatie}
Sector: ${bedrijf.sector||'?'} | Segment: ${bedrijf.segment||'?'}
Medewerkers: ${bedrijf.medewerkers_raw||'?'} | Regio: ${bedrijf.regio||'?'}
Website: ${bedrijf.website||'geen'}
Signalen: ${signalen}

Geef ALLEEN dit JSON object terug:
{"score":<1-10>,"reden":"<één zin>","haakje":"<1-2 zinnen gespreksstarter voor mail/bel, niet beginnen met bedrijfsnaam, null als score onder 6>"}` }],
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

  // Stap 1: Claude bepaalt de zoekstrategie op basis van focusgebied
  const strategie = await bepaalZoekStrategie(opdrachtgever, focusgebied);
  const zoekGemeenten = strategie?.gemeenten?.length ? strategie.gemeenten : GEMEENTEN.slice(0, 5);
  const zoekSBI = strategie?.sbi_codes?.length ? strategie.sbi_codes : null;
  const minMedewerkers = strategie?.min_medewerkers || 10;

  console.log(`[Search] ${zoekGemeenten.length} gemeenten, ${zoekSBI?.length||'standaard'} SBI codes, min ${minMedewerkers} medewerkers`);

  for (const gemeente of zoekGemeenten) {
    if (resultaten.length >= DOEL || Date.now()-start > 55000) break;
    const zoek = await zoekBedrijven(gemeente, 1);
    if (!zoek?.resultaten?.length) continue;

    for (const r of zoek.resultaten) {
      if (resultaten.length >= DOEL || Date.now()-start > 55000) break;
      if (verwerkt.has(r.kvkNummer)) continue;
      verwerkt.add(r.kvkNummer);
      try {
        const profiel = await getBedrijfsProfiel(r.kvkNummer);
        await wacht(150);
        const bedrijf = parseBedrijf(r, profiel);
        // Medewerkers filter op basis van strategie
        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < minMedewerkers) continue;

        // SBI filter: als Claude specifieke codes heeft opgegeven, gebruik die
        const sbiCodes = (profiel?.sbiActiviteiten || r?.sbiActiviteiten || []).map(s => String(s.sbiCode || s));
        if (zoekSBI && zoekSBI.length) {
          const matchSBI = sbiCodes.some(code => zoekSBI.some(s => code.startsWith(s)));
          if (!matchSBI) continue;
        } else {
          if (!isSBIInteressant(profiel?.sbiActiviteiten || r?.sbiActiviteiten || [])) continue;
        }
        const nL = (bedrijf.organisatie||'').toLowerCase();
        if (SKIP_NAMEN.some(s => nL.includes(s))) continue;
        if (await bestaatAl(bedrijf.kvk_nummer, bedrijf.website)) continue;

        let scrapeData = null;
        if (bedrijf.website) {
          try { scrapeData = await Promise.race([scrapeWebsite(bedrijf.website), new Promise((_,rj)=>setTimeout(()=>rj(new Error('timeout')),5000))]); } catch(e){}
        }

        const beoordeling = await beoordeelLead(bedrijf, scrapeData, opdrachtgever, focusgebied);

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
      } catch(e) { console.warn('[fout]', r.naam, e.message); }
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
