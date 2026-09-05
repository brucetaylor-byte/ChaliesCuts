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

const server = app.listen(PORT, () => {
  console.log(`Haircut booking app listening on http://localhost:${PORT}`);
});

// Node's own defaults here (headersTimeout 60s, requestTimeout 5min) are
// self-imposed limits well short of Railway's platform ceiling (15 minutes).
// A slow mobile upload of a legitimately-sized gallery video can easily take
// longer than 5 minutes to finish sending, so the default requestTimeout was
// killing the connection mid-upload even though the file itself was within
// the 300MB cap - the request just hadn't fully arrived yet. Raise both to
// give slow uploads the same headroom Railway itself allows.
server.requestTimeout = 15 * 60 * 1000; // 15 minutes - matches Railway's platform max
server.headersTimeout = 14 * 60 * 1000; // must stay below requestTimeout
server.keepAliveTimeout = 12 * 1000; // Node default (5s) is fine for most, bumped slightly for slow mobile round-trips
