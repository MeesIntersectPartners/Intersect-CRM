const axios = require('axios');

const OVIO_KEY = process.env.OVIO_API_KEY;
const BASE = 'https://api.overheid.io/openkvk';

// OpenKVK ondersteunt geen filters[] — gebruik query parameter
async function zoekBedrijvenOpenKVK({ gemeente, pagina = 1, size = 100 }) {
  try {
    const params = new URLSearchParams();
    params.append('size', size);
    params.append('page', pagina);
    params.append('ovio-api-key', OVIO_KEY);

    // Zoek op plaatsnaam via query — geen queryfields beperking
    if (gemeente) params.append('query', gemeente);

    // Vraag extra velden op
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

function parseOpenKVKBedrijf(r) {
  const straat = [r.straatnaam, r.huisnummer].filter(Boolean).join(' ');
  const adres = [straat, r.postcode, r.plaatsnaam].filter(Boolean).join(', ');

  return {
    kvk_nummer: r.dossiernummer || null,
    organisatie: r.handelsnaam || null,
    sector: null, // Komt uit activiteiten
    sbi_code: null,
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
