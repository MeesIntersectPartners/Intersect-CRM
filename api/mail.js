// /api/mail
// GET  → haal recente emails op
// POST → stuur een email

const { getMails, sendMail, markeerGelezen, refreshToken } = require('../../lib/microsoft');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

async function getTokens(supabase, userEmail) {
  const { data, error } = await supabase
    .from('microsoft_tokens')
    .select('*')
    .eq('user_email', userEmail)
    .single();

  if (error || !data) throw new Error('Geen tokens gevonden voor ' + userEmail);

  // Check of token verlopen is
  const verlooptBinnenkort = new Date(data.expires_at) < new Date(Date.now() + 5 * 60 * 1000);
  if (verlooptBinnenkort) {
    const nieuw = await refreshToken(data.refresh_token);
    const { error: updErr } = await supabase
      .from('microsoft_tokens')
      .update({
        access_token: nieuw.access_token,
        refresh_token: nieuw.refresh_token || data.refresh_token,
        expires_at: new Date(Date.now() + nieuw.expires_in * 1000).toISOString(),
      })
      .eq('user_email', userEmail);
    if (updErr) console.warn('[Mail] Token update fout:', updErr);
    return { ...data, access_token: nieuw.access_token };
  }

  return data;
}

// Vat een email samen via Claude
async function vatSamen(onderwerp, inhoud) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Vat deze email in maximaal 2 korte zinnen samen in het Nederlands. Alleen de samenvatting, geen inleiding.\n\nOnderwerp: ${onderwerp}\n\nInhoud: ${inhoud.substring(0, 1000)}`,
      }],
    });
    return res.content[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const userEmail = req.headers['x-user-email'];

  if (!userEmail) return res.status(401).json({ error: 'x-user-email header verplicht' });

  try {
    const tokens = await getTokens(supabase, userEmail);

    if (req.method === 'GET') {
      const { dagen = 7 } = req.query;
      const mails = await getMails(tokens.access_token, parseInt(dagen));

      // Voeg samenvatting toe aan elke mail
      const metSamenvatting = await Promise.all(mails.map(async mail => {
        const samenvatting = await vatSamen(mail.subject, mail.body?.content || mail.bodyPreview);
        return {
          id: mail.id,
          onderwerp: mail.subject,
          van: mail.from?.emailAddress?.address,
          van_naam: mail.from?.emailAddress?.name,
          datum: mail.receivedDateTime,
          preview: mail.bodyPreview,
          samenvatting,
          gelezen: mail.isRead,
        };
      }));

      return res.json({ mails: metSamenvatting });
    }

    if (req.method === 'POST') {
      const { aan, onderwerp, inhoud, cc, log_acc_id } = req.body;

      if (!aan || !onderwerp || !inhoud) {
        return res.status(400).json({ error: 'aan, onderwerp en inhoud zijn verplicht' });
      }

      await sendMail(tokens.access_token, { aan, onderwerp, inhoud, cc });

      // Log als activiteit in Supabase als acc_id meegegeven
      if (log_acc_id) {
        const samenvatting = await vatSamen(onderwerp, inhoud);
        await supabase.from('notes').insert({
          account_id: log_acc_id,
          type: 'mailshot',
          text: samenvatting || `Email verstuurd: ${onderwerp}`,
          by: userEmail,
          time: new Date().toLocaleString('nl-NL'),
          created_at: new Date().toISOString(),
        });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[Mail API]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
