const { run } = require('../../lib/orchestrator');

module.exports = async function handler(req, res) {
  // Beveilig de cron endpoint — check header OF query param
  const authHeader = req.headers.authorization;
  const querySecret = req.query.secret;
  const secret = process.env.CRON_SECRET;

  const geldig = authHeader === `Bearer ${secret}` || querySecret === secret;
  if (!geldig) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[Cron] Scraper gestart');
    const resultaat = await run();
    return res.status(200).json({
      success: true,
      ...resultaat,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Cron] Fout:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
