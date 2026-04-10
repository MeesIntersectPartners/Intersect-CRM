// /api/auth/callback
// Microsoft stuurt de gebruiker hier naartoe na inloggen
// Wisselt de authorization code in voor tokens en slaat ze op in Supabase

const { exchangeCode, getProfiel } = require('../../lib/microsoft');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const { code, error, state } = req.query;

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.status(400).json({ error: 'Geen authorization code ontvangen' });
  }

  try {
    // Wissel code in voor tokens
    const tokens = await exchangeCode(code);

    // Haal profiel op
    const profiel = await getProfiel(tokens.access_token);

    // Sla tokens op in Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const tokenData = {
      user_email: profiel.mail || profiel.userPrincipalName,
      user_name: profiel.displayName,
      user_id: state || 'MA', // MA of JK meegegeven via state parameter
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Upsert op basis van email
    const { error: dbError } = await supabase
      .from('microsoft_tokens')
      .upsert(tokenData, { onConflict: 'user_email' });

    if (dbError) {
      console.error('[Auth] Supabase fout:', dbError);
      return res.redirect('/?auth_error=database');
    }

    console.log(`[Auth] Succesvol gekoppeld: ${tokenData.user_email}`);
    return res.redirect('/?auth_success=1');

  } catch (err) {
    console.error('[Auth] Fout bij token exchange:', err.message);
    return res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
}
