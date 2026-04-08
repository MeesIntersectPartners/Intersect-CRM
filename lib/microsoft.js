// ══════════════ MICROSOFT GRAPH CLIENT ══════════════
// Handelt OAuth flow, token refresh en API calls af

const axios = require('axios');

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const TENANT_ID = process.env.MICROSOFT_TENANT_ID;
const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 'https://intersect-crm.vercel.app/api/auth/callback';

const SCOPES = [
  'Mail.Read',
  'Mail.Send',
  'Mail.ReadWrite',
  'Calendars.ReadWrite',
  'Contacts.Read',
  'Tasks.ReadWrite',
  'User.Read',
  'offline_access',
].join(' ');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = `https://login.microsoftonline.com/common/oauth2/v2.0/token`;
const AUTH_URL = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`;

// ── Auth URL genereren voor login ──
function getAuthUrl(state = '') {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_mode: 'query',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// ── Authorization code inwisselen voor tokens ──
async function exchangeCode(code) {
  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data; // { access_token, refresh_token, expires_in }
}

// ── Access token vernieuwen via refresh token ──
async function refreshToken(refresh_token) {
  const res = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data;
}

// ── Graph API call helper ──
async function graphGet(accessToken, path, params = {}) {
  const res = await axios.get(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return res.data;
}

async function graphPost(accessToken, path, body) {
  const res = await axios.post(`${GRAPH_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

async function graphPatch(accessToken, path, body) {
  const res = await axios.patch(`${GRAPH_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

// ══ MAIL ══

// Haal recente emails op (inbox)
async function getMails(accessToken, aantalDagen = 7) {
  const sinds = new Date();
  sinds.setDate(sinds.getDate() - aantalDagen);
  const filter = `receivedDateTime ge ${sinds.toISOString()}`;

  const data = await graphGet(accessToken, '/me/mailFolders/inbox/messages', {
    $filter: filter,
    $orderby: 'receivedDateTime desc',
    $top: 50,
    $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead,body',
  });
  return data.value || [];
}

// Stuur een email
async function sendMail(accessToken, { aan, onderwerp, inhoud, cc = [] }) {
  return graphPost(accessToken, '/me/sendMail', {
    message: {
      subject: onderwerp,
      body: { contentType: 'HTML', content: inhoud },
      toRecipients: [{ emailAddress: { address: aan } }],
      ccRecipients: cc.map(e => ({ emailAddress: { address: e } })),
    },
    saveToSentItems: true,
  });
}

// Markeer email als gelezen
async function markeerGelezen(accessToken, mailId) {
  return graphPatch(accessToken, `/me/messages/${mailId}`, { isRead: true });
}

// ══ AGENDA ══

// Haal agenda events op voor de komende X dagen
async function getAgendaEvents(accessToken, aantalDagen = 14) {
  const nu = new Date();
  const einde = new Date();
  einde.setDate(einde.getDate() + aantalDagen);

  const data = await graphGet(accessToken, '/me/calendarView', {
    startDateTime: nu.toISOString(),
    endDateTime: einde.toISOString(),
    $orderby: 'start/dateTime',
    $top: 50,
    $select: 'id,subject,start,end,location,bodyPreview,attendees,isOrganizer',
  });
  return data.value || [];
}

// Maak een agenda event aan
async function maakEvent(accessToken, { titel, start, einde, locatie, notitie, deelnemers = [] }) {
  return graphPost(accessToken, '/me/events', {
    subject: titel,
    start: { dateTime: start, timeZone: 'Europe/Amsterdam' },
    end: { dateTime: einde, timeZone: 'Europe/Amsterdam' },
    location: { displayName: locatie || '' },
    body: { contentType: 'Text', content: notitie || '' },
    attendees: deelnemers.map(email => ({
      emailAddress: { address: email },
      type: 'required',
    })),
  });
}

// Verwijder een agenda event
async function verwijderEvent(accessToken, eventId) {
  await axios.delete(`${GRAPH_BASE}/me/events/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ══ TAKEN ══

// Haal Outlook taken op
async function getTaken(accessToken) {
  const lijsten = await graphGet(accessToken, '/me/todo/lists');
  const defaultLijst = lijsten.value?.[0];
  if (!defaultLijst) return [];

  const taken = await graphGet(accessToken, `/me/todo/lists/${defaultLijst.id}/tasks`, {
    $filter: "status ne 'completed'",
    $top: 50,
  });
  return taken.value || [];
}

// ══ PROFIEL ══
async function getProfiel(accessToken) {
  return graphGet(accessToken, '/me', {
    $select: 'displayName,mail,userPrincipalName',
  });
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshToken,
  graphGet,
  getMails,
  sendMail,
  markeerGelezen,
  getAgendaEvents,
  maakEvent,
  verwijderEvent,
  getTaken,
  getProfiel,
};
