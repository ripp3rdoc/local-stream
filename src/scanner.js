const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('./config');

let library = new Map();
let scanning = false;

function videoId(relativePath) {
  return crypto.createHash('md5').update(relativePath).digest('hex').slice(0, 12);
}

// Turn a release-style filename into a readable title, e.g.
// "Dark.City.1998.DC.1080p.BluRay.x265-GalaxyRG" -> "Dark City (1998)".
// Names without a year token are just tidied (separators, trailing tags).
function cleanTitle(name) {
  let s = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ');
  for (let i = 1; i < tokens.length; i++) {
    const m = tokens[i].match(/^[[(]?((?:19|20)\d{2})[)\]]?$/);
    if (m) {
      const title = tokens.slice(0, i).join(' ').trim();
      if (title) return `${title} (${m[1]})`;
    }
  }
  // No year: drop a trailing bracketed group tag like [YTS.MX] or (1080p).
  s = s.replace(/\s*[[(][^)\]]*[)\]]\s*$/g, '').trim();
  return s || name;
}

function findVideos(dir, baseDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findVideos(fullPath, baseDir));
    } else if (config.videoExtensions.includes(path.extname(entry.name).toLowerCase())) {
      const relativePath = path.relative(baseDir, fullPath);
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; } // unreadable file
      results.push({
        id: videoId(relativePath),
        title: cleanTitle(path.basename(entry.name, path.extname(entry.name))),
        fileName: entry.name,
        relativePath,
        fullPath,
        extension: path.extname(entry.name).toLowerCase(),
        size: stat.size,
        addedAt: stat.mtimeMs,
        folder: path.dirname(relativePath) === '.' ? null : path.dirname(relativePath),
      });
    }
  }
  return results;
}

function runFFprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function generateThumbnail(filePath, outputPath, timestamp) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    execFile('ffmpeg', [
      '-y',
      '-ss', String(timestamp),
      '-i', filePath,
      '-vframes', '1',
      '-vf', `scale=${config.thumbnailWidth}:-1`,
      '-q:v', '6',
      outputPath,
    ], { timeout: 30000 }, (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

function hasFFmpeg() {
  try {
    require('child_process').execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = hasFFmpeg();

async function enrichVideo(video) {
  if (!ffmpegAvailable) {
    video.duration = null;
    video.width = null;
    video.height = null;
    video.videoCodec = null;
    video.audioCodec = null;
    video.bitrate = null;
    video.hasThumbnail = false;
    return video;
  }

  try {
    const probe = await runFFprobe(video.fullPath);
    const videoStream = probe.streams?.find(s => s.codec_type === 'video');
    const audioStream = probe.streams?.find(s => s.codec_type === 'audio');
    const format = probe.format || {};

    // Real container (e.g. "mov,mp4,m4a,3gp,3g2,mj2", "mpegts"); the file
    // extension can lie — some ".mp4" course files are MPEG-TS inside.
    video.container = format.format_name || null;
    video.duration = parseFloat(format.duration) || null;
    video.width = videoStream?.width || null;
    video.height = videoStream?.height || null;
    video.videoCodec = videoStream?.codec_name || null;
    video.audioCodec = audioStream?.codec_name || null;
    video.bitrate = parseInt(format.bit_rate) || null;
  } catch {
    video.duration = null;
    video.width = null;
    video.height = null;
    video.videoCodec = null;
    video.audioCodec = null;
    video.bitrate = null;
  }

  const thumbDir = path.join(config.dataDir, 'thumbnails');
  const thumbPath = path.join(thumbDir, `${video.id}.jpg`);

  if (!fs.existsSync(thumbPath) && video.duration) {
    try {
      await generateThumbnail(video.fullPath, thumbPath, Math.min(video.duration * 0.1, 30));
      video.hasThumbnail = true;
    } catch {
      video.hasThumbnail = false;
    }
  } else {
    video.hasThumbnail = fs.existsSync(thumbPath);
  }

  return video;
}

let rescanRequested = false;

async function scanLibrary() {
  // A scan requested mid-scan (e.g. a folder was just added) must not be
  // dropped: remember it and run again once the current scan finishes.
  if (scanning) { rescanRequested = true; return; }
  scanning = true;
  try {
    do {
      rescanRequested = false;
      await runScan();
    } while (rescanRequested);
  } finally {
    // Always clear the flag, or one failed scan blocks every future scan.
    scanning = false;
  }
}

async function runScan() {
  console.log('Scanning media library...');

  const videos = [];
  for (const { path: dir, category } of config.mediaDirs) {
    if (!fs.existsSync(dir)) {
      // A missing source may be an unplugged drive: skip it, don't create it.
      console.warn(`  Media folder not found, skipping: ${dir}`);
      continue;
    }
    const found = findVideos(dir, dir);
    found.forEach((v) => { v.category = category; });
    videos.push(...found);
  }

  const batchSize = 5;
  for (let i = 0; i < videos.length; i += batchSize) {
    const batch = videos.slice(i, i + batchSize);
    await Promise.all(batch.map(v => enrichVideo(v)));
  }

  library.clear();
  for (const video of videos) {
    library.set(video.id, video);
  }

  console.log(`Found ${library.size} video(s)`);
  if (!ffmpegAvailable) {
    console.log('FFmpeg not found - thumbnails and metadata disabled. Install with: winget install ffmpeg');
  }
}

function getLibrary() {
  return Array.from(library.values());
}

function getVideo(id) {
  return library.get(id) || null;
}

function isScanning() {
  return scanning;
}

module.exports = { scanLibrary, getLibrary, getVideo, isScanning, ffmpegAvailable };
