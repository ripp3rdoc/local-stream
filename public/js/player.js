// Player page: playback (direct or HLS), speed, subtitles, casting,
// previous/next, playlist, and progress tracking.
'use strict';

const { escapeHtml: esc, icon, prettyName } = LS;

const video = document.getElementById('videoPlayer');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const castBtn = document.getElementById('castBtn');
const ccWrap = document.getElementById('ccWrap');
const ccBtn = document.getElementById('ccBtn');
const ccMenu = document.getElementById('ccMenu');
const speedBtn = document.getElementById('speedBtn');
const speedMenu = document.getElementById('speedMenu');

const params = new URLSearchParams(window.location.search);
const videoId = params.get('id');
if (!videoId) window.location.replace('/');

// Tracks whether playback uses MSE (hls.js). The Remote Playback API can't
// cast an MSE/blob source, so casting is only reliable for direct-play files.
let usingMSE = false;

let videoData = null;          // full metadata for the current video
let castInfo = null;           // { httpBase, token } for TV-reachable URLs
let castSdkReady = false;      // Google Cast SDK loaded & initialized
let selectedSubtitle = -1;     // index into videoData.subtitles, -1 = off
let subOffset = 0;             // subtitle sync offset in seconds

// The Cast SDK calls this global when cast_sender.js finishes loading.
window.__onGCastApiAvailable = function (isAvailable) {
  if (isAvailable) initCastSdk();
};

// --- Popup menus (speed, subtitles) ------------------------------------------
// On phones a menu is a bottom sheet (CSS) over a dimmed backdrop; on larger
// screens it drops from its button and is flipped/limited to stay on screen.
const menus = [];
const phoneLayout = window.matchMedia('(max-width: 720px), (max-height: 500px)'); // must match the CSS
let menuScrim = null;

function setScrim(on) {
  if (on && !menuScrim) {
    menuScrim = document.createElement('div');
    menuScrim.className = 'menu-scrim';
    document.body.appendChild(menuScrim);
  }
  if (menuScrim) menuScrim.hidden = !on;
}

function placeMenu(menu) {
  menu.classList.remove('align-left', 'open-up');
  menu.style.maxHeight = '';
  if (phoneLayout.matches) return; // bottom sheet, positioned by CSS

  const pad = 8;
  // Default: right edge aligned with the button. Flip if it pokes out left.
  if (menu.getBoundingClientRect().left < pad) menu.classList.add('align-left');

  const anchor = menu.parentElement.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - pad * 2;
  const above = anchor.top - pad * 2;
  if (menu.getBoundingClientRect().bottom > window.innerHeight - pad && above > below) {
    menu.classList.add('open-up');
    menu.style.maxHeight = `${above}px`;
  } else {
    menu.style.maxHeight = `${Math.max(160, below)}px`;
  }
}

function registerMenu(button, menu) {
  menus.push({ button, menu });
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeMenus();
    if (open) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      placeMenu(menu);
      setScrim(phoneLayout.matches);
      const active = menu.querySelector('.active') || menu.querySelector('button');
      if (active) active.focus({ preventScroll: true });
    }
  });
  menu.addEventListener('click', e => e.stopPropagation());
}

function closeMenus() {
  for (const m of menus) {
    m.menu.hidden = true;
    m.button.setAttribute('aria-expanded', 'false');
  }
  setScrim(false);
}

// Rotating the phone / resizing the window: re-fit or close.
window.addEventListener('resize', closeMenus);

document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

// --- Playback speed (one setting for every video) ----------------------------
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const savedSpeed = parseFloat(localStorage.getItem('playbackRate'));
let speed = Number.isFinite(savedSpeed) && savedSpeed >= 0.25 && savedSpeed <= 4 ? savedSpeed : 1;
// While a source is loading, browsers may reset the rate; don't mistake that
// for the user changing it.
let rateLocked = true;

const fmtSpeed = r => `${Number(r.toFixed(2))}×`;

