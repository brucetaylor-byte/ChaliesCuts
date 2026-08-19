// Small date/time formatting helpers shared by booking confirmation emails.
// Split out from routes/bookings.js so they're easy to unit test directly.

function formatDateForEmail(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Australia/Melbourne' });
}

function formatTimeForEmail(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

module.exports = { formatDateForEmail, formatTimeForEmail };
