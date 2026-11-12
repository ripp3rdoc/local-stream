const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const { ffmpegAvailable } = require('./scanner');

// ISO 639 language tags (2- and 3-letter, incl. 639-2/B) -> display names.
const LANG_NAMES = {
  en: 'English', eng: 'English',
  es: 'Spanish', spa: 'Spanish',
  fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German',
  it: 'Italian', ita: 'Italian',
  pt: 'Portuguese', por: 'Portuguese',
  ru: 'Russian', rus: 'Russian',
  ja: 'Japanese', jpn: 'Japanese',
  ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  nl: 'Dutch', dut: 'Dutch', nld: 'Dutch',
  ar: 'Arabic', ara: 'Arabic',
  hi: 'Hindi', hin: 'Hindi',
  pl: 'Polish', pol: 'Polish',
  sv: 'Swedish', swe: 'Swedish',
  no: 'Norwegian', nor: 'Norwegian',
  da: 'Danish', dan: 'Danish',
  fi: 'Finnish', fin: 'Finnish',
  bg: 'Bulgarian', bul: 'Bulgarian',
  cs: 'Czech', cze: 'Czech', ces: 'Czech',
  et: 'Estonian', est: 'Estonian',
  el: 'Greek', gre: 'Greek', ell: 'Greek',
  he: 'Hebrew', heb: 'Hebrew',
  hr: 'Croatian', hrv: 'Croatian',
  id: 'Indonesian', ind: 'Indonesian',
  ro: 'Romanian', rum: 'Romanian', ron: 'Romanian',
  sk: 'Slovak', slo: 'Slovak', slk: 'Slovak',
  sl: 'Slovenian', slv: 'Slovenian',
  sr: 'Serbian', srp: 'Serbian',
  th: 'Thai', tha: 'Thai',
  vi: 'Vietnamese', vie: 'Vietnamese',
  tr: 'Turkish', tur: 'Turkish',
  uk: 'Ukrainian', ukr: 'Ukrainian',
  hu: 'Hungarian', hun: 'Hungarian',
  ms: 'Malay', may: 'Malay', msa: 'Malay',
  fa: 'Persian', per: 'Persian', fas: 'Persian',
  ca: 'Catalan', cat: 'Catalan',
  lt: 'Lithuanian', lit: 'Lithuanian',
  lv: 'Latvian', lav: 'Latvian',
  is: 'Icelandic', ice: 'Icelandic', isl: 'Icelandic',
};

function isSubExt(name) {
  return config.subtitleExtensions.includes(path.extname(name).toLowerCase());
}

// Derive { lang, label } from a free-form subtitle filename or tag, e.g.
// "English", "2_English.HI", "en", "Movie.fr". Falls back to "Subtitles".
function parseSubMeta(text) {
  let s = String(text)
    .replace(/\.(srt|vtt|ass|ssa|sub|idx)$/i, '') // strip subtitle extension
    .replace(/^\d+[\s._-]*/, '');                 // strip leading "2_" etc.
  const lower = s.toLowerCase();

  const flags = [];
  if (/\bsdh\b|\bhi\b|hearing/i.test(s)) flags.push('SDH');
  if (/forced/i.test(s)) flags.push('Forced');

  let lang = 'und';
  let langName = null;
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) {
    if (LANG_NAMES[t]) { lang = t; langName = LANG_NAMES[t]; break; }
  }
  if (!langName) {
    for (const [code, nm] of Object.entries(LANG_NAMES)) {
      if (lower.includes(nm.toLowerCase())) { lang = code; langName = nm; break; }
    }
  }

  let label = langName || (s.trim() || 'Subtitles');
  if (flags.length) label += ` (${flags.join(', ')})`;
  return { lang, label };
}

function gatherSubFiles(dir, depth, out) {
  if (depth < 0) return;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of dirents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) gatherSubFiles(full, depth - 1, out);
    else if (isSubExt(e.name)) out.push(full);
  }
}

