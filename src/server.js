const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');
const { scanLibrary, getLibrary, getVideo, isScanning, ffmpegAvailable } = require('./scanner');
const { isDirectPlayable, streamDirect, startTranscode, getTranscodeState, serveHLSFile, cleanupTranscodes, pipeFile } = require('./transcoder');
const { findSubtitles, getVttPath, shiftVtt } = require('./subtitles');
const auth = require('./auth');
const users = require('./users');
const security = require('./security');

const app = express();
app.disable('x-powered-by');

// Token a Chromecast can present (in ?token=) to fetch media/subtitles over
// the plain-HTTP cast port without Basic Auth, which it cannot perform.
// Generated fresh each server start; only handed to authenticated clients.
const castToken = crypto.randomBytes(24).toString('hex');

// The cast token travels over plain HTTP in URLs, so it only unlocks what a
// Chromecast needs to read — never the folder browser or source management.
const CAST_PATH = /^\/api\/video\/[^/]+\/(stream|hls\/[^/]+|subtitle\/[^/]+\.vtt)$/;

// Set once the dedicated plain-HTTP cast listener is up (HTTPS mode only).
let castServer;

const hostAllowed = security.makeHostCheck(config.allowedHosts || []);

app.use(security.securityHeaders);

// Reject requests addressed to a foreign hostname (DNS rebinding) and
// cross-site writes before anything else runs.
app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host)) {
    return res.status(421).json({ error: 'Unknown host name. Add it to "allowedHosts" in config.json.' });
  }
  if (security.crossSiteWrite(req)) {
    return res.status(403).json({ error: 'Cross-site request refused' });
  }
  next();
});

// The extra plain-HTTP cast port exists only so a Chromecast can pull media;
// don't serve the login page or the rest of the app (passwords!) over it.
app.use((req, res, next) => {
  if (castServer && req.socket.localPort === config.castHttpPort &&
      !(CAST_PATH.test(req.path) && ['GET', 'HEAD', 'OPTIONS'].includes(req.method))) {
    return res.status(404).end();
  }
  next();
});

// Permissive CORS on the media/subtitle paths so the Cast receiver can
// sideload subtitle tracks and media (the default media receiver enforces
// CORS on text tracks). Only read-only media routes get it.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/video/') || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Range');
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Accounts & session auth (LAN-only) -----------------------------------
// Accounts live in data/users.json (see users.js). On first run the login from
// config.json { "auth": { "username", "password" } } (or STREAM_USER /
// STREAM_PASSWORD) becomes the first admin; after that, accounts are managed
// in the app. With no accounts and no configured login the server runs open.
// Users sign in via /login, which sets an HttpOnly session cookie. A valid
// ?token= (the cast token) also passes, so a Chromecast — which can't sign
// in — can still pull media/subtitles.
const bootUser = process.env.STREAM_USER || (config.auth && config.auth.username);
const bootPass = process.env.STREAM_PASSWORD || (config.auth && config.auth.password);
const bootAdmin = users.bootstrap({ username: bootUser, password: bootPass });
if (bootAdmin) console.log(`  Accounts: created admin "${bootAdmin.username}" from config.json`);
if (users.firstAdmin()) auth.adoptLegacySessions(users.firstAdmin().id);

