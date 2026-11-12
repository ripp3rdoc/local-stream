const path = require('path');
const fs = require('fs');

const defaults = {
  port: 3000,
  // HTTPS is required for in-page casting (Remote Playback API needs a
  // secure context). When enabled, a self-signed cert is generated on first
  // run and cached under data/certs/. Set https.enabled to false for plain HTTP.
  https: { enabled: true },
  // A Chromecast won't trust the self-signed HTTPS cert, so media + subtitles
  // are also served over plain HTTP on this port (token-protected) for the TV
  // to fetch. Set to null to disable Google Cast support.
  castHttpPort: 3001,
  subtitleExtensions: ['.srt', '.vtt', '.ass', '.ssa', '.sub'],
  mediaDirs: [path.join(__dirname, '..', 'media')],
  dataDir: path.join(__dirname, '..', 'data'),
  videoExtensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts'],
  thumbnailWidth: 480,
  transcodePreset: 'veryfast',
  hlsSegmentDuration: 4,
};

// LS_CONFIG points at an alternative config file (used by the demo).
const configPath = process.env.LS_CONFIG
  ? path.resolve(process.env.LS_CONFIG)
  : path.join(__dirname, '..', 'config.json');
let userConfig = {};

if (fs.existsSync(configPath)) {
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.warn('Invalid config.json, using defaults');
  }
}

const merged = { ...defaults, ...userConfig };

// Normalize mediaDirs into { path, category } objects. A plain string entry
// keeps backward compatibility, defaulting its category to the folder name.
merged.mediaDirs = merged.mediaDirs.map((entry) => {
  if (typeof entry === 'string') {
    return { path: entry, category: path.basename(entry) };
  }
  return { path: entry.path, category: entry.category || path.basename(entry.path) };
});

merged.configPath = configPath;

module.exports = merged;
