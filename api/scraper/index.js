// Lead scraper — Claude + web search, job-systeem voor grote targets
// POST /api/scraper?action=start|results|save_opdrachtgever  GET ?action=status

let voegAccountToe, bestaatAl, createClient, Anthropic;
try {
  ({ voegAccountToe, bestaatAl } = require('../../lib/supabase'));
  ({ createClient } = require('@supabase/supabase-js'));
  Anthropic = require('@anthropic-ai/sdk');
  console.log('[Init] Modules geladen');
} catch(e) {
  console.error('[Init] Fout:', e.message);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function getDb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }
function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiCallMetRetry(fn, maxPogingen = 3) {
  for (let poging = 1; poging <= maxPogingen; poging++) {
    try {
      return await fn();
    } catch(e) {
      const is429 = e.status === 429 || e.message?.includes('429') || e.message?.includes('rate_limit');
      if (is429 && poging < maxPogingen) {
        const wachttijd = poging * 65000;
        console.log(`[RateLimit] Poging ${poging}/${maxPogingen} — wacht ${wachttijd/1000}s...`);
        await wacht(wachttijd);
        continue;
      }
      throw e;
    }
  }
}

function extractDomein(website) {
  try {
    if (!website) return null;
    const url = website.startsWith('http') ? website : 'https://' + website;
    return new URL(url).hostname.replace('www.', '').toLowerCase();
  } catch { return null; }
}

async function haalBekendeCompanies(db) {
  const [{ data: accounts }, { data: scraper }] = await Promise.all([
    db.from('accounts').select('name, website').limit(5000),
    db.from('scraper_results').select('organisatie, website').limit(5000),
  ]);
  const namen = new Set([
    ...(accounts || []).map(a => a.name?.toLowerCase().trim()).filter(Boolean),
    ...(scraper || []).map(a => a.organisatie?.toLowerCase().trim()).filter(Boolean),
  ]);
  const websites = new Set([
    ...(accounts || []).map(a => extractDomein(a.website)).filter(Boolean),
    ...(scraper || []).map(a => extractDomein(a.website)).filter(Boolean),
  ]);
  return { namen, websites };
}

async function zoekBedrijven(opdrachtgever, opdrachtgeverInfo, focusgebied, limit, goedgekeurd, bekendeNamen) {
  const voorbeeldTekst = goedgekeurd?.length
    ? `\nEerder goedgekeurde leads (zelfde kwaliteit gewenst):\n${goedgekeurd.map(l => `- ${l.organisatie} | ${l.sector || '?'} | ${l.regio || '?'}`).join('\n')}`
    : '';
  const bekendeStr = [...bekendeNamen].slice(0, 50).join(', ');
  const bekendeNamenTekst = bekendeStr ? `\nAl bekend — NIET opnemen: ${bekendeStr}` : '';
  const opdrachtgeverContext = opdrachtgeverInfo
    ? `\nWat "${opdrachtgever}" verkoopt/aanbiedt:\n${opdrachtgeverInfo}`
    : '';

  const zoekPrompt = `Je bent een B2B sales researcher voor Intersect, een Nederlands sales agency.
Intersect verkoopt namens opdrachtgever "${opdrachtgever}".
${opdrachtgeverContext}

Zoek naar ${limit} concrete Nederlandse bedrijven die een geschikte prospect zijn voor "${opdrachtgever}".
Focusgebied: "${focusgebied}"
${voorbeeldTekst}
${bekendeNamenTekst}

Doe meerdere gerichte web searches. Varieer: sector + regio, vacatures, groeilijsten, nieuws, LinkedIn, etc.
Zoek ook naar adres, telefoonnummer en LinkedIn URL van elk bedrijf.
Beschrijf per bedrijf: naam, website, adres, telefoonnummer, LinkedIn URL, stad, sector, en waarom het een goede prospect is.
Wees streng: alleen bedrijven die echt passen bij het focusgebied.`;

  const zoekResponse = await apiCallMetRetry(() => anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: zoekPrompt }],
  }));

  const zoekTekst = (zoekResponse.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');

  if (!zoekTekst.trim()) throw new Error('Geen output van zoekstap');
  console.log(`[Search] Zoekstap klaar, ${zoekTekst.length} tekens`);

  await wacht(8000);

  const zoekTekstKort = zoekTekst.length > 6000 ? zoekTekst.substring(0, 6000) + '\n...' : zoekTekst;

  const jsonResponse = await apiCallMetRetry(() => anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system: 'Je converteert bedrijfsinformatie naar een JSON array. Geef ALLEEN de JSON array terug. Begin met [ en eindig met ]. Geen tekst eromheen.',
    messages: [{
      role: 'user',
      content: `Converteer naar JSON array. Score 1-10 (7+ = goed genoeg, streng zijn).

Structuur:
{"naam":"...","website":"...","stad":"...","adres":"...","telefoon":"...","linkedin":"...","sector":"...","score":8,"reden":"max 10 woorden"}

Bedrijfsinformatie:
${zoekTekstKort}

Geef ALLEEN de JSON array:`
    }],
  }));

  const jsonTekst = (jsonResponse.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');

  console.log(`[JSON] Output: ${jsonTekst.substring(0, 300)}`);

  const startIdx = jsonTekst.indexOf('[');
  const eindIdx = jsonTekst.lastIndexOf(']');
  if (startIdx === -1 || eindIdx === -1) throw new Error('Geen JSON: ' + jsonTekst.substring(0, 200));

  const jsonStr = jsonTekst.substring(startIdx, eindIdx + 1);
  try {
    return JSON.parse(jsonStr);
  } catch(e) {
    return JSON.parse(jsonStr.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, ''));
  }
}

