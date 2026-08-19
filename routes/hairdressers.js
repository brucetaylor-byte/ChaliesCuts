const express = require('express');
const db = require('../db');

const router = express.Router();

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

const PUBLIC_FIELDS = 'id, username, display_name, bio, instagram_url, facebook_url, tiktok_url, website_url';

// Public: list both hairdressers so a customer can choose
router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM hairdressers ORDER BY id`).all();
  res.json(rows);
});

// Public: single hairdresser profile
router.get('/:id', (req, res) => {
  const hd = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM hairdressers WHERE id = ?`).get(req.params.id);
  if (!hd) return res.status(404).json({ error: 'Not found' });
  res.json(hd);
});

// Logged-in hairdresser: update own profile / bio / socials
router.put('/me', requireHairdresser, (req, res) => {
  const { display_name, bio, instagram_url, facebook_url, tiktok_url, website_url } = req.body || {};
  const current = db.prepare('SELECT * FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  db.prepare(`UPDATE hairdressers SET display_name = ?, bio = ?, instagram_url = ?, facebook_url = ?, tiktok_url = ?, website_url = ? WHERE id = ?`)
    .run(
      display_name ?? current.display_name,
      bio ?? current.bio,
      instagram_url ?? current.instagram_url,
      facebook_url ?? current.facebook_url,
      tiktok_url ?? current.tiktok_url,
      website_url ?? current.website_url,
      req.session.hairdresserId
    );
  const updated = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM hairdressers WHERE id = ?`).get(req.session.hairdresserId);
  res.json(updated);
});

module.exports = router;
