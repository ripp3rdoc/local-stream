const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const activeTranscodes = new Map();

function isDirectPlayable(video) {
  const directContainers = ['.mp4', '.m4v', '.webm'];
  const directVideoCodecs = ['h264', 'vp8', 'vp9', 'av1'];
  const directAudioCodecs = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

  if (!directContainers.includes(video.extension)) return false;
  // Trust the probed container over the extension: an MPEG-TS stream named
  // ".mp4" can't be played by browsers and must go through HLS instead.
  if (video.container && !/(^|,)(mp4|mov|webm)(,|$)/.test(video.container)) return false;
  if (video.videoCodec && !directVideoCodecs.includes(video.videoCodec)) return false;
  if (video.audioCodec && !directAudioCodecs.includes(video.audioCodec)) return false;
  return true;
}

function streamDirect(video, req, res) {
  const filePath = video.fullPath;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
  };
  const contentType = mimeTypes[video.extension] || 'video/mp4';

  const range = req.headers.range;
  if (range) {
    const parsed = parseRange(range, fileSize);
    if (!parsed) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end();
      return;
    }
    const { start, end } = parsed;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    pipeFile(fs.createReadStream(filePath, { start, end }), res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    pipeFile(fs.createReadStream(filePath), res);
  }
}

// Parse a single "bytes=start-end" / "bytes=start-" / "bytes=-suffix" range.
// Returns null when the range is malformed or unsatisfiable.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).split(',')[0].trim());
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return null;
  let start;
  let end;
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    start = Math.max(0, size - parseInt(m[2], 10));
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

// Pipe a file stream to the response without letting a read error (file
// deleted, drive unplugged) crash the whole server.
function pipeFile(stream, res) {
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function getTranscodeDir(videoId) {
  return path.join(config.dataDir, 'transcode', videoId);
}

function startTranscode(video) {
  const outDir = getTranscodeDir(video.id);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const playlistPath = path.join(outDir, 'stream.m3u8');

  if (activeTranscodes.has(video.id)) return;
  if (fs.existsSync(playlistPath)) return;

  // Re-encode only what the browser can't play. H.264 video and AAC audio are
  // copied (fast); anything else (HEVC, E-AC-3/Dolby, etc.) is transcoded.
  const videoArgs = video.videoCodec === 'h264'
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', config.transcodePreset, '-crf', '23'];
  const audioArgs = video.audioCodec === 'aac'
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];

  const args = [
    '-i', video.fullPath,
    // Take just the first video + audio track; ignore extra/image subtitle
    // streams (e.g. PGS) that would break HLS muxing.
    '-map', '0:v:0',
    '-map', '0:a:0?', // "?" = optional, so videos without audio still work
    ...videoArgs,
    ...audioArgs,
    '-f', 'hls',
    '-hls_time', String(config.hlsSegmentDuration),
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(outDir, 'seg%04d.ts'),
    '-start_number', '0',
    playlistPath,
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  const state = { process: proc, ready: false, error: null };
  activeTranscodes.set(video.id, state);

  proc.stderr.on('data', () => {});

  const checkReady = setInterval(() => {
    if (fs.existsSync(playlistPath)) {
      state.ready = true;
      clearInterval(checkReady);
    }
  }, 500);

  // On failure, report the error once, then drop the state and the partial
  // output so the next request can retry (instead of a half-written playlist
  // being treated as "ready" forever).
  const fail = (msg) => {
    clearInterval(checkReady);
    state.error = msg;
    state.ready = false;
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    setTimeout(() => {
      if (activeTranscodes.get(video.id) === state) activeTranscodes.delete(video.id);
    }, 10000);
  };

  proc.on('close', (code) => {
    if (state.error) return; // already handled by 'error'
    clearInterval(checkReady);
    if (code === 0) {
      state.ready = true;
      activeTranscodes.delete(video.id); // the finished playlist on disk is the state now
    } else {
      fail(`FFmpeg exited with code ${code}`);
    }
  });

  proc.on('error', (err) => fail(err.message));
}

function getTranscodeState(videoId) {
  const active = activeTranscodes.get(videoId);
  if (active && active.error) return active;
  const playlistPath = path.join(getTranscodeDir(videoId), 'stream.m3u8');
  if (fs.existsSync(playlistPath)) return { ready: true };
  return active || null;
}

// Only allow the files ffmpeg writes (stream.m3u8, segNNNN.ts) and plain
// hex video ids, so URL-encoded "..\" can't escape the transcode folder.
const SAFE_ID = /^[a-f0-9]{1,64}$/i;
const SAFE_HLS_FILE = /^(stream\.m3u8|seg\d+\.ts)$/;

function serveHLSFile(videoId, fileName, res, token) {
  if (!SAFE_ID.test(videoId) || !SAFE_HLS_FILE.test(fileName)) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  const filePath = path.join(getTranscodeDir(videoId), fileName);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }

  const ext = path.extname(fileName);
  if (ext === '.m3u8') {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    // A Chromecast fetches segment URIs from the playlist relative to it, which
    // would drop the auth token. When a token is present (cast), append it to
    // each segment line so the receiver can fetch segments too.
    if (token) {
      const text = fs.readFileSync(filePath, 'utf-8').split('\n').map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        const sep = t.includes('?') ? '&' : '?';
        return `${t}${sep}token=${encodeURIComponent(token)}`;
      }).join('\n');
      res.setHeader('Cache-Control', 'no-store');
      res.send(text);
      return;
    }
  } else if (ext === '.ts') {
    res.setHeader('Content-Type', 'video/mp2t');
  }

  pipeFile(fs.createReadStream(filePath), res);
}

function cleanupTranscodes() {
  const transcodeDir = path.join(config.dataDir, 'transcode');
  if (!fs.existsSync(transcodeDir)) return;

  for (const [id, state] of activeTranscodes) {
    if (state.process && !state.process.killed) {
      state.process.kill('SIGTERM');
    }
  }
  activeTranscodes.clear();

  try {
    fs.rmSync(transcodeDir, { recursive: true, force: true });
  } catch {}
}

module.exports = {
  isDirectPlayable,
  streamDirect,
  startTranscode,
  getTranscodeState,
  serveHLSFile,
  cleanupTranscodes,
  pipeFile,
};