function applySpeed(rate, { save = true } = {}) {
  speed = Math.min(4, Math.max(0.25, Math.round(rate * 100) / 100));
  video.defaultPlaybackRate = speed; // survives loading a new source
  video.playbackRate = speed;
  if (save) localStorage.setItem('playbackRate', String(speed));
  speedBtn.textContent = fmtSpeed(speed);
  speedBtn.classList.toggle('on', speed !== 1);
  speedMenu.querySelectorAll('.seg[data-rate]').forEach((b) => {
    const active = Number(b.dataset.rate) === speed;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  });
}

function buildSpeedMenu() {
  speedMenu.innerHTML = '<div class="menu-head" data-jp="再生速度">Playback speed</div><div class="speed-grid">' +
    SPEEDS.map(r => `<button class="seg" role="menuitemradio" data-rate="${r}">${fmtSpeed(r)}</button>`).join('') +
    '</div><div class="menu-note">Applies to every video · <kbd>&lt;</kbd> <kbd>&gt;</kbd></div>';
  speedMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.seg[data-rate]');
    if (!item) return;
    applySpeed(Number(item.dataset.rate));
    closeMenus();
    LS.toast(`Speed ${fmtSpeed(speed)} — applies to every video`);
  });
}

function stepSpeed(dir) {
  const i = SPEEDS.findIndex(r => r >= speed - 0.001);
  const cur = i === -1 ? SPEEDS.length - 1 : i;
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, cur + dir))];
  applySpeed(next);
  LS.toast(`Speed ${fmtSpeed(speed)}`);
}

// Changing speed from the browser's own video menu also sticks.
video.addEventListener('ratechange', () => {
  if (Math.abs(video.playbackRate - speed) < 0.001 || video.playbackRate <= 0) return;
  if (rateLocked) video.playbackRate = speed;
  else applySpeed(video.playbackRate);
});
video.addEventListener('loadedmetadata', () => { video.playbackRate = speed; });
video.addEventListener('playing', () => {
  if (Math.abs(video.playbackRate - speed) > 0.001) video.playbackRate = speed;
  rateLocked = false;
});

buildSpeedMenu();
registerMenu(speedBtn, speedMenu);
// No petals on the player — nothing should float over the video.
LS.bindModeToggle(document.getElementById('modeBtn'));
LS.initDecor({ petals: false });
applySpeed(speed, { save: false });

// --- Progress --------------------------------------------------------------------
let saveInterval;

