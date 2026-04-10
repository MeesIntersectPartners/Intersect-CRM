// /api/mail-upload
// Maakt een Microsoft upload session aan voor grote bijlages
// De browser upload dan direct naar Microsoft — geen Vercel limiet

const { refreshToken } = require('../lib/microsoft');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const userEmail = req.headers['x-user-email'];
  if (!userEmail) return res.status(401).json({ error: 'x-user-email header verplicht' });

  const { action, messageId, fileName, fileSize, mimeType, aan, onderwerp, inhoud, cc } = req.body || {};
  console.log('[Mail Upload] action:', action, 'userEmail:', userEmail, 'body keys:', Object.keys(req.body || {}));

  try {
    // Haal tokens op
    const { data, error } = await supabase.from('microsoft_tokens').select('*').eq('user_email', userEmail).single();
    if (error || !data) throw new Error('Geen tokens gevonden');

    const verlooptBinnenkort = new Date(data.expires_at) < new Date(Date.now() + 5 * 60 * 1000);
    let accessToken = data.access_token;
    if (verlooptBinnenkort) {
      const nieuw = await refreshToken(data.refresh_token);
      accessToken = nieuw.access_token;
      await supabase.from('microsoft_tokens').update({
        access_token: nieuw.access_token,
        refresh_token: nieuw.refresh_token || data.refresh_token,
        expires_at: new Date(Date.now() + nieuw.expires_in * 1000).toISOString(),
      }).eq('user_email', userEmail);
    }

    const GRAPH = 'https://graph.microsoft.com/v1.0';
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

    if (action === 'create-draft') {
      // Maak een draft aan en geef het message ID terug
      const draftRes = await axios.post(`${GRAPH}/me/messages`, {
        subject: onderwerp,
        body: { contentType: 'HTML', content: inhoud },
        toRecipients: [{ emailAddress: { address: aan } }],
        ccRecipients: (cc || []).map(e => ({ emailAddress: { address: e } })),
      }, { headers });
      return res.json({ messageId: draftRes.data.id });
    }

    if (action === 'create-upload-session') {
      // Maak upload session aan voor een bijlage
      const sessionRes = await axios.post(`${GRAPH}/me/messages/${messageId}/attachments/createUploadSession`, {
        AttachmentItem: {
          attachmentType: 'file',
          name: fileName,
          size: fileSize,
          contentType: mimeType || 'application/octet-stream',
        },
      }, { headers });
      return res.json({ uploadUrl: sessionRes.data.uploadUrl });
    }

    if (action === 'send-draft') {
      // Verstuur de draft
      await axios.post(`${GRAPH}/me/messages/${messageId}/send`, {}, { headers });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Onbekende actie' });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Mail Upload] Fout:', JSON.stringify(detail));
    return res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
};
