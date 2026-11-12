const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const SESSION_COOKIE = 'ls_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sessionsFile = path.join(config.dataDir, 'sessions.json');
const sessions = new Map(); // token -> { exp (ms), userId }

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    const now = Date.now();
    for (const [token, s] of Object.entries(obj)) {
      // Sessions from before accounts were a bare expiry with no user.
      const entry = typeof s === 'number' ? { exp: s, userId: null } : s;
      if (entry && entry.exp > now) sessions.set(token, entry);
    }
  } catch { /* no sessions yet */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
    fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)));
  } catch { /* best effort */ }
}

load();

// Pre-account sessions belonged to the single config.json login, which is now
// the first admin; keep them signed in as that account.
function adoptLegacySessions(userId) {
  let changed = false;
  for (const s of sessions.values()) {
    if (s.userId === null) { s.userId = userId; changed = true; }
  }
  if (changed) save();
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { exp: Date.now() + SESSION_TTL_MS, userId });
  save();
  return token;
}

// Returns the session's user id, or null if the token is missing/expired.
function sessionUserId(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    save();
    return null;
  }
  return s.userId;
}

function destroySession(token) {
  if (token && sessions.has(token)) {
    sessions.delete(token);
    save();
  }
}

// Sign a user out everywhere (e.g. password reset, account deleted), except
// optionally the session making the change.
function destroyUserSessions(userId, exceptToken = null) {
  let changed = false;
  for (const [token, s] of sessions) {
    if (s.userId === userId && token !== exceptToken) { sessions.delete(token); changed = true; }
  }
  if (changed) save();
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const raw = pair.slice(i + 1).trim();
    // A malformed %-escape must not 500 every request carrying the cookie.
    try { out[pair.slice(0, i).trim()] = decodeURIComponent(raw); } catch { out[pair.slice(0, i).trim()] = raw; }
  });
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

// Build a Set-Cookie value. maxAgeSec === 0 clears the cookie.
function cookieString(token, maxAgeSec) {
  const secure = config.https && config.https.enabled ? '; Secure' : '';
  const base = `Path=/; HttpOnly; SameSite=Lax${secure}`;
  if (maxAgeSec === 0) return `${SESSION_COOKIE}=; Max-Age=0; ${base}`;
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSec}; ${base}`;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  adoptLegacySessions,
  createSession,
  sessionUserId,
  destroySession,
  destroyUserSessions,
  parseCookies,
  sessionToken,
  cookieString,
};
