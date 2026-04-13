const axios = require('axios');
const cheerio = require('cheerio');
const { selecteerBestContact } = require('./contactpersoon');
const { classificeerTelefoon, extractTelefoons } = require('./telefoon');

const TEAM_PADEN = [
  '/team', '/over-ons', '/over-ons/team', '/about', '/about-us', '/about/team',
  '/mensen', '/medewerkers', '/ons-team', '/wie-zijn-wij', '/onze-mensen',
  '/founders', '/management', '/leadership', '/the-team',
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Emails die we negeren (algemeen/support)
const SKIP_EMAIL_PATTERNS = [
  /^info@/, /^contact@/, /^hello@/, /^hallo@/, /^support@/,
  /^service@/, /^admin@/, /^noreply@/, /^no-reply@/, /^mail@/,
  /^post@/, /^office@/, /^reception@/, /^secretariaat@/,
];

function isDirectEmail(email) {
  return !SKIP_EMAIL_PATTERNS.some(p => p.test(email.toLowerCase()));
}

async function fetchPagina(url, timeout = 8000) {
  try {
    const response = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IntersectBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl,en;q=0.9',
      },
      maxRedirects: 3,
    });
    return response.data;
  } catch {
    return null;
  }
}

function normaliserenUrl(website) {
  if (!website) return null;
  let url = website.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  // Verwijder trailing slash
  return url.replace(/\/$/, '');
}

function extractContactenUitHtml($, html) {
  const contacten = [];

  // Zoek naar elementen die naam + titel bevatten
  // Typische patronen: .team-member, .person, article, .card, li met p
  const selectors = [
    '.team-member', '.team__member', '.person', '.medewerker',
    '.team-card', '.member', '[class*="team"]', '[class*="person"]',
    '[class*="medewerker"]', '[class*="employee"]',
    'article', '.card',
  ];

  for (const selector of selectors) {
    $(selector).each((i, el) => {
      const tekst = $(el).text();
      const naam = extractNaam($, el);
      const titel = extractTitel($, el);

      if (naam && naam.length > 3 && naam.length < 60) {
        // Zoek telefoon naast deze persoon
        const persoonTekst = $(el).text();
        const telefoons = extractTelefoons(persoonTekst);
        const telefoon = telefoons.length
          ? classificeerTelefoon(telefoons[0], 'team')
          : null;

        // Zoek email naast deze persoon
        const emails = persoonTekst.match(EMAIL_REGEX) || [];
        const directEmail = emails.find(e => isDirectEmail(e)) || null;

        contacten.push({
          naam,
          titel: titel || null,
          email: directEmail,
          telefoon: telefoon?.opslaan ? telefoon.nummer : null,
          bron: 'teampagina',
        });
      }
    });

    if (contacten.length >= 10) break; // Genoeg gevonden
  }

  return contacten;
}

function extractNaam($, el) {
  // Probeer specifieke naam-elementen
  const naamSelectors = ['h3', 'h4', '.naam', '.name', '[class*="name"]', 'strong'];
  for (const sel of naamSelectors) {
    const tekst = $(el).find(sel).first().text().trim();
    if (tekst && tekst.length > 2 && tekst.length < 60 && /^[A-Za-zÀ-ÿ\s\-\.]+$/.test(tekst)) {
      return tekst;
    }
  }
  return null;
}

function extractTitel($, el) {
  const titelSelectors = [
    '.titel', '.title', '.functie', '.role', '.position',
    '[class*="title"]', '[class*="role"]', '[class*="functie"]',
    'p', 'span',
  ];
  for (const sel of titelSelectors) {
    const tekst = $(el).find(sel).first().text().trim();
    if (tekst && tekst.length > 2 && tekst.length < 80) {
      return tekst;
    }
  }
  return null;
}

