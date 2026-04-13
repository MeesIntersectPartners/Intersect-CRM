const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('./kvk');
const { scrapeWebsite } = require('./scraper');
const { bestaatAl, voegAccountToe } = require('./supabase');

const LEADS_DOEL = parseInt(process.env.LEADS_PER_RUN || '10');
const WEBSITE_TIMEOUT = 5000; // 5s max per website
const MAX_GEMEENTEN = 5; // Niet alle gemeenten per run

function wacht(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verwerkBedrijf(result) {
  const kvkNummer = result.kvkNummer;
  if (!kvkNummer) return null;

  // KvK profiel ophalen
  let profiel = null;
  try {
    profiel = await getBedrijfsProfiel(kvkNummer);
  } catch(e) {
    console.log(`  [kvk profiel] fout: ${e.message}`);
  }
  await wacht(150);

  const bedrijf = parseBedrijf(result, profiel);

  // Filter: minimaal 10 medewerkers
  if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < 10) return null;

  // Filter: skip op naam (duidelijke niet-doelgroep)
  const naamLower = (bedrijf.organisatie || '').toLowerCase();
  const skipNamen = ['kapsalon', 'kappers', 'ziekenhuis', 'huisarts', 'tandarts', 'apotheek',
    'fysiotherap', 'paramedisch', 'thuiszorg', 'verpleeg', 'maatschap', 'praktijk',
    'supermarkt', 'slager', 'bakker', 'pizzeria', 'restaurant', 'snackbar', 'cafetaria',
    'garage', 'autohandel', 'schilders', 'loodgiet', 'dakdekker', 'elektricien'];
  if (skipNamen.some(s => naamLower.includes(s))) return null;

  // Filter: sector interessant?
  if (!isSBIInteressant(profiel?.sbiActiviteiten || result?.sbiActiviteiten || [])) return null;

  // Deduplicatie
  const bestaat = await bestaatAl(bedrijf.kvk_nummer, bedrijf.website);
  if (bestaat) {
    console.log(`  [skip] ${bedrijf.organisatie} — al in CRM`);
    return null;
  }

  console.log(`[+] ${bedrijf.organisatie} (${bedrijf.regio})`);

  // Website scrapen — alleen als we een website hebben en nog tijd over is
  let scrapeData = null;
  if (bedrijf.website) {
    try {
      const scrapePromise = scrapeWebsite(bedrijf.website);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), WEBSITE_TIMEOUT));
      scrapeData = await Promise.race([scrapePromise, timeout]);
    } catch(e) {
      console.log(`  [website] geen data — ${e.message}`);
    }
  }

  return {
    ...bedrijf,
    contactpersoon: scrapeData?.bestContact || null,
    email: scrapeData?.bestContact?.email || scrapeData?.directEmail || null,
    telefoon: scrapeData?.bestContact?.telefoon || scrapeData?.telefoon || bedrijf.telefoon || null,
    contactTelefoon: scrapeData?.bestContact?.telefoon || null,
    linkedin: scrapeData?.linkedin || null,
    notitie: `KvK scraper — ${bedrijf.sector || 'zakelijke dienstverlening'}, ${bedrijf.regio || 'Zuid-Holland'}`,
  };
}

async function run() {
  const startTijd = Date.now();
  const MAX_TIJD = 240000; // Stop na 4 min zodat we ruim binnen 300s blijven

  console.log(`Scraper gestart — doel: ${LEADS_DOEL} leads`);
  const toegevoegd = [];
  const verwerkt = new Set();

  const gemeentenDezeRun = GEMEENTEN.slice(0, MAX_GEMEENTEN);

  for (const gemeente of gemeentenDezeRun) {
    if (toegevoegd.length >= LEADS_DOEL) break;
    if (Date.now() - startTijd > MAX_TIJD) {
      console.log(`[tijd] Tijdslimiet bereikt, stoppen`);
      break;
    }

    console.log(`Gemeente: ${gemeente}`);

    let zoekResultaat = null;
    try {
      zoekResultaat = await zoekBedrijven(gemeente, 1);
    } catch(e) {
      console.log(`  [kvk] fout bij zoeken: ${e.message}`);
      continue;
    }

    if (!zoekResultaat?.resultaten?.length) {
      console.log(`  Geen resultaten`);
      continue;
    }

    console.log(`  ${zoekResultaat.resultaten.length} bedrijven gevonden`);

    for (const result of zoekResultaat.resultaten) {
      if (toegevoegd.length >= LEADS_DOEL) break;
      if (Date.now() - startTijd > MAX_TIJD) break;
      if (verwerkt.has(result.kvkNummer)) continue;
      verwerkt.add(result.kvkNummer);

      try {
        const lead = await verwerkBedrijf(result);

        if (lead) {
          const id = await voegAccountToe(lead);
          if (id) {
            toegevoegd.push({ id, naam: lead.organisatie });
            console.log(`  ✓ Opgeslagen: ${lead.organisatie}`);
          }
        }
      } catch(e) {
        console.log(`  [fout] ${result.naam}: ${e.message}`);
      }

      await wacht(200);
    }
  }

  const duur = Math.round((Date.now() - startTijd) / 1000);
  console.log(`Klaar — ${toegevoegd.length} leads toegevoegd in ${duur}s`);
  return { toegevoegd: toegevoegd.length, leads: toegevoegd, duur_seconden: duur };
}

if (require.main === module) {
  run().catch(console.error);
}

module.exports = { run };