function postProgress(body, { keepalive = false } = {}) {
  return fetch(`/api/video/${encodeURIComponent(videoId)}/progress`, {
    method: 'POST',
    keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function saveProgressNow({ keepalive = false } = {}) {
  if (!(video.currentTime > 0) || video.ended) return;
  postProgress({ time: video.currentTime, duration: video.duration || null }, { keepalive });
}

function startProgressSaving() {
  clearInterval(saveInterval);
  saveInterval = setInterval(() => { if (!video.paused) saveProgressNow(); }, 5000);
}

function restoreProgress(data) {
  const p = data.progress;
  if (p && !p.completed && p.time > 5) {
    const remaining = (data.duration || Infinity) - p.time;
    if (remaining > 30) video.currentTime = p.time;
  }
}

video.addEventListener('pause', () => saveProgressNow());
window.addEventListener('pagehide', () => saveProgressNow({ keepalive: true }));

video.addEventListener('ended', () => {
  clearInterval(saveInterval);
  postProgress({ time: video.duration || 0, duration: video.duration || null, completed: true });
  markPlaylistDone(videoId);
  showUpNext();
});

// --- Loading -------------------------------------------------------------------
function showError(message) {
  loadingOverlay.hidden = false;
  loadingOverlay.classList.add('error');
  loadingOverlay.innerHTML = `${icon('film', 36)}<p>${esc(message)}</p>`;
}

async function initPlayer() {
  let data;
  try {
    data = await LS.api(`/api/video/${encodeURIComponent(videoId)}`);
  } catch (err) {
    showError(err.message === 'Video not found'
      ? 'This video is no longer in your library.'
      : `Couldn’t load this video: ${err.message}`);
    return;
  }
  videoData = data;
  renderInfo(data);
  setupCasting();
  setupSubtitles(data);
  setupEpisodeNav(data);
  loadPlaylist(data);
  prefetchCastInfo();

  try {
    if (data.directPlay || !data.ffmpeg) loadDirectStream(data);
    else await loadHLSStream(data);
  } catch (err) {
    showError(`Playback failed: ${err.message}`);
  }
}

function renderInfo(data) {
  const cat = data.category ? prettyName(data.category) : 'Library';
  const catUrl = data.category ? `/?c=${encodeURIComponent(data.category)}` : '/';
  document.title = `${data.title} · Local Stream`;
  document.getElementById('crumbCat').textContent = data.folder ? `${cat} › ${prettyName(data.folder)}` : cat;
  document.getElementById('crumbCat').href = catUrl;
  document.getElementById('backLink').href = catUrl;
  document.getElementById('crumbTitle').textContent = data.title;
  document.getElementById('videoTitle').textContent = data.title;

  const meta = [];
  const res = LS.resolutionLabel(data.height);
  if (res) meta.push(res);
  if (data.duration) meta.push(LS.formatDuration(data.duration));
  if (data.size) meta.push(LS.formatSize(data.size));
  if (!data.directPlay && data.ffmpeg) meta.push('Converted for your browser');
  const metaEl = document.getElementById('videoMeta');
  metaEl.innerHTML = meta.map(m => `<span>${esc(m)}</span>`).join('');
  metaEl.title = [data.videoCodec, data.audioCodec].filter(Boolean).join(' / ').toUpperCase();
}

function onPlayerReady(data) {
  loadingOverlay.hidden = true;
  restoreProgress(data);
  video.playbackRate = speed;
  if (params.get('autoplay') === '1') {
    video.play().catch(() => { /* browser blocked autoplay; controls still work */ });
  }
}

// Each playback method is tried at most once; if the browser rejects the raw
// file (wrong container, unsupported codec), fall back to the HLS stream.
const attempted = new Set();

function fallbackToDirect(data) {
  if (attempted.has('direct')) showError('This video can’t be played in your browser.');
  else loadDirectStream(data);
}

function loadDirectStream(data) {
  attempted.add('direct');
  const onReady = () => onPlayerReady(data);
  const onError = () => {
    video.removeEventListener('loadeddata', onReady);
    if (data.ffmpeg && !attempted.has('hls')) {
      loadingOverlay.hidden = false;
      loadingText.textContent = 'Converting this video for your browser…';
      loadHLSStream(data).catch(err => showError(`Playback failed: ${err.message}`));
    } else {
      showError('Your browser can’t play this file format.');
    }
  };
  video.addEventListener('loadeddata', onReady, { once: true });
  video.addEventListener('error', onError, { once: true });
  video.src = `/api/video/${encodeURIComponent(videoId)}/stream`;
  startProgressSaving();
}

async function loadHLSStream(data) {
  attempted.add('hls');
  const base = `/api/video/${encodeURIComponent(videoId)}`;
  const first = await LS.api(`${base}/transcode`);
  if (first.error) { fallbackToDirect(data); return; }

  if (!first.ready) {
    loadingText.textContent = 'Preparing video…';
    for (let i = 0; ; i++) {
      if (i >= 90) throw new Error('Preparing the video took too long');
      await new Promise(r => setTimeout(r, 1000));
      const s = await LS.api(`${base}/transcode`);
      if (s.ready) break;
      if (s.error) throw new Error(s.error);
    }
  }

  const hlsUrl = `${base}/hls/stream.m3u8`;
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = hlsUrl;
    video.addEventListener('loadeddata', () => onPlayerReady(data), { once: true });
  } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    usingMSE = true;
    updateCastHint();
    const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => onPlayerReady(data));
    hls.on(Hls.Events.ERROR, (event, errorData) => {
      if (errorData.fatal) {
        console.error('HLS error:', errorData);
        hls.destroy();
        fallbackToDirect(data);
      }
    });
  } else {
    fallbackToDirect(data);
  }
  startProgressSaving();
}

