// /api/mail-learn
// Slaat op wat Mees/Julian hebben aangepast aan een mail suggestie
// Zodat de volgende suggestie beter is

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { account_id, account_naam, mail_type, user_id, suggestie_onderwerp, suggestie_inhoud, verstuurd_onderwerp, verstuurd_inhoud } = req.body;

  try {
    // Bepaal wat er is aangepast
    const aanpassingen = [];

    if (suggestie_onderwerp !== verstuurd_onderwerp) {
      aanpassingen.push(`Onderwerp aangepast van "${suggestie_onderwerp}" naar "${verstuurd_onderwerp}"`);
    }

    // Simpele diff — kijk hoeveel % de inhoud is gewijzigd
    const origLen = (suggestie_inhoud || '').length;
    const nieuwLen = (verstuurd_inhoud || '').length;
    const verschil = Math.abs(origLen - nieuwLen);
    const pct = origLen > 0 ? Math.round((verschil / origLen) * 100) : 0;

    if (pct > 10) {
      aanpassingen.push(`Inhoud ${pct}% gewijzigd (${origLen} → ${nieuwLen} tekens)`);
    }
    if (nieuwLen < origLen * 0.7) {
      aanpassingen.push('Mail aanzienlijk ingekort');
    }
    if (nieuwLen > origLen * 1.3) {
      aanpassingen.push('Mail uitgebreid');
    }

    const aanpassingNotitie = aanpassingen.length > 0 ? aanpassingen.join(', ') : 'Geen aanpassingen';

    await supabase.from('mail_leerdata').insert({
      account_id,
      account_naam,
      mail_type,
      user_id,
      fase: 'aangepast',
      suggestie_onderwerp,
      suggestie_inhoud,
      verstuurd_onderwerp,
      verstuurd_inhoud,
      aanpassing_notitie: aanpassingNotitie,
      created_at: new Date().toISOString(),
    });

    return res.json({ success: true, aanpassingen });
  } catch (err) {
    console.error('[Mail Learn]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
