import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { customAlphabet } from 'nanoid';
import QRCode from 'qrcode';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
// BASE_URL is what gets embedded in QR codes, shown as the short link, and
// used to build the Google OAuth redirect URI. Must match the public domain.
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const IS_HTTPS = BASE_URL.startsWith('https://');

const API_KEY = process.env.API_KEY || '';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ALLOWED_DOMAIN = process.env.GOOGLE_ALLOWED_DOMAIN || '';
const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (GOOGLE_ENABLED && !SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    'SESSION_SECRET is not set — using a random one for this run. ' +
    'Everyone will be signed out on every restart. Set SESSION_SECRET in .env to avoid that.'
  );
}

const SESSION_COOKIE = 'pfadis_session';
const STATE_COOKIE = 'pfadis_oauth_state';

const oauthClient = GOOGLE_ENABLED
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/google/callback`)
  : null;

// Lowercase letters, digits, no ambiguous chars (0/O, 1/l/I) removed.
const nanoid = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 6);

const RESERVED = new Set(['api', 'auth', 'health', 'favicon.ico']);

// ---------- auth helpers ----------

function getSessionUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  // Programmatic access via a shared API key (scripts/automation), if configured.
  if (API_KEY) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === API_KEY) return next();
  }

  // Browser access via a signed-in Google session, if configured.
  if (GOOGLE_ENABLED) {
    const user = getSessionUser(req);
    if (user) {
      req.user = user;
      return next();
    }
  }

  // Neither auth method is configured at all — run open (fine for a private network).
  if (!API_KEY && !GOOGLE_ENABLED) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function withShortUrl(row) {
  return { ...row, shortUrl: `${BASE_URL}/${row.code}` };
}

// ---------- auth routes ----------

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(500).send('Google sign-in is not configured.');

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_HTTPS,
    maxAge: 5 * 60 * 1000,
  });

  const url = oauthClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    hd: GOOGLE_ALLOWED_DOMAIN || undefined, // hints Google's account chooser, not a security check on its own
    prompt: 'select_account',
    state,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(500).send('Google sign-in is not configured.');

  const { code, state } = req.query;
  const expectedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE);

  if (!code || !state || state !== expectedState) {
    return res.status(400).send('Sign-in failed: this link expired or was already used. Go back and try again.');
  }

  try {
    const { tokens } = await oauthClient.getToken(code);
    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;

    // The verified 'hd' claim (present for Google Workspace accounts) is the
    // reliable check here — it comes from Google's signed token, not the client.
    const domainOk =
      !GOOGLE_ALLOWED_DOMAIN ||
      payload.hd === GOOGLE_ALLOWED_DOMAIN ||
      (payload.email_verified && email && email.toLowerCase().endsWith(`@${GOOGLE_ALLOWED_DOMAIN.toLowerCase()}`));

    if (!domainOk) {
      return res
        .status(403)
        .send(`Access denied: ${email} is not part of ${GOOGLE_ALLOWED_DOMAIN || 'the allowed organization'}.`);
    }

    const sessionToken = jwt.sign({ email }, SESSION_SECRET, { expiresIn: '30d' });
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_HTTPS,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/');
  } catch (err) {
    console.error('Google sign-in error:', err);
    res.status(500).send('Sign-in failed. Please try again.');
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});

app.get('/api/session', (req, res) => {
  const user = GOOGLE_ENABLED ? getSessionUser(req) : null;
  const openAccess = !API_KEY && !GOOGLE_ENABLED;
  res.json({
    googleEnabled: GOOGLE_ENABLED,
    apiKeyEnabled: Boolean(API_KEY),
    authenticated: openAccess || Boolean(user),
    email: user ? user.email : null,
  });
});

// ---------- API ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/links', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM links ORDER BY created_at DESC').all();
  res.json(rows.map(withShortUrl));
});

app.post('/api/links', requireAuth, (req, res) => {
  const { url, code } = req.body || {};

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'A valid destination URL (http:// or https://) is required.' });
  }

  let finalCode = (code || '').trim();

  if (finalCode) {
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(finalCode)) {
      return res.status(400).json({ error: 'Custom code must be 3-32 characters: letters, numbers, - or _.' });
    }
    if (RESERVED.has(finalCode.toLowerCase())) {
      return res.status(400).json({ error: 'That code is reserved, please choose another.' });
    }
    const exists = db.prepare('SELECT 1 FROM links WHERE code = ?').get(finalCode);
    if (exists) {
      return res.status(409).json({ error: 'That code is already taken.' });
    }
  } else {
    do {
      finalCode = nanoid();
    } while (db.prepare('SELECT 1 FROM links WHERE code = ?').get(finalCode));
  }

  db.prepare('INSERT INTO links (code, url) VALUES (?, ?)').run(finalCode, url);
  const row = db.prepare('SELECT * FROM links WHERE code = ?').get(finalCode);
  res.status(201).json(withShortUrl(row));
});

app.delete('/api/links/:code', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM links WHERE code = ?').run(req.params.code);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

// QR codes stay public: they only ever encode a public short URL, and it's
// convenient to drop <img src="/api/links/CODE/qr"> straight into the UI.
app.get('/api/links/:code/qr', async (req, res) => {
  const row = db.prepare('SELECT * FROM links WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Not found.' });

  const format = req.query.format === 'svg' ? 'svg' : 'png';
  const shortUrl = `${BASE_URL}/${row.code}`;

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(shortUrl, { type: 'svg', margin: 1, width: 512 });
      res.type('image/svg+xml').send(svg);
    } else {
      const buffer = await QRCode.toBuffer(shortUrl, { type: 'png', margin: 1, width: 512 });
      res.type('image/png').send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: 'Could not generate QR code.' });
  }
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- redirect (kept last, after static + api routes) ----------
app.get('/:code', (req, res, next) => {
  const code = req.params.code;
  if (RESERVED.has(code.toLowerCase())) return next();

  const row = db.prepare('SELECT * FROM links WHERE code = ?').get(code);
  if (!row) return res.status(404).send('Short link not found.');

  db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?').run(code);
  res.redirect(302, row.url);
});

app.use((req, res) => res.status(404).send('Not found.'));

app.listen(PORT, () => {
  console.log(`pfadis-shortener listening on :${PORT} (base url: ${BASE_URL})`);
  if (GOOGLE_ENABLED) {
    console.log(`Google sign-in enabled, restricted to: ${GOOGLE_ALLOWED_DOMAIN || '(any Google account)'}`);
  }
});