// --- Previous / next + playlist ------------------------------------------------
const episodeNav = document.getElementById('episodeNav');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

const neighbourLabel = n => (n.folder ? `${prettyName(n.folder)} › ${n.title}` : n.title);

function videoUrl(id) {
  return `/player?id=${encodeURIComponent(id)}&autoplay=1`;
}

function goToVideo(target) {
  saveProgressNow({ keepalive: true });
  window.location.href = videoUrl(target.id);
}

function setupEpisodeNav(data) {
  const { prev, next } = data;
  if (!prev && !next) return;
  episodeNav.hidden = false;
  const wire = (btn, n, kind, key) => {
    btn.disabled = !n;
    btn.querySelector('.episode-title').textContent = n ? n.title : (kind === 'Next' ? 'End of collection' : 'Start of collection');
    btn.title = n ? `${kind}: ${neighbourLabel(n)} (Shift+${key})` : '';
    if (n) btn.addEventListener('click', () => goToVideo(n));
  };
  wire(prevBtn, prev, 'Previous', 'P');
  wire(nextBtn, next, 'Next', 'N');

  // Lock screen / headset / notification next & previous.
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: data.title,
        artist: data.category ? prettyName(data.category) : '',
      });
      navigator.mediaSession.setActionHandler('previoustrack', prev ? () => goToVideo(prev) : null);
      navigator.mediaSession.setActionHandler('nexttrack', next ? () => goToVideo(next) : null);
    } catch { /* not supported */ }
  }
}

const playlistEl = document.getElementById('playlist');
const playlistBody = document.getElementById('playlistBody');

async function loadPlaylist(data) {
  let list;
  try {
    list = await LS.api(`/api/video/${encodeURIComponent(videoId)}/playlist`);
  } catch { return; }
  if (!list.items || list.items.length < 2) return;

  const title = document.getElementById('playlistTitle');
  title.textContent = list.category ? prettyName(list.category) : 'Playlist';
  title.href = list.category ? `/?c=${encodeURIComponent(list.category)}` : '/';

  let folder;
  let n = 0;
  const html = [];
  for (const item of list.items) {
    if (item.folder !== folder) {
      folder = item.folder;
      n = 0;
      if (folder) html.push(`<div class="pl-folder">${esc(prettyName(folder))}</div>`);
    }
    n++;
    const done = item.progress && item.progress.completed;
    const current = item.id === videoId;
    const dur = LS.formatDuration(item.duration);
    html.push(`
      <a class="pl-item${current ? ' current' : ''}${done ? ' done' : ''}" href="${videoUrl(item.id)}" data-id="${esc(item.id)}"${current ? ' aria-current="true"' : ''}>
        <span class="pl-index">${current ? icon('play', 14) : done ? icon('check', 16) : n}</span>
        <span class="pl-thumb">${item.hasThumbnail ? `<img src="/api/video/${encodeURIComponent(item.id)}/thumbnail" alt="" loading="lazy">` : ''}${dur ? `<span class="badge badge-duration">${dur}</span>` : ''}</span>
        <span class="pl-text"><span class="pl-title">${esc(item.title)}</span></span>
      </a>`);
  }
  playlistBody.innerHTML = html.join('');
  playlistEl._items = list.items;
  updatePlaylistMeter();
  playlistEl.hidden = false;

  // Bring the current video into view inside the list (not the page),
  // showing its section heading when it's close by.
  const cur = playlistBody.querySelector('.pl-item.current');
  if (cur) {
    let heading = cur.previousElementSibling;
    while (heading && !heading.classList.contains('pl-folder')) heading = heading.previousElementSibling;
    const near = heading && cur.offsetTop - heading.offsetTop < 220;
    const anchor = near ? heading : cur;
    playlistBody.scrollTop = anchor.offsetTop - playlistBody.offsetTop - (near ? 0 : 80);
  }
}

