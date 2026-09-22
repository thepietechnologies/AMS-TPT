'use strict';
/* ─── Views — Client → Project → Task hierarchy ──────────────────────────── */
(() => {
const { api, esc, toast, modal, confirmDialog, state, $, $$ } = App;
const pb = App.priorityBadge, sb = App.statusBadge, cb = App.channelBadge, gsb = App.genericStatusBadge;
const STM = App.TASK_STATUS_META;

const QUIET_NOTE = `The system stays silent unless something important happens — no daily digests, no "you have no tasks" messages, no greetings. Notifications are only sent for: task assignment, an Admin-scheduled reminder, reassignment, an Admin-posted project update, and Admin-enabled status alerts.`;

/* ─── shared UI helpers ─── */
function crumbs(items) {
  return `<div class="crumbs">${items.map((c, i) =>
    c.hash ? `<a href="${c.hash}" class="crumb-link">${esc(c.label)}</a>${i < items.length - 1 ? '<span class="crumb-sep">↓</span>' : ''}`
           : `<span class="crumb-here">${esc(c.label)}</span>`
  ).join(' ')}</div>`;
}
function activityTimeline(items) {
  if (!items || !items.length) return '<div class="empty" style="padding:18px;"><b>No activity yet</b>Real actions on this record will appear here.</div>';
  const ico = { created: '✨', updated: '✎', archived: '📦', restored: '♻️', completed: '✅', status_changed: '🔁', assigned: '👤', commented: '💬', posted: '📢', reminder_sent: '⏰', reminder_skipped: '🚫', checklist_added: '☑️', checklist_toggled: '☑️', file_attached: '📎', smtp_test: '✉️' };
  return `<div class="activity">${items.map(a => `
    <div class="act-row">
      <div class="act-ico">${ico[a.action] || '•'}</div>
      <div>
        <div class="act-detail">${esc(a.detail || a.action)}</div>
        <div class="act-meta">${esc(a.actor_name || 'System')} · ${esc(a.when_display)}</div>
      </div>
    </div>`).join('')}</div>`;
}
function fileRows(files) {
  if (!files || !files.length) return '<div class="empty" style="padding:18px;"><b>No files</b>Attach client-related files above.</div>';
  return files.map(f => `
    <div class="file-row">
      <span>📎</span>
      <a href="${esc(f.url)}" class="file-name">${esc(f.name)}</a>
      <span class="muted small">${esc(App.fmtBytes(f.size))}</span>
      <span class="muted small">${esc(f.uploadedBy)} · ${esc(f.when_display)}</span>
      <button class="btn btn-sm btn-danger" data-del-file="${f.id}">✕</button>
    </div>`).join('');
}
function uploadWidget(type, id, onDone) {
  return `
    <div class="upload-row">
      <input type="file" class="input" style="max-width:280px;" data-file-input>
      <button class="btn btn-sm btn-primary" data-file-upload>📎 Attach</button>
      <span class="muted small">max 8 MB</span>
    </div>`;
}
function wireUpload(root, type, id, onDone) {
  const btn = $('[data-file-upload]', root);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const input = $('[data-file-input]', root);
    const file = input && input.files && input.files[0];
    if (!file) { toast('Choose a file first', 'error'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('File too large (max 8 MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api(`/attachments/${type}/${id}`, { method: 'POST', body: { name: file.name, mime: file.type || 'application/octet-stream', data: reader.result.split(',')[1] } });
        toast('File attached.', 'success');
        onDone && onDone();
      } catch (e) { toast(e.message, 'error'); }
    };
    reader.readAsDataURL(file);
  });
}
const estDisplay = (m) => !m ? '—' : m % 60 === 0 ? `${m / 60}h` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;

/* ═══ Dashboard (§19 admin / §20 member) ═══════════════════════════════════ */
App.register('dashboard', {
  async render(view) {
    const d = await api('/dashboard');
    const admin = App.state.user.role === 'admin';
    const stat = (ico, bg, val, label) => `
      <div class="card stat"><div class="s-ico" style="background:${bg};">${ico}</div>
        <div><div class="s-val">${val}</div><div class="s-label">${label}</div></div></div>`;
    const taskMini = (t) => `
      <div class="task-row" data-task="${t.id}" style="cursor:pointer;">
        <div class="task-main">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-meta">
            ${t.client_name ? `<span class="tm">🏢 ${esc(t.client_name)}</span>` : ''}
            ${t.project_name ? `<span class="tm">📁 ${esc(t.project_name)}</span>` : ''}
            <span class="tm">👤 ${esc(t.assignee_name || 'Unassigned')}</span>
            ${t.due_display ? `<span class="tm ${t.overdue ? 'tm-overdue' : ''}">📅 ${t.overdue ? 'Overdue · ' : 'Due '}${esc(t.due_display)}</span>` : ''}
            ${pb(t.priority)}${sb(t.status)}
          </div>
        </div>
      </div>`;
    const listCard = (title, sub, rows, emptyTxt) => `
      <div class="card">
        <div class="card-head"><h2>${title}</h2><span class="sub">${sub}</span></div>
        ${rows && rows.length ? rows.map(taskMini).join('') : `<div class="empty"><b>Nothing here</b>${esc(emptyTxt)}</div>`}
      </div>`;

    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${admin ? 'Agency overview' : 'My workspace'}</h1>
          <p>Agency timezone <b>${esc(d.agencyTz)}</b> · Client → Project → Task · event-based notifications only</p>
        </div>
        <div class="spacer"></div>
        ${admin ? '<button class="btn btn-gold" id="new-task-btn">＋ New Task</button>' : ''}
      </div>
      <div class="grid ${admin ? 'grid-4' : 'grid-4'}" style="margin-bottom:18px;">
        ${admin ? (
          stat('🏢', 'var(--blue-soft)', d.stats.active_clients, 'Active clients') +
          stat('📁', 'var(--blue-soft)', d.stats.active_projects, 'Active projects') +
          stat('📋', 'var(--gold-soft)', d.stats.pending_tasks, 'Pending tasks') +
          stat('🔥', 'var(--red-soft)', d.stats.overdue_tasks, 'Overdue') +
          stat('📅', 'var(--gold-soft)', d.stats.due_today, 'Due today') +
          stat('👥', 'var(--green-soft)', d.stats.team_members, 'Team members')
        ) : (
          stat('📋', 'var(--blue-soft)', d.stats.my_tasks, 'My open tasks') +
          stat('📅', 'var(--gold-soft)', d.stats.due_today, 'Due today') +
          stat('🔥', 'var(--red-soft)', d.stats.overdue, 'Overdue') +
          stat('✅', 'var(--green-soft)', d.stats.completed_week, 'Done this week')
        )}
      </div>
      <div class="grid grid-2">
        ${listCard('Due today', 'actual tasks with today’s due date', d.dueToday, 'No tasks are due today.')}
        ${listCard('Overdue', 'needs attention', d.overdueTasks, 'Nothing overdue — good.')}
        ${admin ? `
        <div class="card">
          <div class="card-head"><h2>Team workload</h2><span class="sub">live task counts</span></div>
          ${d.teamWorkload.length ? `<div class="table-wrap"><table class="tbl">
            <tr><th>Member</th><th>Active</th><th>Due today</th><th>Overdue</th></tr>
            ${d.teamWorkload.map(m => `
              <tr><td class="t-title">${esc(m.name)}<div class="t-sub">${esc(m.title || '')}</div></td>
              <td>${m.active_tasks}</td><td>${m.due_today}</td>
              <td>${m.overdue ? `<span class="badge b-urgent">${m.overdue}</span>` : '0'}</td></tr>`).join('')}
          </table></div>` : '<div class="empty"><b>No team members yet</b></div>'}
        </div>
        <div class="card">
          <div class="card-head"><h2>Upcoming reminders</h2><span class="sub">each scheduled explicitly by an Admin</span></div>
          ${d.upcomingReminders.length ? d.upcomingReminders.map(r => `
            <div class="task-row">
              <div class="task-main">
                <div class="task-title">⏰ ${esc(r.task_title)}</div>
                <div class="task-meta"><span class="tm">👤 ${esc(r.assignee_name || 'Unassigned')}</span>
                <span class="tm">🕒 fires ${esc(r.remind_display)}</span></div>
              </div>
            </div>`).join('') : '<div class="empty"><b>No reminders scheduled</b>Reminders only exist when an Admin schedules them on a task.</div>'}
        </div>` : `
        <div class="card">
          <div class="card-head"><h2>My tasks</h2><span class="sub">assigned to you</span></div>
          ${d.myTasks.length ? d.myTasks.map(taskMini).join('') : '<div class="empty"><b>Nothing assigned to you</b>You\'ll be notified when a new task arrives.</div>'}
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent notifications</h2><span class="sub">real events only</span></div>
          ${d.myRecentNotifications.length ? `<div class="table-wrap"><table class="tbl">
            ${d.myRecentNotifications.map(r => `
              <tr><td>${esc(({ task_assigned: '📋 Task Assigned', task_reminder: '⏰ Task Reminder', task_reassigned: '🔁 Task Reassigned', project_update: '📢 Project Update', task_completed: '✅ Task Completed', task_overdue: '🔥 Task Overdue', task_comment: '💬 Comment', whatsapp_failed: '🚫 WhatsApp Failed' })[r.event_type] || r.event_type)}
                <div class="t-sub">${esc((r.message || '').slice(0, 60))}</div></td>
              <td>${gsb(r.status)}<div class="t-sub">${esc(r.when_display)}</div></td></tr>`).join('')}
          </table></div>` : '<div class="empty"><b>No notifications yet</b></div>'}
        </div>`}
      </div>
      <div class="card card-pad" style="margin-top:18px;">
        <div class="card-head" style="padding:0 0 10px 0;border:0;"><h2>Recent activity</h2><span class="sub">real actions only</span></div>
        ${activityTimeline(d.recentActivity)}
      </div>
      <div class="card card-pad" style="margin-top:16px;">
        <div class="callout co-gold"><span class="c-ico">🌙</span><div><b>Quiet by design.</b> ${esc(QUIET_NOTE)}</div></div>
      </div>`;
    $$('[data-task]', view).forEach(row => row.addEventListener('click', () => { location.hash = `#/tasks/${row.dataset.task}`; }));
    const nt = $('#new-task-btn', view);
    if (nt) nt.addEventListener('click', () => taskFormModal());
  },
});

/* ═══ Clients (§2/§3) ══════════════════════════════════════════════════════ */
App.register('clients', {
  async render(view) {
    const clients = await api('/clients');
    const isAdmin = App.state.user.role === 'admin';
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Clients</h1><p>${clients.length} active clients — every project and task lives under a client</p></div>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="new-client-btn">＋ New Client</button>' : ''}
      </div>
      <div class="grid grid-3">
        ${clients.map(c => `
          <div class="card card-pad client-card" data-open="${c.id}">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
              <div class="avatar" style="border-radius:10px;">${esc(App.initials(c.name))}</div>
              <div style="flex:1;min-width:0;">
                <div class="t-title" style="font-size:15px;">${esc(c.name)}</div>
                <div class="muted small">${esc(c.contactPerson || c.contact_person || '')}</div>
              </div>
              <span class="badge ${c.status === 'active' ? 'b-completed' : 'b-skipped'}">${esc(c.status || 'active')}</span>
            </div>
            <div class="task-meta" style="margin-top:2px;">
              <span class="tm">📁 ${c.projectCount || c.project_count || 0} projects</span>
              <span class="tm">📋 ${c.openTasks || c.open_tasks || 0} open tasks</span>
              ${c.package ? `<span class="tm">📦 ${esc(c.package)}</span>` : ''}
            </div>
            ${c.website ? `<div class="muted small" style="margin-top:8px;">🌐 ${esc(c.website.replace(/^https?:\/\//, ''))}</div>` : ''}
          </div>`).join('')}
      </div>
      ${!clients.length ? '<div class="empty"><b>No clients yet</b>Create your first client — projects and tasks are organized under it.</div>' : ''}`;
    $$('.client-card', view).forEach(el => el.addEventListener('click', () => { location.hash = `#/clients/${el.dataset.open}`; }));
    const nb = $('#new-client-btn', view);
    if (nb) nb.addEventListener('click', () => clientFormModal());
  },
});

function clientFormModal(c) {
  let social = {};
  try { social = typeof c?.social === 'string' ? JSON.parse(c.social || '{}') : (c?.social || {}); } catch { /* ignore */ }
  App.modal({
    title: c ? `Edit Client — ${c.name}` : 'New Client',
    wide: true,
    body: `
      <div class="field-row">
        <label class="field"><span>Business name *</span><input class="input" id="cf-name" value="${esc(c ? c.name : '')}" placeholder="e.g. Velocity Solar Power"></label>
        <label class="field"><span>Contact person</span><input class="input" id="cf-contact" value="${esc(c ? (c.contactPerson || c.contact_person || '') : '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Email</span><input class="input" id="cf-email" value="${esc(c ? c.email : '')}"></label>
        <label class="field"><span>Phone</span><input class="input" id="cf-phone" value="${esc(c ? c.phone : '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Website</span><input class="input" id="cf-website" value="${esc(c ? c.website : '')}" placeholder="https://…"></label>
        <label class="field"><span>Start date</span><input type="date" class="input" id="cf-start" value="${esc(c ? (c.startDate || c.start_date || '') : '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Package</span><input class="input" id="cf-package" value="${esc(c ? c.package : '')}" placeholder="e.g. Growth Package — Premium"></label>
        <label class="field"><span>Services</span><input class="input" id="cf-services" value="${esc(c ? c.services : '')}" placeholder="e.g. SEO, Social Media"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Facebook</span><input class="input" id="cf-fb" value="${esc(social.facebook || '')}"></label>
        <label class="field"><span>Instagram</span><input class="input" id="cf-ig" value="${esc(social.instagram || '')}"></label>
        <label class="field"><span>LinkedIn</span><input class="input" id="cf-li" value="${esc(social.linkedin || '')}"></label>
      </div>
      <label class="field"><span>Notes</span><textarea class="input" id="cf-notes">${esc(c ? c.notes : '')}</textarea></label>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="cf-save">${c ? 'Save' : 'Create client'}</button>`,
    onMount(ov, close) {
      $('#cf-save', ov).addEventListener('click', async () => {
        const body = {
          name: $('#cf-name', ov).value.trim(),
          contact_person: $('#cf-contact', ov).value,
          email: $('#cf-email', ov).value,
          phone: $('#cf-phone', ov).value,
          website: $('#cf-website', ov).value,
          start_date: $('#cf-start', ov).value || null,
          package: $('#cf-package', ov).value,
          services: $('#cf-services', ov).value,
          social: { facebook: $('#cf-fb', ov).value, instagram: $('#cf-ig', ov).value, linkedin: $('#cf-li', ov).value },
          notes: $('#cf-notes', ov).value,
        };
        if (!body.name) { toast('Client name is required', 'error'); return; }
        try {
          if (c) await api(`/clients/${c.id}`, { method: 'PATCH', body });
          else await api('/clients', { method: 'POST', body });
          toast(c ? 'Client updated.' : 'Client created.', 'success');
          close(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

/* ═══ Client detail (§3) ═══════════════════════════════════════════════════ */
App.register('clients_detail', {
  async render(view, parts, qs) {
    const id = parts[0];
    let d;
    try { d = await api(`/clients/${id}`); }
    catch (e) { view.innerHTML = `<div class="empty"><b>Cannot open client</b>${esc(e.message)}</div>`; return; }
    const c = d.client;
    const isAdmin = App.state.user.role === 'admin';
    const tab = qs.get('tab') || 'overview';
    const tabBtn = (key, label) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`;
    const socialLinks = Object.entries(c.social || {}).filter(([, v]) => v);

    view.innerHTML = `
      ${crumbs([{ label: 'Clients', hash: '#/clients' }, { label: c.name }])}
      <div class="card card-pad" style="margin-bottom:14px;">
        <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;">
          <div class="avatar" style="width:52px;height:52px;border-radius:14px;font-size:19px;">${esc(App.initials(c.name))}</div>
          <div style="flex:1;min-width:200px;">
            <h1 style="margin:0;">${esc(c.name)} <span class="badge ${c.status === 'active' ? 'b-completed' : 'b-skipped'}">${esc(c.status)}</span></h1>
            <div class="task-meta" style="margin-top:6px;">
              ${c.contactPerson ? `<span class="tm">👤 ${esc(c.contactPerson)}</span>` : ''}
              ${c.email ? `<span class="tm">✉️ ${esc(c.email)}</span>` : ''}
              ${c.phone ? `<span class="tm">📞 ${esc(c.phone)}</span>` : ''}
              ${c.website ? `<span class="tm">🌐 <a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website.replace(/^https?:\/\//, ''))}</a></span>` : ''}
              ${socialLinks.map(([k, v]) => `<span class="tm">🔗 <a href="https://${esc(String(v).replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener">${esc(k)}</a></span>`).join('')}
            </div>
            <div class="task-meta" style="margin-top:4px;">
              ${c.package ? `<span class="tm">📦 ${esc(c.package)}</span>` : ''}
              ${c.services ? `<span class="tm">🛠 ${esc(c.services)}</span>` : ''}
              ${c.startDate ? `<span class="tm">📆 Client since ${esc(c.startDate)}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${isAdmin ? `<button class="btn btn-outline" id="edit-client-btn">✎ Edit</button>
            ${c.status === 'active'
              ? '<button class="btn btn-danger" id="archive-client-btn">📦 Archive</button>'
              : '<button class="btn btn-gold" id="restore-client-btn">♻️ Restore</button>'}` : ''}
          </div>
        </div>
        ${c.notes ? `<div class="callout co-info" style="margin-top:12px;"><span class="c-ico">📝</span><div>${esc(c.notes)}</div></div>` : ''}
      </div>
      <div class="tabs">
        ${tabBtn('overview', 'Overview')}
        ${tabBtn('projects', `Projects (${d.projects.length})`)}
        ${tabBtn('tasks', `Tasks (${d.tasks.length})`)}
        ${tabBtn('files', `Files (${d.files.length})`)}
        ${tabBtn('activity', 'Activity')}
      </div>
      <div id="client-tab-body"></div>`;

    const body = $('#client-tab-body', view);
    if (tab === 'overview') {
      body.innerHTML = `
        <div class="grid grid-2">
          <div class="card card-pad">
            <h2>Business overview</h2>
            <div class="kv" style="margin-top:10px;">
              <div class="k">Client</div><div>${esc(c.name)}</div>
              <div class="k">Status</div><div>${gsb(c.status)}</div>
              <div class="k">Contact</div><div>${esc(c.contactPerson || '—')}</div>
              <div class="k">Email</div><div>${esc(c.email || '—')}</div>
              <div class="k">Phone</div><div>${esc(c.phone || '—')}</div>
              <div class="k">Website</div><div>${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : '—'}</div>
              <div class="k">Package</div><div>${esc(c.package || '—')}</div>
              <div class="k">Services</div><div>${esc(c.services || '—')}</div>
              <div class="k">Start date</div><div>${esc(c.startDate || '—')}</div>
            </div>
          </div>
          <div class="card card-pad">
            <h2>Projects snapshot</h2>
            ${d.projects.length ? d.projects.map(p => `
              <div class="rem-pill" style="cursor:pointer;" data-proj="${p.id}">
                <span>📁</span>
                <div style="flex:1;">
                  <div style="font-weight:650;">${esc(p.name)}</div>
                  <div class="muted small">${gsb(p.status)} · ${p.openTasks || p.open_tasks || 0} open tasks</div>
                </div>
              </div>`).join('') : '<div class="empty"><b>No projects</b>Add the first project for this client.</div>'}
            ${isAdmin ? '<button class="btn btn-gold" id="add-proj-btn" style="margin-top:8px;">＋ New Project for this client</button>' : ''}
          </div>
        </div>`;
    } else if (tab === 'projects') {
      body.innerHTML = `
        ${isAdmin ? '<div style="margin-bottom:12px;"><button class="btn btn-gold" id="add-proj-btn2">＋ New Project for this client</button></div>' : ''}
        <div class="grid grid-2">
          ${d.projects.map(p => `
            <div class="card card-pad" style="cursor:pointer;" data-proj="${p.id}">
              <div class="muted small">Client: <b>${esc(c.name)}</b></div>
              <h2 style="margin:6px 0;">${esc(p.name)}</h2>
              <div style="display:flex;gap:8px;margin-bottom:8px;">
                ${gsb(p.status)}<span class="badge b-neutral">${p.openTasks || p.open_tasks || 0} open</span>
              </div>
              <p class="muted small" style="margin:0;">${esc((p.description || '').slice(0, 120))}${(p.description || '').length > 120 ? '…' : ''}</p>
            </div>`).join('') || '<div class="empty"><b>No projects yet</b></div>'}
        </div>`;
    } else if (tab === 'tasks') {
      body.innerHTML = d.tasks.length ? `
        <div class="card">${d.tasks.map(t => taskRow(t)).join('')}</div>`
        : `<div class="empty"><b>No tasks</b>${isAdmin ? 'Create one from any project of this client.' : 'assigned to you in this client.'}</div>`;
    } else if (tab === 'files') {
      body.innerHTML = `
        <div class="card card-pad">
          <h2>Files</h2>
          ${isAdmin ? uploadWidget('client', c.id) : ''}
          <div id="file-list">${fileRows(d.files)}</div>
        </div>`;
      wireUpload(body, 'client', c.id, () => App.navigate());
    } else {
      body.innerHTML = `<div class="card card-pad"><h2>Activity</h2><p class="muted small">Everything that actually happened on this client — newest first.</p>${activityTimeline(d.activity)}</div>`;
    }

    $$('[data-proj]', body).forEach(el => el.addEventListener('click', () => { location.hash = `#/projects/${el.dataset.proj}`; }));
    $$('[data-tab]', view).forEach(b => b.addEventListener('click', () => { location.hash = `#/clients/${id}?tab=${b.dataset.tab}`; }));
    $$('[data-task]', body).length && $$('[data-task]', body).forEach(row => row.addEventListener('click', () => { location.hash = `#/tasks/${row.dataset.task}`; }));
    const eb = $('#edit-client-btn', view);
    if (eb) eb.addEventListener('click', () => clientFormModal(c));
    const ab = $('#archive-client-btn', view);
    if (ab) ab.addEventListener('click', async () => {
      const ok = await confirmDialog('Archive this client?', `"${c.name}" and all its projects will be archived. Open tasks are kept but reminders and overdue alerts stop. You can restore the client later.`, 'Archive client');
      if (!ok) return;
      await api(`/clients/${c.id}/archive`, { method: 'POST', body: { archive: true } });
      toast('Client archived — reminders for its tasks are stopped.', 'success');
      App.navigate();
    });
    const rb = $('#restore-client-btn', view);
    if (rb) rb.addEventListener('click', async () => {
      await api(`/clients/${c.id}/archive`, { method: 'POST', body: { archive: false } });
      toast('Client restored. Re-activate its projects from each project page.', 'success');
      App.navigate();
    });
    const ap = $('#add-proj-btn', view) || $('#add-proj-btn2', view);
    if (ap) ap.addEventListener('click', () => projectFormModal({ client_id: c.id, client_name: c.name }));
  },
});

/* ═══ Projects global list (admin convenience) ═════════════════════════════ */
App.register('projects', {
  adminOnly: true,
  async render(view) {
    const projects = await api('/projects');
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Projects</h1><p>Global view — projects are managed inside their client (${projects.length})</p></div>
        <div class="spacer"></div>
        <button class="btn btn-gold" id="new-proj-btn">＋ New Project</button>
      </div>
      <div class="grid grid-3">
        ${projects.map(p => `
          <div class="card card-pad" style="cursor:pointer;" data-open="${p.id}">
            <div class="muted small">🏢 ${esc(p.clientName || p.client_name)}</div>
            <h2 style="margin:6px 0 8px;">${esc(p.name)}</h2>
            <div style="display:flex;gap:8px;margin-bottom:10px;">
              ${gsb(p.status)}<span class="badge b-neutral">${p.openTasks || p.open_tasks} open · ${p.completedTasks || p.completed_tasks} done</span>
            </div>
          </div>`).join('')}
      </div>
      ${!projects.length ? '<div class="empty"><b>No projects yet</b>Create one from a client page.</div>' : ''}`;
    $$('[data-open]', view).forEach(el => el.addEventListener('click', () => { location.hash = `#/projects/${el.dataset.open}`; }));
    $('#new-proj-btn', view).addEventListener('click', () => projectFormModal());
  },
});

function projectFormModal(pre = {}) {
  const meta = state.meta;
  const isEdit = !!pre.id;
  App.modal({
    title: isEdit ? 'Edit Project' : 'New Project',
    body: `
      <label class="field"><span>Client *</span>
        <select class="input" id="pf-client" ${isEdit ? 'disabled' : ''}>
          ${meta.clients.map(cl => `<option value="${cl.id}" ${(pre.client_id || '') == cl.id ? 'selected' : ''}>${esc(cl.name)}</option>`).join('')}
        </select></label>
      <label class="field"><span>Project name *</span><input class="input" id="pf-name" value="${esc(pre.name || '')}" placeholder="e.g. Social Media Management"></label>
      <label class="field"><span>Description</span><textarea class="input" id="pf-desc">${esc(pre.description || '')}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Start date</span><input type="date" class="input" id="pf-start" value="${esc(pre.startDate || pre.start_date || '')}"></label>
        <label class="field"><span>End date</span><input type="date" class="input" id="pf-end" value="${esc(pre.endDate || pre.end_date || '')}"></label>
      </div>
      ${isEdit ? `<label class="field"><span>Status</span>
        <select class="input" id="pf-status">${['active', 'paused', 'completed'].map(s => `<option ${pre.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>` : ''}`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="pf-save">${isEdit ? 'Save' : 'Create project'}</button>`,
    onMount(ov, close) {
      $('#pf-save', ov).addEventListener('click', async () => {
        const name = $('#pf-name', ov).value.trim();
        if (!name) { toast('Project name is required', 'error'); return; }
        try {
          if (isEdit) {
            await api(`/projects/${pre.id}`, { method: 'PATCH', body: { name, description: $('#pf-desc', ov).value, start_date: $('#pf-start', ov).value || null, end_date: $('#pf-end', ov).value || null, status: $('#pf-status', ov).value } });
          } else {
            await api('/projects', { method: 'POST', body: { client_id: $('#pf-client', ov).value, name, description: $('#pf-desc', ov).value, start_date: $('#pf-start', ov).value || null, end_date: $('#pf-end', ov).value || null } });
          }
          toast(isEdit ? 'Project updated.' : 'Project created.', 'success');
          close(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

/* ═══ Project detail (§4) ══════════════════════════════════════════════════ */
App.register('projects_detail', {
  async render(view, parts, qs) {
    const id = parts[0];
    let d;
    try { d = await api(`/projects/${id}`); }
    catch (e) { view.innerHTML = `<div class="empty"><b>Cannot open project</b>${esc(e.message)}</div>`; return; }
    const p = d.project;
    const isAdmin = App.state.user.role === 'admin';
    const tab = qs.get('tab') || 'tasks';
    const tabBtn = (key, label) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`;

    view.innerHTML = `
      ${crumbs([
        { label: 'Clients', hash: '#/clients' },
        { label: d.client ? d.client.name : '—', hash: d.client ? `#/clients/${p.clientId}` : null },
        { label: p.name },
      ])}
      <div class="card card-pad" style="margin-bottom:14px;">
        <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div style="flex:1;min-width:220px;">
            <div class="muted small">🏢 ${esc(d.client ? d.client.name : '')}</div>
            <h1 style="margin:4px 0 6px;">${esc(p.name)} ${gsb(p.status)}</h1>
            <p class="muted" style="margin:0;font-size:13.5px;">${esc(p.description || '')}</p>
            <div class="task-meta" style="margin-top:8px;">
              ${p.startDate ? `<span class="tm">📆 Started ${esc(p.startDate)}</span>` : ''}
              ${p.endDate ? `<span class="tm">🏁 Target end ${esc(p.endDate)}</span>` : ''}
              <span class="tm">📋 ${d.tasks.filter(t => t.status !== 'completed').length} open</span>
              <span class="tm">✅ ${d.tasks.filter(t => t.status === 'completed').length} completed</span>
            </div>
            ${d.team.length ? `<div class="task-meta" style="margin-top:4px;"><span class="tm">👥 Team: ${d.team.map(m => esc(m.name)).join(', ')}</span></div>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${isAdmin ? `<button class="btn btn-outline" id="edit-proj-btn">✎ Edit</button>
            <button class="btn btn-gold" id="new-task-btn2">＋ New Task</button>
            <button class="btn btn-outline" id="update-btn">📢 Project Update</button>
            ${p.status === 'archived'
              ? '<button class="btn btn-gold" id="restore-proj-btn">♻️ Restore</button>'
              : '<button class="btn btn-danger" id="archive-proj-btn">📦 Archive</button>'}` : ''}
          </div>
        </div>
      </div>
      <div class="tabs">
        ${tabBtn('tasks', `Tasks (${d.tasks.length})`)}
        ${tabBtn('files', `Files (${d.files.length})`)}
        ${tabBtn('activity', 'Activity')}
        ${tabBtn('updates', `Updates (${d.updates.length})`)}
      </div>
      <div id="proj-tab-body"></div>`;

    const body = $('#proj-tab-body', view);
    if (tab === 'tasks') {
      body.innerHTML = d.tasks.length ? `<div class="card">${d.tasks.map(t => taskRow(t)).join('')}</div>`
        : `<div class="empty"><b>No tasks</b>${isAdmin ? 'Use “＋ New Task” — this project is pre-selected.' : ''}</div>`;
    } else if (tab === 'files') {
      body.innerHTML = `
        <div class="card card-pad"><h2>Files</h2>
          ${isAdmin ? uploadWidget('project', p.id) : ''}
          <div>${fileRows(d.files)}</div></div>`;
      wireUpload(body, 'project', p.id, () => App.navigate());
    } else if (tab === 'activity') {
      body.innerHTML = `<div class="card card-pad"><h2>Activity</h2>${activityTimeline(d.activity)}</div>`;
    } else {
      body.innerHTML = `
        <div class="card card-pad">
          <h2>Project updates</h2>
          <p class="muted small" style="margin:2px 0 14px;">Posted manually by admins — the team is notified only on the channels chosen per update.</p>
          ${d.updates.length ? d.updates.map(u => `
            <div class="update-item">
              <div class="u-title">${esc(u.title)}</div>
              <div class="u-msg">${esc(u.message)}</div>
              <div class="u-meta"><span>👤 ${esc(u.created_by_name || 'Admin')}</span><span>🕐 ${esc(u.created_at)}</span>
                ${u.send_whatsapp ? cb('whatsapp') : ''}${u.send_email ? cb('email') : ''}${u.send_inapp ? cb('in_app') : ''}</div>
            </div>`).join('') : '<div class="empty"><b>No updates yet</b></div>'}
        </div>`;
    }

    $$('[data-tab]', view).forEach(b => b.addEventListener('click', () => { location.hash = `#/projects/${id}?tab=${b.dataset.tab}`; }));
    $$('[data-task]', body).forEach(row => row.addEventListener('click', () => { location.hash = `#/tasks/${row.dataset.task}`; }));
    $$('[data-complete]', body).forEach(btn => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/tasks/${btn.dataset.complete}/complete`, { method: 'POST' });
      toast('Task completed — pending reminders were cancelled.', 'success');
      App.navigate();
    }));
    const eb = $('#edit-proj-btn', view);
    if (eb) eb.addEventListener('click', () => projectFormModal({ ...p, client_id: p.clientId, id: p.id }));
    const nb = $('#new-task-btn2', view);
    if (nb) nb.addEventListener('click', () => taskFormModal({ client_id: p.clientId, project_id: p.id }));
    const ub = $('#update-btn', view);
    if (ub) ub.addEventListener('click', () => projectUpdateModal(p));
    const ab = $('#archive-proj-btn', view);
    if (ab) ab.addEventListener('click', async () => {
      const ok = await confirmDialog('Archive this project?', `"${p.name}" will be archived. Its tasks are kept, but reminders and overdue alerts stop. You can restore it later.`, 'Archive project');
      if (!ok) return;
      await api(`/projects/${p.id}/archive`, { method: 'POST', body: { archive: true } });
      toast('Project archived — its task reminders are cancelled.', 'success');
      App.navigate();
    });
    const rb = $('#restore-proj-btn', view);
    if (rb) rb.addEventListener('click', async () => {
      await api(`/projects/${p.id}/archive`, { method: 'POST', body: { archive: false } });
      toast('Project restored to active.', 'success');
      App.navigate();
    });
  },
});

/* §19 — manual project update */
function projectUpdateModal(p) {
  const meta = state.meta;
  App.modal({
    title: '＋ Project Update',
    wide: true,
    body: `
      <div class="callout co-gold" style="margin-bottom:14px;"><span class="c-ico">📢</span>
        <div>Use for <b>important</b> project news only. Sent <b>only</b> on the channels you tick below.</div></div>
      <label class="field"><span>Title *</span><input class="input" id="pu-title" placeholder="e.g. Client approved the new content strategy"></label>
      <label class="field"><span>Message *</span><textarea class="input" id="pu-msg"></textarea></label>
      <div style="border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:12px;">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:4px;">Notify team members</div>
        <label class="check"><input type="checkbox" id="pu-wa"> 🟢 Send WhatsApp</label>
        <label class="check"><input type="checkbox" id="pu-email"> ✉️ Send Email</label>
        <label class="check"><input type="checkbox" id="pu-inapp" checked> 🔔 Send In-App notification</label>
        <div style="margin-top:8px;font-weight:600;font-size:13px;">Recipients</div>
        ${meta.members.filter(m => m.role !== 'admin').map(m => `
          <label class="check"><input type="checkbox" checked data-rcpt value="${m.id}"> ${esc(m.name)} <span class="muted small">— ${esc(m.title || '')}</span></label>`).join('')}
      </div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="pu-send">Post update & notify</button>`,
    onMount(ov, close) {
      $('#pu-send', ov).addEventListener('click', async () => {
        const title = $('#pu-title', ov).value.trim();
        const message = $('#pu-msg', ov).value.trim();
        if (!title || !message) { toast('Title and message are required', 'error'); return; }
        try {
          const res = await api(`/projects/${p.id}/updates`, {
            method: 'POST',
            body: {
              title, message,
              recipient_ids: $$('[data-rcpt]', ov).filter(c2 => c2.checked).map(c2 => Number(c2.value)),
              send_whatsapp: $('#pu-wa', ov).checked,
              send_email: $('#pu-email', ov).checked,
              send_inapp: $('#pu-inapp', ov).checked,
            },
          });
          toast(res.queued ? `Update posted — ${res.queued} notification(s) queued.` : 'Update posted (no channels selected).', 'success');
          close(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

/* ═══ Tasks global (§8) ════════════════════════════════════════════════════ */
function taskRow(t) {
  return `
    <div class="task-row" data-task="${t.id}" style="cursor:pointer;">
      <div class="task-main">
        <div class="task-title ${t.status === 'completed' ? 'done' : ''}">${esc(t.title)}</div>
        <div class="task-meta">
          ${t.client_name ? `<span class="tm">🏢 ${esc(t.client_name)}</span>` : ''}
          ${t.project_name ? `<span class="tm">📁 ${esc(t.project_name)}</span>` : ''}
          <span class="tm">👤 ${esc(t.assignee_name || 'Unassigned')}</span>
          ${t.due_display ? `<span class="tm ${t.overdue ? 'tm-overdue' : ''}">📅 ${t.overdue ? 'Overdue · was due ' : 'Due '}${esc(t.due_display)}</span>` : ''}
          <span class="tm">⏱ ${estDisplay(t.estimated_minutes)}</span>
          ${pb(t.priority)}${sb(t.status)}
        </div>
      </div>
      <div class="task-actions">
        ${t.status !== 'completed' ? `<button class="btn btn-sm btn-gold" data-complete="${t.id}">✓ Complete</button>` : ''}
      </div>
    </div>`;
}

App.register('tasks', {
  async render(view, parts, qs) {
    const isAdmin = App.state.user.role === 'admin';
    const params = new URLSearchParams();
    for (const k of ['status', 'client_id', 'project_id', 'assignee_id', 'priority', 'due_from', 'due_to', 'q']) {
      if (qs.get(k)) params.set(k, qs.get(k));
    }
    const tasks = await api(`/tasks?${params}`);
    const tab = qs.get('status') || 'pending';
    const meta = state.meta;
    const tabBtn = (key, label) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`;

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Tasks</h1><p>All work in one place — filter by client, project, assignee, status, priority or due date</p></div>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="new-task-btn">＋ New Task</button>' : ''}
      </div>
      <div class="card card-pad" style="margin-bottom:14px;">
        <div class="filters">
          <select class="input" id="f-client"><option value="">All clients</option>
            ${meta.clients.map(c2 => `<option value="${c2.id}" ${qs.get('client_id') == c2.id ? 'selected' : ''}>${esc(c2.name)}</option>`).join('')}</select>
          <select class="input" id="f-project"><option value="">All projects</option>
            ${meta.projects.map(p2 => `<option value="${p2.id}" ${qs.get('project_id') == p2.id ? 'selected' : ''}>${esc(p2.name)}</option>`).join('')}</select>
          ${isAdmin ? `<select class="input" id="f-assignee"><option value="">All assignees</option>
            ${meta.members.filter(m => m.role !== 'admin' || true).map(m => `<option value="${m.id}" ${qs.get('assignee_id') == m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
          <select class="input" id="f-priority"><option value="">All priorities</option>
            ${['Low', 'Medium', 'High', 'Urgent'].map(p2 => `<option ${qs.get('priority') === p2 ? 'selected' : ''}>${p2}</option>`).join('')}</select>
          <input type="date" class="input" id="f-due-from" value="${esc(qs.get('due_from') || '')}" title="Due from">
          <input type="date" class="input" id="f-due-to" value="${esc(qs.get('due_to') || '')}" title="Due to">
          <input class="input" id="f-q" placeholder="Search task / client / project…" style="min-width:200px;" value="${esc(qs.get('q') || '')}">
          <button class="btn btn-primary btn-sm" id="f-apply">Apply</button>
          <button class="btn btn-outline btn-sm" id="f-clear">Clear</button>
        </div>
      </div>
      <div class="tabs">
        ${tabBtn('pending', 'Pending')}
        ${tabBtn('in_progress', 'In Progress')}
        ${tabBtn('overdue', 'Overdue')}
        ${tabBtn('on_hold', 'On Hold')}
        ${tabBtn('completed', 'Completed')}
        ${tabBtn('all', 'All')}
      </div>
      <div class="card">
        ${tasks.length ? tasks.map(t => taskRow(t)).join('') : `<div class="empty"><b>No tasks match</b>${esc('Adjust the filters above.')}</div>`}
      </div>`;

    const apply = () => {
      const p2 = new URLSearchParams();
      p2.set('status', $('#f-client', view) ? tab : tab);
      if ($('#f-client', view).value) p2.set('client_id', $('#f-client', view).value);
      if ($('#f-project', view).value) p2.set('project_id', $('#f-project', view).value);
      if ($('#f-assignee', view) && $('#f-assignee', view).value) p2.set('assignee_id', $('#f-assignee', view).value);
      if ($('#f-priority', view).value) p2.set('priority', $('#f-priority', view).value);
      if ($('#f-due-from', view).value) p2.set('due_from', $('#f-due-from', view).value);
      if ($('#f-due-to', view).value) p2.set('due_to', $('#f-due-to', view).value);
      if ($('#f-q', view).value) p2.set('q', $('#f-q', view).value);
      location.hash = `#/tasks?${p2}`;
    };
    $('#f-apply', view).addEventListener('click', apply);
    $('#f-q', view).addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    $('#f-clear', view).addEventListener('click', () => { location.hash = '#/tasks?status=' + tab; });
    $$('.tab', view).forEach(b => b.addEventListener('click', () => {
      const p2 = new URLSearchParams(location.hash.split('?')[1] || '');
      p2.set('status', b.dataset.tab);
      location.hash = `#/tasks?${p2}`;
    }));
    $('#f-client', view).addEventListener('change', () => {
      // narrow the project list to the chosen client
      const cid = $('#f-client', view).value;
      const sel = $('#f-project', view);
      sel.innerHTML = '<option value="">All projects</option>' + meta.projects
        .filter(p2 => !cid || String(p2.client_id) === cid)
        .map(p2 => `<option value="${p2.id}" ${qs.get('project_id') == p2.id ? 'selected' : ''}>${esc(p2.name)}</option>`).join('');
    });
    $$('[data-task]', view).forEach(row => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-complete]')) return;
      location.hash = `#/tasks/${row.dataset.task}`;
    }));
    $$('[data-complete]', view).forEach(btn => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/tasks/${btn.dataset.complete}/complete`, { method: 'POST' });
      toast('Task completed — pending reminders cancelled.', 'success');
      App.navigate();
    }));
    const nt = $('#new-task-btn', view);
    if (nt) nt.addEventListener('click', () => taskFormModal());
  },
});

/* ─── Task create/edit modal (§6: client → project cascade; §21 reminders) ── */
async function taskFormModal(pre = {}, taskId = null) {
  const meta = state.meta;
  const isEdit = !!taskId;
  let task = null, reminders = [], existingProcessed = 0;
  if (isEdit) {
    const d = await api(`/tasks/${taskId}`);
    task = d.task;
    reminders = d.reminders.filter(r => !r.processed_at);
    existingProcessed = d.reminders.filter(r => r.processed_at).length;
    pre = { client_id: task.clientId, project_id: task.projectId };
  }
  let defRemTime = '22:00';
  try {
    const s = await api('/settings');
    if (s && s.reminderSettings && s.reminderSettings.defaultReminderTime) defRemTime = s.reminderSettings.defaultReminderTime;
  } catch { /* member — default stands */ }

  const todayStr = state.meta.nowInAgency.date;
  const remRow = (r = {}) => `
    <div class="rem-pill" data-rem>
      <span>⏰</span>
      <input type="date" class="input" style="width:150px;" data-rem-date value="${esc(r.date || todayStr)}">
      <input type="time" class="input" style="width:110px;" data-rem-time value="${esc(r.time || defRemTime)}">
      <span class="small muted">fires exactly at this time (${esc(state.meta.agencyTz)})</span>
      <button class="rp-x" data-rem-x title="Remove reminder">✕</button>
    </div>`;

  const dueDate = (task && task.due_date_part) || '';
  const dueTime = (task && task.due_time_part) || '';

  App.modal({
    title: isEdit ? 'Edit Task' : 'New Task',
    wide: true,
    body: `
      <div class="callout co-info" style="margin-bottom:14px;"><span class="c-ico">🧭</span>
        <div>Pick the <b>Client</b> first, then the <b>Project</b> — only that client's projects are listed. The task always belongs to the project's client.</div></div>
      <div class="field-row">
        <label class="field"><span>1 · Client *</span>
          <select class="input" id="tf-client">
            <option value="">— Select client —</option>
            ${meta.clients.map(c2 => `<option value="${c2.id}" ${pre.client_id == c2.id ? 'selected' : ''}>${esc(c2.name)}</option>`).join('')}
          </select></label>
        <label class="field"><span>2 · Project *</span>
          <select class="input" id="tf-project">
            <option value="">— Select client first —</option>
          </select></label>
      </div>
      <label class="field"><span>Task title *</span>
        <input class="input" id="tf-title" value="${esc(task ? task.title : '')}" placeholder="e.g. Create Facebook Post"></label>
      <label class="field"><span>Description</span>
        <textarea class="input" id="tf-desc">${esc(task ? task.description : '')}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Assign to</span>
          <select class="input" id="tf-assignee"><option value="">— Unassigned —</option>
            ${meta.members.filter(m => m.active !== false).map(m => `<option value="${m.id}" ${task && task.assigneeId == m.id ? 'selected' : ''}>${esc(m.name)} — ${esc(m.title || 'Team Member')}</option>`).join('')}
          </select></label>
        <label class="field"><span>Priority</span>
          <select class="input" id="tf-priority">
            ${['Low', 'Medium', 'High', 'Urgent'].map(p2 => `<option ${task && task.priority === p2 ? 'selected' : ''}>${p2}</option>`).join('')}
          </select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Due date</span>
          <input type="date" class="input" id="tf-due-date" value="${esc(dueDate)}"></label>
        <label class="field"><span>Due time (${esc(state.meta.agencyTz)})</span>
          <input type="time" class="input" id="tf-due-time" value="${esc(dueTime)}"></label>
        <label class="field"><span>Estimated time (hours)</span>
          <input type="number" step="0.25" min="0" class="input" id="tf-est" value="${task && task.estimatedMinutes ? task.estimatedMinutes / 60 : ''}" placeholder="e.g. 1.5"></label>
      </div>
      ${isEdit ? `<label class="field"><span>Status</span>
        <select class="input" id="tf-status">${Object.entries(STM).filter(([k]) => k !== 'completed').map(([k, v]) => `<option value="${k}" ${task && task.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>` : ''}
      <div class="callout co-gold" style="margin:6px 0 14px 0;"><span class="c-ico">🌙</span>
        <div>Times use the agency timezone (<b>${esc(state.meta.agencyTz)}</b>) exactly — night hours are respected, never shifted to business hours.</div></div>

      <div style="border:1px solid var(--line);border-radius:12px;padding:14px 16px;">
        <label class="check" style="font-weight:700;"><input type="checkbox" id="tf-reminders-on" ${reminders.length ? 'checked' : ''}>
          Enable reminder(s)</label>
        <div class="hint" style="margin-bottom:10px;">A reminder fires <b>once</b>, exactly at the chosen time — only if the task is still open. Completing the task cancels its reminders. No automatic daily reminders exist.</div>
        <div id="tf-reminders" class="${reminders.length ? '' : 'hidden'}">
          <div id="tf-rem-list">${reminders.length ? reminders.map(r => remRow({ date: r.date_part, time: r.time_part })).join('') : remRow()}</div>
          <button class="btn btn-sm btn-outline" id="tf-rem-add">＋ Add another reminder</button>
          ${existingProcessed ? `<div class="hint">ℹ️ ${existingProcessed} earlier reminder(s) already fired or were skipped (kept in history).</div>` : ''}
        </div>
      </div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button>
           <button class="btn btn-gold" id="tf-save">${isEdit ? 'Save changes' : 'Create task & notify'}</button>`,
    onMount(ov, close) {
      const clientSel = $('#tf-client', ov);
      const projSel = $('#tf-project', ov);
      const fillProjects = () => {
        const cid = clientSel.value;
        const list = meta.projects.filter(p2 => String(p2.client_id) === String(cid));
        projSel.innerHTML = `<option value="">— ${cid ? 'Select project' : 'Select client first'} —</option>` +
          list.map(p2 => `<option value="${p2.id}" ${pre.project_id == p2.id ? 'selected' : ''}>${esc(p2.name)}</option>`).join('');
        if (isEdit && cid) projSel.value = pre.project_id || '';
      };
      fillProjects();
      clientSel.addEventListener('change', () => { pre.project_id = null; fillProjects(); });
      projSel.addEventListener('change', () => {
        const opt = projSel.selectedOptions[0];
        const proj = meta.projects.find(p2 => String(p2.id) === projSel.value);
        if (proj) clientSel.value = String(proj.client_id); // project determines the client
      });

      const remOn = $('#tf-reminders-on', ov);
      const remWrap = $('#tf-reminders', ov);
      remOn.addEventListener('change', () => remWrap.classList.toggle('hidden', !remOn.checked));
      $('#tf-rem-add', ov).addEventListener('click', () => $('#tf-rem-list', ov).insertAdjacentHTML('beforeend', remRow()));
      $('#tf-rem-list', ov).addEventListener('click', (e) => {
        if (e.target.closest('[data-rem-x]')) e.target.closest('[data-rem]').remove();
      });

      $('#tf-save', ov).addEventListener('click', async () => {
        const title = $('#tf-title', ov).value.trim();
        if (!title) { toast('Task title is required', 'error'); return; }
        if (!clientSel.value || !projSel.value) { toast('Select the client and its project first', 'error'); return; }
        const estH = $('#tf-est', ov).value;
        const payload = {
          title,
          description: $('#tf-desc', ov).value,
          client_id: Number(clientSel.value),
          project_id: Number(projSel.value),
          assignee_id: $('#tf-assignee', ov).value || null,
          priority: $('#tf-priority', ov).value,
          due_date: $('#tf-due-date', ov).value || null,
          due_time: $('#tf-due-time', ov).value || null,
          estimated_minutes: estH ? Math.round(Number(estH) * 60) : null,
        };
        if (isEdit) payload.status = $('#tf-status', ov).value;
        payload.reminders = remOn.checked
          ? $$('[data-rem]', ov).map(row => ({ date: $('[data-rem-date]', row).value, time: $('[data-rem-time]', row).value })).filter(r => r.date && r.time)
          : [];
        try {
          let d;
          if (isEdit) {
            d = await api(`/tasks/${taskId}`, { method: 'PATCH', body: payload });
            if (payload.status && payload.status !== task.status && payload.status !== 'completed') {
              await api(`/tasks/${taskId}/status`, { method: 'POST', body: { status: payload.status } });
            }
            toast(d.queued ? `Saved — reassignment notification sent (${d.queued}).` : 'Task saved.', 'success');
          } else {
            d = await api('/tasks', { method: 'POST', body: payload });
            toast(d.queued ? `Task created — assignee notified (${d.queued} message(s)).` : 'Task created (no assignee — nothing notified).', 'success');
          }
          close(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

/* ═══ Task detail (§5) ═════════════════════════════════════════════════════ */
App.register('tasks_detail', {
  async render(view, parts) {
    const id = parts[0];
    let d;
    try { d = await api(`/tasks/${id}`); }
    catch (e) { view.innerHTML = `<div class="empty"><b>Cannot open task</b>${esc(e.message)}</div>`; return; }
    const t = d.task;
    const isAdmin = App.state.user.role === 'admin';
    const crumbItems = [{ label: 'Tasks', hash: '#/tasks' }];
    if (d.client) crumbItems.push({ label: d.client.name, hash: `#/clients/${d.client.id}` });
    if (d.project) crumbItems.push({ label: d.project.name, hash: `#/projects/${d.project.id}` });
    crumbItems.push({ label: t.title });

    const statusActions = [];
    if (t.status !== 'completed') {
      if (t.status !== 'in_progress') statusActions.push(['in_progress', '▶ Start (In Progress)']);
      if (t.status !== 'on_hold') statusActions.push(['on_hold', '⏸ On Hold']);
      if (t.status !== 'pending') statusActions.push(['pending', '↩ Back to Pending']);
      statusActions.push(['completed', '✓ Mark Completed']);
    } else {
      statusActions.push(['pending', '↩ Reopen']);
    }

    view.innerHTML = `
      ${crumbs(crumbItems)}
      <div class="page-head">
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-outline" id="edit-btn">✎ Edit</button>' : ''}
        ${isAdmin ? '<button class="btn btn-danger" id="delete-btn">🗑 Delete</button>' : ''}
      </div>
      <div class="grid grid-2">
        <div>
          <div class="card card-pad" style="margin-bottom:16px;">
            <h2 style="margin-bottom:2px;">${esc(t.title)} ${sb(t.status)}</h2>
            <div class="task-meta" style="margin:6px 0 12px;">
              ${pb(t.priority)}
              ${t.overdue ? '<span class="badge b-urgent">OVERDUE</span>' : ''}
            </div>
            <div class="kv">
              <div class="k">Client</div><div>${d.client ? `<a href="#/clients/${d.client.id}">${esc(d.client.name)}</a>` : '—'}</div>
              <div class="k">Project</div><div>${d.project ? `<a href="#/projects/${d.project.id}">${esc(d.project.name)}</a>` : '—'}</div>
              <div class="k">Assignee</div><div>${esc(t.assignee_name || 'Unassigned')}</div>
              <div class="k">Priority</div><div>${pb(t.priority)}</div>
              <div class="k">Status</div><div>${sb(t.status)}</div>
              <div class="k">Due</div><div>${esc(t.due_display || '—')} ${t.due_display ? `<span class="muted small">(${esc(d.agencyTz)})</span>` : ''}</div>
              <div class="k">Estimated</div><div>${estDisplay(t.estimatedMinutes)}</div>
              ${t.completedAt ? `<div class="k">Completed</div><div>${esc(App.fmtWhen(t.completedAt))}</div>` : ''}
            </div>
            ${t.description ? `<div style="margin-top:14px;"><div class="k muted small" style="font-weight:700;">DESCRIPTION</div>
              <p style="font-size:14px;line-height:1.6;white-space:pre-line;margin:6px 0 0;">${esc(t.description)}</p></div>` : ''}
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">
              ${statusActions.map(([st, label]) => `<button class="btn btn-sm ${st === 'completed' ? 'btn-gold' : 'btn-outline'}" data-status="${st}">${label}</button>`).join('')}
            </div>
          </div>
          <div class="card card-pad" style="margin-bottom:16px;">
            <h2>Reminders</h2>
            <p class="muted small" style="margin:2px 0 12px;">Each fires once at its exact time — only while the task is still open.</p>
            ${d.reminders.length ? d.reminders.map(r => `
              <div class="rem-pill ${r.processed_at ? 'fired' : ''}">
                <span>${r.processed_at ? (r.skip_reason ? '🚫' : '✅') : '⏰'}</span>
                <div>
                  <div>${esc(r.remind_display)} <span class="muted small">(${esc(d.agencyTz)})</span></div>
                  <div class="small" style="${r.skip_reason ? 'color:var(--red);' : 'color:var(--muted);'}">${r.processed_at ? esc(r.skip_reason || 'Sent') : 'Scheduled — waiting for the exact time'}</div>
                </div>
              </div>`).join('') : '<div class="empty" style="padding:18px;"><b>No reminders</b>An Admin did not schedule one.</div>'}
          </div>
          <div class="card card-pad">
            <h2>Comments</h2>
            <div id="comments">
              ${d.comments.length ? d.comments.map(c2 => `
                <div class="comment">
                  <div class="avatar" style="width:30px;height:30px;font-size:12px;">${esc(App.initials(c2.author_name))}</div>
                  <div>
                    <div class="c-body ${c2.important ? 'important' : ''}">${esc(c2.body)}${c2.important ? ' <span class="badge b-high">IMPORTANT</span>' : ''}</div>
                    <div class="c-meta">${esc(c2.author_name)} · ${esc(App.fmtWhen(c2.created_at))}</div>
                  </div>
                </div>`).join('') : '<p class="muted small">No comments yet.</p>'}
            </div>
            <textarea class="input" id="comment-body" placeholder="Write a comment…"></textarea>
            <div style="display:flex;align-items:center;gap:12px;margin-top:8px;">
              <label class="check"><input type="checkbox" id="comment-important"> Mark as important</label>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" id="comment-btn">Comment</button>
            </div>
          </div>
        </div>
        <div>
          <div class="card card-pad" style="margin-bottom:16px;">
            <h2>Checklist</h2>
            ${d.checklist.length ? d.checklist.map(ci => `
              <label class="check check-item"><input type="checkbox" data-check="${ci.id}" ${ci.done ? 'checked' : ''}>
                <span class="${ci.done ? 'check-done' : ''}">${esc(ci.text)}</span>
                <span class="spacer"></span>
                <button class="rp-x" data-check-del="${ci.id}" title="Remove">✕</button>
              </label>`).join('') : '<p class="muted small">No checklist items — break the task into steps below.</p>'}
            <div style="display:flex;gap:8px;margin-top:10px;">
              <input class="input" id="check-text" placeholder="Add a checklist item…">
              <button class="btn btn-sm btn-primary" id="check-add">＋ Add</button>
            </div>
          </div>
          <div class="card card-pad" style="margin-bottom:16px;">
            <h2>Attachments</h2>
            ${uploadWidget('task', t.id)}
            <div>${fileRows(d.attachments)}</div>
          </div>
          <div class="card card-pad">
            <h2>Activity history</h2>
            ${activityTimeline(d.activity)}
          </div>
        </div>
      </div>`;

    wireUpload(view, 'task', t.id, () => App.navigate());
    $$('[data-status]', view).forEach(b => b.addEventListener('click', async () => {
      const st = b.dataset.status;
      if (st === 'completed') {
        const ok = await confirmDialog('Complete this task?', 'Pending reminders will be cancelled and will NOT fire. Admins subscribed to completion alerts will be notified.', 'Complete task');
        if (!ok) return;
      }
      await api(`/tasks/${t.id}/status`, { method: 'POST', body: { status: st } });
      toast(st === 'completed' ? 'Task completed — reminders cancelled.' : 'Status updated.', 'success');
      App.navigate();
    }));
    const eb = $('#edit-btn', view);
    if (eb) eb.addEventListener('click', () => taskFormModal({}, String(t.id)));
    const db2 = $('#delete-btn', view);
    if (db2) db2.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete this task?', `"${t.title}" and its reminders, comments, checklist and attachments will be permanently removed. Prefer completing the task when possible.`, 'Delete permanently');
      if (!ok) return;
      await api(`/tasks/${t.id}`, { method: 'DELETE' });
      toast('Task deleted.', 'success');
      location.hash = '#/tasks';
    });
    $('#comment-btn', view).addEventListener('click', async () => {
      const body = $('#comment-body', view).value.trim();
      if (!body) return;
      await api(`/tasks/${t.id}/comments`, { method: 'POST', body: { body, important: $('#comment-important', view).checked } });
      App.navigate();
    });
    $('#check-add', view).addEventListener('click', async () => {
      const text = $('#check-text', view).value.trim();
      if (!text) return;
      await api(`/tasks/${t.id}/checklist`, { method: 'POST', body: { text } });
      App.navigate();
    });
    $$('[data-check]', view).forEach(cbEl => cbEl.addEventListener('change', async () => {
      await api(`/checklist/${cbEl.dataset.check}`, { method: 'PATCH', body: { done: cbEl.checked } });
    }));
    $$('[data-check-del]', view).forEach(b => b.addEventListener('click', async () => {
      await api(`/checklist/${b.dataset.checkDel}`, { method: 'DELETE' });
      App.navigate();
    }));
  },
});

/* ═══ Calendar ═════════════════════════════════════════════════════════════ */
App.register('calendar', {
  async render(view, parts, qs) {
    const zone = state.meta.agencyTz;
    // month offset from current agency date
    const todayParts = state.meta.nowInAgency.date.split('-').map(Number);
    let y = todayParts[0], m = todayParts[1];
    const mo = Number(qs.get('m') || 0);
    if (mo) { const d0 = new Date(y, m - 1 + mo, 1); y = d0.getFullYear(); m = d0.getMonth() + 1; }
    const daysInMonth = new Date(y, m, 0).getDate();
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const to = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    const d = await api(`/calendar?from=${from}&to=${to}`);
    const byDay = {};
    for (const t of d.tasks) { const k = t.dueDate; (byDay[k] = byDay[k] || []).push({ type: 'task', t }); }
    for (const r of d.reminders) { (byDay[r.remindDate] = byDay[r.remindDate] || []).push({ type: 'reminder', r }); }
    const firstDow = new Date(y, m - 1, 1).getDay();
    const monthName = new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const todayKey = state.meta.nowInAgency.date;

    let cells = '';
    for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell cal-blank"></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const items = byDay[key] || [];
      cells += `
        <div class="cal-cell ${key === todayKey ? 'cal-today' : ''}">
          <div class="cal-day">${day}</div>
          ${items.slice(0, 3).map(it => it.type === 'task' ? `
            <div class="cal-item ${it.t.overdue ? 'cal-overdue' : ''}" data-task="${it.t.id}" title="${esc(it.t.title)} — due ${esc(it.t.dueDisplay || '')}">
              📋 ${esc(it.t.title.slice(0, 24))}${it.t.title.length > 24 ? '…' : ''}
            </div>` : `
            <div class="cal-item cal-rem ${it.r.processed ? 'cal-done' : ''}" data-task="${it.r.taskId}" title="Reminder — ${esc(it.r.taskTitle)}">
              ⏰ ${esc((it.r.taskTitle || '').slice(0, 22))}
            </div>`).join('')}
          ${items.length > 3 ? `<div class="cal-more">+${items.length - 3} more</div>` : ''}
        </div>`;
    }

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Calendar</h1><p>Task due dates and scheduled reminders — agency timezone <b>${esc(zone)}</b></p></div>
        <div class="spacer"></div>
        <button class="btn btn-outline btn-sm" id="cal-prev">← Prev</button>
        <b style="min-width:150px;text-align:center;">${esc(monthName)}</b>
        <button class="btn btn-outline btn-sm" id="cal-next">Next →</button>
        <button class="btn btn-outline btn-sm" id="cal-today-btn">Today</button>
      </div>
      <div class="card card-pad">
        <div class="cal-grid">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d2 => `<div class="cal-dow">${d2}</div>`).join('')}
          ${cells}
        </div>
      </div>
      <div class="card card-pad" style="margin-top:14px;">
        <div class="callout co-info"><span class="c-ico">ℹ️</span><div>📋 = task due &nbsp;·&nbsp; ⏰ = Admin-scheduled reminder fires &nbsp;·&nbsp; highlighted border = today. Click any item to open the task.</div></div>
      </div>`;
    $('#cal-prev', view).addEventListener('click', () => { location.hash = `#/calendar?m=${mo - 1}`; });
    $('#cal-next', view).addEventListener('click', () => { location.hash = `#/calendar?m=${mo + 1}`; });
    $('#cal-today-btn', view).addEventListener('click', () => { location.hash = '#/calendar'; });
    $$('[data-task]', view).forEach(el => el.addEventListener('click', () => { location.hash = `#/tasks/${el.dataset.task}`; }));
  },
});

/* ═══ Reports (admin) ══════════════════════════════════════════════════════ */
App.register('reports', {
  adminOnly: true,
  async render(view) {
    const r = await api('/reports');
    const total = Object.values(r.tasksByStatus).reduce((a, b) => a + b, 0);
    view.innerHTML = `
      <div class="page-head"><div><h1>Reports</h1><p>Real aggregates from the database — agency timezone ${esc(r.agencyTz)}</p></div></div>
      <div class="grid grid-4" style="margin-bottom:16px;">
        ${Object.entries(r.tasksByStatus).map(([k, v]) => `
          <div class="card stat"><div class="s-ico" style="background:var(--${k === 'completed' ? 'green' : k === 'completed' ? 'green' : 'blue'}-soft);">${{ pending: '📋', in_progress: '🔄', completed: '✅', on_hold: '⏸' }[k]}</div>
          <div><div class="s-val">${v}</div><div class="s-label">${STM[k].label}${total ? ` · ${Math.round(v * 100 / total)}%` : ''}</div></div></div>`).join('')}
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>By priority</h2><span class="sub">open tasks</span></div>
          <div class="table-wrap"><table class="tbl">
            ${Object.entries(r.byPriority).map(([p, v]) => `<tr><td>${pb(p)}</td><td style="text-align:right;"><b>${v}</b></td></tr>`).join('')}
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Reminders</h2><span class="sub">all-time</span></div>
          <div class="table-wrap"><table class="tbl">
            <tr><td>⏰ Scheduled (waiting)</td><td style="text-align:right;"><b>${r.reminders.scheduled}</b></td></tr>
            <tr><td>✅ Fired</td><td style="text-align:right;"><b>${r.reminders.fired}</b></td></tr>
            <tr><td>🚫 Skipped by conditions</td><td style="text-align:right;"><b>${r.reminders.skipped}</b></td></tr>
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Workload by client</h2><span class="sub">active clients</span></div>
          <div class="table-wrap"><table class="tbl">
            <tr><th>Client</th><th>Projects</th><th>Open</th><th>Overdue</th></tr>
            ${r.perClient.map(c2 => `<tr><td class="t-title">${esc(c2.name)}</td><td>${c2.projects}</td><td>${c2.open_tasks}</td><td>${c2.overdue ? `<span class="badge b-urgent">${c2.overdue}</span>` : '0'}</td></tr>`).join('')}
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Workload by member</h2><span class="sub">team</span></div>
          <div class="table-wrap"><table class="tbl">
            <tr><th>Member</th><th>Open</th><th>Completed</th><th>Overdue</th></tr>
            ${r.perMember.map(mm => `<tr><td class="t-title">${esc(mm.name)}</td><td>${mm.open}</td><td>${mm.completed}</td><td>${mm.overdue ? `<span class="badge b-urgent">${mm.overdue}</span>` : '0'}</td></tr>`).join('')}
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Notifications by channel</h2><span class="sub">all-time</span></div>
          <div class="table-wrap"><table class="tbl">
            ${r.notifByChannel.map(x => `<tr><td>${cb(x.channel)}</td><td style="text-align:right;"><b>${x.c}</b></td></tr>`).join('') || '<tr><td class="muted">No notifications yet</td></tr>'}
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Notifications by status</h2><span class="sub">delivery health</span></div>
          <div class="table-wrap"><table class="tbl">
            ${r.notifByStatus.map(x => `<tr><td>${gsb(x.status)}</td><td style="text-align:right;"><b>${x.c}</b></td></tr>`).join('') || '<tr><td class="muted">No notifications yet</td></tr>'}
          </table></div>
        </div>
      </div>`;
  },
});

/* ═══ Notifications page (admin: history / member: my notifications) ═══════ */
App.register('notifications', {
  async render(view, parts, qs) {
    if (App.state.user.role === 'admin') return historyView(view, qs);
    const d = await api('/inapp');
    const ico = { task_assigned: '📋', task_reassigned: '🔁', task_reminder: '⏰', task_overdue: '🔥', task_completed: '✅', project_update: '📢', task_comment: '💬', whatsapp_failed: '🚫' };
    view.innerHTML = `
      <div class="page-head">
        <div><h1>My notifications</h1><p>Real events only — quiet when nothing needs your attention</p></div>
        <div class="spacer"></div>
        <button class="btn btn-outline" id="read-all">Mark all read</button>
      </div>
      <div class="card">
        ${d.rows.length ? d.rows.map(r => `
          <div class="bell-item" style="padding:14px 18px;" data-link="${esc(r.link)}">
            <div class="b-ico">${ico[r.event_type] || '🔔'}</div>
            <div style="flex:1;">
              <div class="b-title">${esc(r.title)} ${r.read ? '' : '<span class="badge b-high">NEW</span>'}</div>
              <div class="b-body">${esc(r.body)}</div>
              <div class="b-time">${esc(App.fmtWhen(r.created_at))}</div>
            </div>
          </div>`).join('') : '<div class="empty"><b>No notifications</b>' + esc(QUIET_NOTE) + '</div>'}
      </div>`;
    $('#read-all', view).addEventListener('click', async () => {
      await api('/inapp/read', { method: 'POST', body: { all: true } });
      App.refreshBell(); App.navigate();
    });
    $$('.bell-item', view).forEach(el => el.addEventListener('click', async () => {
      await api('/inapp/read', { method: 'POST', body: { all: true } }).catch(() => {});
      if (el.dataset.link && el.dataset.link.startsWith('#/')) location.hash = el.dataset.link;
    }));
  },
});

/* ─── Notification History (admin) ─── */
async function historyView(view, qs) {
  const params = new URLSearchParams();
  for (const k of ['status', 'channel', 'type', 'q']) if (qs.get(k)) params.set(k, qs.get(k));
  const d = await api(`/notifications/history?${params}`);
  const typeLabel = (k) => state.meta.events[k] || k;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Notification History</h1><p>Every message the system attempted — unique event/reference IDs prevent duplicates. Push rows are reserved for the future mobile app.</p></div>
      <div class="spacer"></div>
      <button class="btn btn-outline" id="run-sched">⚡ Run scheduler now</button>
    </div>
    <div class="card card-pad" style="margin-bottom:14px;">
      <div class="filters">
        <select class="input" id="f-status"><option value="">All statuses</option>
          ${['sent', 'pending', 'failed', 'skipped'].map(st => `<option value="${st}" ${qs.get('status') === st ? 'selected' : ''}>${st}</option>`).join('')}</select>
        <select class="input" id="f-channel"><option value="">All channels</option>
          <option value="whatsapp" ${qs.get('channel') === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
          <option value="email" ${qs.get('channel') === 'email' ? 'selected' : ''}>Email</option>
          <option value="in_app" ${qs.get('channel') === 'in_app' ? 'selected' : ''}>In-App</option>
          <option value="push" ${qs.get('channel') === 'push' ? 'selected' : ''}>Mobile Push</option></select>
        <select class="input" id="f-type"><option value="">All types</option>
          ${Object.entries(state.meta.events).map(([k, v]) => `<option value="${k}" ${qs.get('type') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <input class="input" id="f-q" placeholder="Search recipient / subject…" value="${esc(qs.get('q') || '')}">
        <button class="btn btn-primary btn-sm" id="f-apply">Apply filters</button>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table class="tbl">
      <tr><th>Sent / created</th><th>Recipient</th><th>Type</th><th>Client / Task</th><th>Channel</th><th>Status</th><th></th></tr>
      ${d.rows.map(r2 => `
        <tr>
          <td>${esc(r2.sent_display || r2.created_display)}${r2.retry_count ? `<div class="t-sub">retry #${r2.retry_count}</div>` : ''}</td>
          <td class="t-title">${esc(r2.recipient_label)}</td>
          <td>${esc(typeLabel(r2.event_type))}</td>
          <td>${esc(r2.client_name || '—')}${r2.task_title ? `<div class="t-sub">${esc(r2.task_title)}</div>` : ''}</td>
          <td>${cb(r2.channel)}</td>
          <td>${gsb(r2.status)}${r2.status_reason ? `<div class="t-sub">${esc(r2.status_reason)}</div>` : ''}${r2.error ? `<div class="t-sub" style="color:var(--red);">${esc(r2.error.slice(0, 90))}</div>` : ''}</td>
          <td style="white-space:nowrap;">
            ${r2.status === 'failed' && r2.channel !== 'push' ? `<button class="btn btn-sm btn-gold" data-retry="${r2.id}">↻ Retry</button>` : ''}
            <button class="btn btn-sm btn-outline" data-detail="${r2.id}">Details</button>
          </td>
        </tr>`).join('')}
    </table></div></div>
    ${!d.rows.length ? '<div class="empty"><b>No notifications</b>' + esc(QUIET_NOTE) + '</div>' : ''}`;
  $('#f-apply', view).addEventListener('click', () => {
    const p2 = new URLSearchParams();
    if ($('#f-status', view).value) p2.set('status', $('#f-status', view).value);
    if ($('#f-channel', view).value) p2.set('channel', $('#f-channel', view).value);
    if ($('#f-type', view).value) p2.set('type', $('#f-type', view).value);
    if ($('#f-q', view).value) p2.set('q', $('#f-q', view).value);
    location.hash = `#/notifications?${p2}`;
  });
  $('#run-sched', view).addEventListener('click', async () => {
    const r2 = await api('/admin/run-scheduler', { method: 'POST' });
    toast(`Scheduler ran — ${r2.remindersFired} fired, ${r2.remindersSkipped} skipped by conditions, ${r2.overdueDetected} overdue detected.`, 'success', 6000);
    App.navigate();
  });
  $$('[data-retry]', view).forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/notifications/${b.dataset.retry}/retry`, { method: 'POST' });
      toast('Retried — delivery re-attempted.', 'success');
      App.navigate();
    } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-detail]', view).forEach(b => b.addEventListener('click', () => {
    const row = d.rows.find(x => String(x.id) === b.dataset.detail);
    notifDetailModal(row, typeLabel);
  }));
}

function notifDetailModal(r, typeLabel) {
  let meta = {};
  try { meta = JSON.parse(r.meta || '{}'); } catch { /* ignore */ }
  const kv = (k, v) => v ? `<div class="k">${k}</div><div>${v}</div>` : '';
  App.modal({
    title: `Notification #${r.id} — ${typeLabel(r.event_type)}`,
    wide: true,
    body: `
      <div class="kv" style="margin-bottom:14px;">
        ${kv('Event ID', `<span class="mono">${esc(r.event_id)}</span>`)}
        ${kv('Channel', cb(r.channel))}
        ${kv('Status', `${gsb(r.status)}${r.status_reason ? ` — ${esc(r.status_reason)}` : ''}`)}
        ${kv('Recipient', esc(r.recipient_label))}
        ${kv('Client', esc(r.client_name || '—'))}
        ${kv('Project', esc(r.project_name || '—'))}
        ${kv('Task', esc(r.task_title || '—'))}
        ${kv('Created', esc(r.created_display))}
        ${kv('Scheduled', esc(r.scheduled_at || '—'))}
        ${kv('Sent', esc(r.sent_display || '—'))}
        ${kv('Retry count', String(r.retry_count))}
        ${r.error ? kv('Error', `<span style="color:var(--red);">${esc(r.error)}</span>`) : ''}
      </div>
      ${meta.text ? `<div class="k muted small" style="font-weight:700;margin-bottom:6px;">WHATSAPP MESSAGE</div><div class="wa-phone">to ${esc(meta.to || '')}</div><div class="wa-bubble">${esc(meta.text)}</div>` : ''}
      ${(r.channel === 'in_app' || r.channel === 'push') ? `<div class="k muted small" style="font-weight:700;margin-bottom:6px;">${r.channel === 'push' ? 'PUSH PAYLOAD (future mobile app)' : 'IN-APP MESSAGE'}</div><div class="wa-bubble" style="background:#f4f6fa;">${esc((meta.title || r.subject || '') + '\n' + (meta.body || r.message || ''))}</div>` : ''}`,
    foot: `${r.channel === 'email' && meta.html ? '<button class="btn btn-outline" id="nd-view">View full email</button>' : ''}
           <button class="btn btn-primary" data-close>Close</button>`,
    onMount(ov) {
      const vb = $('#nd-view', ov);
      if (vb) vb.addEventListener('click', () => {
        const w = window.open('', '_blank');
        w.document.write(meta.html);
        w.document.close();
      });
    },
  });
}

/* ═══ My preferences (member) ══════════════════════════════════════════════ */
App.register('myprefs', {
  async render(view) {
    const me = state.user;
    const [prefs, settings] = await Promise.all([api(`/team/${me.id}/prefs`), api('/settings')]);
    const critical = settings.notificationSettings.criticalEvents || [];
    const override = settings.notificationSettings.adminOverrideCritical;
    const channels = ['whatsapp', 'email', 'in_app', 'push'];
    const chLabel = { whatsapp: '🟢 WhatsApp', email: '✉️ Email', in_app: '🔔 In-App', push: '📱 Mobile Push' };
    view.innerHTML = `
      <div class="page-head"><div><h1>My notification preferences</h1>
        <p>Choose which events may reach you on each channel. Admins can override these for critical events${override ? ' (currently enabled)' : ''}.</p></div></div>
      <div class="card"><div class="table-wrap"><table class="tbl matrix">
        <tr><th>Event</th>${channels.map(c2 => `<th>${chLabel[c2]}</th>`).join('')}</tr>
        ${Object.entries(state.meta.events).map(([key, label]) => `
          <tr>
            <td class="m-row-label">${esc(label)} ${critical.includes(key) ? '<span class="badge b-high" title="Admin override may apply">critical</span>' : ''}</td>
            ${channels.map(c2 => `
              <td><label class="switch"><input type="checkbox" data-ev="${key}" data-ch="${c2}" ${prefs[key] && prefs[key][c2] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
          </tr>`).join('')}
      </table></div>
      <div class="card-pad" style="border-top:1px solid var(--line);display:flex;justify-content:flex-end;">
        <button class="btn btn-gold" id="save-prefs">Save preferences</button>
      </div></div>
      <div class="card card-pad" style="margin-top:16px;">
        <div class="callout co-info"><span class="c-ico">🌙</span><div>
          You will never receive daily digests, "no tasks today" notes, greetings or motivational messages — regardless of these settings. Mobile Push becomes active when the future mobile app is released.</div></div>
      </div>`;
    $('#save-prefs', view).addEventListener('click', async () => {
      const body = {};
      $$('[data-ev]', view).forEach(cbEl => {
        body[cbEl.dataset.ev] = body[cbEl.dataset.ev] || {};
        body[cbEl.dataset.ev][cbEl.dataset.ch] = cbEl.checked;
      });
      await api(`/team/${me.id}/prefs`, { method: 'PUT', body });
      toast('Preferences saved.', 'success');
    });
  },
});

/* ═══ Team (admin) ═════════════════════════════════════════════════════════ */
App.register('team', {
  adminOnly: true,
  async render(view) {
    const team = await api('/team');
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Team</h1><p>Profiles, contact details and per-member notification preferences</p></div>
        <div class="spacer"></div>
        <button class="btn btn-gold" id="new-member-btn">＋ New Team Member</button>
      </div>
      <div class="card"><div class="table-wrap"><table class="tbl">
        <tr><th>Member</th><th>Role</th><th>Email</th><th>WhatsApp</th><th>Open tasks</th><th>Status</th><th></th></tr>
        ${team.map(u => `
          <tr>
            <td class="t-title"><span style="display:inline-flex;align-items:center;gap:9px;">
              <span class="avatar" style="width:30px;height:30px;font-size:12px;">${esc(App.initials(u.name))}</span>
              <span>${esc(u.name)}<div class="t-sub">${esc(u.title || '')}</div></span></span></td>
            <td><span class="badge ${u.role === 'admin' ? 'b-high' : 'b-neutral'}">${u.role}</span></td>
            <td>${esc(u.email)}</td>
            <td>${esc(u.phone || '—')}</td>
            <td>${u.open_tasks}</td>
            <td>${u.active ? '<span class="badge b-completed">active</span>' : '<span class="badge b-skipped">deactivated</span>'}</td>
            <td style="white-space:nowrap;">
              <button class="btn btn-sm btn-outline" data-prefs="${u.id}" data-name="${esc(u.name)}">🔔 Preferences</button>
              <button class="btn btn-sm btn-outline" data-edit="${u.id}">✎ Edit</button>
            </td>
          </tr>`).join('')}
      </table></div></div>
      <div class="card card-pad" style="margin-top:16px;">
        <div class="callout co-info"><span class="c-ico">💡</span><div>
          Members can only see their own work through the API — the backend enforces this regardless of client. Team members cannot delete clients or projects.</div></div>
      </div>`;
    $('#new-member-btn', view).addEventListener('click', () => memberModal());
    $$('[data-edit]', view).forEach(b => b.addEventListener('click', () => {
      memberModal(team.find(x => String(x.id) === b.dataset.edit));
    }));
    $$('[data-prefs]', view).forEach(b => b.addEventListener('click', () => prefsModal(Number(b.dataset.prefs), b.dataset.name)));
  },
});

function memberModal(u) {
  App.modal({
    title: u ? `Edit ${u.name}` : 'New Team Member',
    body: `
      <div class="field-row">
        <label class="field"><span>Full name *</span><input class="input" id="mf-name" value="${esc(u ? u.name : '')}"></label>
        <label class="field"><span>Role title</span><input class="input" id="mf-title" value="${esc(u ? u.title : '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Email address *</span><input type="email" class="input" id="mf-email" value="${esc(u ? u.email : '')}"></label>
        <label class="field"><span>WhatsApp number</span><input class="input" id="mf-phone" value="${esc(u ? u.phone : '')}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>System role</span>
          <select class="input" id="mf-role"><option value="member" ${u && u.role === 'member' ? 'selected' : ''}>Team Member</option>
          <option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
        <label class="field"><span>${u ? 'New password (blank to keep)' : 'Password'}</span><input type="password" class="input" id="mf-pass"></label>
      </div>
      ${u ? `<label class="check"><input type="checkbox" id="mf-active" ${u.active ? 'checked' : ''}> Active — can sign in and receive notifications</label>` : ''}`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="mf-save">${u ? 'Save' : 'Create member'}</button>`,
    onMount(ov, close) {
      $('#mf-save', ov).addEventListener('click', async () => {
        const body = {
          name: $('#mf-name', ov).value.trim(), title: $('#mf-title', ov).value,
          email: $('#mf-email', ov).value.trim(), phone: $('#mf-phone', ov).value, role: $('#mf-role', ov).value,
        };
        const pass = $('#mf-pass', ov).value;
        if (pass) body.password = pass;
        if (u) body.active = $('#mf-active', ov).checked;
        if (!body.name || !body.email) { toast('Name and email are required', 'error'); return; }
        try {
          if (u) await api(`/team/${u.id}`, { method: 'PATCH', body });
          else await api('/team', { method: 'POST', body });
          toast(u ? 'Member updated.' : 'Member created.', 'success');
          close(); App.loadMeta(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

async function prefsModal(userId, name) {
  const [prefs, settings] = await Promise.all([api(`/team/${userId}/prefs`), api('/settings')]);
  const critical = settings.notificationSettings.criticalEvents || [];
  const override = settings.notificationSettings.adminOverrideCritical;
  const channels = ['whatsapp', 'email', 'in_app', 'push'];
  const chLabel = { whatsapp: '🟢 WhatsApp', email: '✉️ Email', in_app: '🔔 In-App', push: '📱 Mobile Push' };
  App.modal({
    title: `Notification preferences — ${name}`,
    wide: true,
    body: `
      ${override ? `<div class="callout co-gold" style="margin-bottom:12px;"><span class="c-ico">🛡️</span><div>Admin override for <b>critical events</b> is ON — assignments, reminders, reassignments and overdue alerts reach members even if turned off here.</div></div>` : ''}
      <div class="table-wrap"><table class="tbl matrix">
        <tr><th>Event</th>${channels.map(c2 => `<th>${chLabel[c2]}</th>`).join('')}</tr>
        ${Object.entries(state.meta.events).map(([key, label]) => `
          <tr>
            <td class="m-row-label">${esc(label)} ${critical.includes(key) ? '<span class="badge b-high">critical</span>' : ''}</td>
            ${channels.map(c2 => `
              <td><label class="switch"><input type="checkbox" data-ev="${key}" data-ch="${c2}" ${prefs[key] && prefs[key][c2] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
          </tr>`).join('')}
      </table></div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="pm-save">Save preferences</button>`,
    onMount(ov, close) {
      $('#pm-save', ov).addEventListener('click', async () => {
        const body = {};
        $$('[data-ev]', ov).forEach(cbEl => {
          body[cbEl.dataset.ev] = body[cbEl.dataset.ev] || {};
          body[cbEl.dataset.ev][cbEl.dataset.ch] = cbEl.checked;
        });
        await api(`/team/${userId}/prefs`, { method: 'PUT', body });
        toast('Preferences saved.', 'success');
        close();
      });
    },
  });
}

/* ═══ Email Templates (admin) ══════════════════════════════════════════════ */
App.register('templates', {
  adminOnly: true,
  async render(view) {
    const tpls = await api('/templates');
    const icons = { new_task_assigned: '📋', task_reminder: '⏰', task_reassigned: '🔁', task_reassigned_from: '↩️', project_update: '📢', task_completed: '✅', task_overdue: '🔥', whatsapp_failed: '🚫' };
    view.innerHTML = `
      <div class="page-head"><div><h1>Email Templates</h1>
        <p>Branded emails per event. Placeholders like <span class="mono">{{team_member_name}}</span> are replaced automatically.</p></div></div>
      <div class="card">
        ${tpls.map(t => `
          <div class="tpl-row" data-key="${t.key}">
            <div class="tpl-ico">${icons[t.key] || '✉️'}</div>
            <div style="flex:1;">
              <div style="font-weight:700;">${esc(t.name)}</div>
              <div class="muted small">Subject: ${esc(t.subject)}</div>
            </div>
            <button class="btn btn-sm btn-outline">Edit</button>
          </div>`).join('')}
      </div>`;
    $$('.tpl-row', view).forEach(row => row.addEventListener('click', () => templateEditor(row.dataset.key)));
  },
});

const TEMPLATE_VARS = ['{{team_member_name}}', '{{first_name}}', '{{client_name}}', '{{project_name}}', '{{task_name}}', '{{task_description}}', '{{priority}}', '{{due_date}}', '{{due_time}}', '{{reminder_time}}', '{{update_title}}', '{{update_message}}', '{{dashboard_url}}', '{{admin_name}}'];

async function templateEditor(key) {
  const tpl = await api(`/templates/${key}`);
  App.modal({
    title: `Edit template — ${tpl.name}`,
    wide: true,
    body: `
      <label class="field"><span>Subject line</span><input class="input" id="te-subject" value="${esc(tpl.subject)}"></label>
      <label class="field"><span>Heading</span><input class="input" id="te-heading" value="${esc(tpl.heading)}"></label>
      <label class="field"><span>Body</span><textarea class="input" id="te-body" style="min-height:120px;">${esc(tpl.body)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>CTA text</span><input class="input" id="te-cta-text" value="${esc(tpl.cta_text)}"></label>
        <label class="field"><span>CTA URL</span><input class="input" id="te-cta-url" value="${esc(tpl.cta_url)}"></label>
      </div>
      <label class="field"><span>Footer note</span><input class="input" id="te-footer" value="${esc(tpl.footer_text)}"></label>
      <div class="field"><span>Placeholders (click to copy)</span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${TEMPLATE_VARS.map(v => `<button class="btn btn-sm btn-outline mono" data-var="${esc(v)}">${esc(v)}</button>`).join('')}
        </div></div>
      <div class="field"><span>Live preview</span>
        <div class="filters" style="margin-bottom:8px;"><button class="btn btn-sm btn-primary" id="te-refresh">↻ Refresh preview</button></div>
        <iframe class="preview-frame" id="te-preview"></iframe></div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="te-save">Save template</button>`,
    onMount(ov, close) {
      const loadPreview = async () => {
        const p = await api(`/templates/${key}/preview`, {
          method: 'POST',
          body: { vars: { subject: $('#te-subject', ov).value, heading: $('#te-heading', ov).value, body: $('#te-body', ov).value, cta_text: $('#te-cta-text', ov).value, cta_url: $('#te-cta-url', ov).value, footer_text: $('#te-footer', ov).value } },
        });
        $('#te-preview', ov).srcdoc = p.html;
      };
      $('#te-refresh', ov).addEventListener('click', loadPreview);
      loadPreview();
      $$('[data-var]', ov).forEach(b => b.addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.var);
        toast(`Copied ${b.dataset.var}`, 'success', 1600);
      }));
      $('#te-save', ov).addEventListener('click', async () => {
        await api(`/templates/${key}`, {
          method: 'PUT',
          body: { subject: $('#te-subject', ov).value, heading: $('#te-heading', ov).value, body: $('#te-body', ov).value, cta_text: $('#te-cta-text', ov).value, cta_url: $('#te-cta-url', ov).value, footer_text: $('#te-footer', ov).value },
        });
        toast('Template saved.', 'success');
        close(); App.navigate();
      });
    },
  });
}

/* ═══ Settings (admin) ═════════════════════════════════════════════════════ */
App.register('settings', {
  adminOnly: true,
  async render(view, parts, qs) {
    const s = await api('/settings');
    const tab = qs.get('tab') || 'reminders';
    const tabBtn = (key, label) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`;
    view.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p>Reminders, notification channels, admin alerts and integrations — all Admin-owned</p></div></div>
      <div class="tabs">
        ${tabBtn('reminders', '⏰ Reminders')}
        ${tabBtn('notifications', '🎛 Notification Control')}
        ${tabBtn('admin', '🛡 Admin Alerts')}
        ${tabBtn('integrations', '🔌 Integrations')}
      </div>
      <div id="settings-body"></div>`;
    $$('.tab', view).forEach(b => b.addEventListener('click', () => { location.hash = `#/settings?tab=${b.dataset.tab}`; }));
    const body = $('#settings-body', view);

    if (tab === 'reminders') {
      const commonTzs = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];
      body.innerHTML = `
        <div class="grid grid-2">
          <div class="card card-pad">
            <h2>Reminder defaults</h2>
            <p class="muted small">No automatic daily reminders exist — a reminder exists only when an Admin adds one to a task.</p>
            <div class="field-row">
              <label class="field"><span>Agency time zone</span>
                <select class="input" id="rs-tz">
                  ${commonTzs.map(tz2 => `<option value="${tz2}" ${s.reminderSettings.timezone === tz2 ? 'selected' : ''}>${tz2}</option>`).join('')}
                  ${Intl.supportedValuesOf('timeZone').filter(tz2 => !commonTzs.includes(tz2)).map(tz2 => `<option value="${tz2}" ${s.reminderSettings.timezone === tz2 ? 'selected' : ''}>${tz2}</option>`).join('')}
                </select></label>
              <label class="field"><span>Default reminder time</span>
                <input type="time" class="input" id="rs-time" value="${esc(s.reminderSettings.defaultReminderTime)}"></label>
            </div>
            <button class="btn btn-gold" id="rs-save">Save reminder settings</button>
          </div>
          <div class="card card-pad">
            <h2>Night-shift friendly</h2>
            <div class="callout co-gold" style="margin-bottom:10px;"><span class="c-ico">🌙</span><div>
              Reminders fire at <b>exactly</b> the Admin-picked time in this timezone — 10:30&nbsp;PM stays 10:30&nbsp;PM.</div></div>
            <div class="callout co-red"><span class="c-ico">🚫</span><div>
              No daily summaries, no "you have no tasks today", no greetings. If nothing needs attention, nothing is sent.</div></div>
            <div class="hint" style="margin-top:10px;">Current agency time: <b>${esc(state.meta.nowInAgency.date)} ${esc(state.meta.nowInAgency.time)}</b> (${esc(s.reminderSettings.timezone)})</div>
          </div>
        </div>`;
      $('#rs-save', body).addEventListener('click', async () => {
        await api('/settings/reminderSettings', { method: 'PUT', body: { timezone: $('#rs-tz', body).value, defaultReminderTime: $('#rs-time', body).value } });
        toast('Reminder settings saved.', 'success');
        await App.loadMeta(); App.navigate();
      });
    }

    if (tab === 'notifications') {
      const evs = s.notificationSettings.events;
      const channels = ['whatsapp', 'email', 'in_app', 'push'];
      const chHead = { whatsapp: '🟢 WhatsApp', email: '✉️ Email', in_app: '🔔 In-App', push: '📱 Push' };
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h2>Channel control per event</h2><span class="sub">channels are independent — Mobile Push is reserved for the future app</span></div>
          <div class="table-wrap"><table class="tbl matrix">
            <tr><th>Event</th>${channels.map(c2 => `<th>${chHead[c2]}</th>`).join('')}</tr>
            ${Object.entries(state.meta.events).map(([key, label]) => `
              <tr>
                <td class="m-row-label">${esc(label)}${(s.notificationSettings.criticalEvents || []).includes(key) ? ' <span class="badge b-high">critical</span>' : ''}</td>
                ${channels.map(c2 => `
                  <td><label class="switch"><input type="checkbox" data-ev="${key}" data-ch="${c2}" ${evs[key] && evs[key][c2] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
              </tr>`).join('')}
          </table></div>
          <div class="card-pad" style="border-top:1px solid var(--line);">
            <label class="check" style="font-weight:600;"><input type="checkbox" id="nc-override" ${s.notificationSettings.adminOverrideCritical ? 'checked' : ''}>
              🛡 Override member preferences for critical events</label>
            <label class="check" style="font-weight:600;"><input type="checkbox" id="nc-prev" ${s.notificationSettings.notifyPreviousAssigneeOnReassign ? 'checked' : ''}>
              ↩️ Also notify the previous assignee on reassignment</label>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
              <button class="btn btn-gold" id="nc-save">Save notification control</button>
            </div>
          </div>
        </div>
        <div class="card card-pad" style="margin-top:16px;">
          <div class="callout co-info"><span class="c-ico">📱</span><div>
            <b>Mobile Push</b> rows create the notification record with channel = <span class="mono">push</span> — the future mobile app will deliver them without any change to the task system. Keep it off until the app exists.</div></div>
        </div>`;
      $('#nc-save', body).addEventListener('click', async () => {
        const events = {};
        $$('[data-ev]', body).forEach(cbEl => {
          events[cbEl.dataset.ev] = events[cbEl.dataset.ev] || {};
          events[cbEl.dataset.ev][cbEl.dataset.ch] = cbEl.checked;
        });
        await api('/settings/notificationSettings', {
          method: 'PUT',
          body: { ...s.notificationSettings, events, adminOverrideCritical: $('#nc-override', body).checked, notifyPreviousAssigneeOnReassign: $('#nc-prev', body).checked },
        });
        toast('Notification control saved.', 'success');
        App.navigate();
      });
    }

    if (tab === 'admin') {
      const a = s.adminNotify;
      const row = (key, label, note) => `
        <tr><td class="m-row-label">${label}<div class="t-sub">${note}</div></td>
        ${['email', 'in_app'].map(c2 => `<td><label class="switch"><input type="checkbox" data-an="${key}" data-ch="${c2}" ${a[key][c2] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}</tr>`;
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h2>Admin alert preferences</h2><span class="sub">all configurable</span></div>
          <div class="table-wrap"><table class="tbl matrix">
            <tr><th>Alert</th><th>✉️ Email</th><th>🔔 In-App</th></tr>
            ${row('onTaskCompleted', 'Notify me when a task is completed', 'sent to all admins')}
            ${row('onTaskOverdue', 'Notify me when a task becomes overdue', 'one alert per task, never repeated')}
            ${row('onTaskComment', 'Notify me when a team member comments', 'member comments only')}
            ${row('onProjectUpdate', 'Send me a copy of project updates', 'copies of posted updates')}
            ${row('onWhatsAppFailed', 'Notify me when a WhatsApp notification fails', 'includes a Retry action')}
          </table></div>
          <div class="card-pad" style="border-top:1px solid var(--line);display:flex;justify-content:flex-end;">
            <button class="btn btn-gold" id="an-save">Save admin alerts</button>
          </div>
        </div>`;
      $('#an-save', body).addEventListener('click', async () => {
        const out = structuredClone(s.adminNotify);
        $$('[data-an]', body).forEach(cbEl => { out[cbEl.dataset.an][cbEl.dataset.ch] = cbEl.checked; });
        await api('/settings/adminNotify', { method: 'PUT', body: out });
        toast('Admin alerts saved.', 'success');
        App.navigate();
      });
    }

    if (tab === 'integrations') {
      const it = s.integrationSettings;
      body.innerHTML = `
        <div class="grid grid-2">
          <div class="card card-pad">
            <h2>Workspace</h2>
            <label class="field"><span>App URL (email CTAs)</span><input class="input" id="in-appurl" value="${esc(it.appUrl)}"></label>
            <label class="field"><span>Website URL (email footer)</span><input class="input" id="in-weburl" value="${esc(it.websiteUrl)}"></label>
            <label class="field"><span>Admin display name</span><input class="input" id="in-adminname" value="${esc(it.adminName)}"></label>
            <button class="btn btn-gold" id="in-save">Save workspace</button>
            <div class="callout co-green" style="margin-top:14px;"><span class="c-ico">🛡</span><div>
              <b>Fail-safe:</b> delivery failures never break task management — they're logged with a Retry button.</div></div>
          </div>
          <div>
            <div class="card card-pad" style="margin-bottom:16px;">
              <h2>WhatsApp</h2>
              <p class="muted small"><b>${it.whatsapp.mode === 'cloud_api' && s.whatsappConfigured ? 'Meta WhatsApp Cloud API' : 'simulation mode'}</b>
                ${s.whatsappConfigured ? '<span class="badge b-sent">credentials set</span>' : '<span class="badge b-pending">not configured</span>'}</p>
              <label class="field"><span>Mode</span>
                <select class="input" id="in-wa-mode">
                  <option value="simulation" ${it.whatsapp.mode !== 'cloud_api' ? 'selected' : ''}>Simulation (log only)</option>
                  <option value="cloud_api" ${it.whatsapp.mode === 'cloud_api' ? 'selected' : ''}>Meta WhatsApp Cloud API</option>
                </select></label>
              <label class="field"><span>Phone Number ID</span><input class="input" id="in-wa-pid" value="${esc(it.whatsapp.phoneNumberId)}"></label>
              <label class="field"><span>API token ${it.whatsapp.hasApiToken ? '<span class="badge b-sent">saved — leave blank to keep</span>' : ''}</span>
                <input class="input" id="in-wa-token" type="password" placeholder="${it.whatsapp.hasApiToken ? '•••••••• (stored)' : 'EAAG…'}"></label>
              <label class="check"><input type="checkbox" id="in-wa-fail" ${it.whatsapp.simulateFailures ? 'checked' : ''}> Simulate failures (test Retry flow)</label>
            </div>
            <div class="card card-pad">
              <h2>Email (SMTP)</h2>
              <p class="muted small"><b>${it.email.mode === 'smtp' && s.emailConfigured ? 'SMTP delivery' : 'simulation mode'}</b>
                ${s.emailConfigured ? '<span class="badge b-sent">configured</span>' : '<span class="badge b-pending">not configured</span>'}
                ${s.nodemailerInstalled ? '' : '<span class="badge b-failed">nodemailer missing</span>'}</p>
              <div class="field-row">
                <label class="field"><span>SMTP host</span><input class="input" id="in-em-host" value="${esc(it.email.smtpHost)}" placeholder="smtp.gmail.com"></label>
                <label class="field"><span>Port</span><input class="input" id="in-em-port" value="${esc(it.email.smtpPort)}"></label>
              </div>
              <label class="check"><input type="checkbox" id="in-em-secure" ${it.email.smtpSecure ? 'checked' : ''}> Use implicit TLS (port 465). Unchecked = STARTTLS (587)</label>
              <div class="field-row" style="margin-top:8px;">
                <label class="field"><span>Username</span><input class="input" id="in-em-user" value="${esc(it.email.smtpUser)}"></label>
                <label class="field"><span>Password ${it.email.smtpHasPassword ? '<span class="badge b-sent">saved — leave blank to keep</span>' : ''}</span>
                  <input class="input" id="in-em-pass" type="password" placeholder="${it.email.smtpHasPassword ? '•••••••• (stored)' : ''}"></label>
              </div>
              <div class="field-row">
                <label class="field"><span>From name</span><input class="input" id="in-em-fromname" value="${esc(it.email.fromName)}"></label>
                <label class="field"><span>From email</span><input class="input" id="in-em-from" value="${esc(it.email.fromEmail)}"></label>
              </div>
              <div class="hint">Credentials stay on the server — the browser never receives them. Env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) are used as initial defaults.</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
                <button class="btn btn-outline" id="in-test-smtp">🔌 Test SMTP Connection</button>
                <button class="btn btn-outline" id="in-test-email">✉️ Send Test Email</button>
              </div>
              <div id="smtp-result" style="margin-top:10px;"></div>
              <div style="margin-top:10px;"><button class="btn btn-gold" id="in-save2">Save integrations</button></div>
            </div>
          </div>
        </div>`;

      const collect = () => {
        const out = structuredClone(it);
        out.appUrl = $('#in-appurl', body).value.trim();
        out.websiteUrl = $('#in-weburl', body).value.trim();
        out.adminName = $('#in-adminname', body).value.trim();
        out.whatsapp.mode = $('#in-wa-mode', body).value;
        out.whatsapp.phoneNumberId = $('#in-wa-pid', body).value.trim();
        out.whatsapp.apiToken = $('#in-wa-token', body).value.trim(); // empty → server keeps stored
        out.whatsapp.simulateFailures = $('#in-wa-fail', body).checked;
        out.email.smtpHost = $('#in-em-host', body).value.trim();
        out.email.mode = out.email.smtpHost ? 'smtp' : 'simulation';
        out.email.smtpPort = Number($('#in-em-port', body).value) || 587;
        out.email.smtpSecure = $('#in-em-secure', body).checked;
        out.email.smtpUser = $('#in-em-user', body).value.trim();
        out.email.smtpPass = $('#in-em-pass', body).value; // empty → server keeps stored
        out.email.fromName = $('#in-em-fromname', body).value.trim();
        out.email.fromEmail = $('#in-em-from', body).value.trim();
        out.email.simulateFailures = false;
        return out;
      };
      $('#in-save', body).addEventListener('click', async () => {
        await api('/settings/integrationSettings', { method: 'PUT', body: collect() });
        toast('Workspace saved.', 'success');
      });
      $('#in-save2', body).addEventListener('click', async () => {
        await api('/settings/integrationSettings', { method: 'PUT', body: collect() });
        toast('Integrations saved. You can now test the connection.', 'success');
        App.navigate();
      });
      $('#in-test-smtp', body).addEventListener('click', async () => {
        const out = $('#smtp-result', body);
        out.innerHTML = '<span class="muted small">Testing…</span>';
        // save first so the test uses what's on screen
        await api('/settings/integrationSettings', { method: 'PUT', body: collect() });
        const r = await api('/settings/test-smtp', {
          method: 'POST',
          body: {
            smtpHost: $('#in-em-host', body).value.trim(),
            smtpPort: Number($('#in-em-port', body).value) || 587,
            smtpSecure: $('#in-em-secure', body).checked,
            smtpUser: $('#in-em-user', body).value.trim(),
            smtpPass: $('#in-em-pass', body).value,
            fromEmail: $('#in-em-from', body).value.trim(),
          },
        }).catch(e => ({ ok: false, message: e.message }));
        out.innerHTML = `<div class="callout ${r.ok ? 'co-green' : 'co-red'}"><span class="c-ico">${r.ok ? '✓' : '✗'}</span><div>${esc(r.message)}</div></div>`;
      });
      $('#in-test-email', body).addEventListener('click', async () => {
        const out = $('#smtp-result', body);
        const to = $('#in-em-user', body).value.trim() || $('#in-em-from', body).value.trim();
        if (!to) { toast('Enter an SMTP username or from-address to send the test to', 'error'); return; }
        out.innerHTML = '<span class="muted small">Sending…</span>';
        await api('/settings/integrationSettings', { method: 'PUT', body: collect() });
        const r = await api('/settings/send-test-email', { method: 'POST', body: { to } }).catch(e => ({ error: e.message }));
        out.innerHTML = r.ok
          ? `<div class="callout co-green"><span class="c-ico">✓</span><div>${esc(r.message)} — check the inbox (and spam folder).</div></div>`
          : `<div class="callout co-red"><span class="c-ico">✗</span><div>${esc(r.error || 'Failed')}</div></div>`;
      });
    }
  },
});
})();
