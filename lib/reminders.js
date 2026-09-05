// Sends a reminder email roughly 24 hours before an approved appointment.
// Runs as a periodic sweep inside the app itself (same idea as the stale-
// upload cleanup in routes/gallery.js) rather than a separate scheduled job -
// this is a single long-running Node process, so no extra infrastructure is
// needed for "check every so often and act if it's time".
const db = require('../db');
const { sendMail } = require('./mailer');
const { formatDateForEmail, formatTimeForEmail } = require('./emailFormat');

// Same address/contact block used on the booking-confirmed email, so the
// reminder reads consistently with everything else customers get from us.
const VENUE_ADDRESS = '36 Wyralla Crescent\nGisborne, 3437';
const VENUE_CONTACTS = 'Contact Charlie on 0493 032 545 if you need to make any change to your appointment, ideally at least 24 hours before.';

const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000; // send ~1 day ahead of the appointment
const REMINDER_WINDOW_MARGIN_MS = 45 * 60 * 1000; // +/- 45 min around that point
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min - comfortably inside the window above, so a booking can never fall between two sweeps unnoticed

// A slot's date/time is stored as Melbourne-local wall-clock strings (see
// melbourneToday() in emailFormat.js for why - the server's own clock may be
// running in UTC). To find "bookings whose appointment is ~24 hours from
// now", we need the Melbourne wall-clock date+time exactly 24 real hours
// from this instant, expressed the same way, so it can be compared directly
// against slot.date/slot.start_time as plain strings.
function melbourneDateTimeParts(instant) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
  });
  const parts = fmt.formatToParts(instant);
  const get = (type) => parts.find(p => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function reminderWindowKeys(now = Date.now()) {
  const lower = melbourneDateTimeParts(new Date(now + REMINDER_LEAD_MS - REMINDER_WINDOW_MARGIN_MS));
  const upper = melbourneDateTimeParts(new Date(now + REMINDER_LEAD_MS + REMINDER_WINDOW_MARGIN_MS));
  return { lowerKey: lower.date + lower.time, upperKey: upper.date + upper.time };
}

function bookingWithSlotAndHairdresser(booking) {
  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(booking.slot_id);
  const hairdresser = db.prepare('SELECT id, display_name FROM hairdressers WHERE id = ?').get(booking.hairdresser_id);
  return { ...booking, slot, hairdresser };
}

async function sendReminderEmail(booking) {
  const when = `${formatTimeForEmail(booking.slot.start_time)} on ${formatDateForEmail(booking.slot.date)}`;
  const subject = `Appointment reminder - ${formatDateForEmail(booking.slot.date)}`;
  const text = `Hi ${booking.customer_name},\n\nReminder: you have an appointment with Charlie's Cuts tomorrow at ${when}, with ${booking.hairdresser.display_name}.\n\nPlease be at:\n${VENUE_ADDRESS}\n\n${VENUE_CONTACTS}\n\nCharlie's Cuts`;
  await sendMail({ to: booking.customer_email, subject, text });
}

let sweepInProgress = false;

async function sweepAppointmentReminders() {
  if (sweepInProgress) return; // don't overlap if a previous sweep is still mid-send
  sweepInProgress = true;
  try {
    const { lowerKey, upperKey } = reminderWindowKeys();
    const candidates = db.prepare(`
      SELECT bookings.* FROM bookings
      JOIN availability_slots ON availability_slots.id = bookings.slot_id
      WHERE bookings.status = 'approved'
        AND bookings.reminder_sent_at IS NULL
        AND (availability_slots.date || availability_slots.start_time) BETWEEN ? AND ?
    `).all(lowerKey, upperKey);

    for (const row of candidates) {
      const booking = bookingWithSlotAndHairdresser(row);
      if (!booking.customer_email || !booking.slot || !booking.hairdresser) continue;
      try {
        await sendReminderEmail(booking);
        db.prepare(`UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?`).run(booking.id);
      } catch (err) {
        console.error(`Failed to send appointment reminder for booking ${booking.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Appointment reminder sweep failed:', err.message);
  } finally {
    sweepInProgress = false;
  }
}

function startReminderScheduler() {
  // A short initial delay avoids piling straight into a sweep the instant
  // the process boots, alongside everything else that happens on startup.
  setTimeout(sweepAppointmentReminders, 30 * 1000).unref();
  setInterval(sweepAppointmentReminders, SWEEP_INTERVAL_MS).unref();
}

module.exports = { startReminderScheduler, sweepAppointmentReminders, reminderWindowKeys };