function updatePlaylistMeter() {
  const items = playlistEl._items || [];
  const done = items.filter(i => i.progress && i.progress.completed).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  document.getElementById('playlistMeter').innerHTML = `
    <div class="meter${done === items.length ? ' done' : ''}">
      <div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div>
      <span>${done}/${items.length} watched</span>
    </div>`;
}

function markPlaylistDone(id) {
  const items = playlistEl._items || [];
  const item = items.find(i => i.id === id);
  if (item) item.progress = { ...(item.progress || {}), completed: true };
  updatePlaylistMeter();
}

// Save position before following a playlist link.
playlistBody.addEventListener('click', (e) => {
  if (e.target.closest('.pl-item')) saveProgressNow({ keepalive: true });
});

// --- Up next (when a video finishes) ---------------------------------------------
// With Auto-next on, the next video starts after a short countdown (which
// you can cancel). With it off, the card just offers the next video.
const AUTO_NEXT_DELAY = 3; // seconds
const upNext = document.getElementById('upNext');
const upNextCount = document.getElementById('upNextCount');
const upNextPlay = document.getElementById('upNextPlay');
const upNextCancel = document.getElementById('upNextCancel');
const autoNextBtn = document.getElementById('autoNextBtn');
let upNextTimer = null;
let autoNext = localStorage.getItem('autoNext') !== '0'; // on by default

function renderAutoNext() {
  autoNextBtn.setAttribute('aria-checked', String(autoNext));
  autoNextBtn.title = autoNext
    ? 'Auto-next is on: the next video plays when this one ends'
    : 'Auto-next is off: playback stops when this video ends';
}

autoNextBtn.addEventListener('click', () => {
  autoNext = !autoNext;
  localStorage.setItem('autoNext', autoNext ? '1' : '0');
  renderAutoNext();
  LS.toast(autoNext ? 'Auto-next on' : 'Auto-next off');
  // Switching while the end card is showing takes effect right away.
  if (!upNext.hidden) showUpNext();
});
renderAutoNext();

function showUpNext() {
  const next = videoData && videoData.next;
  if (!next || (castSdkReady && getCastMedia())) return;
  document.getElementById('upNextTitle').textContent = neighbourLabel(next);
  upNext.hidden = false;
  clearInterval(upNextTimer);

  if (!autoNext) {
    upNextCount.textContent = '';
    upNextPlay.textContent = 'Play next';
    upNextCancel.textContent = 'Dismiss';
    return;
  }

  upNextPlay.textContent = 'Play now';
  upNextCancel.textContent = 'Cancel';
  let left = AUTO_NEXT_DELAY;
  upNextCount.textContent = `in ${left}s`;
  upNextTimer = setInterval(() => {
    left--;
    upNextCount.textContent = `in ${left}s`;
    if (left <= 0) { clearInterval(upNextTimer); goToVideo(next); }
  }, 1000);
}

function hideUpNext() {
  clearInterval(upNextTimer);
  upNext.hidden = true;
}

upNextPlay.addEventListener('click', () => {
  if (videoData && videoData.next) goToVideo(videoData.next);
});
upNextCancel.addEventListener('click', hideUpNext);
video.addEventListener('play', hideUpNext);
video.addEventListener('seeking', () => { if (!video.ended) hideUpNext(); });

// --- Keyboard shortcuts -------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const onMedia = e.target === video;           // native controls handle these
  const inMenu = e.target.closest && e.target.closest('.menu, button, a');

  if (e.shiftKey && (e.key === 'N' || e.key === 'n') && videoData && videoData.next) { e.preventDefault(); goToVideo(videoData.next); return; }
  if (e.shiftKey && (e.key === 'P' || e.key === 'p') && videoData && videoData.prev) { e.preventDefault(); goToVideo(videoData.prev); return; }
  if (e.key === '>') { e.preventDefault(); stepSpeed(1); return; }
  if (e.key === '<') { e.preventDefault(); stepSpeed(-1); return; }
  if (onMedia || inMenu) return;

  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); if (video.paused) video.play().catch(() => {}); else video.pause(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); }
  else if (e.key === 'f') {
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen();
    else (video.requestFullscreen || video.webkitEnterFullscreen || (() => {})).call(video);
  }
  else if (e.key === 'm') { video.muted = !video.muted; }
});

