#!/usr/bin/env node
// Generate a fictional demo library for screenshots: title-card videos with
// realistic runtimes, nested course folders and subtitle tracks.
//
//   node demo/generate-media.js [--force]
//
// Each video is a single poster frame (gradient + grain + title) encoded as a
// real H.264/AAC MP4 at 1 fps, so files stay tiny and generate in seconds
// while durations, thumbnails and playback all behave like real media.
// Requires ffmpeg on PATH. Output: demo/media/ (git-ignored).
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, 'media');
const FORCE = process.argv.includes('--force');

// --- Fonts ------------------------------------------------------------------
const FONT_DIRS = [
  'C:/Windows/Fonts', '/usr/share/fonts/truetype/dejavu', '/System/Library/Fonts/Supplemental', '/Library/Fonts',
];
function font(...names) {
  for (const dir of FONT_DIRS) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`None of these fonts found: ${names.join(', ')}`);
}
const FONTS = {
  serif: font('georgiab.ttf', 'Georgia Bold.ttf', 'DejaVuSerif-Bold.ttf'),
  sans: font('bahnschrift.ttf', 'segoeuib.ttf', 'Arial Bold.ttf', 'DejaVuSans-Bold.ttf'),
  light: font('segoeuil.ttf', 'segoeui.ttf', 'Arial.ttf', 'DejaVuSans.ttf'),
  jp: font('yumindb.ttf', 'yumin.ttf', 'msgothic.ttc', 'Hiragino Sans GB.ttc', 'DejaVuSans.ttf'),
};

// --- Library definition -------------------------------------------------------
// [palette, gradient type] per collection keeps each collection visually coherent.
const PALETTES = {
  movies: [['0x0b1a3a', '0xff3eaa', '0x37edee'], ['0x1d0b2e', '0xff8a3d', '0x2a0a12'], ['0x02141b', '0x37edee', '0x0b3d2e'],
    ['0x2b0f0f', '0xd4462a', '0x170d21'], ['0x0a1020', '0x6a5cff', '0x00c2a8'], ['0x141414', '0xe8c170', '0x3a1f0b'],
    ['0x0d1b2a', '0x9fd3ff', '0x1b263b'], ['0x1a0626', '0x75ffff', '0xff3eaa']],
  series: ['0x050b1e', '0x4d7cff', '0xc04dff'],
  rust: ['0x1b0d06', '0xff7a2f', '0x3b1a0a'],
  watercolor: ['0x13283a', '0x7fc8a9', '0xf2b5d4'],
  signals: ['0x041016', '0x37edee', '0x0d3b66'],
  docs: [['0x021b2b', '0x0aa2c0', '0x01303f'], ['0x0b1f0e', '0x6fbf4a', '0x10301a'],
    ['0x1f0a03', '0xff5a1f', '0x2a0e05'], ['0x05060f', '0x3d4cff', '0xc6b8ff']],
};

const videos = [];
const add = (v) => videos.push(v);

// Movies — release-style filenames show off the title cleaner.
const movies = [
  ['Neon.Ronin.2031.1080p.BluRay.x264-DEMO', 'NEON RONIN', '2031 · Sci-fi · 1h 58m', 118, '浪人', true],
  ['The.Paper.Lantern.1998.720p.WEB-DL.AAC', 'THE PAPER LANTERN', '1998 · Drama · 1h 44m', 104, '灯籠'],
  ['Glass.Orchard.2019.2160p.HDR.x265-DEMO', 'GLASS ORCHARD', '2019 · Mystery · 2h 6m', 126, '果樹園'],
  ['Midnight.Cartographers.2024.1080p.WEBRip', 'MIDNIGHT CARTOGRAPHERS', '2024 · Adventure · 1h 37m', 97, '地図'],
  ['Saltwater.Requiem.2015.1080p.BluRay', 'SALTWATER REQUIEM', '2015 · Thriller · 1h 52m', 112, '潮'],
  ['Echoes.of.Kyoto.2008.1080p.BluRay.x264', 'ECHOES OF KYOTO', '2008 · Romance · 1h 31m', 91, '京都'],
  ['The.Last.Lighthouse.Keeper.2022.1080p', 'THE LAST LIGHTHOUSE KEEPER', '2022 · Drama · 1h 49m', 109, '灯台'],
  ['Static.Bloom.2027.1080p.WEB-DL', 'STATIC BLOOM', '2027 · Sci-fi · 1h 28m', 88, '花'],
];
movies.forEach(([file, title, sub, min, kanji, subs], i) => add({
  rel: `Movies/${file}.mp4`, title, sub, min, kanji, font: 'serif',
  colors: PALETTES.movies[i], type: ['radial', 'linear', 'circular', 'spiral'][i % 4], seed: 11 + i,
  subs: subs ? ['en', 'ja', 'es'] : null,
}));

