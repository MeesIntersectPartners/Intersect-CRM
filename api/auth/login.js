// /api/auth/login
// Stuurt gebruiker door naar Microsoft login pagina

const { getAuthUrl } = require('../../lib/microsoft');

export default function handler(req, res) {
  const { user } = req.query; // bijv. MA of JK
  const authUrl = getAuthUrl(user || 'unknown');
  res.redirect(authUrl);
}