// --- Cast to TV ---------------------------------------------------------------
// Primary: Google Cast SDK, which sideloads WebVTT subtitle tracks onto the
// TV. Fallback: Remote Playback API (no subtitle support) when the Cast SDK
// can't load. Both need a secure context (HTTPS).
function setupCasting() {
  castBtn.addEventListener('click', () => {
    if (castSdkReady) castViaSdk();
    else if (video.remote) video.remote.prompt().catch(() => {});
  });

  // Until the Cast SDK initializes, fall back to Remote Playback availability.
  if ('remote' in HTMLMediaElement.prototype && video.remote) {
    video.remote.watchAvailability((available) => {
      if (!castSdkReady) castBtn.hidden = !available;
    }).catch(() => {});
  }
}

function initCastSdk() {
  try {
    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    castSdkReady = true;

    const reflect = () => {
      const S = cast.framework.CastState;
      const st = context.getCastState();
      castBtn.hidden = (st === S.NO_DEVICES_AVAILABLE);
      castBtn.classList.toggle('connected', st === S.CONNECTED);
      castBtn.classList.toggle('connecting', st === S.CONNECTING);
    };
    context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, reflect);
    reflect();
  } catch {
    castSdkReady = false;
  }
}

async function prefetchCastInfo() {
  try {
    const info = await LS.api('/api/cast-info');
    if (info.enabled) castInfo = info;
  } catch { /* media URLs for the TV unavailable */ }
}

function castTok() { return `?token=${encodeURIComponent(castInfo.token)}`; }

// WebVTT subtitle tracks for the Cast receiver (trackId = subtitle index + 1).
function buildCastTracks() {
  const subs = (videoData && videoData.subtitles) || [];
  return subs.map((s) => {
    const t = new chrome.cast.media.Track(s.index + 1, chrome.cast.media.TrackType.TEXT);
    const off = subOffset ? `&offset=${subOffset}` : '';
    t.trackContentId = `${castInfo.httpBase}/api/video/${videoId}/subtitle/${s.index}.vtt${castTok()}${off}`;
    t.trackContentType = 'text/vtt';
    t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    t.name = s.label;
    t.language = s.lang;
    return t;
  });
}

function buildCastTextStyle() {
  const s = new chrome.cast.media.TextTrackStyle();
  s.fontScale = SIZE_SCALE[subStyle.size] || 1.0;
  s.foregroundColor = (subStyle.color || '#ffffff') + 'FF';
  s.backgroundColor = subStyle.bg ? '#000000C0' : '#00000000';
  s.edgeType = chrome.cast.media.TextTrackEdgeType.OUTLINE;
  s.edgeColor = '#000000FF';
  return s;
}

function activeCastTrackIds() {
  return selectedSubtitle >= 0 ? [selectedSubtitle + 1] : [];
}

let castUsingHls = false; // true when casting the transcoded HLS stream

function buildLoadRequest(startTime) {
  // Files the Chromecast can't play raw (HEVC, Dolby audio, MKV, …) are cast as
  // the transcoded HLS stream; others cast direct.
  const mediaUrl = castUsingHls
    ? `${castInfo.httpBase}/api/video/${videoId}/hls/stream.m3u8${castTok()}`
    : `${castInfo.httpBase}/api/video/${videoId}/stream${castTok()}`;
  const contentType = castUsingHls ? 'application/x-mpegurl' : 'video/mp4';

  const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, contentType);
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = videoData ? videoData.title : 'Video';
  mediaInfo.tracks = buildCastTracks();
  mediaInfo.textTrackStyle = buildCastTextStyle();

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = startTime || 0;
  request.playbackRate = speed;
  if (selectedSubtitle < 0 && mediaInfo.tracks.length) selectedSubtitle = 0;
  request.activeTrackIds = activeCastTrackIds();
  return request;
}

