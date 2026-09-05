const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { sendMail } = require('../lib/mailer');
const { formatDateForEmail, formatTimeForEmail, melbourneToday } = require('../lib/emailFormat');

const router = express.Router();

// Shared salon address/contact block, appended to booking-confirmed emails
// so a customer knows exactly where to show up without having to ask.
const VENUE_ADDRESS = '36 Wyralla Crescent\nGisborne, 3437';
const VENUE_CONTACTS = 'Contact Charlie on 0493 032 545 if you need to make any change to your appointment, ideally at least 24 hours before.';

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
      text = `Hi ${booking.customer_name},\n\nThank you for your booking - your appointment with ${stylist} has been confirmed for ${when}.\n\nPlease be at:\n${VENUE_ADDRESS}\n\n${VENUE_CONTACTS}\n\nNeed to check the details? Use your booking link:\n${link}\n\nSee you then!\nCharlie's Cuts`;
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

// Fire-and-forget: tells the stylist a new booking request has come in, sent
// to whichever email Charlie set up for them (contact_email) - so booking
// queries land in each stylist's own inbox rather than one shared one, and
// they don't have to keep the dashboard open to notice a new request. Same
// swallow-errors behaviour as notifyBookingEmail: never breaks the customer's
// booking request even if the email fails or no contact_email is set yet.
async function notifyStylistOfNewRequest(req, booking) {
  try {
    const hd = db.prepare('SELECT display_name, contact_email FROM hairdressers WHERE id = ?').get(booking.hairdresser_id);
    if (!hd || !hd.contact_email) return;
    const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(booking.slot_id);
    if (!slot) return;
    const when = `${formatDateForEmail(slot.date)} at ${formatTimeForEmail(slot.start_time)}`;
    const contactBits = [booking.customer_email, booking.customer_phone].filter(Boolean).join(' / ');
    const subject = `New booking request - ${formatDateForEmail(slot.date)}`;
    const text = `Hi ${hd.display_name},\n\n${booking.customer_name} has requested ${when}${contactBits ? ` (${contactBits})` : ''}.${booking.note ? `\n\nNote: ${booking.note}` : ''}\n\nApprove or decline it from your dashboard's "Pending requests" list.\n\nCharlie's Cuts`;
    await sendMail({ to: hd.contact_email, subject, text });
  } catch (err) {
    console.error('notifyStylistOfNewRequest failed:', err.message);
  }
}

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  const hd = db.prepare('SELECT is_active FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  if (!hd || !hd.is_active) {
    req.session.hairdresserId = null;
    return res.status(401).json({ error: 'This account is no longer active' });
  }
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

// Customer: request a booking for an open slot. There are no customer
// accounts - every booking is anonymous, identified only by the name/email/
// phone given on the form, plus the private access_token link emailed back.
router.post('/', (req, res) => {
  const { slotId, customerName, customerEmail, customerPhone, note } = req.body || {};
  const name = customerName;
  const email = customerEmail;

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
    INSERT INTO bookings (slot_id, hairdresser_id, customer_name, customer_email, customer_phone, status, access_token, note)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(slotId, slot.hairdresser_id, name.trim(), email.trim().toLowerCase(), (customerPhone || '').trim(), accessToken, note || '');

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(info.lastInsertRowid);
  notifyStylistOfNewRequest(req, booking);
  res.json(bookingWithSlot(booking));
});

// Anonymous status lookup / management via private link.
router.get('/token/:token', (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE access_token = ?').get(req.params.token);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json(bookingWithSlot(booking));
});

// Cancel a booking - hairdresser only (e.g. cancelling a phone booking, or
// actioning a customer's request that came in by phone/text). Customers
// cannot cancel online themselves any more: the booking-confirmation email
// points them to call Charlie directly instead, ideally 24 hours ahead, so
// every cancellation goes through a real conversation rather than a click.
//
// Reopening the freed-up slot is a separate choice (reopenSlot), not an
// automatic side effect - sometimes that time should go straight back up
// for other customers, other times Charlie wants to just block it off
// (the slot's about to pass anyway, he's taking that time for something
// else, etc). Defaults to true so anything that doesn't pass it explicitly
// keeps the old always-reopen behaviour.
router.post('/cancel', requireHairdresser, (req, res) => {
  const { bookingId, reopenSlot } = req.body || {};
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND hairdresser_id = ?').get(bookingId, req.session.hairdresserId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'cancelled' || booking.status === 'declined') {
    return res.status(409).json({ error: 'This booking is already ' + booking.status });
  }

  const shouldReopen = reopenSlot !== false;
  const runAll = db.transaction(() => {
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`).run(booking.id);
    if (shouldReopen) {
      db.prepare(`UPDATE availability_slots SET status = 'open' WHERE id = ?`).run(booking.slot_id);
    }
  });
  runAll();

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const full = bookingWithSlot(updated);
  notifyBookingEmail(req, full, 'cancelled');
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
  let mapped = rows.map(bookingWithSlot);
  // A "pending request" for a slot whose time has already passed can never be
  // approved (there's nothing left to confirm), so it's just dead clutter in
  // the dashboard's action list rather than something the stylist needs to
  // decide on. Drop those from the pending view - the row itself is left
  // alone (still queryable with no status filter) so nothing is lost, it
  // just stops demanding attention.
  if (status === 'pending') {
    const today = melbourneToday();
    mapped = mapped.filter(b => !b.slot || b.slot.date >= today);
  }
  res.json(mapped);
});

// Toggle a purely informational "paid" flag on a booking - Charlie's manual
// process today is crossing a name off his paper schedule once they've paid
// in person; this is that, digitised. It doesn't change the booking's
// status or move it out of any list - just marks it for his own reference.
router.post('/:id/paid', requireHairdresser, (req, res) => {
  const { paid } = req.body || {};
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND hairdresser_id = ?').get(req.params.id, req.session.hairdresserId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  db.prepare('UPDATE bookings SET paid = ? WHERE id = ?').run(paid ? 1 : 0, booking.id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  res.json(bookingWithSlot(updated));
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

// Exposed so routes/hairdressers.js can reuse them when removing a stylist
// (cancelling their upcoming bookings and emailing the affected customers).
router.notifyBookingEmail = notifyBookingEmail;
router.bookingWithSlot = bookingWithSlot;

module.exports = router;
