const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// See db.js for why this respects DATA_DIR - keeps uploaded photos on the
// same persistent volume as the database in production.
const BASE_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const UPLOAD_DIR = path.join(BASE_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Where in-progress chunked uploads live until they're finalised into
// UPLOAD_DIR. Kept as a subfolder of uploads/ so it rides along on the same
// persistent volume rather than the container's ephemeral disk.
const TMP_UPLOAD_DIR = path.join(UPLOAD_DIR, '.chunked-tmp');
if (!fs.existsSync(TMP_UPLOAD_DIR)) fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};

// Videos need a lot more headroom than photos - this is a shared cap for
// whichever file comes in. Phone video gets big fast (a minute of 1080p can
// easily be 100-200MB), so this is sized for a short gallery/profile clip
// rather than a photo.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

// Uploads are sent in small pieces rather than as one giant request. This
// isn't about Railway's own platform limit (their edge allows requests up to
// 15 minutes) - it's because SOMETHING in front of the app (their load
// balancer, most likely) was found to cut the connection with a 504 partway
// through a large single-request upload, well before either that 15-minute
// ceiling or our own server timeouts came into play. Keeping each request
// small and quick sidesteps whatever that shorter limit is, whatever it
// turns out to be, instead of us having to guess at a number to raise.
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2MB per request

function oversizedError() {
  return `That file is too big (over ${MAX_UPLOAD_MB}MB). Photos: JPEG/PNG/WEBP/GIF. Videos: MP4/WEBM/MOV, up to ${MAX_UPLOAD_MB}MB - try trimming the clip or lowering its resolution first.`;
}

function extensionFor(mimetype, originalName) {
  const fromName = path.extname(originalName || '').toLowerCase();
  if (fromName) return fromName;
  return MIME_EXTENSIONS[mimetype] || '';
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

// An upload session left behind (tab closed mid-upload, phone locked and the
// browser gave up, a deploy restarted the server) can never be resumed by
// this client, so there's no point keeping its temp file or DB row around.
// Sweeps on startup, and again every hour so a long-running server doesn't
// slowly accumulate abandoned partial uploads on disk.
const STALE_UPLOAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
function cleanupStaleUploads({ all } = {}) {
  const rows = all
    ? db.prepare('SELECT * FROM gallery_uploads').all()
    : db.prepare("SELECT * FROM gallery_uploads WHERE created_at < datetime('now', ?)").all(`-${STALE_UPLOAD_MAX_AGE_MS / 1000} seconds`);
  for (const u of rows) {
    fs.unlink(path.join(TMP_UPLOAD_DIR, u.temp_filename), () => {});
    db.prepare('DELETE FROM gallery_uploads WHERE id = ?').run(u.id);
  }
}
cleanupStaleUploads({ all: true }); // fresh start on every boot - none of these can be resumed anyway
setInterval(() => cleanupStaleUploads(), 60 * 60 * 1000).unref();

// Public: view the gallery (optionally filter by hairdresser)
router.get('/', (req, res) => {
  const { hairdresserId } = req.query;
  let query = `
    SELECT gallery_photos.id, gallery_photos.filename, gallery_photos.caption, gallery_photos.media_type, gallery_photos.created_at,
           hairdressers.id as hairdresser_id, hairdressers.display_name as hairdresser_name
    FROM gallery_photos LEFT JOIN hairdressers ON hairdressers.id = gallery_photos.hairdresser_id
  `;
  const params = [];
  if (hairdresserId) { query += ' WHERE gallery_photos.hairdresser_id = ?'; params.push(hairdresserId); }
  query += ' ORDER BY gallery_photos.created_at DESC';
  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({ ...r, url: `/uploads/${r.filename}` })));
});

