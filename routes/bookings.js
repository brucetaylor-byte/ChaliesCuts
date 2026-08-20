const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { sendMail } = require('../lib/mailer');
const { formatDateForEmail, formatTimeForEmail } = require('../lib/emailFormat');

const router = express.Router();

// Shared salon address/contact block, appended to booking-confirmed emails
// so a customer knows exactly where to show up without having to ask.
const VENUE_ADDRESS = '36 Wyralla Crescent\nGisborne, 3437';
const VENUE_CONTACTS = 'Contact either Charlie on 0493 032 545 or Angus on [ADD ANGUS\'S NUMBER]';

// Fire-and-forget booking status email. Never throws - a template or send
// failure is logged and swallowed so it can never break the request that
// triggered it (approve/decline/cancel all respond to the client either way).
async function notifyBookingEmail(req, booking, kind) {
  try {
    if (!booking.customer_email || !booking.slot || !booking.hairdresser) return;
    const when = `${formatDateForEmail(booking.slot.date)} at ${formatTimeForEmail(booking.slot.start_time)}`;
    const stylist = booking.hairdresser.display_name;
    const link = `${req.protocol}://${req.get('host')}/booking-status.html?token=${booking.access_token}`;
    let subject, text;
    if (kind === 'approved') {
      subject = `Booking confirmed - ${formatDateForEmail(booking.slot.date)}`;
      text = `Hi ${booking.customer_name},\n\nThank you for your booking - your appointment with ${stylist} has been confirmed for ${when}.\n\nPlease be at:\n${VENUE_ADDRESS}\n\n${VENUE_CONTACTS}\n\nNeed to check the details or cancel later? Use your booking link:\n${link}\n\nSee you then!\nCharlie's Cuts`;
    } else if (kind === 'declined') {
      subject = `About your booking request - ${formatDateForEmail(booking.slot.date)}`;
      text = `Hi ${booking.customer_name},\n\nSorry, ${stylist} isn't able to take your requested slot on ${when}. Head back to the app when you get a chance and pick another time that suits.\n\nCharlie's Cuts`;
    } else if (kind === 'cancelled') {
      subject = `Booking cancelled - ${formatDateForEmail(booking.slot.date)}`;
      text = `Hi ${booking.customer_name},\n\nYour booking with ${stylist} for ${when} has had to be cancelled. Sorry for the inconvenience - head back to the app if you'd like to book another time.\n\nCharlie's Cuts`;
    } else {
      return;
    }
    await sendMail({ to: booking.customer_email, subject, text });
  } catch (err) {
    console.error('notifyBookingEmail failed:', err.message);
  }
}

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function bookingWithSlot(booking) {
  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(booking.slot_id);
  const hd = db.prepare('SELECT id, display_name FROM hairdressers WHERE id = ?').get(booking.hairdresser_id);
  return { ...booking, slot, hairdresser: hd };
}

// Accepts Australian mobile numbers in common written forms:
//   0412 345 678 / 0412345678 / +61 412 345 678 / 61412345678
// Spaces/dashes/parens are ignored. An empty string passes (the field is optional).
function isValidAuMobile(phone) {
  const trimmed = (phone || '').trim();
  if (!trimmed) return true;
  const digitsAndPlus = trimmed.replace(/[\s-()]/g, '');
  return /^(?:0|\+?61)4\d{8}$/.test(digitsAndPlus);
}

// Customer (anonymous or logged in): request a booking for an open slot.
router.post('/', (req, res) => {
  const { slotId, customerName, customerEmail, customerPhone, note } = req.body || {};

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
  if (!isValidAuMobile(customerPhone)) {
    return res.status(400).json({ error: 'Please provide a valid Australian mobile number (e.g. 0412 345 678), or leave it blank' });
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
    INSERT INTO bookings (slot_id, hairdresser_id, customer_id, customer_name, customer_email, customer_phone, status, access_token, note)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(slotId, slot.hairdresser_id, customerId, name.trim(), email.trim().toLowerCase(), (customerPhone || '').trim(), accessToken, note || '');

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

// Cancel a booking: as the logged-in customer who made it, via their private token,
// or as the hairdresser it belongs to (e.g. cancelling a phone booking).
router.post('/cancel', (req, res) => {
  const { bookingId, token } = req.body || {};
  let booking;
  let cancelledByHairdresser = false;
  if (token) {
    booking = db.prepare('SELECT * FROM bookings WHERE access_token = ?').get(token);
  } else if (bookingId && req.session.customerId) {
    booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(bookingId, req.session.customerId);
  } else if (bookingId && req.session.hairdresserId) {
    booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND hairdresser_id = ?').get(bookingId, req.session.hairdresserId);
    cancelledByHairdresser = true;
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
  const full = bookingWithSlot(updated);
  // Only email the customer when the stylist cancelled it - if the customer
  // cancelled it themselves they obviously already know.
  if (cancelledByHairdresser) notifyBookingEmail(req, full, 'cancelled');
  res.json(full);
});

// ---------- Hairdresser-side management ----------

// Hairdresser: manually book an open slot on a customer's behalf (e.g. a phone booking).
// Goes straight to "approved" since the stylist is creating it themselves - no self-approval step needed.
router.post('/manual', requireHairdresser, (req, res) => {
  const { slotId, customerName, customerEmail, customerPhone, note } = req.body || {};
  if (!slotId || !customerName || !customerName.trim()) {
    return res.status(400).json({ error: 'slotId and a customer name are required' });
  }
  const email = (customerEmail || '').trim();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address, or leave it blank' });
  }
  if (!isValidAuMobile(customerPhone)) {
    return res.status(400).json({ error: 'Please provide a valid Australian mobile number (e.g. 0412 345 678), or leave it blank' });
  }

  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(slotId);
  if (!slot || slot.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Slot not found' });
  }

  const claim = db.prepare(`UPDATE availability_slots SET status = 'booked' WHERE id = ? AND status = 'open'`).run(slotId);
  if (claim.changes === 0) {
    return res.status(409).json({ error: 'That slot is no longer open.' });
  }

  const accessToken = nanoid(24);
  const info = db.prepare(`
    INSERT INTO bookings (slot_id, hairdresser_id, customer_id, customer_name, customer_email, customer_phone, status, access_token, note, decided_at)
    VALUES (?, ?, NULL, ?, ?, ?, 'approved', ?, ?, datetime('now'))
  `).run(slotId, slot.hairdresser_id, customerName.trim(), email, (customerPhone || '').trim(), accessToken, note || '');

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
  const full = bookingWithSlot(booking);
  notifyBookingEmail(req, full, 'approved');
  res.json(full);
});

// Hairdresser: look up the active (non-cancelled/declined) booking tied to one of their own slots,
// so clicking a booked/pending slot in the dashboard calendar can show who it's for.
router.get('/slot/:slotId', requireHairdresser, (req, res) => {
  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(req.params.slotId);
  if (!slot || slot.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  const booking = db.prepare(`
    SELECT * FROM bookings
    WHERE slot_id = ? AND status IN ('pending', 'approved')
    ORDER BY created_at DESC LIMIT 1
  `).get(slot.id);
  if (!booking) return res.status(404).json({ error: 'No active booking for this slot' });
  res.json(bookingWithSlot(booking));
});

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
  const full = bookingWithSlot(updated);
  notifyBookingEmail(req, full, 'approved');
  res.json(full);
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
  const full = bookingWithSlot(updated);
  notifyBookingEmail(req, full, 'declined');
  res.json(full);
});

module.exports = router;