// Find subtitle tracks for a video:
//  1) sidecar files in the same folder matching the video name
//     ("Movie.srt", "Movie.en.srt"), and
//  2) any subtitle files inside a "Subs"/"Subtitles" subfolder (e.g. YTS
//     releases that ship "Subs/English.srt").
function findSubtitles(video) {
  const dir = path.dirname(video.fullPath);
  const base = path.basename(video.fileName, path.extname(video.fileName));

  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];

  for (const e of dirents) {
    if (e.isFile() && isSubExt(e.name)) {
      const stem = path.basename(e.name, path.extname(e.name));
      if (stem !== base && !stem.startsWith(base + '.')) continue;
      const tag = stem === base ? '' : stem.slice(base.length + 1);
      const meta = tag ? parseSubMeta(tag) : { lang: 'und', label: 'Subtitles' };
      found.push({ fullPath: path.join(dir, e.name), ...meta });
    } else if (e.isDirectory() && /sub/i.test(e.name)) {
      const files = [];
      gatherSubFiles(path.join(dir, e.name), 2, files);
      for (const f of files) found.push({ fullPath: f, ...parseSubMeta(path.basename(f)) });
    }
  }

  // Stable order so a track's index is consistent across requests.
  found.sort((a, b) => a.fullPath.localeCompare(b.fullPath));

  return found.map((s, i) => ({
    index: i,
    fileName: path.basename(s.fullPath),
    fullPath: s.fullPath,
    ext: path.extname(s.fullPath).toLowerCase(),
    lang: s.lang,
    label: s.label,
  }));
}

// Shift WebVTT cue timestamps by `offset` seconds (for sync correction).
function shiftVtt(content, offset) {
  if (!offset) return content;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return content.split('\n').map((line) => {
    if (!line.includes('-->')) return line;
    return line.replace(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/g, (_m, h, m, s, ms) => {
      let t = (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 +
        parseInt(s, 10) + parseInt(ms, 10) / 1000 + offset;
      if (t < 0) t = 0;
      const hh = Math.floor(t / 3600);
      const mm = Math.floor((t % 3600) / 60);
      const ss = Math.floor(t % 60);
      const mss = Math.round((t - Math.floor(t)) * 1000);
      return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(mss, 3)}`;
    });
  }).join('\n');
}

// Minimal SRT -> WebVTT conversion used when FFmpeg isn't available.
function srtToVtt(srt) {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    // 00:00:01,000 --> 00:00:04,000  =>  00:00:01.000 --> 00:00:04.000
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

function ffmpegToVtt(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', inputPath, '-f', 'webvtt', outputPath],
      { timeout: 30000 }, (err) => (err ? reject(err) : resolve(outputPath)));
  });
}

// Return a path to a cached WebVTT version of the given subtitle track.
async function getVttPath(video, index) {
  const subs = findSubtitles(video);
  const sub = subs[index];
  if (!sub) return null;

  const outDir = path.join(config.dataDir, 'subtitles');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${video.id}_${index}.vtt`);

  // Reuse cache unless the source subtitle is newer.
  if (fs.existsSync(outPath)) {
    try {
      if (fs.statSync(outPath).mtimeMs >= fs.statSync(sub.fullPath).mtimeMs) {
        return outPath;
      }
    } catch { /* regenerate */ }
  }

  if (sub.ext === '.vtt') {
    fs.copyFileSync(sub.fullPath, outPath);
    return outPath;
  }

  // FFmpeg handles srt/ass/ssa/sub robustly; fall back to a simple SRT parse.
  if (ffmpegAvailable) {
    try {
      await ffmpegToVtt(sub.fullPath, outPath);
      return outPath;
    } catch { /* fall through to manual */ }
  }

  if (sub.ext === '.srt') {
    fs.writeFileSync(outPath, srtToVtt(fs.readFileSync(sub.fullPath, 'utf-8')));
    return outPath;
  }

  return null; // Unsupported format without FFmpeg.
}

module.exports = { findSubtitles, getVttPath, shiftVtt };
