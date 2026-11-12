// Library page: home (continue watching + collections), a collection's
// videos grouped by folder, and search. The view lives in the URL
// (?c=<collection>, ?q=<search>) so Back/Refresh and links work.
'use strict';

const { escapeHtml: esc, icon, prettyName, naturalCompare, watchState } = LS;

const view = document.getElementById('view');
const searchInput = document.getElementById('search');

const state = {
  videos: [],
  scanning: false,
  loaded: false,
  error: null,
};

// --- Persisted UI preferences -------------------------------------------
const prefs = {
  // Folder sections start collapsed; only the ones you opened are remembered.
  get expanded() { return new Set(JSON.parse(localStorage.getItem('expandedSections') || '[]')); },
  setExpanded(set) { localStorage.setItem('expandedSections', JSON.stringify([...set])); },
  get sort() { return localStorage.getItem('collectionSort') || 'order'; },
  set sort(v) { localStorage.setItem('collectionSort', v); },
};

// --- Routing ---------------------------------------------------------------
function currentRoute() {
  const p = new URLSearchParams(location.search);
  return { c: p.get('c') || '', q: p.get('q') || '' };
}

function routeUrl({ c = '', q = '' }) {
  const p = new URLSearchParams();
  if (c) p.set('c', c);
  if (q) p.set('q', q);
  const s = p.toString();
  return s ? `/?${s}` : '/';
}

function navigate(route, { replace = false } = {}) {
  const url = routeUrl(route);
  if (url !== location.pathname + location.search) {
    history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }
  render();
  if (!replace) window.scrollTo(0, 0);
}

window.addEventListener('popstate', render);

// In-app links (data-nav) switch views without a page load.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.pathname !== '/') return;
  e.preventDefault();
  navigate({ c: url.searchParams.get('c') || '', q: url.searchParams.get('q') || '' });
});

// --- Data ------------------------------------------------------------------
let pollTimer = null;

async function loadLibrary({ quiet = false } = {}) {
  try {
    const data = await LS.api('/api/library');
    state.videos = data.videos;
    state.scanning = data.scanning;
    state.loaded = true;
    state.error = null;
  } catch (err) {
    state.error = err.message;
    if (!quiet) state.loaded = true;
  }
  render();

  // While the server is scanning, refresh every few seconds.
  clearTimeout(pollTimer);
  if (state.scanning) pollTimer = setTimeout(() => loadLibrary({ quiet: true }), 3000);
}

function playbackSort(a, b) {
  if (!a.folder !== !b.folder) return a.folder ? 1 : -1; // root files first
  return naturalCompare(a.folder, b.folder) || naturalCompare(a.title, b.title) ||
    naturalCompare(a.fileName, b.fileName);
}

function collections() {
  const map = new Map();
  for (const v of state.videos) {
    const key = v.category || 'Other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return [...map.entries()]
    .map(([name, videos]) => summarize(name, videos.sort(playbackSort)))
    .sort((a, b) => naturalCompare(prettyName(a.name), prettyName(b.name)));
}

function summarize(name, videos) {
  let duration = 0;
  let size = 0;
  let completed = 0;
  for (const v of videos) {
    duration += v.duration || 0;
    size += v.size || 0;
    if (watchState(v).completed) completed++;
  }
  return {
    name,
    videos,
    duration,
    size,
    completed,
    cover: videos.find(v => v.hasThumbnail) || null,
    folders: new Set(videos.map(v => v.folder).filter(Boolean)).size,
  };
}

// Where "Continue" should take you in a collection: the most recently watched
// unfinished video, else the first unwatched one, else the first.
function resumeTarget(videos) {
  const started = videos
    .filter(v => watchState(v).inProgress)
    .sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)[0];
  if (started) return { video: started, label: 'Continue' };
  const next = videos.find(v => !watchState(v).completed);
  if (next) {
    const anyDone = videos.some(v => watchState(v).completed);
    return { video: next, label: anyDone ? 'Continue' : 'Start watching' };
  }
  return videos[0] ? { video: videos[0], label: 'Watch again' } : null;
}

// --- Rendering helpers -------------------------------------------------------
function thumbImg(v, cls = '') {
  return v && v.hasThumbnail
    ? `<img class="${cls}" src="/api/video/${encodeURIComponent(v.id)}/thumbnail" alt="" loading="lazy" decoding="async">`
    : `<div class="thumb-fallback">${icon('film', 30)}</div>`;
}

