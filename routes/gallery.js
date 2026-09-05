const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');

const router = express.Router();

// See db.js for why this respects DATA_DIR - keeps uploaded photos on the
// same persistent volume as the database in production.
const BASE_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const UPLOAD_DIR = path.join(BASE_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

// Videos need a lot more headroom than photos - this is a shared cap for
// whichever file comes in (multer can't apply a different limit per mimetype
// up front). Phone video gets big fast (a minute of 1080p can easily be
// 100-200MB), so this is sized for a short gallery/profile clip rather than
// a photo. Railway's own edge network allows requests up to 15 minutes, so
// even a full 300MB upload has plenty of headroom on a slow mobile connection.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype) && !ALLOWED_VIDEO_TYPES.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP, GIF photos or MP4, WEBM, MOV videos are allowed'));
    }
    cb(null, true);
  }
});

function requireHairdresser(req, res, next) {
  if (!req.session.hairdresserId) return res.status(401).json({ error: 'Not logged in' });
  const hd = db.prepare('SELECT is_active FROM hairdressers WHERE id = ?').get(req.session.hairdresserId);
  if (!hd || !hd.is_active) {
    req.session.hairdresserId = null;
    return res.status(401).json({ error: 'This account is no longer active' });
  }
  next();
}

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

// Reject an oversized upload immediately, before multer even starts reading
// the file off the wire. Without this, a file bigger than the limit still
// streams in until multer's own fileSize check trips mid-upload - at which
// point it destroys the connection rather than sending a clean response, so
// the browser just sees the request die with no useful error after however
// long it took to get that far. Checking Content-Length up front means an
// oversized file fails fast with a proper message instead of silently
// hanging for however long the doomed upload takes.
function rejectOversized(req, res, next) {
  const contentLength = Number(req.headers['content-length']);
  if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `That file is too big (over ${MAX_UPLOAD_MB}MB). Photos: JPEG/PNG/WEBP/GIF. Videos: MP4/WEBM/MOV, up to ${MAX_UPLOAD_MB}MB - try trimming the clip or lowering its resolution first.` });
  }
  next();
}

// Tracks how much of the request body actually arrived before anything goes
// wrong, and logs it if the client disconnects mid-upload. This doesn't fix
// anything by itself, but a "connection dropped" error can mean a genuinely
// flaky mobile connection OR a server-side problem (e.g. a disk write
// failure on the upload volume) - without this we're guessing blind. Next
// time this happens, the logs will show which one it was.
function trackUploadProgress(req, res, next) {
  req._uploadBytesReceived = 0;
  req.on('data', (chunk) => { req._uploadBytesReceived += chunk.length; });
  req.on('aborted', () => {
    const total = req.headers['content-length'] || 'unknown';
    console.warn(`[gallery upload] client connection dropped after ${req._uploadBytesReceived}/${total} bytes (hairdresser ${req.session.hairdresserId})`);
  });
  next();
}

// Hairdresser: upload a photo or video to their own gallery section
router.post('/', requireHairdresser, rejectOversized, trackUploadProgress, (req, res) => {
  upload.single('media')(req, res, (err) => {
    if (err) {
      const total = req.headers['content-length'] || 'unknown';
      console.error(`[gallery upload] failed after ${req._uploadBytesReceived}/${total} bytes:`, err.code || err.message, err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `That file is too big (over ${MAX_UPLOAD_MB}MB). Photos: JPEG/PNG/WEBP/GIF. Videos: MP4/WEBM/MOV, up to ${MAX_UPLOAD_MB}MB - try trimming the clip or lowering its resolution first.` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo or video uploaded' });
    const caption = (req.body && req.body.caption) || '';
    const mediaType = ALLOWED_VIDEO_TYPES.has(req.file.mimetype) ? 'video' : 'photo';
    const info = db.prepare('INSERT INTO gallery_photos (hairdresser_id, filename, caption, media_type) VALUES (?, ?, ?, ?)')
      .run(req.session.hairdresserId, req.file.filename, caption, mediaType);
    const photo = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(info.lastInsertRowid);
    res.json({ ...photo, url: `/uploads/${photo.filename}` });
  });
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
