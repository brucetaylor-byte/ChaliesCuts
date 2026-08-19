const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');

const router = express.Router();

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function bookingWithSlot(booking) {
  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(booking.slot_id);
  const hd = db.prepare('SELECT id, display_name FROM hairdressers WHERE id = ?').get(booking.hairdresser_id);
  return { ...booking, slot, hairdresser: hd };
}

// Customer (anonymous or logged in): request a booking for an open slot.
router.post('/', (req, res) => {
  const { slotId, customerName, customerEmail, note } = req.body || {};

  let name = customerName;
  let email = customerEmail;
  let customerId = null;

  if (req.session.customerId) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
    if (c) { customerId = c.id; name = name || c.name; email = email || c.email; }
  }

  if (!slotId || !name || !email) {
    return res.status(400).json({ error: 'slotId, customerName and customerEmail are required' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address' });
  }

  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(slotId);
  if (!slot) return res.status(404).json({ error: 'That slot no longer exists' });

  // Atomically claim the slot only if it is still open, to avoid double-booking races.
  const claim = db.prepare(`UPDATE availability_slots SET status = 'pending' WHERE id = ? AND status = 'open'`).run(slotId);
  if (claim.changes === 0) {
    return res.status(409).json({ error: 'Sorry, that slot was just taken. Please pick another.' });
  }

  const accessToken = nanoid(24);
  const info = db.prepare(`
    INSERT INTO bookings (slot_id, hairdresser_id, customer_id, customer_name, customer_email, status, access_token, note)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(slotId, slot.hairdresser_id, customerId, name.trim(), email.trim().toLowerCase(), accessToken, note || '');

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
  res.json(bookingWithSlot(booking));
});

// Anonymous status lookup / management via private link.
router.get('/token/:token', (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE access_token = ?').get(req.params.token);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json(bookingWithSlot(booking));
});

// Logged-in customer: list their own bookings.
router.get('/mine', (req, res) => {
  if (!req.session.customerId) return res.status(401).json({ error: 'Not logged in' });
  const rows = db.prepare('SELECT * FROM bookings WHERE customer_id = ? ORDER BY created_at DESC').all(req.session.customerId);
  res.json(rows.map(bookingWithSlot));
});

// Cancel a booking, either as the logged-in customer who made it, or via their private token.
router.post('/cancel', (req, res) => {
  const { bookingId, token } = req.body || {};
  let booking;
  if (token) {
    booking = db.prepare('SELECT * FROM bookings WHERE access_token = ?').get(token);
  } else if (bookingId && req.session.customerId) {
    booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(bookingId, req.session.customerId);
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'cancelled' || booking.status === 'declined') {
    return res.status(409).json({ error: 'This booking is already ' + booking.status });
  }

  const runAll = db.transaction(() => {
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`).run(booking.id);
    db.prepare(`UPDATE availability_slots SET status = 'open' WHERE id = ?`).run(booking.slot_id);
  });
  runAll();

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  res.json(bookingWithSlot(updated));
});

// ---------- Hairdresser-side management ----------

// All bookings for the logged-in hairdresser (optionally filter by status).
router.get('/', requireHairdresser, (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM bookings WHERE hairdresser_id = ?';
  const params = [req.session.hairdresserId];
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params);
  res.json(rows.map(bookingWithSlot));
});

router.post('/:id/approve', requireHairdresser, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND hairdresser_id = ?').get(req.params.id, req.session.hairdresserId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'pending') return res.status(409).json({ error: `Booking is already ${booking.status}` });

  const runAll = db.transaction(() => {
    db.prepare(`UPDATE bookings SET status = 'approved', decided_at = datetime('now') WHERE id = ?`).run(booking.id);
    db.prepare(`UPDATE availability_slots SET status = 'booked' WHERE id = ?`).run(booking.slot_id);
  });
  runAll();

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  res.json(bookingWithSlot(updated));
});

router.post('/:id/decline', requireHairdresser, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND hairdresser_id = ?').get(req.params.id, req.session.hairdresserId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'pending') return res.status(409).json({ error: `Booking is already ${booking.status}` });

  const runAll = db.transaction(() => {
    db.prepare(`UPDATE bookings SET status = 'declined', decided_at = datetime('now') WHERE id = ?`).run(booking.id);
    db.prepare(`UPDATE availability_slots SET status = 'open' WHERE id = ?`).run(booking.slot_id);
  });
  runAll();

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  res.json(bookingWithSlot(updated));
});

module.exports = router;
