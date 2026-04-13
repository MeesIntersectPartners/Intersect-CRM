const axios = require('axios');

const OVIO_KEY = process.env.OVIO_API_KEY;
const BASE = 'https://api.overheid.io/openkvk';

async function zoekBedrijvenOpenKVK({ sbiCode, gemeente, pagina = 1, size = 100 }) {
  try {
    // Bouw query params — overheid.io gebruikt arrays als filters[]
    const queryParts = [
      `size=${size}`,
      `page=${pagina}`,
      `ovio-api-key=${OVIO_KEY}`,
    ];

    if (sbiCode) queryParts.push(`filters[sbi_hoofdactiviteit]=${encodeURIComponent(sbiCode)}`);
    if (gemeente) queryParts.push(`filters[plaatsnaam]=${encodeURIComponent(gemeente)}`);

    // Vraag nuttige velden op
    const velden = ['handelsnaam','dossiernummer','plaatsnaam','straatnaam',
      'huisnummer','postcode','website','telefoonnummer',
      'sbi_hoofdactiviteit','sbi_omschrijving_hoofdactiviteit','werkzame_personen'];
    velden.forEach(v => queryParts.push(`fields[]=${v}`));

    const url = `${BASE}?${queryParts.join('&')}`;
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'Accept': 'application/json' }
    });
    return response.data;
  } catch(e) {
    console.warn(`[OpenKVK] Fout SBI:${sbiCode||'-'} ${gemeente||'NL'}: ${e.response?.status||e.message}`);
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