async function ensureTranscodeReady() {
  for (let i = 0; i < 90; i++) {
    const s = await LS.api(`/api/video/${encodeURIComponent(videoId)}/transcode`);
    if (s.ready) return;
    if (s.error) throw new Error(s.error);
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error('Preparing the video took too long');
}

async function castViaSdk() {
  const context = cast.framework.CastContext.getInstance();
  try {
    if (!context.getCurrentSession()) await context.requestSession();
  } catch {
    return; // device picker dismissed
  }
  const session = context.getCurrentSession();
  if (!session) return;

  if (!castInfo) await prefetchCastInfo();
  if (!castInfo) { LS.toast('Casting isn’t available on this server', 'error'); return; }

  castUsingHls = !!(videoData && !videoData.directPlay && videoData.ffmpeg);
  if (castUsingHls) {
    castBtn.classList.add('connecting');
    try {
      await ensureTranscodeReady();
    } catch (e) {
      castBtn.classList.remove('connecting');
      LS.toast(`Couldn’t prepare this video for casting: ${e.message}`, 'error');
      return;
    }
  }

  try {
    // The HLS transcode starts at 0; direct play resumes from the current spot.
    await session.loadMedia(buildLoadRequest(castUsingHls ? 0 : (video.currentTime || 0)));
    video.pause(); // playback now lives on the TV
    refreshCcActive();
  } catch (e) {
    LS.toast(`Couldn’t start casting: ${e && e.description ? e.description : e}`, 'error');
  }
}

function getCastMedia() {
  if (!castSdkReady) return null;
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  return session ? session.getMediaSession() : null;
}

function updateCastTracks() {
  const media = getCastMedia();
  if (!media) return;
  try {
    media.editTracksInfo(
      new chrome.cast.media.EditTracksInfoRequest(activeCastTrackIds(), buildCastTextStyle()),
      () => {}, () => {});
  } catch { /* no active media yet */ }
}

// A new sync offset means new subtitle URLs, so reload at the TV's position.
function reloadCastForOffset() {
  const media = getCastMedia();
  if (!media) return;
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  const at = media.getEstimatedTime ? media.getEstimatedTime() : 0;
  session.loadMedia(buildLoadRequest(at)).catch(() => {});
}

function updateCastHint() {
  castBtn.title = usingMSE ? 'Casting works best with MP4 files' : 'Cast to TV';
}

// --- Subtitles -------------------------------------------------------------------
// One menu controls track, sync offset and appearance — applied to local
// playback (<track> + ::cue CSS) and to the cast receiver.
const subStyle = Object.assign(
  { size: 'medium', color: '#ffffff', bg: true },
  JSON.parse(localStorage.getItem('subStyle') || '{}')
);
const SIZE_SCALE = { small: 0.8, medium: 1.0, large: 1.4 };
const SIZE_CSS = { small: '85%', medium: '110%', large: '150%' };
const COLOR_SWATCHES = ['#ffffff', '#ffff00', '#00e5ff', '#7cfc00'];

function setupSubtitles(data) {
  const subs = (data && data.subtitles) || [];
  selectedSubtitle = -1;
  subOffset = 0;
  applyCueStyle();
  if (!subs.length) { ccWrap.hidden = true; return; }
  ccWrap.hidden = false;
  buildCcPanel(subs);
  registerMenu(ccBtn, ccMenu);
}

function buildCcPanel(subs) {
  const items = [{ label: 'Off', index: -1 }].concat(subs.map(s => ({ label: s.label, index: s.index })));
  ccMenu.innerHTML = `
    <div class="menu-head" data-jp="字幕">Subtitles</div>
    ${items.map(e => `<button class="menu-item" data-track="${e.index}"><span>${esc(e.label)}</span>${icon('check', 16)}</button>`).join('')}
    <div class="menu-sep"></div>
    <div class="menu-head">Sync</div>
    <div class="menu-row">
      <button class="mini" data-offset="-0.5" aria-label="Show subtitles earlier">−</button>
      <span class="offset-val" id="ccOffsetVal"></span>
      <button class="mini" data-offset="0.5" aria-label="Show subtitles later">+</button>
      <button class="mini" data-offset="reset" aria-label="Reset sync">⟲</button>
    </div>
    <div class="menu-head">Size</div>
    <div class="menu-row">
      ${[['small', 'S'], ['medium', 'M'], ['large', 'L']].map(([sz, l]) => `<button class="seg" data-size="${sz}">${l}</button>`).join('')}
    </div>
    <div class="menu-head">Color</div>
    <div class="menu-row">
      ${COLOR_SWATCHES.map(c => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}
    </div>
    <button class="menu-item" id="ccBgBtn"><span>Background</span>${icon('check', 16)}</button>`;

  ccMenu.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.track !== undefined) selectSubtitle(Number(t.dataset.track));
    else if (t.dataset.offset === 'reset') setOffset(0);
    else if (t.dataset.offset) setOffset(subOffset + Number(t.dataset.offset));
    else if (t.dataset.size) setSubStyle({ size: t.dataset.size });
    else if (t.dataset.color) setSubStyle({ color: t.dataset.color });
    else if (t.id === 'ccBgBtn') setSubStyle({ bg: !subStyle.bg });
  });
  refreshCcActive();
}

