const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const bookingsRouter = require('./bookings');
const { melbourneToday } = require('../lib/emailFormat');

const router = express.Router();

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  const hd = db.prepare('SELECT is_active FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  if (!hd || !hd.is_active) {
    req.session.hairdresserId = null;
    return res.status(401).json({ error: 'This account is no longer active' });
  }
  next();
}

// Only Charlie's account (the one admin) can add/remove stylist logins or reset passwords.
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

// is_admin is included so the dashboard's stylist-management list knows which
// account can't be removed - it's not sensitive, just a boolean flag.
const PUBLIC_FIELDS = 'id, username, display_name, bio, instagram_url, facebook_url, tiktok_url, snapchat_url, website_url, is_admin';

// Public: list active hairdressers so a customer can choose. A removed
// stylist (is_active = 0) simply stops appearing here.
router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM hairdressers WHERE is_active = 1 ORDER BY id`).all();
  res.json(rows.map(r => ({ ...r, is_admin: !!r.is_admin })));
});

// Admin only (Charlie): add a new stylist login. It gets its own calendar,
// availability, bookings and gallery just like any other stylist - it's
// just not an admin itself, so it won't see this "add a stylist" feature.
router.post('/', requireAdmin, (req, res) => {
  const { username, password, display_name, contact_email } = req.body || {};
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'Username, password and display name are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const normalizedUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,20}$/.test(normalizedUsername)) {
    return res.status(400).json({ error: 'Username should be 3-20 characters: letters, numbers, - or _ only' });
  }
  // Every stylist gets their own booking-notification email, set here by
  // Charlie when the account is created - this is where new booking requests
  // get emailed, so each stylist manages their own customer list rather than
  // everything funnelling through one inbox.
  const normalizedEmail = (contact_email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ error: "A booking notification email is required for the new stylist" });
  }
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Please provide a valid booking notification email' });
  }
  const existing = db.prepare('SELECT id FROM hairdressers WHERE username = ?').get(normalizedUsername);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const password_hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO hairdressers (username, password_hash, display_name, bio, is_admin, contact_email)
    VALUES (?, ?, ?, '', 0, ?)
  `).run(normalizedUsername, password_hash, display_name.trim(), normalizedEmail);
  const created = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM hairdressers WHERE id = ?`).get(info.lastInsertRowid);
  res.json({ ...created, is_admin: !!created.is_admin });
});

// Admin only (Charlie): force-set any stylist's password directly - unlike
// the profile page's own "change password" form, this doesn't need the
// current password, so it also works for a stylist who's locked out.
router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const target = db.prepare('SELECT id, display_name FROM hairdressers WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Stylist not found' });
  const password_hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE hairdressers SET password_hash = ? WHERE id = ?').run(password_hash, target.id);
  res.json({ ok: true });
});

// Admin only (Charlie): remove a stylist. This is a soft removal, not a hard
// delete - their account just stops being able to log in and disappears from
// the public booking page and every "other stylist" view. Past bookings,
// availability history and gallery photos are all preserved. Charlie's own
// admin account can never be removed this way. If the stylist has upcoming
// pending/approved bookings, the caller must confirm (confirmCancelBookings:
// true) before they're cancelled and the affected customers emailed.
router.delete('/:id', requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT * FROM hairdressers WHERE id = ?').get(targetId);
  if (!target || !target.is_active) return res.status(404).json({ error: 'Stylist not found' });
  if (target.is_admin) return res.status(400).json({ error: "Charlie's admin account can't be removed" });

  const today = melbourneToday();
  const upcoming = db.prepare(`
    SELECT bookings.* FROM bookings
    JOIN availability_slots ON availability_slots.id = bookings.slot_id
    WHERE bookings.hairdresser_id = ? AND bookings.status IN ('pending', 'approved') AND availability_slots.date >= ?
  `).all(targetId, today);

  if (upcoming.length > 0 && !req.body?.confirmCancelBookings) {
    return res.status(409).json({
      error: `${target.display_name} has ${upcoming.length} upcoming booking(s). Confirm to cancel them and email the affected customers.`,
      upcomingBookingsCount: upcoming.length
    });
  }

  const runAll = db.transaction(() => {
    for (const b of upcoming) {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`).run(b.id);
    }
    db.prepare('UPDATE hairdressers SET is_active = 0 WHERE id = ?').run(targetId);
  });
  runAll();

  for (const b of upcoming) {
    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
    bookingsRouter.notifyBookingEmail(req, bookingsRouter.bookingWithSlot(updated), 'cancelled');
  }

  res.json({ ok: true, cancelledBookings: upcoming.length });
});

// Public: single hairdresser profile
router.get('/:id', (req, res) => {
  const hd = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM hairdressers WHERE id = ? AND is_active = 1`).get(req.params.id);
  if (!hd) return res.status(404).json({ error: 'Not found' });
  res.json({ ...hd, is_admin: !!hd.is_admin });
});

// Logged-in hairdresser: update own profile / bio / socials / booking notification email
router.put('/me', requireHairdresser, (req, res) => {
  const { display_name, bio, instagram_url, facebook_url, tiktok_url, snapchat_url, website_url, contact_email } = req.body || {};
  const current = db.prepare('SELECT * FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);

  let normalizedContactEmail = current.contact_email;
  if (contact_email !== undefined) {
    const trimmed = contact_email.trim().toLowerCase();
    if (trimmed && !/^\S+@\S+\.\S+$/.test(trimmed)) {
      return res.status(400).json({ error: 'Please provide a valid booking notification email, or leave it blank' });
    }
    normalizedContactEmail = trimmed;
  }

  db.prepare(`UPDATE hairdressers SET display_name = ?, bio = ?, instagram_url = ?, facebook_url = ?, tiktok_url = ?, snapchat_url = ?, website_url = ?, contact_email = ? WHERE id = ?`)
    .run(
      display_name ?? current.display_name,
      bio ?? current.bio,
      instagram_url ?? current.instagram_url,
      facebook_url ?? current.facebook_url,
      tiktok_url ?? current.tiktok_url,
      snapchat_url ?? current.snapchat_url,
      website_url ?? current.website_url,
      normalizedContactEmail,
      req.session.hairdresserId
    );
  const updated = db.prepare(`SELECT ${PUBLIC_FIELDS}, contact_email FROM hairdressers WHERE id = ?`).get(req.session.hairdresserId);
  res.json({ ...updated, is_admin: !!updated.is_admin });
});

module.exports = router;
