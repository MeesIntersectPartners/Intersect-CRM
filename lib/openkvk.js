const axios = require('axios');

const OVIO_KEY = process.env.OVIO_API_KEY;
const BASE = 'https://api.overheid.io/openkvk';

// Zoek bedrijven op SBI code + optioneel gemeente
// OpenKVK API geeft direct gefilterde resultaten terug — geen aparte profielcall nodig
async function zoekBedrijvenOpenKVK({ sbiCode, gemeente, pagina = 1, size = 100 }) {
  try {
    const params = {
      size,
      page: pagina,
      'ovio-api-key': OVIO_KEY,
    };

    // Filter op SBI code
    if (sbiCode) params['filters[sbi_code]'] = sbiCode;

    // Filter op gemeente/plaats
    if (gemeente) params['filters[plaatsnaam]'] = gemeente;

    // Haal nuttige velden op
    params['fields[]'] = [
      'handelsnaam', 'kvk_nummer', 'sbi_code', 'sbi_omschrijving',
      'straatnaam', 'huisnummer', 'postcode', 'plaatsnaam',
      'website', 'telefoonnummer', 'aantal_werkzame_personen',
    ];

    const response = await axios.get(BASE, { params, timeout: 15000 });
    return response.data;
  } catch(e) {
    console.warn(`[OpenKVK] Fout SBI:${sbiCode} ${gemeente||'NL'}: ${e.message}`);
    return null;
  }
}

// Parst een OpenKVK resultaat naar ons interne formaat
function parseOpenKVKBedrijf(r) {
  const straat = [r.straatnaam, r.huisnummer].filter(Boolean).join(' ');
  const adres = [straat, r.postcode, r.plaatsnaam].filter(Boolean).join(', ');
  const mw = r.aantal_werkzame_personen || null;

  return {
    kvk_nummer: r.kvk_nummer,
    organisatie: r.handelsnaam,
    sector: r.sbi_omschrijving || null,
    segment: null, // wordt later gevuld door bepaalSegment
    website: r.website || null,
    adres: adres || null,
    regio: r.plaatsnaam || null,
    telefoon: r.telefoonnummer || null,
    medewerkers_raw: mw ? String(mw) : null,
    medewerkers_min: mw ? parseInt(mw) : 0,
    sbi_code: r.sbi_code || null,
  };
}

module.exports = { zoekBedrijvenOpenKVK, parseOpenKVKBedrijf };
