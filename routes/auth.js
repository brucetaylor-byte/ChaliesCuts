const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

// ---------- Hairdresser auth ----------

router.post('/hairdresser/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const hd = db.prepare('SELECT * FROM hairdressers WHERE username = ?').get(username.trim().toLowerCase());
  if (!hd || !bcrypt.compareSync(password, hd.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!hd.is_active) {
    return res.status(403).json({ error: 'This account has been removed. Contact the salon admin.' });
  }

  req.session.hairdresserId = hd.id;
  res.json({ id: hd.id, username: hd.username, display_name: hd.display_name, is_admin: !!hd.is_admin });
});

router.post('/hairdresser/logout', (req, res) => {
  delete req.session.hairdresserId;
  res.json({ ok: true });
});

router.put('/hairdresser/password', (req, res) => {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Current password and a new password (6+ chars) are required' });
  }
  const hd = db.prepare('SELECT * FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  if (!hd || !bcrypt.compareSync(currentPassword, hd.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const password_hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE hairdressers SET password_hash = ? WHERE id = ?').run(password_hash, hd.id);
  res.json({ ok: true });
});

router.get('/hairdresser/me', (req, res) => {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  const hd = db.prepare('SELECT id, username, display_name, bio, instagram_url, facebook_url, tiktok_url, snapchat_url, website_url, contact_email, is_admin, is_active FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  if (!hd || !hd.is_active) {
    req.session.hairdresserId = null;
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json({ ...hd, is_admin: !!hd.is_admin });
});

module.exports = router;
