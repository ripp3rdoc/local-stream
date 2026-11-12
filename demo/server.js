#!/usr/bin/env node
// Run Local Stream against the generated demo library, fully isolated from
// your real setup: its own config file, data folder and port.
//
//   node demo/server.js            → http://localhost:4321
//
// Sign in as "sensei" with the password below (or DEMO_PASSWORD).
// Generate the media first with: node demo/generate-media.js
'use strict';

const fs = require('fs');
const path = require('path');

const DEMO = __dirname;
const MEDIA = path.join(DEMO, 'media');
const DATA = path.join(DEMO, 'data');
const CONFIG = path.join(DATA, 'config.json');

// Demo-only credentials for a throwaway local instance.
const DEMO_USER = 'sensei';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo-only-password';
const PORT = Number(process.env.DEMO_PORT) || 4321;

if (!fs.existsSync(MEDIA)) {
  console.error('No demo media yet. Run: node demo/generate-media.js');
  process.exit(1);
}

// Collections in the order they should appear.
const ORDER = ['Movies', 'Starlight Station', 'Rust Systems Programming', 'Watercolor Fundamentals',
  'Signal Processing for Hackers', 'Documentaries'];
const dirs = fs.readdirSync(MEDIA, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

// Fresh accounts/sessions/progress every run; keep thumbnails (slow to make).
for (const f of ['users.json', 'sessions.json', 'progress.json']) fs.rmSync(path.join(DATA, f), { force: true });
fs.rmSync(path.join(DATA, 'progress'), { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

fs.writeFileSync(CONFIG, JSON.stringify({
  port: PORT,
  https: { enabled: false },
  castHttpPort: null,
  dataDir: DATA,
  mediaDirs: dirs.map(d => ({ path: path.join(MEDIA, d), category: d })),
  auth: { username: DEMO_USER, password: DEMO_PASSWORD },
}, null, 2));

process.env.LS_CONFIG = CONFIG;
delete process.env.STREAM_USER;
delete process.env.STREAM_PASSWORD;
require('../src/server');
