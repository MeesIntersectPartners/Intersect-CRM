const axios = require('axios');
const cheerio = require('cheerio');

// Zoekt via DuckDuckGo naar nieuws over een bedrijf
// Geeft snippets terug die als signaal gebruikt kunnen worden
async function zoekNieuws(bedrijfsnaam) {
  const queries = [
    `"${bedrijfsnaam}" funding OR investering OR groei`,
    `"${bedrijfsnaam}" award OR winnaar OR nieuw kantoor OR uitbreiding`,
  ];

  const signalen = [];

  for (const query of queries) {
    try {
      const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query, kl: 'nl-nl' },
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; IntersectBot/1.0)',
          'Accept': 'text/html',
        },
        timeout: 8000,
      });

      const $ = cheerio.load(response.data);

      // Extraheer zoekresultaten snippets
      $('.result__snippet').each((i, el) => {
        if (i >= 2) return false; // Max 2 resultaten per query
        const snippet = $(el).text().trim();
        if (snippet && snippet.length > 20) {
          signalen.push({
            type: 'nieuws',
            tekst: snippet,
            query,
          });
        }
      });
    } catch {
      // DuckDuckGo geblokkeerd of timeout — geen probleem, doorgaan
    }
  }

  return signalen;
}

// Detecteert signalen op basis van websitedata + nieuws
function analyseSignalen(bedrijf, scrapeData, nieuwsSignalen) {
  const signalen = [];

  // === Website signalen ===
  if (scrapeData?.heeftVacatures) {
    signalen.push({
      type: 'groei',
      beschrijving: 'Actief aan het werven — bedrijf in groeifase',
      gewicht: 3,
    });
  }

  if (scrapeData?.vacatureAantal > 3) {
    signalen.push({
      type: 'groei',
      beschrijving: `Meerdere vacatures open (${scrapeData.vacatureAantal}+) — sterke uitbreiding`,
      gewicht: 4,
    });
  }

  if (scrapeData?.heeftCultuurSignaal) {
    signalen.push({
      type: 'cultuur',
      beschrijving: 'Bedrijf communiceert actief over beleving en teamcultuur',
      gewicht: 4,
    });
  }

  // === Bedrijfsleeftijd signalen ===
  const huidigJaar = new Date().getFullYear();
  if (bedrijf.opgericht) {
    const leeftijd = huidigJaar - bedrijf.opgericht;
    if (leeftijd >= 3 && leeftijd <= 10) {
      signalen.push({
        type: 'leeftijd',
        beschrijving: `Opgericht in ${bedrijf.opgericht} — groeiende scale-up fase`,
        gewicht: 2,
      });
    } else if (leeftijd > 10 && leeftijd <= 20) {
      signalen.push({
        type: 'leeftijd',
        beschrijving: `Gevestigd bedrijf (${leeftijd} jaar) — waarschijnlijk actief in relatiebeheer`,
        gewicht: 2,
      });
    }
  }

  // === Grootte signalen ===
  if (bedrijf.medewerkers_raw) {
    const min = bedrijf.medewerkers_min;
    if (min >= 10 && min < 50) {
      signalen.push({
        type: 'grootte',
        beschrijving: 'Middelgroot team — persoonlijk evenement goed haalbaar',
        gewicht: 2,
      });
    } else if (min >= 50) {
      signalen.push({
        type: 'grootte',
        beschrijving: 'Groter team — budget voor events aanwezig',
        gewicht: 3,
      });
    }
  }

  // === Nieuws signalen ===
  for (const ns of nieuwsSignalen) {
    const tekst = ns.tekst.toLowerCase();

    if (/funding|investering|series [abc]|seed|miljoen|capital/i.test(tekst)) {
      signalen.push({
        type: 'funding',
        beschrijving: `Recent in het nieuws rondom funding of investering`,
        snippet: ns.tekst.substring(0, 150),
        gewicht: 5,
      });
    } else if (/award|winnaar|prijs gewon|beste|top \d+/i.test(tekst)) {
      signalen.push({
        type: 'award',
        beschrijving: `Heeft recentelijk een award gewonnen of genomineerd`,
        snippet: ns.tekst.substring(0, 150),
        gewicht: 4,
      });
    } else if (/nieuw kantoor|verhuisd|uitbreiding|opens|expanded/i.test(tekst)) {
      signalen.push({
        type: 'uitbreiding',
        beschrijving: `Uitbreiding of verhuizing gesignaleerd`,
        snippet: ns.tekst.substring(0, 150),
        gewicht: 4,
      });
    }
  }

  // Totaalgewicht
  const totalGewicht = signalen.reduce((sum, s) => sum + s.gewicht, 0);

  return {
    signalen,
    score: totalGewicht,
    isInteressant: totalGewicht >= 3 || signalen.some(s => s.gewicht >= 4),
  };
}

module.exports = { zoekNieuws, analyseSignalen };