// Step 1 of 3: start an upload session. Validates type/size up front (so a
// bad file is rejected before any bytes are sent) and hands back an
// uploadId plus the chunk size to split the file into.
router.post('/upload/init', requireHairdresser, (req, res) => {
  const { mimetype, totalBytes, filename, caption } = req.body || {};
  if (!mimetype || (!ALLOWED_IMAGE_TYPES.has(mimetype) && !ALLOWED_VIDEO_TYPES.has(mimetype))) {
    return res.status(400).json({ error: 'Only JPEG, PNG, WEBP, GIF photos or MP4, WEBM, MOV videos are allowed' });
  }
  const size = Number(totalBytes);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'Missing or invalid file size' });
  }
  if (size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: oversizedError() });
  }

  const id = crypto.randomUUID();
  const tempFilename = `${id}.part`;
  const mediaType = ALLOWED_VIDEO_TYPES.has(mimetype) ? 'video' : 'photo';
  const ext = extensionFor(mimetype, filename);

  fs.writeFileSync(path.join(TMP_UPLOAD_DIR, tempFilename), Buffer.alloc(0));
  db.prepare(`
    INSERT INTO gallery_uploads (id, hairdresser_id, mimetype, media_type, ext, caption, temp_filename, total_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.session.hairdresserId, mimetype, mediaType, ext, caption || '', tempFilename, size);

  res.json({ uploadId: id, chunkSize: CHUNK_SIZE_BYTES });
});

// Step 2 of 3: append one chunk. Chunks are expected in order (the client
// sends them sequentially and waits for each response before sending the
// next), and the raw bytes are appended straight onto the temp file as they
// arrive - no need to hold the whole video in memory at once.
const rawChunkParser = express.raw({ type: () => true, limit: CHUNK_SIZE_BYTES + 65536 });

router.post('/upload/:uploadId/chunk', requireHairdresser, rawChunkParser, (req, res) => {
  const upload = db.prepare('SELECT * FROM gallery_uploads WHERE id = ?').get(req.params.uploadId);
  if (!upload || upload.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Upload session not found - it may have expired. Please start the upload again.' });
  }
  const chunk = req.body;
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
    return res.status(400).json({ error: 'Empty chunk received' });
  }
  const newReceived = upload.received_bytes + chunk.length;
  if (newReceived > upload.total_bytes) {
    return res.status(400).json({ error: 'Received more data than expected for this upload' });
  }
  try {
    fs.appendFileSync(path.join(TMP_UPLOAD_DIR, upload.temp_filename), chunk);
  } catch (err) {
    console.error(`[gallery chunked upload] failed writing a chunk for upload ${upload.id}:`, err);
    return res.status(500).json({ error: 'Could not save this part of the upload - please try again' });
  }
  db.prepare('UPDATE gallery_uploads SET received_bytes = ? WHERE id = ?').run(newReceived, upload.id);
  res.json({ receivedBytes: newReceived });
});

// Lets the client check how many bytes actually made it to disk before
// deciding what to resend after a failed chunk. A chunk can succeed on the
// server even if the client never sees the response (the reply itself can
// drop on a flaky connection) - without this, retrying would resend bytes
// that already landed and corrupt the upload.
router.get('/upload/:uploadId/status', requireHairdresser, (req, res) => {
  const upload = db.prepare('SELECT * FROM gallery_uploads WHERE id = ?').get(req.params.uploadId);
  if (!upload || upload.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Upload session not found - it may have expired. Please start the upload again.' });
  }
  res.json({ receivedBytes: upload.received_bytes, totalBytes: upload.total_bytes });
});

// Step 3 of 3: all chunks are in - verify nothing is missing, move the temp
// file into place, and create the gallery row exactly like the old
// single-request upload used to.
router.post('/upload/:uploadId/complete', requireHairdresser, (req, res) => {
  const upload = db.prepare('SELECT * FROM gallery_uploads WHERE id = ?').get(req.params.uploadId);
  if (!upload || upload.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Upload session not found - it may have expired. Please start the upload again.' });
  }
  const tempPath = path.join(TMP_UPLOAD_DIR, upload.temp_filename);
  let actualSize;
  try {
    actualSize = fs.statSync(tempPath).size;
  } catch (err) {
    return res.status(400).json({ error: 'Upload data is missing - please try uploading again' });
  }
  if (actualSize !== upload.total_bytes) {
    return res.status(400).json({ error: `Upload is incomplete (received ${actualSize} of ${upload.total_bytes} bytes) - please try again` });
  }

  const finalFilename = `${crypto.randomUUID()}${upload.ext}`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);
  fs.renameSync(tempPath, finalPath);

  const info = db.prepare('INSERT INTO gallery_photos (hairdresser_id, filename, caption, media_type) VALUES (?, ?, ?, ?)')
    .run(upload.hairdresser_id, finalFilename, upload.caption, upload.media_type);
  db.prepare('DELETE FROM gallery_uploads WHERE id = ?').run(upload.id);

  const photo = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ...photo, url: `/uploads/${photo.filename}` });
});

// Hairdresser: delete one of their own photos/videos
router.delete('/:id', requireHairdresser, (req, res) => {
  const photo = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(req.params.id);
  if (!photo || photo.hairdresser_id !== req.session.hairdresserId) {
    return res.status(404).json({ error: 'Photo not found' });
  }
  db.prepare('DELETE FROM gallery_photos WHERE id = ?').run(photo.id);
  const filePath = path.join(UPLOAD_DIR, photo.filename);
  fs.unlink(filePath, () => {});
  res.json({ ok: true });
});

module.exports = router;
