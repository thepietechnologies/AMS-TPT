'use strict';
/* ─── App framework: router, api, toasts, modal, real-time bell (SSE) ────── */
const App = (() => {
  const state = {
    user: null,
    meta: null,
    unread: 0,
    settings: null,
  };

  /* ── Session token (works inside cross-site preview iframes where cookies
   *    may be blocked; localStorage is wrapped in try/catch for safety) ── */
  let memToken = null;
  const tokenStore = {
    get() {
      try { return localStorage.getItem('tpt_token') || memToken; } catch { return memToken; }
    },
    set(t) {
      memToken = t;
      try { if (t) localStorage.setItem('tpt_token', t); else localStorage.removeItem('tpt_token'); } catch { /* ignore */ }
    },
  };

  /* ── API helper — bearer token attached; server verifies every request ── */
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = tokenStore.get();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...opts,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      if (res.status === 401 && state.user) {
        tokenStore.set(null);
        state.user = null;
        disconnectEvents();
        renderShell();
        location.hash = '#/login';
      }
      throw new Error(msg);
    }
    return data;
  }

  /* ── Real-time notifications over SSE (§13) ── */
  let evtSource = null;
  let bellFallbackTimer = null;
  function connectEvents() {
    disconnectEvents();
    const t = tokenStore.get();
    if (!t || !state.user) return;
    try {
      evtSource = new EventSource(`/api/events?token=${encodeURIComponent(t)}`);
      evtSource.addEventListener('notification', (e) => {
        let p = {};
        try { p = JSON.parse(e.data); } catch { /* ignore */ }
        refreshBell();
        if (p.title) toast(`🔔 ${p.title}`, 'info', 5000);
      });
    } catch { /* SSE unavailable — fallback poll below still runs */ }
  }
  function disconnectEvents() {
    if (evtSource) { try { evtSource.close(); } catch { /* ignore */ } evtSource = null; }
  }

  /* ── Utilities ── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, type = 'info', ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast t-${type}`;
    el.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ'}</span><span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function modal({ title, body, foot, wide, onMount }) {
    const root = $('#modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}">
        <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn btn" data-close style="border:1px solid var(--line);border-radius:8px;">✕</button></div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>`;
    $('.modal-body', overlay).innerHTML = body;
    if (foot) $('.modal-foot', overlay).innerHTML = foot;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) close(); });
    root.appendChild(overlay);
    if (onMount) onMount(overlay, close);
    return { overlay, close };
  }

  function confirmDialog(title, text, actionLabel = 'Confirm') {
    return new Promise((resolve) => {
      modal({
        title, body: `<p style="margin:0;font-size:14px;line-height:1.6;">${esc(text)}</p>`,
        foot: `<button class="btn btn-outline" data-close>Cancel</button>
               <button class="btn btn-danger" data-ok>${esc(actionLabel)}</button>`,
        onMount(ov, close) {
          $('[data-ok]', ov).addEventListener('click', () => { close(); resolve(true); });
          ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) resolve(false); });
        },
      });
    });
  }

  const TASK_STATUS_META = {
    pending: { label: 'Pending', badge: 'b-pending' },
    in_progress: { label: 'In Progress', badge: 'b-in_progress' },
    completed: { label: 'Completed', badge: 'b-completed' },
    on_hold: { label: 'On Hold', badge: 'b-on_hold' },
  };
  const priorityBadge = (p) => `<span class="badge b-${String(p || 'medium').toLowerCase()}">${esc(p || 'Medium')}</span>`;
  const statusBadge = (s) => `<span class="badge ${(TASK_STATUS_META[s] || {}).badge || 'b-neutral'}">${(TASK_STATUS_META[s] || {}).label || esc(s)}</span>`;
  const genericStatusBadge = (s) => {
    const map = { sent: 'b-sent', delivered: 'b-delivered', pending: 'b-pending2', failed: 'b-failed', skipped: 'b-skipped', active: 'b-completed', archived: 'b-skipped', paused: 'b-pending2', completed: 'b-completed' };
    return `<span class="badge ${map[s] || 'b-neutral'}">${esc(s)}</span>`;
  };
  const channelBadge = (c) => {
    const ico = { whatsapp: '🟢', email: '✉️', in_app: '🔔', push: '📱' }[c] || '•';
    return `<span class="badge b-${esc(c)}">${ico} ${esc(({ whatsapp: 'WhatsApp', email: 'Email', in_app: 'In-App', push: 'Mobile Push' })[c] || c)}</span>`;
  };
  const initials = (n) => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const qs = (hash) => { const i = hash.indexOf('?'); return new URLSearchParams(i >= 0 ? hash.slice(i + 1) : ''); };
  const baseHash = (hash) => { const h = hash.replace(/^#/, '').split('?')[0]; return h || '/dashboard'; };
  const fmtBytes = (n) => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  /* ── Router ── */
  const routes = {};
  function register(name, def) { routes[name] = def; }

  async function navigate() {
    if (!state.user) return;
    const hash = location.hash || '#/dashboard';
    const parts = baseHash(hash).split('/').filter(Boolean);
    const name = parts[0] || 'dashboard';
    const route = (parts.length > 1 && routes[`${name}_detail`])
      ? routes[`${name}_detail`]
      : (routes[name] || routes.dashboard);
    if (route.adminOnly && state.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
    const view = $('#view');
    view.innerHTML = `<div class="empty"><b>Loading…</b></div>`;
    try {
      await route.render(view, parts.slice(1), qs(hash));
    } catch (e) {
      view.innerHTML = `<div class="empty"><b>Something went wrong</b>${esc(e.message)}</div>`;
    }
    renderNav();
    const bell = $('#bell-panel');
    if (!bell.classList.contains('hidden')) loadBell();
  }

  function renderNav() {
    const nav = $('#nav');
    const admin = state.user.role === 'admin';
    const items = [
      ['label', 'Workspace'],
      ['dashboard', '📊', 'Dashboard'],
      ['clients', '🏢', 'Clients'],
      ['tasks', '✅', 'Tasks'],
      ['calendar', '📅', 'Calendar'],
      ['label', admin ? 'Team & Notifications' : 'Account'],
      ...(admin ? [['team', '👥', 'Team']] : []),
      ['notifications', '🔔', 'Notifications'],
      ...(admin ? [['reports', '📈', 'Reports']] : []),
      ...(admin ? [['settings', '⚙️', 'Settings']] : [['myprefs', '🔔', 'My Preferences']]),
    ];
    const current = baseHash(location.hash).split('/').filter(Boolean)[0] || 'dashboard';
    nav.innerHTML = items.map(it => {
      if (it[0] === 'label') return `<div class="nav-label">${it[1]}</div>`;
      const [name, ico, label] = it;
      return `<button class="nav-item ${current === name ? 'active' : ''}" data-nav="#/${name}">
        <span class="ico">${ico}</span>${label}
      </button>`;
    }).join('');
    $$('#nav .nav-item').forEach(b => b.addEventListener('click', () => {
      location.hash = b.dataset.nav;
      $('#sidebar').classList.remove('open');
    }));
  }

  function renderShell() {
    const authed = !!state.user;
    $('#auth-screen').classList.toggle('hidden', authed);
    $('#shell').classList.toggle('hidden', !authed);
    if (authed) {
      $('#side-name').textContent = state.user.name;
      $('#side-role').textContent = state.user.role === 'admin' ? 'Administrator' : (state.user.title || 'Team Member');
      $('#side-avatar').textContent = initials(state.user.name);
      renderNav();
      loadMeta();
      connectEvents();
      refreshBell();
      // safety net if SSE is blocked by a proxy
      if (bellFallbackTimer) clearInterval(bellFallbackTimer);
      bellFallbackTimer = setInterval(refreshBell, 60000);
    } else {
      disconnectEvents();
      if (bellFallbackTimer) { clearInterval(bellFallbackTimer); bellFallbackTimer = null; }
    }
  }

  /* ── Bell (in-app notification center) ── */
  async function refreshBell() {
    if (!state.user) return;
    try {
      const d = await api('/inapp');
      state.unread = d.unread;
      const c = $('#bell-count');
      c.textContent = d.unread > 99 ? '99+' : d.unread;
      c.classList.toggle('hidden', !d.unread);
      renderBellList(d.rows);
    } catch { /* ignore */ }
  }

  function renderBellList(rows) {
    const list = $('#bell-list');
    if (!rows.length) {
      list.innerHTML = `<div class="empty" style="padding:26px 14px;"><b>All clear 🌙</b>No notifications — the system stays quiet unless something needs your attention.</div>`;
      return;
    }
    const ico = { task_assigned: '📋', task_reassigned: '🔁', task_reminder: '⏰', task_overdue: '🔥', task_completed: '✅', project_update: '📢', task_comment: '💬', whatsapp_failed: '🚫' };
    list.innerHTML = rows.map(r => `
      <div class="bell-item ${r.read ? '' : 'unread'}" data-id="${r.id}" data-link="${esc(r.link)}" data-type="${esc(r.event_type)}">
        <div class="b-ico">${ico[r.event_type] || '🔔'}</div>
        <div style="flex:1;min-width:0;">
          <div class="b-title">${esc(r.title)}</div>
          <div class="b-body">${esc(r.body)}</div>
          <div class="b-time">${esc(fmtWhen(r.created_at))}</div>
        </div>
      </div>`).join('');
    $$('.bell-item', list).forEach(el => el.addEventListener('click', async () => {
      const id = Number(el.dataset.id);
      await api('/inapp/read', { method: 'POST', body: { ids: [id] } });
      refreshBell();
      $('#bell-panel').classList.add('hidden');
      if (el.dataset.link && el.dataset.link.startsWith('#/')) location.hash = el.dataset.link;
    }));
  }

  async function loadBell() { refreshBell(); }

  async function loadMeta() {
    try { state.meta = await api('/meta'); } catch { /* ignore */ }
    if (state.meta) {
      $('#topbar-tz').textContent = `🕐 Agency time: ${state.meta.nowInAgency.time} (${tzLabel(state.meta.agencyTz)})`;
    }
  }
  const tzLabel = (tz) => String(tz || '').split('/').pop().replace(/_/g, ' ');

  /* ── Boot ── */
  async function doLogin(email, password) {
    const d = await api('/auth/login', { method: 'POST', body: { email, password } });
    tokenStore.set(d.token);
    state.user = d.user;
    renderShell();
    if (location.hash === '#/login' || !location.hash) location.hash = '#/dashboard';
    navigate();
    toast(`Welcome back, ${d.user.name.split(' ')[0]}!`, 'success');
  }

  async function boot() {
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#auth-btn');
      btn.disabled = true; btn.textContent = 'Signing in…';
      $('#auth-error').textContent = '';
      try {
        await doLogin($('#auth-email').value, $('#auth-password').value);
      } catch (err) {
        $('#auth-error').textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });
    $$('.demo-chip').forEach(c => c.addEventListener('click', async () => {
      $('#auth-email').value = c.dataset.email;
      $('#auth-password').value = c.dataset.password;
      const btn = $('#auth-btn');
      btn.disabled = true; btn.textContent = 'Signing in…';
      $('#auth-error').textContent = '';
      try {
        await doLogin(c.dataset.email, c.dataset.password);
      } catch (err) {
        $('#auth-error').textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    }));
    $('#logout-btn').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
      tokenStore.set(null);
      state.user = null;
      renderShell();
    });
    $('#nav-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    $('#bell-btn').addEventListener('click', () => {
      $('#bell-panel').classList.toggle('hidden');
      if (!$('#bell-panel').classList.contains('hidden')) loadBell();
    });
    $('#bell-readall').addEventListener('click', async () => {
      await api('/inapp/read', { method: 'POST', body: { all: true } });
      refreshBell();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#bell-panel') && !e.target.closest('#bell-btn')) $('#bell-panel').classList.add('hidden');
    });
    window.addEventListener('hashchange', navigate);

    // session restore — stored bearer token first, then cookie session
    if (!tokenStore.get()) {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (res.ok) {
          const d = await res.json();
          if (d.user && d.token) tokenStore.set(d.token);
          state.user = d.user || null;
        }
      } catch { state.user = null; }
    } else {
      try {
        const d = await api('/auth/me');
        state.user = d.user || null;
        if (d.token) tokenStore.set(d.token);
      } catch { state.user = null; }
    }
    renderShell();
    if (state.user) navigate();
  }

  return {
    state, api, esc, toast, modal, confirmDialog, boot,
    register, navigate, refreshBell, loadMeta, fmtWhen, fmtBytes,
    priorityBadge, statusBadge, genericStatusBadge, channelBadge, TASK_STATUS_META,
    initials, qs, baseHash, tokenStore,
    $, $$,
  };
})();