function cardHtml(v, { showCollection = false } = {}) {
  const w = watchState(v);
  const dur = LS.formatDuration(v.duration);
  const meta = [];
  if (showCollection) meta.push(esc(prettyName(v.category)));
  if (w.inProgress && v.duration) meta.push(`${LS.formatLength(v.duration - v.progress.time)} left`);
  else if (w.completed) meta.push('Watched');
  else {
    const res = LS.resolutionLabel(v.height);
    if (res) meta.push(res);
    if (v.size) meta.push(LS.formatSize(v.size));
  }

  return `
    <a class="card${w.completed ? ' is-watched' : ''}" href="/player?id=${encodeURIComponent(v.id)}">
      <div class="thumb">
        ${thumbImg(v)}
        <span class="play-hint">${icon('play', 20)}</span>
        ${w.completed ? `<span class="badge badge-watched">${icon('check', 12)}Watched</span>` : ''}
        ${dur ? `<span class="badge badge-duration">${dur}</span>` : ''}
        ${w.inProgress && w.fraction > 0 ? `<div class="progress"><span style="width:${(w.fraction * 100).toFixed(1)}%"></span></div>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="card-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>
      </div>
    </a>`;
}

function meterHtml(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `
    <div class="meter${done && done === total ? ' done' : ''}" title="${done} of ${total} watched">
      <div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div>
      <span>${done}/${total} watched</span>
    </div>`;
}

function statusLine() {
  if (state.scanning) return '<div class="status-line"><span class="dot"></span>Scanning your folders — new videos will appear automatically</div>';
  return '';
}

function skeleton() {
  const cards = Array.from({ length: 8 }, () => `
    <div class="card skeleton-card" aria-hidden="true">
      <div class="thumb skeleton"></div>
      <div class="skeleton skeleton-line" style="width:80%"></div>
      <div class="skeleton skeleton-line" style="width:45%"></div>
    </div>`).join('');
  return `<div class="block"><div class="skeleton skeleton-line" style="width:180px;height:20px;margin-bottom:16px"></div><div class="grid">${cards}</div></div>`;
}

function emptyHtml({ title, text, action }) {
  return `
    <div class="empty">
      ${icon('film', 48)}
      <h2>${title}</h2>
      <p>${text}</p>
      ${action || ''}
    </div>`;
}

// --- Views ------------------------------------------------------------------
function render() {
  const route = currentRoute();
  if (document.activeElement !== searchInput) searchInput.value = route.q;

  if (!state.loaded) { view.innerHTML = skeleton(); return; }
  if (state.error && !state.videos.length) {
    view.innerHTML = emptyHtml({
      title: 'Couldn’t load your library',
      text: esc(state.error),
      action: '<button class="btn" data-action="retry">Try again</button>',
    });
    return;
  }

  if (route.q) renderSearch(route.q);
  else if (route.c) renderCollection(route.c);
  else renderHome();
}

function renderHome() {
  document.title = 'Local Stream';
  if (!state.videos.length) {
    // LS.me is filled in by account.js; only admins can add folders.
    const canManage = Boolean(LS.me && LS.me.isAdmin);
    view.innerHTML = statusLine() + emptyHtml({
      title: state.scanning ? 'Scanning your folders…' : 'Your library is empty',
      text: state.scanning ? 'Videos will show up here as they are found.'
        : canManage ? 'Add a folder with videos and they will show up here.'
          : 'Ask an admin to add a folder with videos.',
      action: state.scanning || !canManage ? '' : `<button class="btn btn-primary" data-action="sources">${icon('folderPlus', 18)}Add a folder</button>`,
    });
    return;
  }

  const continuing = state.videos
    .filter(v => watchState(v).inProgress)
    .sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)
    .slice(0, 16);

  const cols = collections();
  const total = state.videos.length;

  view.innerHTML = `
    ${statusLine()}
    ${featuredHtml(continuing[0], cols)}
    ${continuing.length > 1 ? `
      <section class="block">
        <div class="block-head"><h2 class="block-title" data-jp="続きを見る">Continue watching</h2></div>
        <div class="shelf">${continuing.slice(1).map(v => cardHtml(v, { showCollection: true })).join('')}</div>
      </section>` : ''}
    <section class="block">
      <div class="block-head">
        <h2 class="block-title" data-jp="コレクション">Collections</h2>
        <span class="block-meta">${cols.length} collections · ${total} videos</span>
      </div>
      <div class="collections">${cols.map(collectionCardHtml).join('')}</div>
    </section>`;
}

// Greeting banner featuring the most recently watched video (or where to
// start in the first collection).
function featuredHtml(lastWatched, cols) {
  let video = lastWatched;
  let label = 'Continue';
  if (!video && cols.length) {
    const t = resumeTarget(cols[0].videos);
    if (t) { video = t.video; label = t.label; }
  }
  if (!video) return '';

  const h = new Date().getHours();
  const [en, jp] = h < 11 ? ['Good morning', 'おはよう'] : h < 18 ? ['Good afternoon', 'こんにちは'] : ['Good evening', 'こんばんは'];
  const w = watchState(video);
  const where = [prettyName(video.category), video.folder ? prettyName(video.folder) : ''].filter(Boolean).join(' › ');
  const left = w.inProgress && video.duration ? `${LS.formatLength(video.duration - video.progress.time)} left` : LS.formatDuration(video.duration);

  return `
    <section class="feature">
      <div class="feature-bg">${thumbImg(video)}</div>
      <div class="feature-text">
        <div class="feature-greet" data-jp="${jp}">${en}</div>
        <h1 class="feature-title">${esc(video.title)}</h1>
        <div class="feature-meta">${esc(where)}${left ? ` · ${left}` : ''}</div>
        ${w.inProgress && w.fraction ? `<div class="feature-progress"><span style="width:${(w.fraction * 100).toFixed(1)}%"></span></div>` : ''}
        <a class="btn btn-primary feature-btn" href="/player?id=${encodeURIComponent(video.id)}">${icon('play', 16)}${label}</a>
      </div>
      <a class="feature-art" href="/player?id=${encodeURIComponent(video.id)}" aria-label="Play ${esc(video.title)}">
        ${thumbImg(video)}<span class="play-hint">${icon('play', 22)}</span>
      </a>
    </section>`;
}

function collectionCardHtml(col) {
  const stats = [`${col.videos.length} video${col.videos.length === 1 ? '' : 's'}`];
  if (col.folders > 1) stats.push(`${col.folders} sections`);
  if (col.duration) stats.push(LS.formatLength(col.duration));
  return `
    <a class="collection" href="${routeUrl({ c: col.name })}" data-nav>
      <div class="collection-cover">${thumbImg(col.cover)}</div>
      <div class="collection-body">
        <div class="collection-name">${esc(prettyName(col.name))}</div>
        <div class="collection-stats">${stats.map(s => `<span>${s}</span>`).join('')}</div>
        ${meterHtml(col.completed, col.videos.length)}
      </div>
    </a>`;
}

const SORTS = {
  order: { label: 'Course order' },
  date: { label: 'Recently added', fn: (a, b) => b.addedAt - a.addedAt },
  name: { label: 'Name', fn: (a, b) => naturalCompare(a.title, b.title) },
  duration: { label: 'Longest', fn: (a, b) => (b.duration || 0) - (a.duration || 0) },
};

function renderCollection(name) {
  const videos = state.videos.filter(v => (v.category || 'Other') === name).sort(playbackSort);
  if (!videos.length) {
    view.innerHTML = `<a class="crumb" href="/" data-nav>${icon('back', 18)}Library</a>` + emptyHtml({
      title: 'Collection not found',
      text: state.scanning ? 'Still scanning — it may appear shortly.' : 'It may have been renamed or removed.',
      action: '<a class="btn" href="/" data-nav>Back to library</a>',
    });
    return;
  }

  const col = summarize(name, videos);
  const title = prettyName(name);
  document.title = `${title} · Local Stream`;
  const target = resumeTarget(videos);
  const sortKey = SORTS[prefs.sort] ? prefs.sort : 'order';

  const stats = [`${videos.length} video${videos.length === 1 ? '' : 's'}`];
  if (col.folders > 1) stats.push(`${col.folders} sections`);
  if (col.duration) stats.push(LS.formatLength(col.duration));
  if (col.size) stats.push(LS.formatSize(col.size));

  view.innerHTML = `
    <a class="crumb" href="/" data-nav>${icon('back', 18)}Library</a>
    ${statusLine()}
    <section class="hero">
      <div class="hero-bg">${col.cover ? thumbImg(col.cover) : ''}</div>
      <div>
        <h1 class="hero-title">${esc(title)}</h1>
        <div class="collection-stats hero-stats">${stats.map(s => `<span>${s}</span>`).join('')}</div>
        ${meterHtml(col.completed, videos.length)}
      </div>
      ${target ? `
        <div class="hero-actions">
          <a class="btn btn-primary" href="/player?id=${encodeURIComponent(target.video.id)}">${icon('play', 16)}${target.label}</a>
          <div class="hero-next" title="${esc(target.video.title)}">${esc(target.video.folder ? `${prettyName(target.video.folder)} › ` : '')}${esc(target.video.title)}</div>
        </div>` : ''}
    </section>
    <div class="toolbar">
      <h2 class="block-title" data-jp="エピソード">Videos</h2>
      <label>Sort
        <select class="select" id="sortSelect">
          ${Object.entries(SORTS).map(([k, s]) => `<option value="${k}"${k === sortKey ? ' selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="collectionBody"></div>`;

  const body = document.getElementById('collectionBody');
  if (sortKey !== 'order') {
    body.innerHTML = `<div class="grid">${[...videos].sort(SORTS[sortKey].fn).map(v => cardHtml(v)).join('')}</div>`;
    return;
  }

  // Course order: one collapsible section per folder.
  const groups = new Map();
  for (const v of videos) {
    const k = v.folder || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  if (groups.size === 1) {
    body.innerHTML = `<div class="grid">${videos.map(v => cardHtml(v)).join('')}</div>`;
    return;
  }

  const expanded = prefs.expanded;
  body.innerHTML = [...groups.entries()].map(([folder, items]) => {
    const key = `${name}::${folder}`;
    const done = items.filter(v => watchState(v).completed).length;
    const len = items.reduce((s, v) => s + (v.duration || 0), 0);
    const isCollapsed = !expanded.has(key);
    const cover = items.find(v => v.hasThumbnail);
    return `
      <section class="section${isCollapsed ? ' collapsed' : ''}" data-key="${esc(key)}">
        <button class="section-head" aria-expanded="${!isCollapsed}">
          ${cover ? `<span class="section-bg" aria-hidden="true">${thumbImg(cover)}</span>` : ''}
          ${icon('chevron', 18, 'chev')}
          <span class="section-name">${esc(folder ? prettyName(folder) : 'Videos')}</span>
          <span class="section-count${done === items.length ? ' done' : ''}">${done ? `${done}/` : ''}${items.length} video${items.length === 1 ? '' : 's'}${len ? ` · ${LS.formatLength(len)}` : ''}</span>
        </button>
        <div class="section-body"><div class="grid">${items.map(v => cardHtml(v)).join('')}</div></div>
      </section>`;
  }).join('');
}

function renderSearch(q) {
  document.title = `Search · Local Stream`;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = v => `${v.title} ${v.fileName} ${v.folder || ''} ${v.category || ''}`.toLowerCase();
  const phrase = q.toLowerCase().trim();
  const exact = v => (`${v.title} ${v.fileName}`.toLowerCase().includes(phrase) ? 0 : 1);
  // Every word must match; whole-phrase title matches come first.
  const results = state.videos
    .filter(v => terms.every(t => hay(v).includes(t)))
    .sort((a, b) => exact(a) - exact(b) || naturalCompare(a.category, b.category) || playbackSort(a, b));

  view.innerHTML = `
    ${statusLine()}
    <div class="page-head">
      <div>
        <h1 class="page-title" data-jp="検索結果">Results for “${esc(q)}”</h1>
        <div class="page-sub">${results.length} video${results.length === 1 ? '' : 's'}</div>
      </div>
    </div>
    ${results.length
      ? `<div class="grid">${results.map(v => cardHtml(v, { showCollection: true })).join('')}</div>`
      : emptyHtml({ title: 'No matches', text: 'Try a different word, or check the spelling.' })}`;
}

// --- View interactions (delegated) ------------------------------------------
view.addEventListener('click', (e) => {
  const head = e.target.closest('.section-head');
  if (head) {
    const section = head.parentElement;
    const nowCollapsed = section.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!nowCollapsed));
    const set = prefs.expanded;
    if (nowCollapsed) set.delete(section.dataset.key); else set.add(section.dataset.key);
    prefs.setExpanded(set);
    return;
  }
  const action = e.target.closest('[data-action]');
  if (action && action.dataset.action === 'sources') openSources();
  if (action && action.dataset.action === 'retry') { state.loaded = false; render(); loadLibrary(); }
});

view.addEventListener('change', (e) => {
  if (e.target.id === 'sortSelect') { prefs.sort = e.target.value; render(); }
});

// Broken thumbnail → fallback icon.
view.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.outerHTML = `<div class="thumb-fallback">${icon('film', 30)}</div>`;
}, true);

