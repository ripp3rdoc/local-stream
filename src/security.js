// Request-level hardening against unauthenticated attackers: login brute-force
// limiting, DNS-rebinding (Host) checks, cross-site request (Origin) checks,
// and baseline security headers.
const net = require('net');
const os = require('os');

// --- Login brute-force limiter -----------------------------------------------
// Counts failed sign-ins per client IP. After MAX_FAILURES within WINDOW_MS the
// IP is refused (429) until the window ends. A successful sign-in resets it.
// req.ip is the TCP peer address (Express "trust proxy" is off), so it can't be
// forged with X-Forwarded-For.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // ip -> { count, resetAt }

function prune(now) {
  if (failures.size < 1000) return;
  for (const [ip, f] of failures) if (f.resetAt <= now) failures.delete(ip);
}

// Seconds until this IP may try again, or 0 if it isn't blocked.
function loginBlockedFor(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  const now = Date.now();
  if (f.resetAt <= now) { failures.delete(ip); return 0; }
  return f.count >= MAX_FAILURES ? Math.ceil((f.resetAt - now) / 1000) : 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  prune(now);
  const f = failures.get(ip);
  if (!f || f.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else f.count += 1;
}

function recordLoginSuccess(ip) {
  failures.delete(ip);
}

// --- Host header allowlist (DNS rebinding) -----------------------------------
// A malicious web page can rebind its own domain to this machine's LAN IP and
// then talk to the server from the victim's browser as "same origin". The
// browser still sends the attacker's domain in Host, so only accept IP
// literals, localhost, this machine's name, and anything in config.allowedHosts.
function hostOnly(hostHeader) {
  let h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

function makeHostCheck(extraHosts = []) {
  const me = os.hostname().toLowerCase();
  const extra = extraHosts.map(h => String(h).toLowerCase());
  return function hostAllowed(hostHeader) {
    const h = hostOnly(hostHeader);
    if (!h) return false;
    if (net.isIP(h)) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === me || h.startsWith(`${me}.`)) return true;
    return extra.includes(h);
  };
}

// --- Cross-site request check (CSRF defence in depth) -------------------------
// For state-changing methods, a browser-sent Origin must match the Host the
// request was sent to. Requests without Origin (non-browser clients) pass;
// they carry no ambient cookie unless the caller has the session already.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function crossSiteWrite(req) {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase();
  } catch {
    return true; // "null" or garbage origin
  }
}

// --- Misc --------------------------------------------------------------------
function isLoopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  // The cast token rides in media URLs; never leak URLs to other sites.
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}

module.exports = {
  loginBlockedFor,
  recordLoginFailure,
  recordLoginSuccess,
  makeHostCheck,
  crossSiteWrite,
  isLoopback,
  securityHeaders,
};
