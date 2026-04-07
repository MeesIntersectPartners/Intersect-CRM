const { run } = require('../../lib/orchestrator');

export default async function handler(req, res) {
  // Beveilig de cron endpoint
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[Cron] Scraper gestart via Vercel cron');
    const resultaat = await run();
    return res.status(200).json({
      success: true,
      ...resultaat,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Cron] Fout:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
