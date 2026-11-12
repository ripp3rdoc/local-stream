#!/usr/bin/env node
// Capture the README screenshots from the demo library.
//
//   node demo/generate-media.js     (once)
//   node demo/capture.js            → docs/screenshots/*.png
//
// Starts demo/server.js, seeds accounts + watch history through the API, then
// drives a headless Chromium browser (Edge or Chrome, found automatically or
// via $BROWSER) over the DevTools protocol. Needs Node 22+ (global WebSocket).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.DEMO_PORT) || 4321;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-only-password';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const DEBUG_PORT = 9333;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`  ${msg}`);

function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('No Chromium browser found; set BROWSER=/path/to/chrome');
  return found;
}

// --- Demo server + seed data ---------------------------------------------------
async function waitFor(fn, what, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function api(cookie, method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return { res, json: await res.json() };
}

async function login() {
  const { res } = await api('', 'POST', '/api/login', { username: 'sensei', password: PASSWORD });
  return res.headers.get('set-cookie').split(';')[0]; // "ls_session=…"
}

async function seed(cookie) {
  const { json } = await api(cookie, 'GET', '/api/library');
  const byFile = name => {
    const v = json.videos.find(x => x.fileName.startsWith(name));
    if (!v) throw new Error(`Demo video not found: ${name}`);
    return v;
  };

  for (const [username, role] of [['mika', 'user'], ['jordan', 'user'], ['rin', 'admin']]) {
    await api(cookie, 'POST', '/api/users', { username, password: `demo-${username}-${Date.now()}`, role });
  }

  const done = ['Starlight.Station.S01E01', 'Starlight.Station.S01E02', 'Starlight.Station.S01E03',
    '1 - Welcome and setup', '2 - Ownership in one picture', '3 - Borrowing rules', '4 - Lifetimes demystified',
    '1 - Threads and channels', '2 - Send and Sync', '1 - Materials and paper', '2 - Washes and gradients',
    'The.Paper.Lantern', 'Echoes.of.Kyoto', 'Deep.Blue.Frontier', '01 - What is a signal', '02 - Sampling and aliasing'];
  for (const f of done) {
    const v = byFile(f);
    await api(cookie, 'POST', `/api/video/${v.id}/progress`, { time: v.duration, duration: v.duration, completed: true });
  }

  // In progress, oldest first: the last one becomes the home-page hero.
  const partial = [['03 - The Fourier transform', 0.55], ['3 - Wet-on-wet skies', 0.4], ['The.Volcano.Diaries', 0.47],
    ['3 - Async from first principles', 0.38], ['Starlight.Station.S01E04', 0.44], ['Neon.Ronin', 2241]];
  for (const [f, at] of partial) {
    const v = byFile(f);
    const time = at > 1 ? at : Math.round(v.duration * at);
    await api(cookie, 'POST', `/api/video/${v.id}/progress`, { time, duration: v.duration });
    await sleep(20);
  }
  return { neon: byFile('Neon.Ronin'), rustCollection: 'Rust Systems Programming' };
}

// --- Minimal DevTools-protocol client -------------------------------------------
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      for (const w of waiters.filter(x => x.method === msg.method)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = method => new Promise(resolve => waiters.push({ method, resolve }));
  return { send, once, close: () => ws.close() };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  log('starting demo server…');
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  const browserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-capture-'));
  let browser;

  try {
    await waitFor(() => serverLog.includes('Found '), 'library scan', 300000);
    const cookie = await login();
    const { neon, rustCollection } = await seed(cookie);
    log('seeded accounts and watch history');

    const exe = findBrowser();
    log(`launching ${path.basename(exe)} (headless)…`);
    browser = spawn(exe, [
      '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${browserDir}`,
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
      '--force-color-profile=srgb', '--disable-features=Translate,MediaRouter', 'about:blank',
    ], { stdio: 'ignore' });

    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      return list.find(t => t.type === 'page');
    }, 'browser');
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
      return r.result.value;
    };
    const viewport = async (w, h, dpr, mobile = false) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: mobile
          ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      });
    };
    const scheme = s => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] });
    const settle = () => evaluate(`(async () => {
      await document.fonts.ready;
      const vis = [...document.images].filter(i => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      await Promise.race([
        Promise.all(vis.map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))),
        new Promise(r => setTimeout(r, 8000)),
      ]);
      return true;
    })()`);
    const go = async (url) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: BASE + url });
      await loaded;
      await sleep(600);
      await settle();
      await sleep(700); // entrance animations
    };
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      log(`✓ ${name}.png`);
    };
    const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ${sel}'); el.click(); return true; })()`);
    const waitVideo = () => waitFor(() => evaluate(`(() => { const v = document.getElementById('videoPlayer');
      return v && v.readyState >= 2 && !v.seeking && v.currentTime > 1; })()`), 'video frame', 30000);

    await scheme('dark');
    await viewport(1280, 800, 1.5);

    // Signed out: the login page.
    await go('/login');
    await shot('login');

    await cdp.send('Network.enable');
    const [name, value] = cookie.split('=');
    await cdp.send('Network.setCookie', { name, value, url: BASE, httpOnly: true, sameSite: 'Lax' });

    await go('/');
    await shot('library');

    // Open the course's module sections (they start collapsed).
    const sections = ['01 - Foundations', '02 - Concurrency', '03 - Systems'].map(f => `${rustCollection}::${f}`);
    await evaluate(`localStorage.setItem('expandedSections', ${JSON.stringify(JSON.stringify(sections))})`);
    await go(`/?c=${encodeURIComponent(rustCollection)}`);
    await shot('collection');

    // Player resumes at the seeded position; turn on English subtitles.
    await go(`/player?id=${neon.id}`);
    await waitVideo();
    await click('#ccBtn');
    await sleep(300);
    await click('#ccMenu .menu-item[data-track="0"]');
    await sleep(300);
    await evaluate(`document.getElementById('videoPlayer').currentTime = 2241.5`);
    await waitVideo();
    await sleep(1200);
    await evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await evaluate(`(() => { const m = document.getElementById('ccMenu'); if (!m.hidden) document.getElementById('ccBtn').click(); return true; })()`);
    await sleep(500);
    await shot('player');

    await click('#ccBtn');
    await sleep(600);
    await shot('subtitles');

    await go('/');
    await click('#accountBtn');
    await sleep(900);
    await shot('accounts');

    await scheme('light');
    await go('/?c=Movies');
    await shot('light');
    await scheme('dark');

    await viewport(390, 844, 2, true);
    await go('/');
    await shot('mobile');
    await go(`/player?id=${neon.id}`);
    await waitVideo();
    await sleep(800);
    await shot('mobile-player');

    cdp.close();
    console.log(`\nScreenshots written to ${OUT}`);
  } finally {
    if (browser) browser.kill();
    server.kill();
    await sleep(500);
    fs.rmSync(browserDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((err) => {
  console.error(`\nCapture failed: ${err.message}`);
  process.exit(1);
});
