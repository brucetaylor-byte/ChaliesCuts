require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me')) {
  console.warn('WARNING: set a real SESSION_SECRET environment variable in production.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (isProduction) app.set('trust proxy', 1); // needed for secure cookies behind a reverse proxy / load balancer

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction // requires HTTPS - set NODE_ENV=production once you're serving over HTTPS
  }
}));

// See db.js for DATA_DIR - keeps this in sync with wherever uploads actually get written.
const UPLOADS_BASE_DIR = process.env.DATA_DIR || __dirname;
app.use('/uploads', express.static(path.join(UPLOADS_BASE_DIR, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/hairdressers', require('./routes/hairdressers'));
app.use('/api/availability', require('./routes/availability'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/gallery', require('./routes/gallery'));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Haircut booking app listening on http://localhost:${PORT}`);
});
