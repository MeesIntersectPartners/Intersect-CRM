const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('../../lib/kvk');
const { bestaatAl } = require('../../lib/supabase');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

// Stap 1: Claude bepaalt zoekstrategie
async function bepaalZoekStrategie(opdrachtgever, focusgebied) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `Expert in Nederlandse KvK en SBI-codes.

Intersect (sales agency) zoekt voor "${opdrachtgever}":
"${focusgebied}"

Geef ALLEEN dit JSON terug:
{
  "sbi_codes": ["<2-4 cijferige SBI codes, max 6, breed genoeg om resultaten te geven>"],
  "gemeenten": ["<max 6 relevante gemeenten>"],
  "min_medewerkers": <integer, gebruik 10 als standaard>,
  "uitleg": "<één zin wat we zoeken>"
}

SBI referentie: 6201-6209=software/IT, 6419=holdings/fintech, 6492=financiële diensten,
6619=overige financieel, 7010-7022=consultancy/management, 7311-7312=reclame/marketing,
7320=marktonderzoek, 7410=design, 7810-7830=recruitment/HR, 9001-9004=evenementen/cultuur

Gebruik BREDE SBI codes als er weinig bedrijven zijn (bijv. voor fintech gebruik 64 ipv 6492).` }],
    });
    const txt = response.content[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const s = JSON.parse(txt);
    console.log('[Strategie]', s.uitleg, '| SBI:', s.sbi_codes?.join(','), '| Gemeenten:', s.gemeenten?.join(','));
    return s;
  } catch(e) {
    console.warn('[Strategie] fout:', e.message);
    return null;
  }
}

// Stap 2: Claude snel beoordelen op KvK data alleen (geen website scrape)
async function beoordeelLead(bedrijf, opdrachtgever, focusgebied) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `B2B sales, Intersect werkt voor "${opdrachtgever}".
Zoekopdracht: "${focusgebied}"
Bedrijf: ${bedrijf.organisatie} | Sector: ${bedrijf.sector||'?'} | ${bedrijf.medewerkers_raw||'?'} medewerkers | ${bedrijf.regio||'?'}
JSON only: {"score":<1-10>,"reden":"<max 10 woorden>","haakje":"<1 zin opener, null als score<6>"}` }],
    });
    const txt = response.content[0]?.text?.trim().replace(/```json|```/g,'').trim();
    return JSON.parse(txt);
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

  const { opdrachtgever, focusgebied, limit = 10 } = req.body || {};
  if (!opdrachtgever || !focusgebied) return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit)||10, 20);
  const resultaten = [];
  const verwerkt = new Set();
  const start = Date.now();

  // Stap 1: Zoekstrategie
  const strategie = await bepaalZoekStrategie(opdrachtgever, focusgebied);
  const zoekSBI = strategie?.sbi_codes?.length ? strategie.sbi_codes : null;
  const zoekGemeenten = strategie?.gemeenten?.length ? strategie.gemeenten : GEMEENTEN.slice(0,5);
  const minMedewerkers = strategie?.min_medewerkers || 10;

  // Zoeklijst opbouwen
  const zoekLijst = [];
  if (zoekSBI?.length) {
    for (const sbi of zoekSBI.slice(0,4)) {
      zoekLijst.push({ gemeente: null, sbi }); // heel NL op SBI
      for (const g of zoekGemeenten.slice(0,3)) {
        zoekLijst.push({ gemeente: g, sbi });
      }
    }
  } else {
    for (const g of zoekGemeenten) zoekLijst.push({ gemeente: g, sbi: null });
  }

  for (const { gemeente, sbi } of zoekLijst) {
    if (resultaten.length >= DOEL || Date.now()-start > 45000) break;

    const zoek = await zoekBedrijven(gemeente, 1, sbi);
    if (!zoek?.resultaten?.length) continue;
    console.log(`[KvK] ${zoek.resultaten.length} gevonden — ${gemeente||'NL'} SBI:${sbi||'-'}`);

    for (const r of zoek.resultaten) {
      if (resultaten.length >= DOEL || Date.now()-start > 45000) break;
      if (verwerkt.has(r.kvkNummer)) continue;
      verwerkt.add(r.kvkNummer);

      try {
        const profiel = await getBedrijfsProfiel(r.kvkNummer);
        await wacht(100);
        const bedrijf = parseBedrijf(r, profiel);

        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < minMedewerkers) continue;
        if (!sbi && !isSBIInteressant(profiel?.sbiActiviteiten || r?.sbiActiviteiten || [])) continue;
        const nL = (bedrijf.organisatie||'').toLowerCase();
        if (SKIP_NAMEN.some(s => nL.includes(s))) continue;

        // In preview: bestaatAl check optioneel — toon ook bestaande zodat je context hebt
        const bestaatAlReds = await bestaatAl(bedrijf.kvk_nummer, bedrijf.website);

        // Snel beoordelen op KvK data (geen website scrape in preview)
        const beoordeling = await beoordeelLead(bedrijf, opdrachtgever, focusgebied);
        if (beoordeling.score < 4) continue;

        resultaten.push({
          organisatie: bedrijf.organisatie, sector: bedrijf.sector, segment: bedrijf.segment,
          website: bedrijf.website, adres: bedrijf.adres, regio: bedrijf.regio,
          medewerkers_raw: bedrijf.medewerkers_raw, kvk_nummer: bedrijf.kvk_nummer,
          linkedin: null, telefoon: null, email: null, contactpersoon: null,
          score: beoordeling.score, reden: beoordeling.reden, haakje: beoordeling.haakje,
          al_in_crm: bestaatAlReds,
          notitie: `[${opdrachtgever}] ${beoordeling.haakje||beoordeling.reden||''}`,
        });
        console.log(`[+] ${bedrijf.organisatie} score:${beoordeling.score}${bestaatAlReds?' (al in CRM)':''}`);
      } catch(e) { console.warn('[fout]', r?.naam, e.message); }
      await wacht(100);
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
