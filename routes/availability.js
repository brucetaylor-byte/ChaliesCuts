const express = require('express');
const db = require('../db');

const router = express.Router();

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function isValidTime(s) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(s);
}

// Public: list slots for a hairdresser, optionally within a date range.
// Only exposes status, not who booked it.
router.get('/hairdresser/:hairdresserId', (req, res) => {
  const { from, to } = req.query;
  let query = 'SELECT id, date, start_time, end_time, status FROM availability_slots WHERE hairdresser_id = ?';
  const params = [req.params.hairdresserId];
  if (from) { query += ' AND date >= ?'; params.push(from); }
  if (to) { query += ' AND date <= ?'; params.push(to); }
  query += ' ORDER BY date, start_time';
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// Hairdresser: create a series of half-hour availability windows.
// Body: { startDate, endDate, daysOfWeek: [0-6] (optional, default = every day),
//         startTime: 'HH:MM', endTime: 'HH:MM' }
router.post('/', requireHairdresser, (req, res) => {
  const { startDate, endDate, daysOfWeek, startTime, endTime } = req.body || {};

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.status(400).json({ error: 'startDate and endDate must be valid YYYY-MM-DD dates' });
  }
  if (!isValidTime(startTime) || !isValidTime(endTime)) {
    return res.status(400).json({ error: 'startTime and endTime must be HH:MM (24h)' });
  }
  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  if (endMin <= startMin) {
    return res.status(400).json({ error: 'endTime must be after startTime' });
  }
  if ((endMin - startMin) % 30 !== 0) {
    return res.status(400).json({ error: 'The gap between startTime and endTime must be a multiple of 30 minutes' });
  }

  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  if (end < start) return res.status(400).json({ error: 'endDate must be on or after startDate' });
  const spanDays = Math.round((end - start) / 86400000);
  if (spanDays > 180) return res.status(400).json({ error: 'Please generate at most 180 days at a time' });

  const dayFilter = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
    ? new Set(daysOfWeek.map(Number))
    : null;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO availability_slots (hairdresser_id, date, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'open')
  `);

  let created = 0;
  const runAll = db.transaction(() => {
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (dayFilter && !dayFilter.has(d.getDay())) continue;
      const dateStr = d.toISOString().slice(0, 10);
      for (let m = startMin; m < endMin; m += 30) {
        const info = insert.run(req.session.hairdresserId, dateStr, toHHMM(m), toHHMM(m + 30));
        if (info.changes > 0) created += 1;
      }
    }
  });
  runAll();

  res.json({ created });
});

// Hairdresser: remove an open slot they created (e.g. changed their mind)
router.delete('/:id', requireHairdresser, (req, res) => {
  const slot = db.prepare('SELECT * FROM availability_slots WHERE id = ?').get(req.params.id);
  if (!slot || slot.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (slot.status !== 'open') {
    return res.status(409).json({ error: 'Only open (unrequested) slots can be removed' });
  }
  db.prepare('DELETE FROM availability_slots WHERE id = ?').run(slot.id);
  res.json({ ok: true });
});

module.exports = router;
