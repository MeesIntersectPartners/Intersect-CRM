// Gecombineerde scraper endpoint — action bepaalt wat er gebeurt
// POST /api/scraper?action=start
// POST /api/scraper?action=save  
// POST /api/scraper?action=results (GET ook)
// GET  /api/scraper?action=status

let zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven, bepaalSegment, isSBIInteressant, bestaatAl, createClient, Anthropic;
try {
  ({ zoekBedrijvenOpenKVK, parseOpenKVKBedrijf, getBedrijven } = require('../../lib/openkvk'));
  ({ bepaalSegment, isSBIInteressant } = require('../../lib/kvk'));
  ({ bestaatAl } = require('../../lib/supabase'));
  ({ createClient } = require('@supabase/supabase-js'));
  Anthropic = require('@anthropic-ai/sdk');
  console.log('[Init] Alle modules geladen');
} catch(e) {
  console.error('[Init] Module laad fout:', e.message);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
function wacht(ms) { return new Promise(r => setTimeout(r, ms)); }
function getDb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }

const SKIP_NAMEN = ['kapsalon','kappers','ziekenhuis','huisarts','tandarts','apotheek',
  'fysiotherap','paramedisch','thuiszorg','verpleeg','maatschap','supermarkt',
  'slager','bakker','pizzeria','restaurant','snackbar','garage','autohandel'];

async function bepaalStrategie(opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 500,
      messages: [{ role: 'user', content: `Nederlandse KvK/SBI expert.
Intersect verkoopt voor "${opdrachtgever}" en zoekt: "${focusgebied}"
JSON only: {"sbi_codes":["<4-6 cijferige SBI codes, max 8>"],"gemeenten":["<max 10 gemeenten>"],"min_medewerkers":<integer>,"uitleg":"<één zin>"}
SBI: 6201=maatwerksoftware,6202=IT-advies,6209=overige IT,6311=dataverwerking,6419=holdings/fintech,6492=kredietverlening,6619=overige financieel,7010=holdings,7021=PR,7022=management-advies,7311=reclamebureau,7312=media-advies,7320=marktonderzoek,7410=design,7810=arbeidsbemiddeling,7820=uitzend,9001=podiumkunsten,9002=uitvoerende kunst,9003=kunstondersteuning,9004=events` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) {
    return { sbi_codes:['6201','6202','7311','7022'], gemeenten:['Amsterdam','Rotterdam','Den Haag','Utrecht','Eindhoven'], min_medewerkers:10, uitleg:'Standaard' };
  }
}

async function beoordeelLead(bedrijf, opdrachtgever, focusgebied) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 250,
      messages: [{ role: 'user', content: `Intersect verkoopt voor "${opdrachtgever}". Zoekopdracht: "${focusgebied}"
Bedrijf: ${bedrijf.organisatie} | ${bedrijf.sector||'?'} | ${bedrijf.medewerkers_raw||'?'} mw | ${bedrijf.regio||'?'} | ${bedrijf.website||'geen'}
JSON only: {"score":<1-10>,"reden":"<max 10 woorden>","haakje":"<1-2 zinnen gespreksstarter, null als score<7>"}` }]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g,'').trim());
  } catch(e) { return { score:5, reden:'Niet beoordeeld', haakje:null }; }
}

