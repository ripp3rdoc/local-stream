// Account dialog: see who you're signed in as and change your password.
// Admins also manage accounts here (add, change role, reset password, delete),
// and get the media-folder and rescan buttons in the top bar.
'use strict';

(function () {
  const esc = LS.escapeHtml;
  const icon = LS.icon;
  const ROLE_LABEL = { admin: 'Admin', user: 'Viewer' };

  const $ = id => document.getElementById(id);
  const accountBtn = $('accountBtn');
  const logoutBtn = $('logoutBtn');
  const modal = $('accountModal');
  const closeBtn = $('accountClose');
  const meSection = $('meSection');
  const passwordSection = $('passwordSection');
  const passwordForm = $('passwordForm');
  const pwError = $('pwError');
  const usersSection = $('usersSection');
  const usersList = $('usersList');
  const addUserLabel = $('addUserLabel');
  const addUserForm = $('addUserForm');
  const addUserError = $('addUserError');
  const newRole = $('newRole');

  accountBtn.innerHTML = icon('user');
  closeBtn.innerHTML = icon('close');

  let me = null;      // { authEnabled, user, isAdmin }
  let accounts = [];
  let lastFocus = null;

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = !msg;
  }

  // --- Who am I --------------------------------------------------------------
  async function loadMe() {
    try {
      me = await LS.api('/api/me');
    } catch {
      // 401 already redirects to sign-in. Anything else (e.g. a server still
      // running the pre-accounts code): keep the old buttons usable.
      $('sourcesBtn').hidden = false;
      $('scanBtn').hidden = false;
      logoutBtn.hidden = false;
      return;
    }
    LS.me = me;
    $('sourcesBtn').hidden = !me.isAdmin;
    $('scanBtn').hidden = !me.isAdmin;
    logoutBtn.hidden = !me.authEnabled;
    const who = me.user ? `${me.user.username} (${ROLE_LABEL[me.user.role]})` : 'Account';
    accountBtn.title = me.user ? `Signed in as ${who}` : 'Accounts';
    accountBtn.setAttribute('aria-label', accountBtn.title);
    document.dispatchEvent(new CustomEvent('ls:me', { detail: me }));
  }

  function renderMe() {
    if (!me.authEnabled) {
      meSection.innerHTML = `
        <div class="field-label">Sign-in</div>
        <div class="muted-note">Sign-in is off, so anyone on your network can use Local Stream.
          Create an admin account below to turn it on — you’ll be signed in as it.</div>`;
    } else {
      const u = me.user;
      meSection.innerHTML = `
        <div class="field-label">Signed in as</div>
        <div class="source">
          ${icon('user', 20, 'source-icon')}
          <div class="source-text">
            <div class="source-name">${esc(u.username)}</div>
            <div class="account-sub">${ROLE_LABEL[u.role]}${u.role === 'admin' ? ' — can manage folders and accounts' : ' — can watch'}</div>
          </div>
        </div>`;
      $('pwUsername').value = u.username;
    }
    passwordSection.hidden = !me.user;
    usersSection.hidden = !me.isAdmin;
    // The first account must be an admin (it turns sign-in on).
    newRole.disabled = !me.authEnabled;
    if (!me.authEnabled) newRole.value = 'admin';
    addUserLabel.textContent = me.authEnabled ? 'Add an account' : 'Create the admin account';
  }

  // --- Accounts list (admins) ---------------------------------------------------
  async function loadAccounts() {
    if (!me.isAdmin) return;
    try {
      accounts = (await LS.api('/api/users')).users;
      renderAccounts();
    } catch (err) {
      usersList.innerHTML = `<div class="muted-note">${esc(err.message)}</div>`;
    }
  }

  function renderAccounts() {
    if (!accounts.length) {
      usersList.innerHTML = '<div class="muted-note">No accounts yet.</div>';
      return;
    }
    const myId = me.user && me.user.id;
    usersList.innerHTML = accounts.map(u => {
      const self = u.id === myId;
      return `
        <div class="source account-row" data-id="${esc(u.id)}">
          ${icon('user', 20, 'source-icon')}
          <div class="source-text">
            <div class="source-name">${esc(u.username)}${self ? ' <span class="you-tag">you</span>' : ''}</div>
            <div class="account-sub">Added ${new Date(u.createdAt).toLocaleDateString()}</div>
          </div>
          <select class="select role-select" data-act="role" aria-label="Role for ${esc(u.username)}">
            <option value="user"${u.role === 'user' ? ' selected' : ''}>Viewer</option>
            <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option>
          </select>
          <button class="icon-btn" data-act="reset" title="Set a new password" aria-label="Set a new password for ${esc(u.username)}">${icon('key', 18)}</button>
          ${self ? '' : `<button class="icon-btn danger" data-act="delete" title="Delete account" aria-label="Delete ${esc(u.username)}">${icon('trash', 18)}</button>`}
        </div>`;
    }).join('');
  }

  const accountFor = row => accounts.find(u => u.id === row.dataset.id);

  usersList.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-act="role"]');
    if (!sel) return;
    const row = sel.closest('.account-row');
    const u = accountFor(row);
    const self = me.user && u.id === me.user.id;
    if (self && sel.value !== 'admin' &&
        !confirm('Make yourself a Viewer? You will no longer be able to manage folders or accounts.')) {
      sel.value = u.role;
      return;
    }
    try {
      const data = await LS.api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { role: sel.value } });
      accounts = data.users;
      LS.toast(`${u.username} is now ${ROLE_LABEL[sel.value] === 'Admin' ? 'an Admin' : 'a Viewer'}`);
      if (self) { await loadMe(); renderMe(); }
      renderAccounts();
    } catch (err) {
      sel.value = u.role;
      LS.toast(err.message, 'error');
    }
  });

  usersList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.account-row');
    const u = accountFor(row);

    if (btn.dataset.act === 'delete') {
      if (!confirm(`Delete the account “${u.username}”?\n\nTheir watch progress is deleted too. This can’t be undone.`)) return;
      try {
        accounts = (await LS.api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' })).users;
        renderAccounts();
        LS.toast(`Deleted ${u.username}`);
      } catch (err) { LS.toast(err.message, 'error'); }
    }

    if (btn.dataset.act === 'reset') {
      // Swap the name for an inline password box; Enter saves, Esc cancels.
      const text = row.querySelector('.source-text');
      text.innerHTML = `<input class="input source-name-input" type="password" minlength="4" autocomplete="new-password"
        placeholder="New password for ${esc(u.username)}" aria-label="New password for ${esc(u.username)}">`;
      const input = text.querySelector('input');
      input.focus();
      const finish = async (save) => {
        input.onblur = null;
        if (save && input.value) {
          try {
            accounts = (await LS.api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { password: input.value } })).users;
            const self = me.user && u.id === me.user.id;
            LS.toast(self ? 'Password changed — your other devices were signed out'
              : `New password set — ${u.username} was signed out everywhere`);
          } catch (err) {
            LS.toast(err.message, 'error');
          }
        }
        renderAccounts();
      };
      input.onblur = () => finish(false);
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      };
    }
  });

  addUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(addUserError, '');
    const first = !me.authEnabled;
    const btn = $('addUserBtn');
    btn.disabled = true;
    try {
      const data = await LS.api('/api/users', {
        method: 'POST',
        body: { username: $('newUsername').value.trim(), password: $('newPassword').value, role: newRole.value },
      });
      addUserForm.reset();
      LS.toast(first ? `Sign-in is on — you’re signed in as ${data.user.username}` : `Added ${data.user.username}`);
      if (first) { await loadMe(); renderMe(); }
      accounts = data.users;
      renderAccounts();
    } catch (err) {
      showError(addUserError, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // --- Your password ---------------------------------------------------------------
  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(pwError, '');
    const next = $('pwNew').value;
    if (next !== $('pwConfirm').value) return showError(pwError, 'The new passwords don’t match');
    const btn = $('pwSubmit');
    btn.disabled = true;
    try {
      await LS.api('/api/me/password', { method: 'POST', body: { currentPassword: $('pwCurrent').value, newPassword: next } });
      passwordForm.reset();
      $('pwUsername').value = me.user.username;
      LS.toast('Password changed — your other devices were signed out');
    } catch (err) {
      showError(pwError, err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // --- Open / close ------------------------------------------------------------------
  async function open() {
    lastFocus = document.activeElement;
    if (!me) await loadMe();
    if (!me) { LS.toast('Accounts need a server restart to turn on', 'error'); return; }
    showError(pwError, '');
    showError(addUserError, '');
    renderMe();
    modal.hidden = false;
    closeBtn.focus();
    loadAccounts();
  }

  function close() {
    modal.hidden = true;
    if (lastFocus) lastFocus.focus();
  }

  accountBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  loadMe();
})();
