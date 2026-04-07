// Prioriteitslijst voor contactpersonen
// Hoe lager het getal, hoe hoger de prioriteit
const PRIORITEIT_TITELS = [
  {
    prioriteit: 1,
    trefwoorden: [
      'founder', 'co-founder', 'cofounder',
      'ceo', 'chief executive',
      'owner', 'eigenaar',
      'oprichter', 'mede-oprichter',
      'directeur-eigenaar',
    ],
  },
  {
    prioriteit: 2,
    trefwoorden: [
      'algemeen directeur', 'managing director', 'md',
      'partner',
      'commercieel directeur', 'commercial director',
      'cco', 'chief commercial officer',
      'directeur',
    ],
  },
  {
    prioriteit: 3,
    trefwoorden: [
      'sales director', 'head of sales', 'sales manager',
      'business development', 'bd manager', 'bd director',
      'cso', 'chief sales officer',
    ],
  },
  {
    prioriteit: 4,
    trefwoorden: [
      'cmo', 'chief marketing officer',
      'marketing director', 'head of marketing',
      'partnership manager', 'head of partnerships',
      'partnerships director',
      'client director', 'account director',
    ],
  },
];

function bepaalPrioriteit(titel) {
  if (!titel) return null;
  const lager = titel.toLowerCase().trim();

  for (const niveau of PRIORITEIT_TITELS) {
    for (const trefwoord of niveau.trefwoorden) {
      if (lager.includes(trefwoord)) {
        return niveau.prioriteit;
      }
    }
  }
  return null; // Titel gevonden maar niet in prioriteitslijst
}

// Sorteert een lijst contactpersonen op prioriteit
// en geeft de beste terug
function selecteerBestContact(contacten) {
  if (!contacten || !contacten.length) return null;

  const metPrioriteit = contacten
    .map(c => ({ ...c, prioriteit: bepaalPrioriteit(c.titel) }))
    .filter(c => c.prioriteit !== null)
    .sort((a, b) => a.prioriteit - b.prioriteit);

  if (metPrioriteit.length) return metPrioriteit[0];

  // Geen prioriteitstitel gevonden maar er zijn wel contacten
  // Geef degene terug zonder prioriteit maar wel met een titel
  return contacten.find(c => c.titel) || contacten[0];
}

module.exports = { bepaalPrioriteit, selecteerBestContact, PRIORITEIT_TITELS };