async function handleStart(req, res) {
  const { opdrachtgever, focusgebied, limit=20 } = req.body||{};
  if (!opdrachtgever||!focusgebied) return res.status(400).json({ error:'opdrachtgever en focusgebied verplicht' });

  const DOEL = Math.min(parseInt(limit)||20, 100);
  const db = getDb();
  const start = Date.now();
  const verwerkt = new Set();
  let opgeslagen=0, bekeken=0;

  console.log(`[Start] ${opdrachtgever} | ${focusgebied} | doel:${DOEL}`);
  const strategie = await bepaalStrategie(opdrachtgever, focusgebied);
  console.log(`[Strategie] ${strategie.uitleg} | SBI:${strategie.sbi_codes?.join(',')} | ${strategie.gemeenten?.join(',')}`);

  for (const sbi of (strategie.sbi_codes||[])) {
    if (opgeslagen>=DOEL || Date.now()-start>250000) break;
    for (const gemeente of (strategie.gemeenten||[])) {
      if (opgeslagen>=DOEL || Date.now()-start>250000) break;
      const data = await zoekBedrijvenOpenKVK({ sbiCode:sbi, gemeente, size:100 });
      const resultaten = getBedrijven(data);
      if (!resultaten.length) { console.log(`[OpenKVK] ${gemeente} SBI:${sbi}: 0`); continue; }
      console.log(`[OpenKVK] ${gemeente} SBI:${sbi}: ${resultaten.length}`);

      for (const r of resultaten) {
        if (opgeslagen>=DOEL || Date.now()-start>250000) break;
        const kvkNr = r.dossiernummer;
        if (!kvkNr||verwerkt.has(kvkNr)) continue;
        verwerkt.add(kvkNr); bekeken++;

        const bedrijf = parseOpenKVKBedrijf(r);
        bedrijf.segment = bepaalSegment([{sbiCode:bedrijf.sbi_code}]);
        const nL=(bedrijf.organisatie||'').toLowerCase();
        if (SKIP_NAMEN.some(s=>nL.includes(s))) continue;
        if (bedrijf.medewerkers_min>0 && bedrijf.medewerkers_min<(strategie.min_medewerkers||10)) continue;
        if (await bestaatAl(bedrijf.kvk_nummer, bedrijf.website)) continue;
        const {data:bestaand} = await db.from('scraper_results').select('id').eq('kvk_nummer',kvkNr).eq('status','ter_beoordeling').maybeSingle();
        if (bestaand) continue;

        const beoordeling = await beoordeelLead(bedrijf, opdrachtgever, focusgebied);
        if (beoordeling.score<7) { console.log(`[skip] ${bedrijf.organisatie} ${beoordeling.score}`); continue; }

        const {error} = await db.from('scraper_results').insert({
          opdrachtgever, focusgebied, status:'ter_beoordeling',
          organisatie:bedrijf.organisatie, sector:bedrijf.sector, segment:bedrijf.segment,
          website:bedrijf.website, adres:bedrijf.adres, regio:bedrijf.regio,
          medewerkers:bedrijf.medewerkers_raw, kvk_nummer:bedrijf.kvk_nummer,
          telefoon:bedrijf.telefoon, score:beoordeling.score, reden:beoordeling.reden,
          haakje:beoordeling.haakje, notitie:`[${opdrachtgever}] ${beoordeling.haakje||beoordeling.reden||''}`,
        });
        if (!error) { opgeslagen++; console.log(`[+] ${bedrijf.organisatie} ${beoordeling.score} (${opgeslagen}/${DOEL})`); }
        await wacht(100);
      }
      await wacht(300);
    }
  }
  const duur=Math.round((Date.now()-start)/1000);
  console.log(`[Klaar] ${opgeslagen} leads in ${duur}s (${bekeken} bekeken)`);
  return res.status(200).json({ success:true, opgeslagen, bekeken, duur_seconden:duur });
}

async function handleStatus(req, res) {
  const db = getDb();
  const {count} = await db.from('scraper_results').select('*',{count:'exact',head:true}).eq('status','ter_beoordeling');
  return res.status(200).json({ wachtend:count||0 });
}

async function handleResults(req, res) {
  const db = getDb();
  if (req.method==='GET') {
    const {data,error} = await db.from('scraper_results').select('*').eq('status','ter_beoordeling').order('score',{ascending:false});
    if (error) return res.status(500).json({error:error.message});
    return res.status(200).json({success:true, leads:data||[]});
  }
  const {doorsturen,afwijzen} = req.body||{};
  let opgeslagen=0; const fouten=[];
  for (const lead of (doorsturen||[])) {
    const naamDelen=(lead.contact_naam||'').trim().split(' ');
    const {error} = await db.from('accounts').insert({
      name:lead.organisatie, status:'lead', sector:lead.sector||'', segment:lead.segment||'',
      website:lead.website||'', linkedin:lead.linkedin||'', phone:lead.telefoon||'',
      kvk:lead.kvk_nummer||'', address:lead.adres||'',
      address_url:lead.adres?`https://www.google.com/maps/search/?q=${encodeURIComponent(lead.adres)}`:'',
      pipeline_stage:'Nieuw', value:null, owner:'MA', note:lead.notitie||'', color_index:0,
      added_date:new Date().toISOString().split('T')[0],
      contact_first:naamDelen[0]||'', contact_last:naamDelen.slice(1).join(' ')||'',
      contact_role:lead.contact_titel||'', contact_phone:lead.contact_telefoon||'',
      contact_email:lead.email||'',
    });
    if (error) fouten.push(lead.organisatie);
    else { opgeslagen++; await db.from('scraper_results').update({status:'doorgestuurd'}).eq('id',lead.id); }
  }
  for (const id of (afwijzen||[])) await db.from('scraper_results').update({status:'afgewezen'}).eq('id',id);
  return res.status(200).json({success:true, opgeslagen, fouten:fouten.length});
}

module.exports = async function handler(req, res) {
  console.log('[Handler] aangeroepen', req.method, req.url, 'body:', JSON.stringify(req.body||{}).substring(0,100));
  const secret = process.env.CRON_SECRET;
  const geldig = req.headers.authorization===`Bearer ${secret}` || req.body?.secret===secret || req.query?.secret===secret;
  console.log('[Auth] geldig:', geldig, 'secret aanwezig:', !!secret);
  if (!geldig) return res.status(401).json({error:'Unauthorized'});

  const action = req.query.action || req.body?.action;
  console.log('[Action]', action);
  if (action==='start') return handleStart(req, res);
  if (action==='status') return handleStatus(req, res);
  if (action==='results') return handleResults(req, res);
  return res.status(400).json({error:'Geef action mee: start|status|results'});
};
