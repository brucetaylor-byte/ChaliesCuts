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
// up front), sized for a short profile/gallery clip rather than a photo.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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

// Hairdresser: upload a photo or video to their own gallery section
router.post('/', requireHairdresser, (req, res) => {
  upload.single('media')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
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
