const axios = require('axios');

const OVIO_KEY = process.env.OVIO_API_KEY;
const BASE = 'https://api.overheid.io/openkvk';

async function zoekBedrijvenOpenKVK({ sbiCode, gemeente, pagina = 1, size = 100 }) {
  try {
    const params = new URLSearchParams();
    params.append('size', size);
    params.append('page', pagina);
    params.append('ovio-api-key', OVIO_KEY);

    // Zoek op handelsnaam wildcard als geen specifieke filters
    // OpenKVK filters gebruiken exact deze veldnamen:
    if (sbiCode) params.append('filters[hoofdsbi]', sbiCode);
    if (gemeente) params.append('filters[plaats]', gemeente);

    // Extra velden opvragen
    ['handelsnaam','dossiernummer','plaats','straatnaam','huisnummer',
     'postcode','website','telefoonnummer','hoofdsbi','subdossiernummer'].forEach(v => {
      params.append('fields[]', v);
    });

    const url = `${BASE}?${params.toString()}`;
    console.log('[OpenKVK] URL:', url.replace(OVIO_KEY, '***'));

    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'Accept': 'application/json' }
    });

    // Log eerste resultaat om structuur te zien
    const bedrijven = response.data?._embedded?.bedrijf || [];
    if (bedrijven.length > 0) {
      console.log('[OpenKVK] Eerste resultaat:', JSON.stringify(bedrijven[0]).substring(0, 200));
    }

    return response.data;
  } catch(e) {
    console.warn(`[OpenKVK] Fout SBI:${sbiCode||'-'} ${gemeente||'NL'}: ${e.response?.status} ${e.response?.data ? JSON.stringify(e.response.data).substring(0,100) : e.message}`);
    return null;
  }
}

function parseOpenKVKBedrijf(r) {
  const straat = [r.straatnaam, r.huisnummer].filter(Boolean).join(' ');
  const adres = [straat, r.postcode, r.plaatsnaam].filter(Boolean).join(', ');
  const mw = r.werkzame_personen || null;

  return {
    kvk_nummer: r.dossiernummer || null,
    organisatie: r.handelsnaam || null,
    sector: r.sbi_omschrijving_hoofdactiviteit || null,
    sbi_code: r.sbi_hoofdactiviteit || null,
    website: r.website || null,
    adres: adres || null,
    regio: r.plaatsnaam || null,
    telefoon: r.telefoonnummer || null,
    medewerkers_raw: mw ? String(mw) : null,
    medewerkers_min: mw ? parseInt(mw) : 0,
  };
}

// Haal alle bedrijven op — response zit in _embedded.bedrijf
function getBedrijven(data) {
  return data?._embedded?.bedrijf || [];
}

module.exports = { zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven };
