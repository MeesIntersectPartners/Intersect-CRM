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
  '6201', '6202', '6209', // Software ontwikkeling en advies
  '70', // Holdings en managementadvies
  '7010', '7021', '7022', // Management consulting
  '73', // Reclame en marktonderzoek
  '7311', '7312', '7320', // Reclame en marktonderzoek
  '74', // Overige gespecialiseerde zakelijke diensten
  '7410', '7420', '7430', // Design, fotografie, vertaling
  '69', // Juridische en accountancydiensten
  '6910', '6920', // Juridisch en accountancy
  '78', // Arbeidsbemiddeling en uitzendbureaus (recruitment)
  '7810', '7820', '7830',
  '58', '59', '60', // Uitgeverijen en media
  '90', '91', // Kunst en cultuur
  '9001', '9002', '9003', '9004', // Podiumkunsten, evenementen
];

// SBI-codes die we expliciet overslaan — ruimer dan voorheen
const SKIP_SBI = [
  '86', '87', '88', // Zorg en welzijn
  '84', // Overheid
  '41', '42', '43', // Bouw
  '01', '02', '03', // Landbouw
  '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', // Productie-industrie
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', // Maakindustrie
  '35', '36', '37', '38', '39', // Energie en afval
  '45', '46', '47', // Handel
  '49', '50', '51', '52', '53', // Transport en logistiek
  '55', // Hotels
  '56', // Horeca / restaurants
  '75', // Veterinaire diensten
  '77', // Verhuur
  '80', '81', // Beveiliging en facility
  '85', // Onderwijs
  '93', // Sport en recreatie
  '94', '95', '96', // Verenigingen, reparatie, persoonlijke diensten
  '97', '98', '99', // Huishoudens en extraterritoriale organisaties
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

// Segment bepalen op basis van SBI code
function bepaalSegment(sbiCodes) {
  const codes = sbiCodes.map(s => String(s.sbiCode || s));
  if (codes.some(c => c.startsWith('62') || c.startsWith('63'))) return 'IT / Software';
  if (codes.some(c => c.startsWith('73'))) return 'Marketing & Communicatie';
  if (codes.some(c => c.startsWith('78'))) return 'HR & Recruitment';
  if (codes.some(c => c.startsWith('70') || c.startsWith('71'))) return 'Consultancy';
  if (codes.some(c => c.startsWith('69'))) return 'Finance & Legal';
  if (codes.some(c => c.startsWith('74'))) return 'Zakelijke dienstverlening';
  if (codes.some(c => c.startsWith('58') || c.startsWith('59') || c.startsWith('60'))) return 'Media & Uitgeverij';
  if (codes.some(c => c.startsWith('90') || c.startsWith('91'))) return 'Events & Cultuur';
  if (codes.some(c => c.startsWith('64') || c.startsWith('65') || c.startsWith('66'))) return 'Finance';
  if (codes.some(c => c.startsWith('68'))) return 'Vastgoed';
  return '';
}

function parseBedrijf(result, profiel) {
  const adresObj = profiel?.adressen?.[0] || {};
  const sbiCodes = profiel?.sbiActiviteiten || result?.sbiActiviteiten || [];

  // Adres netjes opbouwen
  const straat = adresObj.straatnaam || '';
  const huisnr = adresObj.huisnummer ? String(adresObj.huisnummer) : '';
  const toevoeging = adresObj.huisnummerToevoeging || '';
  const postcode = adresObj.postcode || '';
  const plaats = adresObj.plaats || result.adres?.binnenlandsAdres?.plaats || '';
  const straatHuis = [straat, huisnr + toevoeging].filter(Boolean).join(' ');
  const adres = [straatHuis, postcode, plaats].filter(Boolean).join(', ');

  return {
    kvk_nummer: result.kvkNummer,
    organisatie: result.naam || profiel?.naam,
    sector: sbiCodes[0]?.sbiOmschrijving || null,
    segment: bepaalSegment(sbiCodes),
    sbi_codes: sbiCodes.map(s => s.sbiCode),
    website: profiel?.websites?.[0] || null,
    adres: adres || null,
    regio: plaats || null,
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
  bepaalSegment,
};