// --- Search -------------------------------------------------------------------
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = searchInput.value.trim();
    const { c, q: prevQ } = currentRoute();
    // Typing refines the same history entry; starting a search pushes one.
    navigate({ c: q ? '' : c, q }, { replace: Boolean(prevQ) });
  }, 200);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; navigate({ q: '' }, { replace: true }); searchInput.blur(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); searchInput.focus(); }
});

// --- Top bar actions ------------------------------------------------------------
const scanBtn = document.getElementById('scanBtn');
const sourcesBtn = document.getElementById('sourcesBtn');
const logoutBtn = document.getElementById('logoutBtn');
scanBtn.innerHTML = icon('refresh');
sourcesBtn.innerHTML = icon('folderPlus');
logoutBtn.innerHTML = icon('logout');
LS.bindModeToggle(document.getElementById('modeBtn'));
LS.initDecor({ petals: true });

scanBtn.addEventListener('click', async () => {
  scanBtn.classList.add('spinning');
  try {
    await LS.api('/api/library/scan', { method: 'POST' });
    LS.toast('Rescanning your folders…');
    // Poll until the scan finishes.
    for (let i = 0; i < 600; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const data = await LS.api('/api/library');
      if (!data.scanning) break;
    }
    await loadLibrary();
    LS.toast(`Library up to date · ${state.videos.length} videos`);
  } catch (err) {
    LS.toast(err.message, 'error');
  } finally {
    scanBtn.classList.remove('spinning');
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  window.location.href = '/login';
});

// --- Media folders dialog ------------------------------------------------------
const sourcesModal = document.getElementById('sourcesModal');
const sourcesClose = document.getElementById('sourcesClose');
const sourcesList = document.getElementById('sourcesList');
const folderPathInput = document.getElementById('folderPathInput');
const browserPath = document.getElementById('browserPath');
const browserList = document.getElementById('browserList');
const categoryInput = document.getElementById('categoryInput');
const addSourceBtn = document.getElementById('addSourceBtn');
const addError = document.getElementById('addError');
sourcesClose.innerHTML = icon('close');

let currentBrowsePath = '';
let browseRevision = 0;
let addingSource = false;
let lastFocus = null;
let sourcesChanged = false;

function openSources() {
  lastFocus = document.activeElement;
  sourcesChanged = false;
  sourcesModal.hidden = false;
  addError.hidden = true;
  folderPathInput.value = '';
  currentBrowsePath = '';
  syncAddSourceButton();
  loadSources();
  browseTo('');
  sourcesClose.focus();
}

function closeSources() {
  sourcesModal.hidden = true;
  if (lastFocus) lastFocus.focus();
  if (sourcesChanged) loadLibrary({ quiet: true });
}

async function loadSources() {
  try {
    const data = await LS.api('/api/sources');
    renderSources(data.sources);
  } catch (err) {
    sourcesList.innerHTML = `<div class="muted-note">${esc(err.message)}</div>`;
  }
}

function renderSources(sources) {
  if (!sources.length) {
    sourcesList.innerHTML = '<div class="muted-note">No folders yet — pick one below.</div>';
    return;
  }
  sourcesList.innerHTML = sources.map((s, i) => `
    <div class="source" data-index="${i}">
      ${icon('folder', 20, 'source-icon')}
      <div class="source-text">
        <div class="source-name">${esc(prettyName(s.category))}</div>
        <div class="source-path" title="${esc(s.path)}"><bdi>${esc(s.path)}</bdi></div>
      </div>
      <button class="icon-btn" data-act="rename" title="Rename" aria-label="Rename ${esc(s.category)}">${icon('edit', 18)}</button>
      <button class="icon-btn danger" data-act="remove" title="Remove from library" aria-label="Remove ${esc(s.category)}">${icon('trash', 18)}</button>
    </div>`).join('');
  sourcesList._sources = sources;
}

sourcesList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.source');
  const source = sourcesList._sources[Number(row.dataset.index)];

  if (btn.dataset.act === 'remove') {
    if (!confirm(`Remove “${prettyName(source.category)}” from the library?\n\nThe files on disk are not touched.`)) return;
    try {
      const data = await LS.api('/api/sources', { method: 'DELETE', body: { path: source.path } });
      renderSources(data.sources);
      sourcesChanged = true;
      LS.toast('Folder removed');
    } catch (err) { LS.toast(err.message, 'error'); }
  }

  if (btn.dataset.act === 'rename') {
    const text = row.querySelector('.source-text');
    text.innerHTML = `<input class="input source-name-input" value="${esc(source.category)}" aria-label="Collection name">`;
    const input = text.querySelector('input');
    input.focus();
    input.select();
    const finish = async (save) => {
      input.onblur = null;
      const name = input.value.trim();
      if (save && name && name !== source.category) {
        try {
          const data = await LS.api('/api/sources', { method: 'PATCH', body: { path: source.path, category: name } });
          renderSources(data.sources);
          sourcesChanged = true;
          // The current URL may point at the old name.
          if (currentRoute().c === source.category) history.replaceState(null, '', routeUrl({ c: name }));
          return;
        } catch (err) { LS.toast(err.message, 'error'); }
      }
      renderSources(sourcesList._sources);
    };
    input.onblur = () => finish(true);
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    };
  }
});

