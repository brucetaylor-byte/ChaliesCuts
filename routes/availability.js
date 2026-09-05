const express = require('express');
const db = require('../db');
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

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function normalizeDays(daysOfWeek) {
  const days = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
    ? [...new Set(daysOfWeek.map(Number))].filter(d => d >= 0 && d <= 6).sort()
    : ALL_DAYS;
  return days;
}

// Validates the shared fields used by both "create a block" and "edit a
// block". Returns an error string, or null if everything's valid.
function validateBlockFields({ startDate, endDate, startTime, endTime }) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return 'startDate and endDate must be valid YYYY-MM-DD dates';
  }
  if (!isValidTime(startTime) || !isValidTime(endTime)) {
    return 'startTime and endTime must be HH:MM (24h)';
  }
  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  if (endMin <= startMin) return 'endTime must be after startTime';
  if ((endMin - startMin) % 30 !== 0) return 'The gap between startTime and endTime must be a multiple of 30 minutes';

  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  if (end < start) return 'endDate must be on or after startDate';
  const spanDays = Math.round((end - start) / 86400000);
  if (spanDays > 180) return 'Please generate at most 180 days at a time';

  return null;
}

// Creates (or extends) the individual half-hour open slots implied by a
// block's parameters, tagging each newly-created slot with blockId so it can
// be listed/edited/removed as a group later. Never touches slots that
// already exist (e.g. already booked, or created by a different block) -
// this is always purely additive.
function generateSlotsForBlock(hairdresserId, blockId, { startDate, endDate, startTime, endTime, daysOfWeek }) {
  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  const dayFilter = new Set(normalizeDays(daysOfWeek));
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO availability_slots (hairdresser_id, date, start_time, end_time, status, block_id)
    VALUES (?, ?, ?, ?, 'open', ?)
  `);

  let created = 0;
  const runAll = db.transaction(() => {
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (!dayFilter.has(d.getDay())) continue;
      const dateStr = d.toISOString().slice(0, 10);
      for (let m = startMin; m < endMin; m += 30) {
        const info = insert.run(hairdresserId, dateStr, toHHMM(m), toHHMM(m + 30), blockId);
        if (info.changes > 0) created += 1;
      }
    }
  });
  runAll();
  return created;
}

function blockWithCounts(block) {
  const openCount = db.prepare(`SELECT COUNT(*) AS c FROM availability_slots WHERE block_id = ? AND status = 'open'`).get(block.id).c;
  const otherCount = db.prepare(`SELECT COUNT(*) AS c FROM availability_slots WHERE block_id = ? AND status != 'open'`).get(block.id).c;
  return {
    id: block.id,
    startDate: block.start_date,
    endDate: block.end_date,
    startTime: block.start_time,
    endTime: block.end_time,
    daysOfWeek: block.days_of_week.split(',').map(Number),
    openSlotCount: openCount,
    bookedOrPendingSlotCount: otherCount
  };
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

// Hairdresser: list their own "active" availability blocks (ones whose date
// range hasn't fully passed yet), in calendar order, for the "Active
// blocks" management list.
router.get('/blocks', requireHairdresser, (req, res) => {
  const today = melbourneToday();
  const rows = db.prepare(`
    SELECT * FROM availability_blocks
    WHERE hairdresser_id = ? AND end_date >= ?
    ORDER BY start_date, start_time
  `).all(req.session.hairdresserId, today);
  res.json(rows.map(blockWithCounts));
});

// Hairdresser: create a series of half-hour availability windows, recorded
// as a "block" so it can be listed/edited/removed as a group later.
// Body: { startDate, endDate, daysOfWeek: [0-6] (optional, default = every day),
//         startTime: 'HH:MM', endTime: 'HH:MM' }
router.post('/', requireHairdresser, (req, res) => {
  const { startDate, endDate, daysOfWeek, startTime, endTime } = req.body || {};
  const error = validateBlockFields({ startDate, endDate, startTime, endTime });
  if (error) return res.status(400).json({ error });

  const days = normalizeDays(daysOfWeek);
  const info = db.prepare(`
    INSERT INTO availability_blocks (hairdresser_id, start_date, end_date, start_time, end_time, days_of_week)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.session.hairdresserId, startDate, endDate, startTime, endTime, days.join(','));
  const blockId = info.lastInsertRowid;

  const created = generateSlotsForBlock(req.session.hairdresserId, blockId, { startDate, endDate, startTime, endTime, daysOfWeek: days });
  res.json({ created, blockId });
});

// Hairdresser: edit an existing block's date range / hours / days. This is
// always additive - it can create newly-implied open slots, but never
// deletes or touches slots that already exist (including ones a customer
// has already booked), even if they now fall outside the edited range.
router.put('/blocks/:id', requireHairdresser, (req, res) => {
  const block = db.prepare('SELECT * FROM availability_blocks WHERE id = ?').get(req.params.id);
  if (!block || block.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Block not found' });
  }
  const { startDate, endDate, daysOfWeek, startTime, endTime } = req.body || {};
  const error = validateBlockFields({ startDate, endDate, startTime, endTime });
  if (error) return res.status(400).json({ error });

  const days = normalizeDays(daysOfWeek);
  db.prepare(`
    UPDATE availability_blocks SET start_date = ?, end_date = ?, start_time = ?, end_time = ?, days_of_week = ?
    WHERE id = ?
  `).run(startDate, endDate, startTime, endTime, days.join(','), block.id);

  const created = generateSlotsForBlock(req.session.hairdresserId, block.id, { startDate, endDate, startTime, endTime, daysOfWeek: days });
  res.json({ created, blockId: block.id });
});

// Hairdresser: remove a block. Only removes the slots from it that are
// still open (unrequested) - any already booked or pending stay untouched,
// since removing a block shouldn't silently cancel a real customer booking.
router.delete('/blocks/:id', requireHairdresser, (req, res) => {
  const block = db.prepare('SELECT * FROM availability_blocks WHERE id = ?').get(req.params.id);
  if (!block || block.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Block not found' });
  }
  const removedSlots = db.prepare(`DELETE FROM availability_slots WHERE block_id = ? AND status = 'open'`).run(block.id).changes;
  const remainingBookedSlots = db.prepare(`SELECT COUNT(*) AS c FROM availability_slots WHERE block_id = ? AND status != 'open'`).get(block.id).c;
  db.prepare('DELETE FROM availability_blocks WHERE id = ?').run(block.id);
  res.json({ removedSlots, remainingBookedSlots });
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
