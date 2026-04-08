const { getAuthUrl } = require('../../lib/microsoft');

module.exports = function handler(req, res) {
  const { user } = req.query;
  const authUrl = getAuthUrl(user || 'unknown');
  res.redirect(authUrl);
};