async function browseTo(p) {
  const revision = ++browseRevision;
  addError.hidden = true;
  try {
    const data = await LS.api(`/api/browse?path=${encodeURIComponent(p)}`);
    if (revision !== browseRevision) return;
    currentBrowsePath = data.path;
    folderPathInput.value = currentBrowsePath;
    syncAddSourceButton();
    browserPath.textContent = currentBrowsePath || 'This PC';

    const items = [];
    if (data.parent !== null) {
      items.push(`<button class="browse-item" data-path="${esc(data.parent)}">${icon('up', 18)}<span>Up one level</span></button>`);
    }
    for (const d of data.dirs) {
      items.push(`<button class="browse-item" data-path="${esc(d.path)}">${icon(currentBrowsePath ? 'folder' : 'drive', 18)}<span>${esc(d.name)}</span></button>`);
    }
    if (!data.dirs.length && currentBrowsePath) items.push('<div class="muted-note">No subfolders here.</div>');
    browserList.innerHTML = items.join('');
    browserList.scrollTop = 0;
  } catch (err) {
    if (revision === browseRevision) showAddError(err.message);
  }
}

browserList.addEventListener('click', (e) => {
  const item = e.target.closest('.browse-item');
  if (item) browseTo(item.dataset.path);
});

function showAddError(msg) {
  addError.textContent = msg;
  addError.hidden = false;
}

