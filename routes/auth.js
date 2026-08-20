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

// ---------- Customer auth (optional accounts) ----------

router.post('/customer/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const normalizedEmail = email.trim().toLowerCase();

  const existing = db.prepare('SELECT * FROM customers WHERE email = ?').get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists. Try logging in instead.' });
  }

  const password_hash = password ? bcrypt.hashSync(password, 10) : null;
  const info = db.prepare('INSERT INTO customers (email, password_hash, name) VALUES (?, ?, ?)').run(normalizedEmail, password_hash, name.trim());
  req.session.customerId = info.lastInsertRowid;
  res.json({ id: info.lastInsertRowid, name: name.trim(), email: normalizedEmail });
});

router.post('/customer/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email.trim().toLowerCase());
  if (!customer || !customer.password_hash || !bcrypt.compareSync(password, customer.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.customerId = customer.id;
  res.json({ id: customer.id, name: customer.name, email: customer.email });
});

router.post('/customer/logout', (req, res) => {
  delete req.session.customerId;
  res.json({ ok: true });
});

router.get('/customer/me', (req, res) => {
  if (!req.session.customerId) return res.status(401).json({ error: 'Not logged in' });
  const c = db.prepare('SELECT id, name, email FROM customers WHERE id = ?').get(req.session.customerId);
  if (!c) return res.status(401).json({ error: 'Not logged in' });
  res.json(c);
});

// ---------- Admin (Charlie): managing customer accounts ----------

function requireAdmin(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  const hd = db.prepare('SELECT is_admin, is_active FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  if (!hd || !hd.is_active) {
    req.session.hairdresserId = null;
    return res.status(401).json({ error: 'This account is no longer active' });
  }
  if (!hd.is_admin) return res.status(403).json({ error: 'Only the admin stylist can do that' });
  next();
}

// List everyone who's created a customer account (not people who've only
// ever booked anonymously - those never get a row in this table).
router.get('/admin/customers', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, email, created_at FROM customers ORDER BY created_at DESC').all();
  res.json(rows);
});

// Deletes the account itself only. Their booking history is untouched -
// bookings already store the customer's name/email directly, and
// bookings.customer_id just falls back to NULL (see db.js schema), so the
// salon keeps its records even after the account is gone.
router.delete('/admin/customers/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Customer account not found' });
  res.json({ ok: true });
});

router.post('/admin/customers/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer account not found' });
  const password_hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(password_hash, customer.id);
  res.json({ ok: true });
});

module.exports = router;
