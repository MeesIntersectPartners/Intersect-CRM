const axios = require('axios');

const KVK_BASE = 'https://api.kvk.nl/api/v2';

// Gemeenten in Zuid-Holland
const GEMEENTEN = [
  'Rotterdam', 'Den Haag', 'Delft', 'Dordrecht', 'Leiden',
  'Zoetermeer', 'Gouda', 'Schiedam', 'Capelle aan den IJssel',
  'Barendrecht', 'Ridderkerk', 'Vlaardingen', 'Pijnacker',
  'Lansingerland', 'Westland', 'Nissewaard', 'Alphen aan den Rijn'
];

// SBI-codes die interessant zijn voor Audio Obscura B2B
// (tech, marketing, finance, consultancy, media, HR, events)
const INTERESSANTE_SBI = [
  '62', // IT-diensten / software
  '63', // Informatie- en communicatiediensten
  '70', // Holdings en managementadvies
  '71', // Architecten en technisch adviesbureaus
  '73', // Reclame en marktonderzoek
  '74', // Overige gespecialiseerde zakelijke diensten
  '69', // Juridische en accountancydiensten
  '64', '65', '66', // Financiële diensten
  '78', // Arbeidsbemiddeling en uitzendbureaus
  '82', // Administratieve en ondersteunende diensten
  '58', '59', '60', // Uitgeverijen en media
  '68', // Vastgoed
  '56', // Eet- en drinkgelegenheden (upscale horeca/events)
  '90', '91', '93', // Kunst, cultuur, sport en recreatie
];

// SBI-codes die we expliciet overslaan
const SKIP_SBI = [
  '86', '87', '88', // Zorg en welzijn
  '84', // Overheid
  '41', '42', '43', // Bouw
  '01', '02', '03', // Landbouw
  '10', '11', '12', '13', '14', '15', '16', // Voedsel- en productie-industrie
  '49', '50', '51', '52', '53', // Transport en logistiek
  '85', // Onderwijs (scholen etc.)
  '94', '95', '96', // Verenigingen, reparatie, overige persoonlijke diensten
];

async function zoekBedrijven(gemeente, pagina = 1) {
  try {
    const response = await axios.get(`${KVK_BASE}/zoeken`, {
      headers: { apikey: process.env.KVK_API_KEY },
      params: {
        plaats: gemeente,
        type: 'hoofdvestiging',
        resultatenPerPagina: 100,
        pagina,
        InclusiefInactieveRegistraties: false,
      },
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    console.error(`[KvK] Fout bij zoeken in ${gemeente}:`, err.message);
    return null;
  }
}

async function getBedrijfsProfiel(kvkNummer) {
  try {
    const response = await axios.get(`${KVK_BASE}/basisprofielen/${kvkNummer}`, {
      headers: { apikey: process.env.KVK_API_KEY },
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    console.error(`[KvK] Fout bij profiel ${kvkNummer}:`, err.message);
    return null;
  }
}

function parseMedewerkers(aantalStr) {
  if (!aantalStr) return 0;
  // KvK geeft bijv. "10 tot 50" terug
  const match = aantalStr.match(/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

function isSBIInteressant(sbiCodes = []) {
  if (!sbiCodes.length) return true; // geen SBI = niet filteren

  const codes = sbiCodes.map(s => String(s.sbiCode || s));

  // Check of een van de skip codes matcht
  const isSkip = codes.some(code =>
    SKIP_SBI.some(skip => code.startsWith(skip))
  );
  if (isSkip) return false;

  // Check of een van de interessante codes matcht
  const isInteressant = codes.some(code =>
    INTERESSANTE_SBI.some(int => code.startsWith(int))
  );

  return isInteressant;
}

function parseBedrijf(result, profiel) {
  const adres = profiel?.adressen?.[0] || {};
  const sbiCodes = profiel?.sbiActiviteiten || result?.sbiActiviteiten || [];

  return {
    kvk_nummer: result.kvkNummer,
    organisatie: result.naam || profiel?.naam,
    sector: sbiCodes[0]?.sbiOmschrijving || null,
    sbi_codes: sbiCodes.map(s => s.sbiCode),
    website: profiel?.websites?.[0] || null,
    regio: adres.plaats || result.adres?.binnenlandsAdres?.plaats || null,
    medewerkers_raw: profiel?.aantalMedewerkers || null,
    medewerkers_min: parseMedewerkers(profiel?.aantalMedewerkers),
    opgericht: profiel?.datumOprichting
      ? parseInt(String(profiel.datumOprichting).substring(0, 4))
      : null,
    rechtsvorm: profiel?.rechtsvorm || null,
  };
}

module.exports = {
  GEMEENTEN,
  zoekBedrijven,
  getBedrijfsProfiel,
  isSBIInteressant,
  parseBedrijf,
};