// Series — seasons as folders.
const eps = [
  ['Arrival', 46], ['Dead Reckoning', 44], ['The Quiet Ring', 47], ['Signal Fire', 43], ['Orbit Decay', 45], ['Homecoming', 52],
  ['New Tenants', 44], ['Ghost Shift', 46], ['Red Shift', 42], ['Escape Velocity', 55],
];
eps.forEach(([name, min], i) => {
  const s = i < 6 ? 1 : 2;
  const e = i < 6 ? i + 1 : i - 5;
  const code = `S0${s}E0${e}`;
  add({
    rel: `Starlight Station/Season 0${s}/Starlight.Station.${code}.${name.replace(/ /g, '.')}.mp4`,
    title: 'STARLIGHT STATION', sub: `${code} · ${name}`, min, kanji: '星', font: 'sans',
    colors: PALETTES.series, type: 'radial', seed: 40 + i,
  });
});

// Courses — module folders with numbered lessons (natural sort demo).
const rust = {
  '01 - Foundations': [['Welcome and setup', 6], ['Ownership in one picture', 18], ['Borrowing rules', 22], ['Lifetimes demystified', 27]],
  '02 - Concurrency': [['Threads and channels', 24], ['Send and Sync', 16], ['Async from first principles', 31]],
  '03 - Systems': [['Talking to the OS', 21], ['Unsafe, carefully', 26], ['Writing a tiny allocator', 34], ['Profiling and flamegraphs', 19]],
};
Object.entries(rust).forEach(([mod, lessons], m) => lessons.forEach(([name, min], l) => add({
  rel: `Rust Systems Programming/${mod}/${l + 1} - ${name}.mp4`,
  title: name.toUpperCase(), sub: `Rust Systems Programming · Module ${m + 1} · Lesson ${l + 1}`, min, kanji: '錆',
  font: 'sans', colors: PALETTES.rust, type: 'linear', seed: 70 + m * 5 + l, subs: ['en'],
})));

['Materials and paper', 'Washes and gradients', 'Wet-on-wet skies', 'Layering and glazing', 'Painting light', 'Final project - harbour at dusk']
  .forEach((name, i) => add({
    rel: `Watercolor Fundamentals/${i + 1} - ${name}.mp4`,
    title: name.toUpperCase(), sub: `Watercolor Fundamentals · Lesson ${i + 1}`, min: [12, 17, 21, 19, 24, 38][i], kanji: '水彩',
    font: 'sans', colors: PALETTES.watercolor, type: 'circular', seed: 100 + i,
  }));

['What is a signal','Sampling and aliasing', 'The Fourier transform', 'Filters you can hear', 'Software-defined radio', 'Capstone - decoding weather satellites']
  .forEach((name, i) => add({
    rel: `Signal Processing for Hackers/${String(i + 1).padStart(2, '0')} - ${name}.mp4`,
    title: name.toUpperCase(), sub: `Signal Processing for Hackers · Part ${i + 1}`, min: [14, 23, 29, 26, 33, 41][i], kanji: '信号',
    font: 'sans', colors: PALETTES.signals, type: 'spiral', seed: 130 + i,
  }));

// Documentaries.
[['Deep.Blue.Frontier.2021.1080p', 'DEEP BLUE FRONTIER', '2021 · Nature · 52m', 52, '深海'],
  ['Kingdom.of.Moss.2018.1080p', 'KINGDOM OF MOSS', '2018 · Nature · 48m', 48, '苔'],
  ['The.Volcano.Diaries.2023.2160p', 'THE VOLCANO DIARIES', '2023 · Science · 1h 4m', 64, '火山'],
  ['Night.Skies.of.Atacama.2020.1080p', 'NIGHT SKIES OF ATACAMA', '2020 · Space · 57m', 57, '夜空'],
].forEach(([file, title, sub, min, kanji], i) => add({
  rel: `Documentaries/${file}.mp4`, title, sub, min, kanji, font: 'serif',
  colors: PALETTES.docs[i], type: ['radial', 'linear', 'circular', 'radial'][i], seed: 160 + i,
}));

// --- ffmpeg helpers -----------------------------------------------------------
function run(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 24 },
      (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

// Filter-graph escaping for a path inside single quotes.
const fpath = p => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-demo-'));
let n = 0;
function textFile(text) {
  const f = path.join(tmp, `t${n++}.txt`);
  fs.writeFileSync(f, text);
  return fpath(f);
}

function wrap(title, max) {
  const words = title.split(' ');
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + ' ' + w).length > max) lines.push(w);
    else lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
  }
  return lines.join('\n');
}

