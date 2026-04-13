const axios = require('axios');

const OVIO_KEY = process.env.OVIO_API_KEY;
const BASE = 'https://api.overheid.io/openkvk';

async function zoekBedrijvenOpenKVK({ gemeente, pagina = 1, size = 100 }) {
  try {
    const params = new URLSearchParams();
    params.append('size', size);
    params.append('page', pagina);
    params.append('ovio-api-key', OVIO_KEY);

    if (gemeente) params.append('query', gemeente);

    ['handelsnaam','dossiernummer','plaatsnaam','straatnaam','huisnummer',
     'postcode','website','telefoonnummer','activiteiten'].forEach(v => {
      params.append('fields[]', v);
    });

    const url = `${BASE}?${params.toString()}`;
    const response = await axios.get(url, { timeout: 15000 });
    const bedrijven = response.data?._embedded?.bedrijf || [];
    if (bedrijven.length > 0) {
      console.log('[OpenKVK] Eerste resultaat keys:', Object.keys(bedrijven[0]).join(', '));
    }
    return response.data;
  } catch(e) {
    console.warn(`[OpenKVK] Fout ${gemeente||'NL'}: ${e.response?.status||e.message}`);
    return null;
  }
}

function parseActiviteiten(activiteiten) {
  if (!activiteiten || !Array.isArray(activiteiten) || activiteiten.length === 0) {
    return { sbi_code: null, sbi_codes: [], sector: null };
  }

  // Ondersteun meerdere veldnamen die OpenKVK kan teruggeven
  const sbiCodes = activiteiten
    .map(a => a.sbicode || a.sbi_code || a.code || a.SBIcode || null)
    .filter(Boolean)
    .map(String);

  const omschrijvingen = activiteiten
    .map(a => a.sbiomschrijving || a.omschrijving || a.description || null)
    .filter(Boolean);

  // Hoofdactiviteit eerst
  const hoofd = activiteiten.find(a => a.isHoofdactiviteit || a.is_hoofdactiviteit || a.hoofdactiviteit);
  const hoofdSbi = hoofd
    ? (hoofd.sbicode || hoofd.sbi_code || hoofd.code || null)
    : sbiCodes[0] || null;
  const hoofdOmschrijving = hoofd
    ? (hoofd.sbiomschrijving || hoofd.omschrijving || null)
    : omschrijvingen[0] || null;

  return {
    sbi_code: hoofdSbi ? String(hoofdSbi) : null,
    sbi_codes: sbiCodes,
    sector: hoofdOmschrijving || null,
  };
}

function parseOpenKVKBedrijf(r) {
  const straat = [r.straatnaam, r.huisnummer].filter(Boolean).join(' ');
  const adres = [straat, r.postcode, r.plaatsnaam].filter(Boolean).join(', ');
  const { sbi_code, sbi_codes, sector } = parseActiviteiten(r.activiteiten);

  return {
    kvk_nummer: r.dossiernummer || null,
    organisatie: r.handelsnaam || null,
    sector,
    sbi_code,
    sbi_codes,
    website: r.website || null,
    adres: adres || null,
    regio: r.plaatsnaam || null,
    telefoon: r.telefoonnummer || null,
    medewerkers_raw: null,
    medewerkers_min: 0,
    activiteiten: r.activiteiten || null,
  };
}

function getBedrijven(data) {
  return data?._embedded?.bedrijf || [];
}

module.exports = { zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven };
