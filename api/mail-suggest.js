// /api/mail-suggest
// Genereert een gepersonaliseerde mail suggestie op basis van volledige account context
// en leert van wat Mees en Julian aanpassen

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { account, mailType, user } = req.body;

  if (!account) return res.status(400).json({ error: 'Account context verplicht' });

  try {
    // Haal leerdata op uit Supabase
    const { data: leerData } = await supabase
      .from('mail_leerdata')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    const prompt = bouwPrompt(account, mailType, user, leerData || []);

    const response = await client.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 800,
      system: `Je bent een sales expert die werkt voor Intersect, een B2B partnerships bureau in Nederland. 
Je schrijft gepersonaliseerde sales mails namens Mees Arentsen of Julian Kanhai.

Intersect verkoopt B2B partnerships — denk aan premium evenementen (zoals Audio Obscura), netwerkmogelijkheden en zakelijke ervaringen die bedrijven kunnen inzetten voor relatiebeheer, teambuilding of klantbinding.

Schrijfstijl:
- Altijd in het Nederlands
- Professioneel maar persoonlijk, niet te formeel
- Kort en to-the-point — geen lange lappen tekst
- Altijd een specifiek haakje of reden voor contact
- Geen standaard sales praat, echte verbinding maken
- Gebruik [naam] voor de contactpersoon en [bedrijf] voor het bedrijf

Geef je antwoord ALLEEN als JSON in dit formaat:
{
  "onderwerp": "...",
  "inhoud": "...",
  "toelichting": "Waarom deze aanpak..."
}`,
      messages: [{ role: 'user', content: prompt }],
    });

    const tekst = response.content[0]?.text?.trim() || '';
    let suggestie;
    try {
      const clean = tekst.replace(/```json|```/g, '').trim();
      suggestie = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Kon suggestie niet parsen', raw: tekst });
    }

    // Sla op dat er een suggestie is gegenereerd (voor leerdata)
    await supabase.from('mail_leerdata').insert({
      account_id: account.id,
      account_naam: account.name,
      mail_type: mailType,
      user_id: user,
      fase: 'suggestie_gegenereerd',
      suggestie_onderwerp: suggestie.onderwerp,
      suggestie_inhoud: suggestie.inhoud,
      created_at: new Date().toISOString(),
    });

    return res.json({ suggestie });

  } catch (err) {
    console.error('[Mail Suggest]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function bouwPrompt(account, mailType, user, leerData) {
  const delen = [];

  // Account basis info
  delen.push(`== ACCOUNT INFO ==`);
  delen.push(`Naam: ${account.name}`);
  if (account.sector) delen.push(`Sector: ${account.sector}`);
  if (account.seg) delen.push(`Segment: ${account.seg}`);
  if (account.status) delen.push(`Status: ${account.status}`);
  if (account.pipe) delen.push(`Pipeline fase: ${account.pipe}`);
  if (account.web) delen.push(`Website: ${account.web}`);
  if (account.added) delen.push(`Toegevoegd: ${account.added}`);

  // Contactpersoon
  if (account.cf || account.cl) {
    delen.push(`\n== CONTACTPERSOON ==`);
    delen.push(`Naam: ${[account.cf, account.cl].filter(Boolean).join(' ')}`);
    if (account.cr) delen.push(`Functie: ${account.cr}`);
    if (account.ce) delen.push(`Email: ${account.ce}`);
  }

  // Notitie / haakje uit scraper
  if (account.note) {
    delen.push(`\n== HAAKJE / SCRAPER NOTITIE ==`);
    delen.push(account.note);
  }

  // Alle activiteit en notities
  if (account.notes && account.notes.length > 0) {
    delen.push(`\n== VOLLEDIGE COMMUNICATIEHISTORIE (${account.notes.length} items) ==`);
    const typeLabels = {
      notitie: 'Notitie', gesprek: 'Gesprek', email: 'Email', voicemail: 'Voicemail',
      mailshot: 'Mailshot', opvolg_mailshot: 'Opvolg Mailshot', linkshot: 'LinkedIn bericht',
      whatsapp: 'WhatsApp', taak: 'Taak', directe_mail: 'Directe mail'
    };
    account.notes.forEach(n => {
      delen.push(`[${typeLabels[n.type] || n.type}] ${n.time} (${n.by}): ${n.text}`);
    });

    // Statistieken
    const aantalContact = account.notes.length;
    const mailshots = account.notes.filter(n => n.type === 'mailshot' || n.type === 'opvolg_mailshot').length;
    const gesprekken = account.notes.filter(n => n.type === 'gesprek').length;
    delen.push(`\nContact statistieken: ${aantalContact}x totaal, ${mailshots}x mail, ${gesprekken}x gesprek`);
  }

  // Deals en kansen
  if (account.deals && account.deals.length > 0) {
    delen.push(`\n== DEALS / KANSEN ==`);
    account.deals.forEach(d => {
      delen.push(`Deal: ${d.name} | Fase: ${d.stage} | Waarde: €${d.val || 0} | Kans: ${d.prob || 50}%`);
      if (d.note) delen.push(`  Notitie: ${d.note}`);
    });
  }

  // Offertes
  if (account.proposals && account.proposals.length > 0) {
    delen.push(`\n== OFFERTES ==`);
    account.proposals.forEach(p => {
      delen.push(`Offerte: ${p.title} | Status: ${p.stat} | Verstuurd: ${p.date || '?'}`);
    });
  }

  // Leerdata — wat hebben Mees/Julian eerder aangepast?
  const relevanteAanpassingen = leerData.filter(l =>
    l.fase === 'aangepast' && (l.account_id === account.id || l.mail_type === mailType)
  );
  if (relevanteAanpassingen.length > 0) {
    delen.push(`\n== WAT MEES/JULIAN EERDER AANPASTEN (leer hiervan) ==`);
    relevanteAanpassingen.slice(0, 10).forEach(l => {
      if (l.aanpassing_notitie) delen.push(`- ${l.aanpassing_notitie}`);
    });
  }

  // Verzender
  delen.push(`\n== VERZENDER ==`);
  delen.push(`Mail wordt verstuurd door: ${user === 'MA' ? 'Mees Arentsen' : 'Julian Kanhai'}`);

  // Mail type instructie
  delen.push(`\n== OPDRACHT ==`);
  const typeInstructies = {
    mailshot: 'Schrijf een eerste kennismakingsmail. Maak gebruik van het haakje. Wees nieuwsgierigmakend, niet te lang.',
    opvolg_mailshot: 'Schrijf een opvolg mail op een eerdere mailshot. Verwijs subtiel naar de vorige mail. Geef een nieuwe reden om te reageren.',
    directe_mail: 'Schrijf een directe persoonlijke mail op basis van de context. Passend bij de relatie die al is opgebouwd.',
  };
  delen.push(typeInstructies[mailType] || 'Schrijf een passende mail op basis van de context.');

  return delen.join('\n');
}
