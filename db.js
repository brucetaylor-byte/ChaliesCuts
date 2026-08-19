const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Locally this is just <project folder>/data. In production, set DATA_DIR to
// wherever your host's persistent volume is mounted (e.g. /app/storage) so
// the database survives deploys/restarts instead of living on ephemeral
// container storage - see README "Deploying live" for details.
const BASE_DIR = process.env.DATA_DIR || __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'booking.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS hairdressers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  instagram_url TEXT DEFAULT '',
  facebook_url TEXT DEFAULT '',
  tiktok_url TEXT DEFAULT '',
  snapchat_url TEXT DEFAULT '',
  website_url TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS availability_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,     -- YYYY-MM-DD
  end_date TEXT NOT NULL,       -- YYYY-MM-DD
  start_time TEXT NOT NULL,     -- HH:MM (24h)
  end_time TEXT NOT NULL,       -- HH:MM (24h)
  days_of_week TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6', -- comma-separated 0=Sun..6=Sat
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS availability_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,          -- YYYY-MM-DD
  start_time TEXT NOT NULL,    -- HH:MM (24h)
  end_time TEXT NOT NULL,      -- HH:MM (24h), always start_time + 30 min
  status TEXT NOT NULL DEFAULT 'open', -- open | pending | booked
  block_id INTEGER,            -- which availability_blocks row generated this slot, if any
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hairdresser_id, date, start_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES availability_slots(id) ON DELETE CASCADE,
  hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined | cancelled
  access_token TEXT UNIQUE NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS gallery_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hairdresser_id INTEGER REFERENCES hairdressers(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slots_hairdresser_date ON availability_slots(hairdresser_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
`);

// Lightweight migrations: add columns that might be missing from a database created
// before this column existed. CREATE TABLE IF NOT EXISTS above only affects brand-new
// databases, so existing installs need an explicit ALTER TABLE here.
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('hairdressers', 'snapchat_url', "TEXT DEFAULT ''");
ensureColumn('bookings', 'customer_phone', "TEXT DEFAULT ''");
ensureColumn('availability_slots', 'block_id', 'INTEGER');

// One-time backfill: availability_slots created before the "blocks" feature
// existed have no block_id, so they'd be invisible in the "Active blocks"
// list even though they're perfectly real, bookable (or already booked)
// slots. Group any such orphan slots by (hairdresser, start_time, end_time) -
// the same dimensions a block is defined by - and create a matching
// availability_blocks row for each group, tagging the slots with it. Runs
// once: after the first pass every slot has a block_id, so later restarts
// find zero orphans and skip straight past this.
function backfillLegacyAvailabilityBlocks() {
  const orphanCount = db.prepare('SELECT COUNT(*) AS c FROM availability_slots WHERE block_id IS NULL').get().c;
  if (orphanCount === 0) return;

  const groups = db.prepare(`
    SELECT hairdresser_id, start_time, end_time, MIN(date) AS start_date, MAX(date) AS end_date
    FROM availability_slots
    WHERE block_id IS NULL
    GROUP BY hairdresser_id, start_time, end_time
  `).all();

  const datesInGroup = db.prepare(`
    SELECT DISTINCT date FROM availability_slots
    WHERE hairdresser_id = ? AND start_time = ? AND end_time = ? AND block_id IS NULL
  `);
  const insertBlock = db.prepare(`
    INSERT INTO availability_blocks (hairdresser_id, start_date, end_date, start_time, end_time, days_of_week)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tagSlots = db.prepare(`
    UPDATE availability_slots SET block_id = ?
    WHERE hairdresser_id = ? AND start_time = ? AND end_time = ? AND block_id IS NULL
  `);

  const runAll = db.transaction(() => {
    for (const g of groups) {
      const dates = datesInGroup.all(g.hairdresser_id, g.start_time, g.end_time).map(r => r.date);
      const daysPresent = [...new Set(dates.map(d => new Date(d + 'T00:00:00').getDay()))].sort().join(',');
      const info = insertBlock.run(g.hairdresser_id, g.start_date, g.end_date, g.start_time, g.end_time, daysPresent);
      tagSlots.run(info.lastInsertRowid, g.hairdresser_id, g.start_time, g.end_time);
    }
  });
  runAll();
}
backfillLegacyAvailabilityBlocks();

module.exports = db;
