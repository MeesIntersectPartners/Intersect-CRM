const axios = require('axios');

const OVIO_KEY = process.env.OVIO_API_KEY;
const BASE = 'https://api.overheid.io/openkvk';

// BELANGRIJK: fields[] wordt genegeerd door de OpenKVK API — alleen standaardvelden
// (huisnummer, postcode, dossiernummer, handelsnaam, _links) komen terug.
// Pre-filtering gebeurt daarom via query="<zoekwoord> <gemeente>".
async function zoekBedrijvenOpenKVK({ gemeente, zoekwoord = '', pagina = 1, size = 100 }) {
  try {
    const params = new URLSearchParams();
    params.append('size', size);
    params.append('page', pagina);
    params.append('ovio-api-key', OVIO_KEY);

    // Combineer zoekwoord + gemeente — dit is de enige werkende filter
    const queryDelen = [zoekwoord, gemeente].filter(Boolean);
    if (queryDelen.length) params.append('query', queryDelen.join(' '));

    const url = `${BASE}?${params.toString()}`;
    const response = await axios.get(url, { timeout: 15000 });
    const bedrijven = response.data?._embedded?.bedrijf || [];
    if (bedrijven.length > 0) {
      console.log('[OpenKVK] Velden ontvangen:', Object.keys(bedrijven[0]).join(', '));
    }
    return response.data;
  } catch(e) {
    console.warn(`[OpenKVK] Fout "${zoekwoord} ${gemeente}": ${e.response?.status || e.message}`);
    return null;
  }
}

function parseOpenKVKBedrijf(r) {
  const straat = [r.straatnaam, r.huisnummer].filter(Boolean).join(' ');
  const adres = [straat, r.postcode, r.plaatsnaam].filter(Boolean).join(', ');

  // Activiteiten — API geeft dit zelden terug, maar parsen als het er is
  const activiteiten = Array.isArray(r.activiteiten) ? r.activiteiten : [];
  const sbiCodes = activiteiten
    .map(a => a.sbicode || a.sbi_code || a.code || null)
    .filter(Boolean).map(String);
  const hoofd = activiteiten.find(a => a.isHoofdactiviteit || a.is_hoofdactiviteit);
  const sectorBron = hoofd || activiteiten[0] || null;
  const sector = sectorBron
    ? (sectorBron.sbiomschrijving || sectorBron.omschrijving || null)
    : null;

  return {
    kvk_nummer:      r.dossiernummer  || null,
    organisatie:     r.handelsnaam    || null,
    sector,
    sbi_code:        sbiCodes[0]      || null,
    sbi_codes:       sbiCodes,
    website:         r.website        || null,
    adres:           adres            || null,
    regio:           r.plaatsnaam     || null,
    telefoon:        r.telefoonnummer || null,
    medewerkers_raw: null,
    medewerkers_min: 0,
  };
}

function getBedrijven(data) {
  return data?._embedded?.bedrijf || [];
}

module.exports = { zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven };
