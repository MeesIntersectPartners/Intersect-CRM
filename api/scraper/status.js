const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { count } = await db.from('scraper_results')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'ter_beoordeling');

  return res.status(200).json({ wachtend: count || 0 });
};