function extractLinkedIn(html) {
  // Zoek linkedin.com/company/ URL in HTML
  const match = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9\-\_\.]+)/);
  if (match) return match[0].replace(/['">\s].*/,'');
  return null;
}

function extractAlgemeneInfo($, baseUrl) {
  const tekst = $('body').text();
  const html = $.html();

  // Emails uit de hele pagina
  const alleEmails = (html.match(EMAIL_REGEX) || [])
    .filter(e => !e.includes('.png') && !e.includes('.jpg'));
  const directEmails = alleEmails.filter(isDirectEmail);
  const algemeenEmail = alleEmails.find(e => !isDirectEmail(e)) || null;

  // Telefoons uit contactpagina (footer context = algemeen)
  const footerTekst = $('footer').text() + $('.contact').text() + $('#contact').text();
  const footerTelefoons = extractTelefoons(footerTekst);
  const contactTelefoon = footerTelefoons.length
    ? classificeerTelefoon(footerTelefoons[0], 'contact')
    : null;

  // Vacatures signaal
  const heeftVacatures =
    /vacatures?|jobs?|werken bij|careers?|join us|wij zoeken/i.test(tekst);
  const vacatureAantal = (tekst.match(/vacatures?\s*\(/g) || []).length;

  // Cultuur/event signalen op website
  const heeftCultuurSignaal =
    /teamuitje|team building|bedrijfsuitje|teamdag|personeelsfeest|klantevent|relatiedag|cultuur|beleving|ervaring/i.test(tekst);

  // Blog of nieuws aanwezig
  const heeftNieuws =
    /nieuws|blog|press|pers|updates?|artikel/i.test(tekst);

  return {
    directEmails,
    algemeenEmail,
    contactTelefoon: contactTelefoon?.opslaan ? contactTelefoon.nummer : null,
    linkedin: extractLinkedIn(html),
    heeftVacatures,
    vacatureAantal,
    heeftCultuurSignaal,
    heeftNieuws,
  };
}

async function scrapeWebsite(website) {
  const baseUrl = normaliserenUrl(website);
  if (!baseUrl) return null;

  const resultaat = {
    contacten: [],
    directEmail: null,
    algemeenEmail: null,
    telefoon: null,
    linkedin: null,
    heeftVacatures: false,
    vacatureAantal: 0,
    heeftCultuurSignaal: false,
    heeftNieuws: false,
    gescrapedPaginas: [],
  };

  // 1. Scrape homepagina voor algemene info
  const homepaginaHtml = await fetchPagina(baseUrl);
  if (!homepaginaHtml) return resultaat;

  const $home = cheerio.load(homepaginaHtml);
  const homeInfo = extractAlgemeneInfo($home, baseUrl);
  Object.assign(resultaat, {
    heeftVacatures: homeInfo.heeftVacatures,
    vacatureAantal: homeInfo.vacatureAantal,
    heeftCultuurSignaal: homeInfo.heeftCultuurSignaal,
    heeftNieuws: homeInfo.heeftNieuws,
    algemeenEmail: homeInfo.algemeenEmail,
    telefoon: homeInfo.contactTelefoon,
    linkedin: homeInfo.linkedin,
  });
  resultaat.gescrapedPaginas.push(baseUrl);

  // 2. Zoek teampagina — max 2 paden proberen
  const SNELLE_PADEN = ['/team', '/over-ons', '/about', '/mensen'];
  for (const pad of SNELLE_PADEN) {
    const teamUrl = baseUrl + pad;
    const teamHtml = await fetchPagina(teamUrl, 4000); // max 4 sec
    if (!teamHtml) continue;

    const $team = cheerio.load(teamHtml);
    const paginaTekst = $team('body').text();

    const lijktOpTeampagina =
      /\b(ceo|founder|directeur|manager|director|partner|eigenaar)\b/i.test(paginaTekst);

    if (!lijktOpTeampagina) continue;

    const contacten = extractContactenUitHtml($team, teamHtml);
    if (contacten.length) {
      resultaat.contacten = contacten;
      resultaat.gescrapedPaginas.push(teamUrl);
      const teamEmails = (teamHtml.match(EMAIL_REGEX) || []).filter(isDirectEmail);
      if (teamEmails.length) resultaat.directEmail = teamEmails[0];
      break;
    }
    break; // Max 1 teampagina proberen
  }

  // 3. Selecteer beste contact op basis van prioriteit
  resultaat.bestContact = selecteerBestContact(resultaat.contacten);

  return resultaat;
}

module.exports = { scrapeWebsite };
