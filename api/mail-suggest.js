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
    const { data: leerData } = await supabase
      .from('mail_leerdata')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    const prompt = bouwPrompt(account, mailType, user, leerData || []);

    const response = await client.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 1000,
      system: `Je bent een senior sales strateeg die werkt voor Intersect, een B2B partnerships bureau in Nederland.
Intersect koppelt bedrijven aan premium experiences en evenementen (zoals Audio Obscura) voor relatiebeheer, teambuilding en klantbinding.

Jouw taak: analyseer de VOLLEDIGE gesprekshistorie met een prospect en schrijf de meest logische volgende mail.

ANALYSE AANPAK:
1. Lees alle eerdere contactmomenten grondig door
2. Bepaal: wat is er gezegd, wat was de reactie, waar zijn ze gebleven?
3. Identificeer: zijn er openstaande vragen, bezwaren, of positieve signalen?
4. Kies de beste volgende stap op basis van deze context
5. Schrijf een mail die naadloos aansluit op het laatste contact

SCHRIJFREGELS:
- Altijd Nederlands, professioneel maar persoonlijk
- Verwijs concreet naar wat er eerder besproken is — nooit generiek
- Als er al eerder gemaild is: erken dat, bouw daarop voort
- Als er een gesprek is geweest: refereer aan wat er gezegd is
- Als er bezwaren waren: adresseer ze subtiel
- Gebruik [naam] en [bedrijf] als placeholders
- Geen standaard sales praat, echte opvolging op basis van de relatie

Geef je antwoord ALLEEN als JSON:
{
  "onderwerp": "...",
  "inhoud": "...",
  "toelichting": "Korte analyse: wat is er al gebeurd, waarom kies je voor deze aanpak nu?"
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

  delen.push(`== ACCOUNT: ${account.name} ==`);
  if (account.sector) delen.push(`Sector: ${account.sector}`);
  if (account.seg) delen.push(`Segment: ${account.seg}`);
  if (account.status) delen.push(`Status: ${account.status}`);
  if (account.pipe) delen.push(`Pipeline fase: ${account.pipe}`);
  if (account.web) delen.push(`Website: ${account.web}`);

  if (account.cf || account.cl) {
    delen.push(`\n== CONTACTPERSOON ==`);
    delen.push(`Naam: ${[account.cf, account.cl].filter(Boolean).join(' ')}`);
    if (account.cr) delen.push(`Functie: ${account.cr}`);
    if (account.ce) delen.push(`Email: ${account.ce}`);
  }

  // Extra contactpersonen
  if (account.contacts && account.contacts.length > 0) {
    delen.push(`\n== OVERIGE CONTACTPERSONEN ==`);
    account.contacts.forEach(c => {
      const naam = [c.first, c.last].filter(Boolean).join(' ');
      delen.push(`- ${naam}${c.role ? ' ('+c.role+')' : ''}${c.email ? ' — '+c.email : ''}`);
    });
  }

  if (account.note) {
    delen.push(`\n== ACHTERGROND / HAAKJE ==`);
    delen.push(account.note);
  }

  // Volledige communicatiehistorie — gesorteerd van oud naar nieuw
  const notes = (account.notes || []).sort((a, b) => a.id - b.id);
  if (notes.length > 0) {
    delen.push(`\n== VOLLEDIGE COMMUNICATIEHISTORIE (chronologisch, ${notes.length} contactmomenten) ==`);
    delen.push(`Lees dit zorgvuldig — dit bepaalt wat de juiste volgende stap is.\n`);

    const typeLabels = {
      notitie: 'Notitie', gesprek: 'Telefoongesprek', email: 'E-mail', voicemail: 'Voicemail',
      mailshot: 'Mailshot verstuurd', opvolg_mailshot: 'Opvolg mailshot verstuurd',
      linkshot: 'LinkedIn bericht', whatsapp: 'WhatsApp', taak: 'Taak', directe_mail: 'Directe mail'
    };

    notes.forEach((n, i) => {
      const door = n.by === 'MA' ? 'Mees' : n.by === 'JK' ? 'Julian' : n.by;
      delen.push(`--- Contact ${i+1}: ${typeLabels[n.type] || n.type} | ${n.time} | Door: ${door}${n.contact ? ' | Met: '+n.contact : ''} ---`);

      // Chat berichten (WhatsApp/LinkedIn)
      if (n.chat && n.chat.length > 0) {
        n.chat.forEach(b => {
          const van = b.van === 'MA' ? 'Mees' : b.van === 'JK' ? 'Julian' : b.van;
          delen.push(`  ${van}: "${b.tekst}"`);
        });
      } else if (n.text) {
        delen.push(`  Inhoud: ${n.text}`);
      }
    });

    const mailshots = notes.filter(n => n.type === 'mailshot' || n.type === 'opvolg_mailshot').length;
    const gesprekken = notes.filter(n => n.type === 'gesprek').length;
    const whatsapps = notes.filter(n => n.type === 'whatsapp' || n.type === 'linkshot').length;
    const laatste = notes[notes.length - 1];
    delen.push(`\nSamenvatting: ${notes.length}x contact — ${mailshots}x mail, ${gesprekken}x gesprek, ${whatsapps}x chat`);
    delen.push(`Laatste contact: ${laatste.time} via ${typeLabels[laatste.type] || laatste.type}`);
  } else {
    delen.push(`\n== COMMUNICATIEHISTORIE ==`);
    delen.push(`Nog geen eerdere contactmomenten gelogd. Dit is het eerste contact.`);
  }

  // Deals
  if (account.deals && account.deals.length > 0) {
    delen.push(`\n== DEALS / KANSEN ==`);
    account.deals.forEach(d => {
      delen.push(`Deal: ${d.name} | Fase: ${d.stage} | Waarde: €${d.val || 0}`);
      if (d.note) delen.push(`  Notitie: ${d.note}`);
    });
  }

  // Leerdata
  const relevanteAanpassingen = leerData.filter(l =>
    l.fase === 'aangepast' && (l.account_id === account.id || l.mail_type === mailType)
  );
  if (relevanteAanpassingen.length > 0) {
    delen.push(`\n== WAT EERDER WERD AANGEPAST (leer hiervan) ==`);
    relevanteAanpassingen.slice(0, 8).forEach(l => {
      if (l.aanpassing_notitie) delen.push(`- ${l.aanpassing_notitie}`);
    });
  }

  delen.push(`\n== VERZENDER ==`);
  delen.push(`Mail wordt verstuurd door: ${user === 'MA' ? 'Mees Arentsen' : 'Julian Kanhai'}`);

  delen.push(`\n== OPDRACHT ==`);
  const typeInstructies = {
    mailshot: 'Schrijf een eerste kennismakingsmail op basis van het haakje. Wees nieuwsgierigmakend, niet te lang. Als er toch al eerder contact is geweest, verwerk dat.',
    opvolg_mailshot: 'Schrijf een opvolg mail. ANALYSEER de eerdere contactmomenten: wat is er gezegd, wat was de reactie, wat is de meest logische volgende stap? Bouw concreet voort op wat er al is besproken.',
    directe_mail: 'Schrijf een directe persoonlijke mail. Analyseer de volledige context en bepaal de beste aanpak op basis van waar de relatie nu staat.',
  };
  delen.push(typeInstructies[mailType] || 'Analyseer de volledige context en schrijf de meest logische volgende mail.');
  delen.push(`\nBelangrijk: als er al contact is geweest, moet de mail daar CONCREET op voortbouwen. Verwijs naar specifieke dingen die zijn besproken. Niet generiek.`);

  return delen.join('\n');
}
