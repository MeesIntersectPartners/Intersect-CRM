// Vercel levert environment variables automatisch — geen dotenv nodig

const { GEMEENTEN, zoekBedrijven, getBedrijfsProfiel, isSBIInteressant, parseBedrijf } = require('./kvk');
const { scrapeWebsite } = require('./scraper');
const { zoekNieuws, analyseSignalen } = require('./signalen');
const { genereerHaakje } = require('./haakje');
const { bestaatAl, voegAccountToe, getStats } = require('./supabase');

const LEADS_DOEL = parseInt(process.env.LEADS_PER_RUN || '100');
const VERTRAGING_MS = 1000; // 1 seconde tussen requests

function wacht(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verwerkBedrijf(result) {
  const kvkNummer = result.kvkNummer;
  if (!kvkNummer) return null;

  // Haal basisprofiel op voor details
  const profiel = await getBedrijfsProfiel(kvkNummer);
  await wacht(300);

  const bedrijf = parseBedrijf(result, profiel);

  // Filter: minimaal 10 medewerkers
  if (bedrijf.medewerkers_min > 0 && bedrijf.medewerkers_min < 10) {
    return null;
  }

  // Filter: sector interessant?
  if (!isSBIInteressant(profiel?.sbiActiviteiten || result?.sbiActiviteiten || [])) {
    return null;
  }

  // Deduplicatie
  const bestaat = await bestaatAl(bedrijf.kvk_nummer, bedrijf.website);
  if (bestaat) {
    console.log(`  [skip] ${bedrijf.organisatie} — staat al in CRM`);
    return null;
  }

  console.log(`  [+] Verwerken: ${bedrijf.organisatie} (${bedrijf.regio})`);

  // Scrape website
  let scrapeData = null;
  if (bedrijf.website) {
    scrapeData = await scrapeWebsite(bedrijf.website);
    await wacht(VERTRAGING_MS);
  }

  // Zoek nieuws/signalen
  const nieuwsSignalen = await zoekNieuws(bedrijf.organisatie);
  await wacht(500);

  // Analyseer signalen
  const signaalData = analyseSignalen(bedrijf, scrapeData, nieuwsSignalen);

  // Skip als er geen enkel signaal is (niet interessant genoeg)
  if (!signaalData.isInteressant && !scrapeData?.bestContact) {
    console.log(`  [skip] ${bedrijf.organisatie} — onvoldoende signalen`);
    return null;
  }

  // Genereer haakje via Claude
  const haakje = await genereerHaakje(bedrijf, scrapeData, signaalData);
  await wacht(500);

  // Skip als Claude zegt dat er onvoldoende signalen zijn
  if (haakje?.includes('Onvoldoende signalen')) {
    console.log(`  [skip] ${bedrijf.organisatie} — Claude: onvoldoende haakje`);
    return null;
  }

  // Bouw lead object
  const lead = {
    ...bedrijf,
    contactpersoon: scrapeData?.bestContact || null,
    email: scrapeData?.bestContact?.email || scrapeData?.directEmail || null,
    telefoon: scrapeData?.bestContact?.telefoon || scrapeData?.telefoon || null,
    notitie: haakje,
    signalen: signaalData.signalen,
    signaal_score: signaalData.score,
  };

  return lead;
}

async function run() {
  console.log(`\n🚀 Intersect Scraper gestart — doel: ${LEADS_DOEL} leads`);
  console.log(`Partner: ${process.env.PARTNER_NAAM || 'Audio Obscura'}\n`);

  const toegevoegd = [];
  const verwerkt = [];

  // Loop door gemeenten tot we het doel hebben
  for (const gemeente of GEMEENTEN) {
    if (toegevoegd.length >= LEADS_DOEL) break;

    console.log(`\n📍 Gemeente: ${gemeente}`);

    let pagina = 1;
    let heeftMeerPaginas = true;

    while (heeftMeerPaginas && toegevoegd.length < LEADS_DOEL) {
      const zoekResultaat = await zoekBedrijven(gemeente, pagina);
      if (!zoekResultaat?.resultaten?.length) break;

      console.log(`  Pagina ${pagina}: ${zoekResultaat.resultaten.length} bedrijven`);

      for (const result of zoekResultaat.resultaten) {
        if (toegevoegd.length >= LEADS_DOEL) break;

        // Skip als we dit al verwerkt hebben in deze run
        if (verwerkt.includes(result.kvkNummer)) continue;
        verwerkt.push(result.kvkNummer);

        const lead = await verwerkBedrijf(result);

        if (lead) {
          const id = await voegAccountToe(lead);
          if (id) {
            toegevoegd.push({ id, naam: lead.organisatie });
            console.log(`  ✅ Toegevoegd: ${lead.organisatie} — "${lead.notitie?.substring(0, 60)}..."`);
          }
        }

        await wacht(VERTRAGING_MS);
      }

      // Check of er meer paginas zijn
      const totaal = zoekResultaat.totaalAantalResultaten || 0;
      heeftMeerPaginas = pagina * 100 < totaal;
      pagina++;
    }
  }

  // Eindrapportage
  const stats = await getStats();
  console.log(`\n✨ Klaar!`);
  console.log(`   Nieuwe leads toegevoegd: ${toegevoegd.length}`);
  console.log(`   Totaal scraper leads in CRM: ${stats.totaal_scraper_leads}`);

  return { toegevoegd: toegevoegd.length, leads: toegevoegd };
}

// Direct uitvoeren als script
if (require.main === module) {
  run().catch(console.error);
}

module.exports = { run };