const authEnabled = () => users.count() > 0;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Compare against self so timing stays constant, then report mismatch.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Pages, scripts and styles must be revalidated on every load, or mobile
// browsers keep running an old player.js after an update. ("no-cache" still
// lets the browser reuse its copy when the server answers 304 Not Modified.)
// send/serve-static only set Cache-Control when it isn't already set.
app.use((req, res, next) => {
  if (req.method === 'GET' && (/\.(html|js|css)$/.test(req.path) ||
      req.path === '/' || req.path === '/player' || req.path === '/login')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// Paths reachable without a session: the login page, the auth endpoints, and
// stylesheets (so the login page is styled). Everything else requires auth.
function isPublicPath(p) {
  return p === '/login' || p === '/api/login' || p === '/api/logout' ||
    p === '/ca.pem' || p.startsWith('/css/') || p === '/js/common.js';
}

// The signed-in account for this request, or null.
function sessionUser(req) {
  const id = auth.sessionUserId(auth.sessionToken(req));
  return id ? users.get(id) : null;
}

function isCastRequest(req) {
  return (req.method === 'GET' || req.method === 'HEAD') &&
    typeof req.query.token === 'string' &&
    CAST_PATH.test(req.path) &&
    safeEqual(req.query.token, castToken);
}

app.use((req, res, next) => {
  req.user = null;
  if (!authEnabled()) return next();
  req.user = sessionUser(req);
  if (req.user) return next();
  // Cast token bypass (constant-time) for the TV's media/subtitle fetches.
  if (isCastRequest(req)) return next();
  if (isPublicPath(req.path)) return next();

  // Unauthenticated: APIs get a 401 the frontend can act on; page requests
  // are redirected to the sign-in page.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login');
});

// Parse JSON bodies only after the auth gate, so unauthenticated clients can
// only reach the parser on the public auth endpoints.
app.use(express.json({ limit: '16kb' }));

// Library management (folders, rescans, accounts) is for admins. With
// accounts off there is no one to sign in as, so only this PC itself
// (loopback) may manage the library or create the first account — otherwise
// anyone on the network could claim the server.
function requireAdmin(req, res, next) {
  if (authEnabled() ? (req.user && req.user.role === 'admin') : security.isLoopback(req)) return next();
  res.status(403).json({
    error: authEnabled() ? 'Only an admin can do that' : 'Set up accounts from this PC (http://localhost) first',
  });
}

// Errors thrown by users.js carry an HTTP status.
function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  if (!err.status) console.error(err);
}

// --- Auth routes ---------------------------------------------------------
app.get('/login', (req, res) => {
  if (!authEnabled() || req.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true });
  const wait = security.loginBlockedFor(req.ip);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} min.` });
  }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) {
    security.recordLoginFailure(req.ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = users.authenticate(username, password);
  if (!user) {
    security.recordLoginFailure(req.ip);
    console.warn(`  Failed sign-in for "${username.slice(0, 32)}" from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  security.recordLoginSuccess(req.ip);
  const token = auth.createSession(user.id);
  res.setHeader('Set-Cookie', auth.cookieString(token, Math.floor(auth.SESSION_TTL_MS / 1000)));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(auth.sessionToken(req));
  res.setHeader('Set-Cookie', auth.cookieString('', 0));
  res.json({ ok: true });
});

// --- Your account -------------------------------------------------------------
app.get('/api/me', (req, res) => {
  res.json({
    authEnabled: authEnabled(),
    user: users.publicUser(req.user),
    isAdmin: !authEnabled() || Boolean(req.user && req.user.role === 'admin'),
  });
});

