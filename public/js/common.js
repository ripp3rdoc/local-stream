// Shared helpers for every page (loaded before the page script).
'use strict';

const LS = window.LS || {};
window.LS = LS;

// Escape text before putting it into innerHTML (file/folder names can
// contain quotes, <, & etc.).
LS.escapeHtml = function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

LS.formatDuration = function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

// "3h 25m" / "42m" — for totals, where seconds are noise.
LS.formatLength = function formatLength(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
};

LS.formatSize = function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} MB`;
};

LS.resolutionLabel = function resolutionLabel(height) {
  if (!height) return '';
  if (height >= 2000) return '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return 'SD';
};

// Folder/category names come straight from disk: "OSEP_-_PEN300",
// "Module 1\\Videos". Make them readable without changing their meaning.
LS.prettyName = function prettyName(name) {
  if (!name) return '';
  return String(name)
    .replace(/[\\/]+/g, ' › ')
    .replace(/_+/g, ' ')
    .replace(/\s+-\s+|\s{2,}/g, m => (m.includes('-') ? ' – ' : ' '))
    .trim();
};

// Natural sort ("2" before "10"), matching the server's playback order.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
LS.naturalCompare = (a, b) => collator.compare(a || '', b || '');

// Watch state derived from a progress record.
LS.watchState = function watchState(video) {
  const p = video.progress;
  if (!p) return { completed: false, fraction: 0, inProgress: false };
  const duration = video.duration || p.duration || 0;
  const fraction = duration && p.time ? Math.min(p.time / duration, 1) : 0;
  return {
    completed: Boolean(p.completed),
    fraction,
    // "Continue watching": started, and not within the last 30s.
    inProgress: p.time > 5 && (!duration || duration - p.time > 30),
  };
};

// fetch wrapper: JSON in/out, and a 401 sends you to the sign-in page.
LS.api = async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

// Inline SVG icons (stroke = currentColor), so no icon font or extra files.
const ICON_PATHS = {
  play: '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  up: '<polyline points="18 15 12 9 6 15"/>',
  drive: '<rect x="2" y="13" width="20" height="8" rx="2"/><path d="M5 13l2.5-8h9L19 13"/><circle cx="17" cy="17" r="1" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>',
  auto: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M12 7.5a2.5 2.5 0 0 0 0 5z" fill="currentColor" stroke="none"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  userPlus: '<circle cx="9" cy="8" r="4"/><path d="M1 21a8 8 0 0 1 16 0"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="17" y1="11" x2="23" y2="11"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M19 4l2 2"/>',
  film: '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="7" y1="3" x2="7" y2="21"/><line x1="17" y1="3" x2="17" y2="21"/><line x1="2" y1="12" x2="22" y2="12"/>',
};

LS.icon = function icon(name, size = 20, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${ICON_PATHS[name] || ''}</svg>`;
};

// Shared decoration hook retained for library and player callers.
// The samurai skin uses CSS HUD frames instead of floating particles.
LS.initDecor = function initDecor() {};

// --- Light / dark mode -------------------------------------------------------
// Each page detects the device before first paint. Manual changes apply to
// the current page; the appearance control offers only Light and Dark.
const MODE_LABEL = { light: 'Light', dark: 'Dark' };

LS.getModeChoice = () => document.documentElement.dataset.mode === 'light' ? 'light' : 'dark';
LS.effectiveMode = LS.getModeChoice;

function applyMode() {
  const mode = LS.effectiveMode();
  document.documentElement.dataset.mode = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = mode === 'light' ? '#eaf0f2' : '#05070c';
}

LS.setModeChoice = function setModeChoice(choice) {
  if (choice !== 'light' && choice !== 'dark') return;
  document.documentElement.dataset.mode = choice;
  applyMode();
};

LS.bindModeToggle = function bindModeToggle(btn) {
  const sync = () => {
    const current = LS.getModeChoice();
    const next = current === 'light' ? 'dark' : 'light';
    btn.innerHTML = LS.icon(current === 'light' ? 'sun' : 'moon');
    btn.title = `Appearance: ${MODE_LABEL[current]} — switch to ${MODE_LABEL[next]}`;
    btn.setAttribute('aria-label', btn.title);
  };
  btn.addEventListener('click', () => {
    const next = LS.getModeChoice() === 'light' ? 'dark' : 'light';
    LS.setModeChoice(next);
    sync();
    LS.toast(`${MODE_LABEL[next]} mode`);
  });
  sync();
};

applyMode();

// Small toast for success/error feedback.
LS.toast = function toast(message, kind = 'info') {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add('leaving'), 2600);
  setTimeout(() => el.remove(), 3000);
};
