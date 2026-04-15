// /api/mail
// GET  → haal recente emails op
// POST → stuur een email

const { getMails, sendMail, markeerGelezen, refreshToken } = require('../lib/microsoft');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

async function getTokens(supabase, userEmail) {
  const { data, error } = await supabase
    .from('microsoft_tokens')
    .select('*')
    .eq('user_email', userEmail)
    .single();

  if (error || !data) throw new Error('Geen tokens gevonden voor ' + userEmail);

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

async function vatSamen(onderwerp, inhoud) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
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

// Zet platte tekst om naar HTML — behoudt alinea's en regelafbrekingen
function tekstNaarHtml(inhoud) {
  if (!inhoud) return '';
  // Als er al HTML in zit, niet dubbel converteren
  if (inhoud.includes('<p>') || inhoud.includes('<br') || inhoud.includes('<div')) return inhoud;
  return '<p>' +
    inhoud
      .split(/\n\n+/)
      .map(p => p.trim().replace(/\n/g, '<br>'))
      .filter(Boolean)
      .join('</p><p>') +
    '</p>';
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
      const { aan, onderwerp, inhoud, cc, log_acc_id, mail_type, bijlages } = req.body;

      if (!aan || !onderwerp || !inhoud) {
        return res.status(400).json({ error: 'aan, onderwerp en inhoud zijn verplicht' });
      }

      // Converteer platte tekst naar HTML
      const inhoudHtml = tekstNaarHtml(inhoud);

      const MAX_DIRECT = 3 * 1024 * 1024;
      const kleineBijlages = [];
      const groteBijlages = [];

      for (const b of (bijlages || [])) {
        const bytes = Buffer.from(b.base64, 'base64').length;
        if (bytes < MAX_DIRECT) {
          kleineBijlages.push({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: b.naam,
            contentType: b.mimeType || 'application/octet-stream',
            contentBytes: b.base64,
          });
        } else {
          groteBijlages.push(b);
        }
      }

      if (groteBijlages.length === 0) {
        await sendMail(tokens.access_token, { aan, onderwerp, inhoud: inhoudHtml, cc, attachments: kleineBijlages });
      } else {
        const axios = require('axios');
        const GRAPH = 'https://graph.microsoft.com/v1.0';
        const headers = { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' };

        const draftRes = await axios.post(`${GRAPH}/me/messages`, {
          subject: onderwerp,
          body: { contentType: 'HTML', content: inhoudHtml },
          toRecipients: [{ emailAddress: { address: aan } }],
          ccRecipients: (cc || []).map(e => ({ emailAddress: { address: e } })),
          attachments: kleineBijlages,
        }, { headers });

        const messageId = draftRes.data.id;

        for (const b of groteBijlages) {
          const fileBytes = Buffer.from(b.base64, 'base64');
          const sessionRes = await axios.post(`${GRAPH}/me/messages/${messageId}/attachments/createUploadSession`, {
            AttachmentItem: {
              attachmentType: 'file',
              name: b.naam,
              size: fileBytes.length,
              contentType: b.mimeType || 'application/octet-stream',
            },
          }, { headers });

          const uploadUrl = sessionRes.data.uploadUrl;
          const chunkSize = 4 * 1024 * 1024;

          for (let offset = 0; offset < fileBytes.length; offset += chunkSize) {
            const chunk = fileBytes.slice(offset, Math.min(offset + chunkSize, fileBytes.length));
            await axios.put(uploadUrl, chunk, {
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${fileBytes.length}`,
                'Content-Length': chunk.length,
              },
            });
          }
        }

        await axios.post(`${GRAPH}/me/messages/${messageId}/send`, {}, { headers });
      }

      if (log_acc_id) {
        const samenvatting = await vatSamen(onderwerp, inhoud);
        const typeLabels = { mailshot: 'Mailshot', opvolg_mailshot: 'Opvolg Mailshot', directe_mail: 'Directe mail' };
        const logTekst = `${typeLabels[mail_type] || 'Mail'} verstuurd via CRM${bijlages && bijlages.length ? ` · ${bijlages.length} bijlage(s)` : ''}\n\n${samenvatting || `Onderwerp: ${onderwerp}`}`;
        await supabase.from('notes').insert({
          account_id: log_acc_id,
          type: mail_type || 'mailshot',
          text: logTekst,
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