// Explorer's Copy as path wraps paths in double quotes.
function enteredFolderPath() {
  return folderPathInput.value.trim().replace(/^"(.*)"$/, '$1').trim();
}

function syncAddSourceButton() {
  addSourceBtn.disabled = addingSource || !enteredFolderPath();
}

folderPathInput.addEventListener('input', () => {
  ++browseRevision; // A pending browse response must not replace a pasted path.
  addError.hidden = true;
  syncAddSourceButton();
});
folderPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSourceBtn.click(); }
});

addSourceBtn.addEventListener('click', async () => {
  const path = enteredFolderPath();
  if (!path || addingSource) return;
  addingSource = true;
  addError.hidden = true;
  syncAddSourceButton();
  try {
    const data = await LS.api('/api/sources', {
      method: 'POST',
      body: { path, category: categoryInput.value },
    });
    // Clear the submitted path, but preserve a new path typed during the request.
    if (enteredFolderPath() === path) {
      folderPathInput.value = '';
      ++browseRevision;
    }
    categoryInput.value = '';
    renderSources(data.sources);
    sourcesChanged = true;
    LS.toast('Folder added — scanning for videos');
  } catch (err) {
    showAddError(err.message);
  } finally {
    addingSource = false;
    syncAddSourceButton();
  }
});

sourcesBtn.addEventListener('click', openSources);
sourcesClose.addEventListener('click', closeSources);
sourcesModal.addEventListener('click', (e) => { if (e.target === sourcesModal) closeSources(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sourcesModal.hidden) closeSources();
});

// Who's signed in decides which actions show; re-render once it's known.
document.addEventListener('ls:me', render);

// --- Start ---------------------------------------------------------------------
render();
loadLibrary();