async function handleStart(req, res) {
  const { opdrachtgever, focusgebied, limit = 20, job_id, gebruiker = 'MA' } = req.body || {};
  if (!opdrachtgever || !focusgebied) {
    return res.status(400).json({ error: 'opdrachtgever en focusgebied verplicht' });
  }

  const TARGET = Math.min(parseInt(limit) || 20, 200);
  const db = getDb();
  const startTime = Date.now();
  const TIJDSLIMIET = 210000; // 210s — ruim binnen Vercel's 300s

  // Haal of maak job aan
  let job;
  if (job_id) {
    const { data } = await db.from('scraper_jobs').select('*').eq('id', job_id).maybeSingle();
    job = data;
  }

  if (!job) {
    // Kijk of er al een actieve job is voor deze opdrachtgever
    const { data: bestaandeJob } = await db.from('scraper_jobs')
      .select('*').eq('opdrachtgever', opdrachtgever).eq('status', 'bezig').eq('gebruiker', gebruiker).maybeSingle();

    if (bestaandeJob && bestaandeJob.target === TARGET) {
      job = bestaandeJob;
      console.log(`[Job] Hervat bestaande job ${job.id} (${job.gevonden}/${job.target})`);
    } else {
      // Sluit eventuele oude jobs
      await db.from('scraper_jobs').update({ status: 'gestopt' })
        .eq('opdrachtgever', opdrachtgever).eq('status', 'bezig').eq('gebruiker', gebruiker);

      // Haal opdrachtgever info
      const { data: klant } = await db.from('accounts')
        .select('note').eq('name', opdrachtgever).maybeSingle();

      const { data: nieuweJob } = await db.from('scraper_jobs').insert({
        opdrachtgever, focusgebied,
        opdrachtgever_info: klant?.note || '',
        target: TARGET, gevonden: 0, status: 'bezig',
        gebruiker,
      }).select().single();
      job = nieuweJob;
      console.log(`[Job] Nieuwe job ${job.id} — target: ${TARGET}`);
    }
  }

  if (!job) return res.status(500).json({ error: 'Kon geen job aanmaken' });

  const opdrachtgeverInfo = job.opdrachtgever_info || '';
  if (opdrachtgeverInfo) console.log(`[Opdrachtgever] Info: ${opdrachtgeverInfo.substring(0, 60)}...`);

  // Eerder goedgekeurde leads als voorbeeld
  const { data: goedgekeurd } = await db.from('scraper_results')
    .select('organisatie, sector, regio')
    .eq('opdrachtgever', opdrachtgever).eq('status', 'doorgestuurd')
    .order('created_at', { ascending: false }).limit(8);

  const { namen: bekendeNamen, websites: bekendeWebsites } = await haalBekendeCompanies(db);
  console.log(`[Dedup] ${bekendeNamen.size} bekende namen | Job voortgang: ${job.gevonden}/${job.target}`);

  let opgeslagenDezeRun = 0;
  let ronde = 0;

  // Blijf zoeken zolang er tijd is en target niet bereikt
  while (job.gevonden + opgeslagenDezeRun < job.target) {
    const tijdVerstreken = Date.now() - startTime;
    if (tijdVerstreken > TIJDSLIMIET) {
      console.log(`[Timeout] Tijdslimiet bereikt na ${Math.round(tijdVerstreken/1000)}s — job wordt hervat`);
      break;
    }

    ronde++;
    const nogNodig = job.target - job.gevonden - opgeslagenDezeRun;
    const rondeGrootte = Math.min(20, nogNodig);
    console.log(`[Ronde ${ronde}] Zoek ${rondeGrootte} bedrijven (${job.gevonden + opgeslagenDezeRun}/${job.target})`);

    let gevonden;
    try {
      gevonden = await zoekBedrijven(opdrachtgever, opdrachtgeverInfo, focusgebied, rondeGrootte, goedgekeurd, bekendeNamen);
      console.log(`[Ronde ${ronde}] ${gevonden.length} kandidaten`);
    } catch(e) {
      console.error(`[Ronde ${ronde}] Fout:`, e.message);
      break;
    }

    for (const bedrijf of gevonden) {
      if (!bedrijf.naam || bedrijf.score < 6) continue;
      if (job.gevonden + opgeslagenDezeRun >= job.target) break;

      const naam = bedrijf.naam.toLowerCase().trim();
      const domein = extractDomein(bedrijf.website);

      if (bekendeNamen.has(naam)) { console.log(`[skip-naam] ${bedrijf.naam}`); continue; }
      if (domein && bekendeWebsites.has(domein)) { console.log(`[skip-web] ${bedrijf.naam}`); continue; }
      if (await bestaatAl(null, bedrijf.website)) { console.log(`[skip-db] ${bedrijf.naam}`); continue; }

      const { error } = await db.from('scraper_results').insert({
        opdrachtgever, focusgebied,
        status: 'ter_beoordeling',
        organisatie: bedrijf.naam,
        sector:   bedrijf.sector   || '',
        segment:  '',
        website:  bedrijf.website  || '',
        adres:    bedrijf.adres    || '',
        regio:    bedrijf.stad     || '',
        medewerkers: '',
        kvk_nummer: null,
        telefoon: bedrijf.telefoon || '',
        linkedin: bedrijf.linkedin || '',
        score:    bedrijf.score,
        reden:    bedrijf.reden    || '',
        haakje:   '',
        notitie:  `[${opdrachtgever}] ${bedrijf.reden || ''}`,
      });

      if (!error) {
        opgeslagenDezeRun++;
        bekendeNamen.add(naam);
        if (domein) bekendeWebsites.add(domein);
        const totaal = job.gevonden + opgeslagenDezeRun;
        console.log(`[+] ${bedrijf.naam} | ${bedrijf.score} | ${bedrijf.sector || '?'} (${totaal}/${job.target})`);
      }
    }

    // Wacht tussen ronden tenzij we klaar zijn
    const nogSteeds = job.gevonden + opgeslagenDezeRun < job.target;
    const tijdOver = (Date.now() - startTime) < TIJDSLIMIET - 60000;
    if (nogSteeds && tijdOver) await wacht(10000);
  }

  // Update job voortgang
  const nieuwGevonden = job.gevonden + opgeslagenDezeRun;
  const klaar = nieuwGevonden >= job.target;
  await db.from('scraper_jobs').update({
    gevonden: nieuwGevonden,
    status: klaar ? 'klaar' : 'bezig',
  }).eq('id', job.id);

  const duur = Math.round((Date.now() - startTime) / 1000);
  console.log(`[Run klaar] ${opgeslagenDezeRun} leads in ${duur}s | Totaal: ${nieuwGevonden}/${job.target} | Status: ${klaar ? 'KLAAR' : 'bezig'}`);

  return res.status(200).json({
    success: true,
    opgeslagen: opgeslagenDezeRun,
    totaal: nieuwGevonden,
    target: job.target,
    klaar,
    job_id: job.id,
    duur_seconden: duur,
  });
}

