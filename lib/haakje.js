const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PARTNER_NAAM = process.env.PARTNER_NAAM || 'Audio Obscura';
const PARTNER_OMSCHRIJVING = process.env.PARTNER_OMSCHRIJVING ||
  'Immersive audio-visuele beleving, geschikt als premium relatiegeschenk, teamuitje of klantervaring';

async function genereerHaakje(bedrijf, scrapeData, signaalData) {
  const context = bouwContext(bedrijf, scrapeData, signaalData);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 300,
      system: `Je bent een B2B sales researcher voor ${PARTNER_NAAM}. 
${PARTNER_OMSCHRIJVING}.

Jouw taak: schrijf een beknopte, persoonlijke notitie (max 2 zinnen) die een verkoper direct kan gebruiken als gespreksstarter. 
De notitie moet:
- Een specifiek haakje bevatten dat je uit de gegeven data hebt gehaald (geen generieke tekst)
- Kort zijn — max 2 zinnen
- In het Nederlands zijn
- Duidelijk maken waarom dit bedrijf interessant is voor ${PARTNER_NAAM}
- Niet beginnen met de bedrijfsnaam

Als er geen sterk haakje is: schrijf dan "Onvoldoende signalen — handmatige review nodig".`,

      messages: [{
        role: 'user',
        content: `Bedrijfsinfo:\n${context}\n\nSchrijf de notitie:`,
      }],
    });

    return response.content[0]?.text?.trim() || null;
  } catch (err) {
    console.error('[Haakje] Claude API fout:', err.message);
    return null;
  }
}

function bouwContext(bedrijf, scrapeData, signaalData) {
  const delen = [];

  delen.push(`Naam: ${bedrijf.organisatie}`);
  if (bedrijf.sector) delen.push(`Sector: ${bedrijf.sector}`);
  if (bedrijf.medewerkers_raw) delen.push(`Medewerkers: ${bedrijf.medewerkers_raw}`);
  if (bedrijf.opgericht) delen.push(`Opgericht: ${bedrijf.opgericht}`);
  if (bedrijf.regio) delen.push(`Regio: ${bedrijf.regio}`);

  if (signaalData?.signalen?.length) {
    delen.push('\nGevonden signalen:');
    for (const s of signaalData.signalen) {
      delen.push(`- [${s.type}] ${s.beschrijving}`);
      if (s.snippet) delen.push(`  Snippet: "${s.snippet}"`);
    }
  }

  if (scrapeData?.heeftVacatures) {
    delen.push(`\nActief aan het werven (${scrapeData.vacatureAantal || 'meerdere'} vacatures)`);
  }

  if (scrapeData?.heeftCultuurSignaal) {
    delen.push('Bedrijf communiceert over beleving/cultuur op website');
  }

  return delen.join('\n');
}

module.exports = { genereerHaakje };