async function poster(v, out) {
  const [c0, c1, c2] = v.colors;
  const big = v.font === 'serif' ? 92 : 70;
  const title = wrap(v.title, v.font === 'serif' ? 18 : 22);
  const filters = [
    'noise=alls=10:allf=t',
    'vignette=PI/3.2',
    // hanko-style seal, top-right
    `drawbox=x=iw-200:y=60:w=130:h=130:color=0xff3eaa@0.16:t=fill`,
    `drawbox=x=iw-200:y=60:w=130:h=130:color=0xff3eaa@0.9:t=4`,
    `drawtext=fontfile=${fpath(FONTS.jp)}:textfile=${textFile(v.kanji)}:fontsize=${[76, 76, 52, 36][Math.min(v.kanji.length, 3)]}:fontcolor=0xff3eaa:x=w-135-text_w/2:y=125-text_h/2`,
    // HUD corner lines
    'drawbox=x=60:y=60:w=90:h=4:color=0x37edee@0.9:t=fill', 'drawbox=x=60:y=60:w=4:h=90:color=0x37edee@0.9:t=fill',
    // title + subtitle, bottom-left
    `drawtext=fontfile=${fpath(FONTS[v.font])}:textfile=${textFile(title)}:fontsize=${big}:fontcolor=white:line_spacing=10:x=80:y=h-text_h-170:shadowcolor=black@0.6:shadowx=3:shadowy=3`,
    `drawtext=fontfile=${fpath(FONTS.light)}:textfile=${textFile(v.sub)}:fontsize=30:fontcolor=0xe4f3f6@0.85:x=82:y=h-120`,
    'drawbox=x=82:y=ih-70:w=220:h=4:color=0xff3eaa@0.9:t=fill',
  ];
  await run(['-f', 'lavfi', '-i',
    `gradients=s=1280x720:c0=${c0}:c1=${c1}:c2=${c2}:n=3:type=${v.type}:seed=${v.seed}:speed=0`,
    '-vf', filters.join(','), '-frames:v', '1', out]);
}

async function encode(v, png, out) {
  await run([
    '-loop', '1', '-framerate', '1', '-i', png,
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
    '-t', String(v.min * 60), '-r', '1',
    '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '28', '-g', '300',
    '-c:a', 'aac', '-b:a', '16k', '-shortest', '-movflags', '+faststart', out,
  ]);
}

// --- Subtitles ----------------------------------------------------------------
const LINES = {
  en: ['The station never sleeps.', 'Do you hear that hum? That\'s the city breathing.', 'We have until dawn.',
    'Keep the lantern lit — they\'ll find us by it.', 'Every map lies a little.', 'Then we make our own road.',
    'You came back.', 'I never really left.'],
  ja: ['駅は眠らない。', 'あの音が聞こえる？街の呼吸だ。', '夜明けまでしかない。', '灯りを消すな。', 'どの地図も少し嘘をつく。',
    'なら自分の道を作ろう。', '戻ってきたのか。', '本当は離れていなかった。'],
  es: ['La estación nunca duerme.', '¿Oyes ese zumbido? Es la ciudad respirando.', 'Tenemos hasta el amanecer.',
    'Mantén la linterna encendida.', 'Todos los mapas mienten un poco.', 'Entonces hacemos nuestro propio camino.',
    'Volviste.', 'Nunca me fui del todo.'],
};
const ts = s => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},000`;
};
function srt(lang, minutes) {
  const lines = LINES[lang];
  const out = [];
  for (let i = 0, t = 2; t < minutes * 60 - 5; i++, t += 6) {
    out.push(`${i + 1}\n${ts(t)} --> ${ts(t + 5)}\n${lines[i % lines.length]}\n`);
  }
  return out.join('\n');
}

// --- Main ---------------------------------------------------------------------
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

(async () => {
  console.log(`Generating ${videos.length} demo videos in ${ROOT}`);
  let done = 0;
  await pool(videos, Math.max(2, Math.min(6, os.cpus().length - 1)), async (v) => {
    const out = path.join(ROOT, v.rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (FORCE || !fs.existsSync(out)) {
      const png = path.join(tmp, `poster${videos.indexOf(v)}.png`);
      await poster(v, png);
      await encode(v, png, out);
    }
    if (v.subs) {
      const base = out.slice(0, -4);
      for (const lang of v.subs) fs.writeFileSync(`${base}.${lang}.srt`, srt(lang, v.min));
    }
    process.stdout.write(`\r  ${++done}/${videos.length}`);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nDone.');
})().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
