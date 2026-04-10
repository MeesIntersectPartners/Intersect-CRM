// /api/agenda
// GET  → haal Outlook events op en sync naar CRM
// POST → maak nieuw event aan in Outlook

const { getAgendaEvents, maakEvent, refreshToken } = require('../lib/microsoft');
const { createClient } = require('@supabase/supabase-js');

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
    await supabase.from('microsoft_tokens').update({
      access_token: nieuw.access_token,
      refresh_token: nieuw.refresh_token || data.refresh_token,
      expires_at: new Date(Date.now() + nieuw.expires_in * 1000).toISOString(),
    }).eq('user_email', userEmail);
    return { ...data, access_token: nieuw.access_token };
  }

  return data;
}

module.exports = async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const userEmail = req.headers['x-user-email'];

  if (!userEmail) return res.status(401).json({ error: 'x-user-email header verplicht' });

  try {
    const tokens = await getTokens(supabase, userEmail);

    if (req.method === 'GET') {
      const { dagen = 14 } = req.query;
      const events = await getAgendaEvents(tokens.access_token, parseInt(dagen));

      const geformatteerd = events.map(e => ({
        id: e.id,
        titel: e.subject,
        start: e.start?.dateTime,
        einde: e.end?.dateTime,
        locatie: e.location?.displayName || '',
        notitie: e.bodyPreview || '',
        deelnemers: (e.attendees || []).map(a => a.emailAddress?.address),
        isOrganisator: e.isOrganizer,
        bron: 'outlook',
      }));

      return res.json({ events: geformatteerd });
    }

    if (req.method === 'POST') {
      const { titel, start, einde, locatie, notitie, deelnemers } = req.body;

      if (!titel || !start || !einde) {
        return res.status(400).json({ error: 'titel, start en einde zijn verplicht' });
      }

      const event = await maakEvent(tokens.access_token, {
        titel, start, einde, locatie, notitie, deelnemers: deelnemers || [],
      });

      return res.json({ success: true, event_id: event.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[Agenda API]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
