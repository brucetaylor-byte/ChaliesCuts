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

// Today's date (YYYY-MM-DD) in the salon's own timezone, regardless of what
// timezone the server itself happens to be running in. Railway's host clock
// runs on UTC, which is up to ~11 hours behind Melbourne - a naive
// `new Date().toISOString().slice(0, 10)` would silently think it's still
// "yesterday" for a big chunk of every day (whenever it's already tomorrow
// in Melbourne but not yet midnight UTC), making "is this booking in the
// past" checks unreliable right when they matter most.
function melbourneToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

module.exports = { formatDateForEmail, formatTimeForEmail, melbourneToday };