async function handleSaveOpdrachtgever(req, res) {
  const { opdrachtgever, info } = req.body || {};
  if (!opdrachtgever) return res.status(400).json({ error: 'opdrachtgever verplicht' });
  const db = getDb();
  const { error } = await db.from('accounts')
    .update({ note: info || '' }).eq('name', opdrachtgever).eq('status', 'klant');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true });
}

async function handleStatus(req, res) {
  const db = getDb();
  const [{ count }, actieveJobs] = await Promise.all([
    db.from('scraper_results').select('*', { count: 'exact', head: true }).eq('status', 'ter_beoordeling'),
    db.from('scraper_jobs').select('*').eq('status', 'bezig').order('created_at', { ascending: false }).limit(10),
  ]);
  return res.status(200).json({
    wachtend: count || 0,
    jobs: actieveJobs?.data || [],
  });
}

async function handleResults(req, res) {
  const db = getDb();
  if (req.method === 'GET') {
    const { data, error } = await db.from('scraper_results')
      .select('*').eq('status', 'ter_beoordeling').order('score', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, leads: data || [] });
  }
  const { doorsturen, afwijzen } = req.body || {};
  let opgeslagen = 0;
  const fouten = [];
  for (const lead of (doorsturen || [])) {
    const id = await voegAccountToe({
      ...lead,
      contactpersoon: { naam: lead.contact_naam || '', titel: lead.contact_rol || '' },
      contactTelefoon: lead.contact_telefoon || '',
      email: lead.contact_email || '',
    });
    if (id) {
      opgeslagen++;
      await db.from('scraper_results').update({ status: 'doorgestuurd' }).eq('id', lead.id);
    } else {
      fouten.push(lead.organisatie);
    }
  }
  for (const id of (afwijzen || [])) {
    await db.from('scraper_results').update({ status: 'afgewezen' }).eq('id', id);
  }
  return res.status(200).json({ success: true, opgeslagen, fouten: fouten.length });
}

module.exports = async function handler(req, res) {
  console.log('[Handler]', req.method, req.url);
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization === `Bearer ${secret}`
    || req.body?.secret === secret
    || req.query?.secret === secret;
  if (!geldig) return res.status(401).json({ error: 'Unauthorized' });
  const action = req.query.action || req.body?.action;
  if (action === 'start')              return handleStart(req, res);
  if (action === 'status')             return handleStatus(req, res);
  if (action === 'results')            return handleResults(req, res);
  if (action === 'save_opdrachtgever') return handleSaveOpdrachtgever(req, res);
  return res.status(400).json({ error: 'Geef action mee: start|status|results|save_opdrachtgever' });
};