function refreshCcActive() {
  ccMenu.querySelectorAll('.menu-item[data-track]').forEach(i =>
    i.classList.toggle('active', Number(i.dataset.track) === selectedSubtitle));
  ccMenu.querySelectorAll('.seg[data-size]').forEach(b =>
    b.classList.toggle('active', b.dataset.size === subStyle.size));
  ccMenu.querySelectorAll('.swatch[data-color]').forEach(b =>
    b.classList.toggle('active', b.dataset.color.toLowerCase() === subStyle.color.toLowerCase()));
  const bgBtn = document.getElementById('ccBgBtn');
  if (bgBtn) bgBtn.classList.toggle('active', subStyle.bg);
  const offEl = document.getElementById('ccOffsetVal');
  if (offEl) offEl.textContent = `${subOffset > 0 ? '+' : ''}${subOffset.toFixed(1)}s`;
  ccBtn.classList.toggle('on', selectedSubtitle >= 0);
}

function selectSubtitle(index) {
  selectedSubtitle = index;
  applyLocalSubtitle();
  refreshCcActive();
  updateCastTracks();
}

function setOffset(value) {
  subOffset = Math.round(Math.max(-30, Math.min(30, value)) * 2) / 2;
  if (selectedSubtitle >= 0) applyLocalSubtitle();
  refreshCcActive();
  reloadCastForOffset();
}

function setSubStyle(patch) {
  Object.assign(subStyle, patch);
  localStorage.setItem('subStyle', JSON.stringify(subStyle));
  applyCueStyle();
  refreshCcActive();
  updateCastTracks();
}

// Rebuild the single active <track>, baking in the sync offset.
function applyLocalSubtitle() {
  [...video.querySelectorAll('track')].forEach(t => t.remove());
  if (selectedSubtitle < 0) return;
  const sub = (videoData.subtitles || []).find(s => s.index === selectedSubtitle);
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = sub ? sub.label : 'Subtitles';
  if (sub && sub.lang && sub.lang !== 'und') track.srclang = sub.lang;
  const qs = subOffset ? `?offset=${subOffset}` : '';
  track.src = `/api/video/${encodeURIComponent(videoId)}/subtitle/${selectedSubtitle}.vtt${qs}`;
  video.appendChild(track);
  const tt = video.textTracks[video.textTracks.length - 1];
  if (tt) tt.mode = 'showing';
}

function applyCueStyle() {
  let el = document.getElementById('cueStyle');
  if (!el) { el = document.createElement('style'); el.id = 'cueStyle'; document.head.appendChild(el); }
  const bg = subStyle.bg ? 'rgba(0,0,0,0.75)' : 'transparent';
  el.textContent = `video::cue{font-size:${SIZE_CSS[subStyle.size] || '110%'};` +
    `color:${subStyle.color};background-color:${bg};text-shadow:0 0 3px #000;}`;
}

initPlayer();
