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
      messages: [{ role: 'user', content: `Expert in Nederlandse KvK database en SBI-codes.

Intersect (sales agency) zoekt voor "${opdrachtgever}":
"${focusgebied}"

De KvK API ondersteunt zoeken op: plaatsnaam en naam van het bedrijf.
SBI codes worden ALLEEN gebruikt als nafilter na het ophalen van resultaten.

Geef ALLEEN dit JSON terug:
{
  "gemeenten": ["<8-12 Nederlandse gemeenten breed genoeg om veel resultaten te geven>"],
  "sbi_codes": ["<2-4 cijferige SBI codes om op te filteren NADAT we zoeken>"],
  "naam_zoekterm": "<optioneel: zoekterm op bedrijfsnaam als dat relevant is, anders null>",
  "min_medewerkers": <integer, gebruik 10 als standaard>,
  "uitleg": "<één zin wat we zoeken>"
}

Gebruik ALTIJD brede gemeentenlijst: Amsterdam, Rotterdam, Den Haag, Utrecht, Eindhoven, Groningen, Tilburg, Breda zijn goede standaards.
Voor fintech/payments: voeg ook Haarlem, Leiden toe.

SBI referentie: 62=IT/software, 63=data/info, 64=financieel, 65=verzekering,
66=financiële diensten, 70=holdings/management, 73=reclame/marketing,
74=zakelijke diensten, 78=recruitment/HR, 82=administratieve diensten,
90-91=kunst/evenementen/cultuur` }],
    });
    const txt = response.content[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const s = JSON.parse(txt);
    console.log('[Strategie]', s.uitleg);
    console.log('[Gemeenten]', s.gemeenten?.join(', '));
    console.log('[SBI filter]', s.sbi_codes?.join(', '));
    return s;
  } catch(e) {
    console.warn('[Strategie] fout:', e.message);
    return { gemeenten: GEMEENTEN.slice(0,8), sbi_codes: null, min_medewerkers: 10, uitleg: 'Standaard zoek' };
  }
}

// Stap 2: Claude beoordeelt lead op basis van KvK data
async function beoordeelLead(bedrijf, opdrachtgever, focusgebied) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Intersect werkt voor "${opdrachtgever}". Zoekopdracht: "${focusgebied}"
Bedrijf: ${bedrijf.organisatie} | Sector: ${bedrijf.sector||'?'} | ${bedrijf.medewerkers_raw||'?'} mw | ${bedrijf.regio||'?'} | Website: ${bedrijf.website||'geen'}
JSON only: {"score":<1-10>,"reden":"<max 10 woorden>","haakje":"<1 zin opener voor mail/bel, null als score<6>"}` }],
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

  // Stap 1: Zoekstrategie van Claude
  const strategie = await bepaalZoekStrategie(opdrachtgever, focusgebied);
  const zoekGemeenten = strategie?.gemeenten?.length ? strategie.gemeenten : GEMEENTEN.slice(0,8);
  const filterSBI = strategie?.sbi_codes?.length ? strategie.sbi_codes : null;
  const minMedewerkers = strategie?.min_medewerkers || 10;
  const naamZoekterm = strategie?.naam_zoekterm || null;

  console.log(`[Search] ${zoekGemeenten.length} gemeenten, SBI filter: ${filterSBI?.join(',')||'breed'}, min: ${minMedewerkers}`);

  for (const gemeente of zoekGemeenten) {
    if (resultaten.length >= DOEL || Date.now()-start > 45000) break;

    // KvK zoekt op gemeente (+ optioneel naam)
    const zoek = await zoekBedrijven(gemeente, 1, null, naamZoekterm);
    if (!zoek?.resultaten?.length) {
      console.log(`[KvK] Geen resultaten voor ${gemeente}`);
      continue;
    }
    console.log(`[KvK] ${zoek.resultaten.length} gevonden in ${gemeente}`);

    for (const r of zoek.resultaten) {
      if (resultaten.length >= DOEL || Date.now()-start > 45000) break;
      if (verwerkt.has(r.kvkNummer)) continue;
      verwerkt.add(r.kvkNummer);

      try {
        const profiel = await getBedrijfsProfiel(r.kvkNummer);
        await wacht(100);
        const bedrijf = parseBedrijf(r, profiel);

        // Medewerkers filter
        if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < minMedewerkers) continue;

        // SBI nafilter
        if (filterSBI && filterSBI.length) {
          const codes = (profiel?.sbiActiviteiten || r?.sbiActiviteiten || []).map(s => String(s.sbiCode || s));
          const match = codes.some(code => filterSBI.some(f => code.startsWith(f)));
          if (!match) continue;
        } else {
          if (!isSBIInteressant(profiel?.sbiActiviteiten || r?.sbiActiviteiten || [])) continue;
        }

        const nL = (bedrijf.organisatie||'').toLowerCase();
        if (SKIP_NAMEN.some(s => nL.includes(s))) continue;

        const bestaatAlReds = await bestaatAl(bedrijf.kvk_nummer, bedrijf.website);

        // Snel beoordelen
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
    strategie: { uitleg: strategie?.uitleg, gemeenten: zoekGemeenten, sbi_filter: filterSBI },
    leads: resultaten,
  });
};
