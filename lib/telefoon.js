// Classificeert telefoonnummers als direct, algemeen of onbekend

function normaliseerTelefoon(nummer) {
  if (!nummer) return null;
  // Verwijder spaties, haakjes, streepjes
  return nummer.replace(/[\s\-().]/g, '').replace(/^00/, '+');
}

function isMobiel(nummer) {
  const norm = normaliseerTelefoon(nummer);
  if (!norm) return false;
  // 06, +316, 0031 6
  return /^(06|^\+316|^00316)/.test(norm);
}

function isNederlandsVast(nummer) {
  const norm = normaliseerTelefoon(nummer);
  if (!norm) return false;
  return /^(0[1-9][0-9]|^\+31[1-9]|^0031[1-9])/.test(norm);
}

// context: 'team' = gevonden naast een naam op teampagina
//          'contact' = gevonden op contactpagina of footer
//          'algemeen' = gevonden als algemeen nummer
function classificeerTelefoon(nummer, context = 'onbekend') {
  if (!nummer) return null;

  if (isMobiel(nummer)) {
    return {
      nummer: formatTelefoon(nummer),
      type: 'direct_mobiel',
      opslaan: true,
    };
  }

  if (isNederlandsVast(nummer)) {
    if (context === 'team') {
      return {
        nummer: formatTelefoon(nummer),
        type: 'vermoedelijk_direct',
        opslaan: true,
      };
    }
    // Op contactpagina of footer = algemeen → niet opslaan
    return {
      nummer: formatTelefoon(nummer),
      type: 'algemeen',
      opslaan: false,
    };
  }

  return null;
}

function formatTelefoon(nummer) {
  const norm = normaliseerTelefoon(nummer);
  if (!norm) return nummer;

  // 06XXXXXXXX → 06-XXXX XXXX
  if (/^06/.test(norm)) {
    return norm.replace(/^(06)(\d{4})(\d{4})$/, '$1-$2 $3');
  }
  // 010XXXXXXX → 010-XXX XXXX
  if (/^0(10|20|30|33|40|43|45|50|53|55|58|70|73|74|75|76|77|78|79|88)/.test(norm)) {
    return norm.replace(/^(0\d{2})(\d{3})(\d{4})$/, '$1-$2 $3');
  }
  return nummer;
}

// Extraheer alle telefoonnummers uit een stuk tekst
function extractTelefoons(tekst) {
  if (!tekst) return [];
  const regex = /(\+?[0-9][0-9\s\-().]{7,}[0-9])/g;
  const matches = tekst.match(regex) || [];
  return matches
    .map(m => m.trim())
    .filter(m => m.replace(/\D/g, '').length >= 9)
    .filter(m => m.replace(/\D/g, '').length <= 12);
}

module.exports = {
  classificeerTelefoon,
  extractTelefoons,
  isMobiel,
  formatTelefoon,
};