app.post('/api/me/password', (req, res) => {
  if (!req.user) return res.status(400).json({ error: 'Accounts are not turned on' });
  const { currentPassword, newPassword } = req.body || {};
  if (!users.checkPassword(req.user, String(currentPassword || ''))) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  try {
    users.update(req.user.id, { password: newPassword });
    // Sign out your other devices; this one stays signed in.
    auth.destroyUserSessions(req.user.id, auth.sessionToken(req));
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// --- Account management (admins) ---------------------------------------------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: users.list() });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  const first = !authEnabled();
  try {
    // The very first account turns sign-in on, so it must be an admin, and
    // whoever made it is signed straight in as it.
    const user = users.create({ username, password, role: first ? 'admin' : (role || 'user') });
    if (first) {
      const token = auth.createSession(user.id);
      res.setHeader('Set-Cookie', auth.cookieString(token, Math.floor(auth.SESSION_TTL_MS / 1000)));
    }
    res.json({ user: users.publicUser(user), users: users.list() });
  } catch (err) { sendError(res, err); }
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const { role, password } = req.body || {};
  try {
    const user = users.update(req.params.id, { role, password });
    // A reset password signs that account out everywhere (but not you, if
    // you reset your own).
    if (password !== undefined) auth.destroyUserSessions(user.id, auth.sessionToken(req));
    res.json({ user: users.publicUser(user), users: users.list() });
  } catch (err) { sendError(res, err); }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (req.user && req.user.id === req.params.id) {
    return res.status(400).json({ error: 'You can’t delete your own account' });
  }
  try {
    users.remove(req.params.id);
    auth.destroyUserSessions(req.params.id);
    res.json({ users: users.list() });
  } catch (err) { sendError(res, err); }
});

// Public download of the local CA certificate, so devices can install/trust it.
app.get('/ca.pem', (req, res) => {
  try {
    const { caCertFile } = require('./certs');
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="local-stream-ca.crt"');
    res.sendFile(caCertFile());
  } catch {
    res.status(404).send('CA not available (HTTPS may be disabled)');
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// `progress` is the signed-in account's progress map (see users.loadProgress).
function formatVideo(video, progress) {
  const subs = findSubtitles(video).map(s => ({
    index: s.index,
    lang: s.lang,
    label: s.label,
  }));
  return {
    id: video.id,
    title: video.title,
    fileName: video.fileName,
    category: video.category || null,
    folder: video.folder,
    duration: video.duration,
    width: video.width,
    height: video.height,
    size: video.size,
    videoCodec: video.videoCodec,
    audioCodec: video.audioCodec,
    addedAt: video.addedAt,
    hasThumbnail: video.hasThumbnail,
    directPlay: isDirectPlayable(video),
    ffmpeg: ffmpegAvailable,
    subtitles: subs,
    progress: progress[video.id] || null,
  };
}

app.get('/api/library', (req, res) => {
  const progress = users.loadProgress(req.user && req.user.id);
  const videos = getLibrary().map(v => formatVideo(v, progress));
  const { sort, search, folder, category } = req.query;

  let filtered = videos;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(v =>
      v.title.toLowerCase().includes(q) || v.fileName.toLowerCase().includes(q)
    );
  }

  if (category) {
    filtered = filtered.filter(v => v.category === category);
  }

  if (folder) {
    filtered = filtered.filter(v => v.folder === folder);
  }

  if (sort === 'date') filtered.sort((a, b) => b.addedAt - a.addedAt);
  else if (sort === 'duration') filtered.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  else if (sort === 'size') filtered.sort((a, b) => b.size - a.size);
  else filtered.sort((a, b) => naturalCompare(a.title, b.title) || naturalCompare(a.fileName, b.fileName));

  const folders = [...new Set(getLibrary().map(v => v.folder).filter(Boolean))].sort(naturalCompare);
  const categories = [...new Set(getLibrary().map(v => v.category).filter(Boolean))].sort();

  res.json({ videos: filtered, folders, categories, scanning: isScanning(), ffmpeg: ffmpegAvailable });
});

app.post('/api/library/scan', requireAdmin, async (req, res) => {
  if (isScanning()) return res.json({ status: 'already scanning' });
  scanLibrary().catch(console.error);
  res.json({ status: 'scan started' });
});

// --- Media source management (add/remove streamable folders via the UI) ---
const CONFIG_JSON = config.configPath;

function persistSources(dirs) {
  let json = {};
  try { json = JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf-8')); } catch { /* new file */ }
  json.mediaDirs = dirs.map(d => ({ path: d.path, category: d.category }));
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(json, null, 2));
  config.mediaDirs = dirs.map(d => ({ path: d.path, category: d.category || path.basename(d.path) }));
}

// Browse the server's filesystem (folders only) so the user can pick a folder.
// Admin-only: it exposes the server's whole filesystem layout.
app.get('/api/browse', requireAdmin, (req, res) => {
  const p = req.query.path;

  if (!p) {
    const roots = [];
    if (process.platform === 'win32') {
      for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${c}:\\`;
        try { fs.accessSync(drive); roots.push({ name: `${c}:`, path: drive }); } catch { /* no drive */ }
      }
    } else {
      roots.push({ name: '/', path: '/' });
    }
    return res.json({ path: '', parent: null, dirs: roots });
  }

  try {
    const dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('$'))
      .map(e => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(p);
    res.json({ path: p, parent: parent === p ? '' : parent, dirs });
  } catch {
    res.status(400).json({ error: 'Cannot open this folder' });
  }
});

app.get('/api/sources', requireAdmin, (req, res) => {
  res.json({ sources: config.mediaDirs.map(d => ({ path: d.path, category: d.category })) });
});

app.post('/api/sources', requireAdmin, (req, res) => {
  const { path: dir, category } = req.body || {};
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });

  let stat;
  try { stat = fs.statSync(dir); } catch { return res.status(400).json({ error: 'Folder not found' }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder' });

  const norm = path.normalize(dir);
  if (config.mediaDirs.some(d => path.normalize(d.path) === norm)) {
    return res.status(409).json({ error: 'Folder already added' });
  }

  const dirs = config.mediaDirs.concat([{ path: dir, category: (category || '').trim() || path.basename(dir) }]);
  persistSources(dirs);
  scanLibrary().catch(console.error);
  res.json({ sources: config.mediaDirs.map(d => ({ path: d.path, category: d.category })) });
});

// Rename a source's category (display name) without rescanning.
app.patch('/api/sources', requireAdmin, (req, res) => {
  const { path: dir, category } = req.body || {};
  const name = typeof category === 'string' ? category.trim() : '';
  if (!dir || !name) return res.status(400).json({ error: 'path and category required' });
  if (name.length > 80) return res.status(400).json({ error: 'Name is too long' });

  const norm = path.normalize(dir);
  const source = config.mediaDirs.find(d => path.normalize(d.path) === norm);
  if (!source) return res.status(404).json({ error: 'Folder not found' });

  const oldName = source.category;
  persistSources(config.mediaDirs.map(d => (d === source ? { ...d, category: name } : d)));
  // Update already-scanned videos in place so the change shows immediately.
  for (const v of getLibrary()) {
    if (v.category === oldName && path.normalize(v.fullPath).startsWith(norm)) v.category = name;
  }
  res.json({ sources: config.mediaDirs.map(d => ({ path: d.path, category: d.category })) });
});

app.delete('/api/sources', requireAdmin, (req, res) => {
  const { path: dir } = req.body || {};
  if (!dir) return res.status(400).json({ error: 'path required' });
  const norm = path.normalize(dir);
  const dirs = config.mediaDirs.filter(d => path.normalize(d.path) !== norm);
  persistSources(dirs);
  scanLibrary().catch(console.error);
  res.json({ sources: config.mediaDirs.map(d => ({ path: d.path, category: d.category })) });
});

// "Natural" order so "2 - Intro" sorts before "10 - Advanced" (course files).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function naturalCompare(a, b) {
  return collator.compare(a || '', b || '');
}

// Playback order within a category: folder by folder (root files first), then
// by title — the same order the library shows inside a category.
function playbackOrder(category) {
  return getLibrary()
    .filter(v => (v.category || null) === (category || null))
    .sort((a, b) => {
      if (!a.folder !== !b.folder) return a.folder ? 1 : -1; // root first
      return naturalCompare(a.folder, b.folder) ||
        naturalCompare(a.title, b.title) ||
        naturalCompare(a.fileName, b.fileName);
    });
}

function neighbour(v) {
  return v ? { id: v.id, title: v.title, folder: v.folder || null } : null;
}

app.get('/api/video/:id', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const order = playbackOrder(video.category);
  const i = order.findIndex(v => v.id === video.id);
  res.json({
    ...formatVideo(video, users.loadProgress(req.user && req.user.id)),
    prev: neighbour(i > 0 ? order[i - 1] : null),
    next: neighbour(i >= 0 && i < order.length - 1 ? order[i + 1] : null),
  });
});

// The video's whole category in playback order, for the player's playlist.
app.get('/api/video/:id/playlist', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const progress = users.loadProgress(req.user && req.user.id);
  const items = playbackOrder(video.category).map(v => ({
    id: v.id,
    title: v.title,
    folder: v.folder || null,
    duration: v.duration,
    hasThumbnail: v.hasThumbnail,
    progress: progress[v.id] || null,
  }));
  res.json({ category: video.category || null, items });
});

app.get('/api/video/:id/stream', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  // Always the raw file; non-direct-play files use the /transcode + /hls path.
  try {
    streamDirect(video, req, res);
  } catch {
    if (!res.headersSent) res.status(404).json({ error: 'Video file unavailable' });
  }
});

app.get('/api/video/:id/transcode', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (!ffmpegAvailable) return res.status(503).json({ error: 'FFmpeg not available' });

  startTranscode(video);
  const state = getTranscodeState(video.id);
  res.json({ ready: state?.ready || false, error: state?.error || null });
});

app.get('/api/video/:id/hls/:file', (req, res) => {
  serveHLSFile(req.params.id, req.params.file, res, req.query.token);
});

// Serve a subtitle track as WebVTT (converted/cached). Used by the in-browser
// <track> and sideloaded onto the Chromecast as a text track.
app.get('/api/video/:id/subtitle/:index.vtt', async (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const index = parseInt(req.params.index, 10);
  try {
    const vttPath = await getVttPath(video, index);
    if (!vttPath) return res.status(404).json({ error: 'Subtitle not found' });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');

    // Optional sync offset (seconds), clamped to a sane range.
    const offset = parseFloat(req.query.offset);
    if (Number.isFinite(offset) && offset !== 0) {
      const clamped = Math.max(-60, Math.min(60, offset));
      const shifted = shiftVtt(fs.readFileSync(vttPath, 'utf-8'), clamped);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(shifted);
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    pipeFile(fs.createReadStream(vttPath), res);
  } catch (err) {
    res.status(500).json({ error: 'Subtitle conversion failed' });
  }
});

// Tells the player how to build URLs the Chromecast can fetch: the plain-HTTP
// base (the TV can't use the self-signed HTTPS cert) plus the cast token.
// castBaseUrl is set once the servers are listening: the extra cast port when
// HTTPS is on, otherwise the main (already plain-HTTP) port.
let castBaseUrl = null;

app.get('/api/cast-info', (req, res) => {
  if (!castBaseUrl) return res.json({ enabled: false });
  res.json({
    enabled: true,
    httpBase: castBaseUrl,
    token: castToken,
  });
});

app.get('/api/video/:id/thumbnail', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const thumbPath = path.join(config.dataDir, 'thumbnails', `${video.id}.jpg`);
  if (!fs.existsSync(thumbPath)) {
    return res.status(404).json({ error: 'No thumbnail' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  pipeFile(fs.createReadStream(thumbPath), res);
});

app.get('/api/video/:id/progress', (req, res) => {
  const progress = users.loadProgress(req.user && req.user.id);
  res.json(progress[req.params.id] || null);
});

app.post('/api/video/:id/progress', (req, res) => {
  const { time, duration, completed } = req.body || {};
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    return res.status(400).json({ error: 'time required' });
  }

  const progress = users.loadProgress(req.user && req.user.id);
  const prev = progress[req.params.id] || {};
  progress[req.params.id] = {
    // Finishing a video marks it watched; rewatching later keeps that mark.
    time: completed ? 0 : time,
    duration: (typeof duration === 'number' && Number.isFinite(duration)) ? duration : (prev.duration || null),
    completed: Boolean(completed || prev.completed),
    updatedAt: Date.now(),
  };
  users.saveProgress(req.user && req.user.id, progress);
  res.json({ ok: true });
});

app.delete('/api/video/:id/progress', (req, res) => {
  const progress = users.loadProgress(req.user && req.user.id);
  delete progress[req.params.id];
  users.saveProgress(req.user && req.user.id, progress);
  res.json({ ok: true });
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player.html'));
});

// Last-resort error handler: never send stack traces (they leak file paths
// and library internals) — log them server-side instead.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status || err.statusCode) ? (err.status || err.statusCode) : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: status < 500 ? 'Bad request' : 'Something went wrong' });
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // Skip virtual adapters (VMware, VirtualBox, Hyper-V, WSL, etc.) —
      // a phone on the real LAN can't reach those addresses.
      if (/vmware|virtualbox|hyper-v|vethernet|wsl|loopback|vmnet/i.test(name)) continue;
      candidates.push({ name, address: iface.address });
    }
  }

  if (candidates.length === 0) return 'localhost';

  // Prefer common home-network ranges, then Wi-Fi/Ethernet by name.
  const preferred = candidates.find(c =>
    /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(c.address) &&
    /wi-?fi|wlan|ethernet|eth/i.test(c.name)
  );
  if (preferred) return preferred.address;

  const privateRange = candidates.find(c =>
    /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(c.address)
  );
  if (privateRange) return privateRange.address;

  return candidates[0].address;
}

cleanupTranscodes();

const localIP = getLocalIP();
const httpsEnabled = Boolean(config.https && config.https.enabled);

async function createServer() {
  if (httpsEnabled) {
    try {
      const https = require('https');
      const { ensureCert } = require('./certs');
      const { cert, key } = await ensureCert(localIP);
      return { server: https.createServer({ cert, key }, app), scheme: 'https' };
    } catch (err) {
      console.warn(`  HTTPS setup failed (${err.message}); falling back to HTTP.`);
    }
  }
  return { server: require('http').createServer(app), scheme: 'http' };
}

let server;

createServer().then(({ server: srv, scheme }) => {
  server = srv;

  // Secondary plain-HTTP listener so a Chromecast (which won't trust the
  // self-signed cert) can fetch media + subtitles. Token-protected via the
  // auth middleware. Skipped if HTTPS is off (then the main port is already
  // plain HTTP and usable directly).
  if (config.castHttpPort && scheme === 'https') {
    castServer = require('http').createServer(app);
    castServer.on('error', (err) => {
      console.warn(`  Cast port ${config.castHttpPort} unavailable (${err.code || err.message}); casting disabled.`);
      castServer = null;
      castBaseUrl = null;
    });
    castServer.listen(config.castHttpPort, '0.0.0.0', () => {});
    castBaseUrl = `http://${localIP}:${config.castHttpPort}`;
  } else if (config.castHttpPort && scheme === 'http') {
    // Main port is already plain HTTP, so the TV can use it directly.
    castBaseUrl = `http://${localIP}:${config.port}`;
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${config.port} is already in use — is Local Stream already running?`);
      console.error('  Stop the other instance or change "port" in config.json.\n');
    } else {
      console.error('  Server error:', err);
    }
    process.exit(1);
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log('');
    console.log('  Local Stream is running!');
    console.log('');
    console.log(`  Local:   ${scheme}://localhost:${config.port}`);
    console.log(`  Network: ${scheme}://${localIP}:${config.port}`);
    console.log('');
    console.log(`  Media: ${config.mediaDirs.map(d => `${d.path} [${d.category}]`).join(', ')}`);
    console.log(`  FFmpeg: ${ffmpegAvailable ? 'available' : 'not found (install with: winget install ffmpeg)'}`);
    console.log(`  Auth: ${authEnabled() ? `enabled (${users.count()} account${users.count() === 1 ? '' : 's'})` : 'disabled — ANYONE on your network can watch; create an account from this PC'}`);
    console.log(`  Casting: ${scheme === 'https' ? 'enabled (HTTPS secure context)' : 'limited (HTTP — use browser-native cast)'}`);
    if (castServer) {
      console.log(`  Cast media (for TV): http://${localIP}:${config.castHttpPort} (token-protected)`);
    }
    console.log('');
    scanLibrary().catch(console.error);
  });
});

function shutdown() {
  cleanupTranscodes();
  if (server) server.close();
  if (castServer) castServer.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  shutdown();
});

process.on('SIGTERM', shutdown);
