'use strict';
/* ─── Views ──────────────────────────────────────────────────────────────── */
(() => {
const { api, esc, toast, modal, confirmDialog, state, $, $$ } = App;
const pb = App.priorityBadge, sb = App.statusBadge, cb = App.channelBadge;

const QUIET_NOTE = `The system stays silent unless something important happens — no daily digests, no "you have no tasks" messages, no greetings. Notifications are only sent for: task assignment, an Admin-scheduled reminder, reassignment, an Admin-posted project update, and Admin-enabled status alerts.`;

/* ═══ Dashboard ════════════════════════════════════════════════════════════ */
App.register('dashboard', {
  async render(view) {
    const d = await api('/dashboard');
    const isAdmin = state.user.role === 'admin';
    const stat = (ico, bg, val, label) => `
      <div class="card stat"><div class="s-ico" style="background:${bg};">${ico}</div>
        <div><div class="s-val">${val}</div><div class="s-label">${label}</div></div></div>`;
    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${App.state.user.role === 'admin' ? 'Agency overview' : 'My workspace'}</h1>
          <p>Agency timezone: <b>${esc(d.agencyTz)}</b> · night-shift friendly · event-based notifications only</p>
        </div>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="new-task-btn">＋ New Task</button>' : ''}
      </div>
      <div class="grid grid-4" style="margin-bottom:18px;">
        ${stat('📋', 'var(--blue-soft)', d.stats.open_tasks, 'Open tasks')}
        ${stat('📅', 'var(--gold-soft)', d.stats.due_today, 'Due today')}
        ${stat('🔥', 'var(--red-soft)', d.stats.overdue, 'Overdue')}
        ${stat('✅', 'var(--green-soft)', d.stats.completed_week, 'Completed this week')}
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>${isAdmin ? 'Upcoming reminders' : 'My open tasks'}</h2>
            <span class="sub">${isAdmin ? 'each one was explicitly scheduled by an Admin' : 'assigned to you'}</span></div>
          ${isAdmin ? (
            d.upcoming.length ? d.upcoming.map(r => `
              <div class="task-row">
                <div class="task-main">
                  <div class="task-title">⏰ ${esc(r.task_title)}</div>
                  <div class="task-meta">
                    <span class="tm">👤 ${esc(r.assignee_name || 'Unassigned')}</span>
                    <span class="tm">🕒 fires ${esc(r.remind_display)}</span>
                  </div>
                </div>
              </div>`).join('') : '<div class="empty"><b>No reminders scheduled</b>Reminders only exist when an Admin schedules them on a task.</div>'
          ) : (
            d.myTasks.length ? d.myTasks.map(t => taskRow(t, { compact: true })).join('') : '<div class="empty"><b>Nothing assigned to you</b>You will be notified on WhatsApp and email when a new task arrives.</div>'
          )}
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent notification activity</h2><span class="sub">full log in ${isAdmin ? 'Notification History' : 'your bell menu'}</span></div>
          ${d.recent.length ? `
            <div class="table-wrap"><table class="tbl">
              <tr><th>When</th><th>Type</th><th>Channel</th><th>Status</th></tr>
              ${d.recent.map(r => `
                <tr>
                  <td>${esc(r.when_display)}<div class="t-sub">${esc(r.recipient_label || '')}</div></td>
                  <td>${esc(({ task_assigned: 'Task Assigned', task_reminder: 'Task Reminder', task_reassigned: 'Task Reassigned', project_update: 'Project Update', task_completed: 'Task Completed', task_overdue: 'Task Overdue', task_comment: 'Task Comment', whatsapp_failed: 'WhatsApp Failed' })[r.event_type] || r.event_type)}</td>
                  <td>${cb(r.channel)}</td>
                  <td>${sb(r.status)}${r.status === 'skipped' && r.status_reason ? `<div class="t-sub">${esc(r.status_reason)}</div>` : ''}</td>
                </tr>`).join('')}
            </table></div>` : '<div class="empty"><b>No notifications yet</b>' + esc(QUIET_NOTE) + '</div>'}
        </div>
      </div>
      <div class="card card-pad" style="margin-top:18px;">
        <div class="callout co-gold"><span class="c-ico">🌙</span><div>
          <b>Quiet by design.</b> ${esc(QUIET_NOTE)}
        </div></div>
      </div>`;
    const nt = $('#new-task-btn', view);
    if (nt) nt.addEventListener('click', () => taskFormModal());
  },
});

/* ═══ Tasks ════════════════════════════════════════════════════════════════ */
function taskRow(t, opts = {}) {
  const overdue = t.status === 'open' && t.due_at && t.due_at < new Date().toISOString();
  return `
    <div class="task-row" data-task="${t.id}" ${opts.compact ? '' : 'style="cursor:pointer;"'}>
      <div class="task-main">
        <div class="task-title ${t.status === 'completed' ? 'done' : ''}">${esc(t.title)}</div>
        <div class="task-meta">
          ${t.client_name ? `<span class="tm">🏢 ${esc(t.client_name)}</span>` : ''}
          ${t.project_name ? `<span class="tm">📁 ${esc(t.project_name)}</span>` : ''}
          <span class="tm">👤 ${esc(t.assignee_name || 'Unassigned')}</span>
          ${t.due_display ? `<span class="tm" style="${overdue ? 'color:var(--red);font-weight:700;' : ''}">📅 ${overdue ? 'Overdue · was due ' : 'Due '}${esc(t.due_display)}</span>` : ''}
          ${pb(t.priority)}
          ${sb(t.status)}
        </div>
      </div>
      <div class="task-actions">
        ${t.status === 'open' && !opts.compact ? `<button class="btn btn-sm btn-gold" data-complete="${t.id}">✓ Complete</button>` : ''}
      </div>
    </div>`;
}

App.register('tasks', {
  async render(view, parts, qs) {
    const params = new URLSearchParams();
    if (qs.get('status')) params.set('status', qs.get('status'));
    const tab = qs.get('status') || 'open';
    const tasks = await api(`/tasks?${params}`);
    const isAdmin = state.user.role === 'admin';
    const tabBtn = (key, label) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Tasks</h1><p>Assignments, reminders and deadlines — agency timezone ${esc(state.meta.agencyTz)}</p></div>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="new-task-btn">＋ New Task</button>' : ''}
      </div>
      <div class="tabs">
        ${tabBtn('open', 'Open')}
        ${tabBtn('overdue', 'Overdue')}
        ${tabBtn('completed', 'Completed')}
        ${tabBtn('all', 'All')}
      </div>
      <div class="card" id="task-list">
        ${tasks.length ? tasks.map(t => taskRow(t)).join('') : `<div class="empty"><b>No tasks here</b>${esc(tab === 'open' ? 'When a task is assigned, the assignee is notified on their enabled channels.' : 'Nothing matches this filter.')}</div>`}
      </div>`;
    $$('.tab', view).forEach(b => b.addEventListener('click', () => { location.hash = `#/tasks?status=${b.dataset.tab}`; }));
    $$('#task-list .task-row', view).forEach(row => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-complete]')) return;
      location.hash = `#/tasks/${row.dataset.task}`;
    }));
    $$('[data-complete]', view).forEach(btn => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const d = await api(`/tasks/${btn.dataset.complete}/complete`, { method: 'POST' });
      toast('Task completed — pending reminders were cancelled so none will fire.', 'success');
      App.navigate();
    }));
    const nt = $('#new-task-btn', view);
    if (nt) nt.addEventListener('click', () => taskFormModal());
  },
});

/* ─── Task create/edit modal with per-task reminder UI (§21) ─────────────── */
async function taskFormModal(taskId) {
  const meta = state.meta;
  const isEdit = !!taskId;
  let task = null, reminders = [], existingProcessed = 0;
  if (isEdit) {
    const d = await api(`/tasks/${taskId}`);
    task = d.task; reminders = d.reminders.filter(r => !r.processed_at);
    existingProcessed = d.reminders.filter(r => r.processed_at).length;
  }
  let defRemTime = '22:00';
  try {
    const s = await api('/settings');
    if (s && s.reminderSettings && s.reminderSettings.defaultReminderTime) defRemTime = s.reminderSettings.defaultReminderTime;
  } catch { /* fall back to 22:00 */ }

  const todayStr = new Date().toISOString().slice(0, 10);
  const remRow = (r = {}) => `
    <div class="rem-pill" data-rem>
      <span>⏰</span>
      <input type="date" class="input" style="width:150px;" data-rem-date value="${esc(r.date || todayStr)}">
      <input type="time" class="input" style="width:110px;" data-rem-time value="${esc(r.time || defRemTime)}">
      <span class="small muted">exactly at this time (${esc(state.meta.agencyTz)})</span>
      <button class="rp-x" data-rem-x title="Remove reminder">✕</button>
    </div>`;

  const dueDate = (task && task.due_date_part) || '';
  const dueTime = (task && task.due_time_part) || '';
  App.modal({
    title: isEdit ? 'Edit Task' : 'New Task',
    wide: true,
    body: `
      <label class="field"><span>Task title *</span>
        <input class="input" id="tf-title" value="${esc(task ? task.title : '')}" placeholder="e.g. Create Facebook Post"></label>
      <label class="field"><span>Description</span>
        <textarea class="input" id="tf-desc" placeholder="What exactly needs to be done?">${esc(task ? task.description : '')}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Client</span>
          <select class="input" id="tf-client"><option value="">— None —</option>
            ${meta.clients.map(c => `<option value="${c.id}" ${task && task.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Project</span>
          <select class="input" id="tf-project"><option value="">— None —</option>
            ${meta.projects.map(p => `<option value="${p.id}" data-client="${p.client_id}" ${task && task.project_id === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.client_name)})</option>`).join('')}
          </select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Assign to *</span>
          <select class="input" id="tf-assignee"><option value="">— Unassigned —</option>
            ${meta.members.filter(m => m.active).map(m => `<option value="${m.id}" ${task && task.assignee_id === m.id ? 'selected' : ''}>${esc(m.name)} — ${esc(m.title || 'Team Member')}</option>`).join('')}
          </select></label>
        <label class="field"><span>Priority</span>
          <select class="input" id="tf-priority">
            ${['Low', 'Medium', 'High', 'Urgent'].map(p => `<option ${task && task.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Due date</span>
          <input type="date" class="input" id="tf-due-date" value="${esc(dueDate)}"></label>
        <label class="field"><span>Due time (${esc(state.meta.agencyTz)})</span>
          <input type="time" class="input" id="tf-due-time" value="${esc(dueTime)}"></label>
      </div>
      <div class="callout co-info" style="margin-bottom:14px;"><span class="c-ico">🌙</span>
        <div>Times are in the agency timezone (<b>${esc(state.meta.agencyTz)}</b>). Night hours are respected exactly — nothing is shifted to business hours.</div></div>

      <div style="border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:4px;">
        <label class="check" style="font-weight:700;"><input type="checkbox" id="tf-reminders-on" ${reminders.length ? 'checked' : ''}>
          Enable reminder(s)</label>
        <div class="hint" style="margin-bottom:10px;">The reminder fires <b>exactly</b> at the date &amp; time you pick — only if the task is still open at that moment. Completed tasks never get reminders. No automatic daily reminders exist.</div>
        <div id="tf-reminders" class="${reminders.length ? '' : 'hidden'}">
          <div id="tf-rem-list">${reminders.length ? reminders.map(r => remRow({ date: r.date_part, time: r.time_part })).join('') : remRow()}</div>
          <button class="btn btn-sm btn-outline" id="tf-rem-add">＋ Add another reminder</button>
          ${existingProcessed ? `<div class="hint">ℹ️ ${existingProcessed} earlier reminder(s) already fired or were skipped and are kept in history.</div>` : ''}
          <div class="hint">💡 Multiple reminders (e.g. night before + 2 hours before) are supported — only the ones you add here will be sent, in the agency timezone.</div>
        </div>
      </div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button>
           <button class="btn btn-gold" id="tf-save">${isEdit ? 'Save changes' : 'Create task & notify'}</button>`,
    onMount(ov, close) {
      const remOn = $('#tf-reminders-on', ov);
      const remWrap = $('#tf-reminders', ov);
      remOn.addEventListener('change', () => remWrap.classList.toggle('hidden', !remOn.checked));
      $('#tf-rem-add', ov).addEventListener('click', () => $('#tf-rem-list', ov).insertAdjacentHTML('beforeend', remRow()));
      $('#tf-rem-list', ov).addEventListener('click', (e) => {
        if (e.target.closest('[data-rem-x]')) e.target.closest('[data-rem]').remove();
      });
      // project selection auto-picks its client
      $('#tf-project', ov).addEventListener('change', (e) => {
        const opt = e.target.selectedOptions[0];
        if (opt && opt.dataset.client) $('#tf-client', ov).value = opt.dataset.client;
      });
      if (task && task.due_at) {
        // due time is prefilled from the API-rendered agency-timezone parts (dueTime)
        $('#tf-due-time', ov).value = dueTime;
      }
      $('#tf-save', ov).addEventListener('click', async () => {
        const title = $('#tf-title', ov).value.trim();
        if (!title) { toast('Task title is required', 'error'); return; }
        const assignee = $('#tf-assignee', ov).value || null;
        const payload = {
          title,
          description: $('#tf-desc', ov).value,
          client_id: $('#tf-client', ov).value || null,
          project_id: $('#tf-project', ov).value || null,
          assignee_id: assignee,
          priority: $('#tf-priority', ov).value,
          due_date: $('#tf-due-date', ov).value || null,
          due_time: $('#tf-due-time', ov).value || null,
        };
        if (remOn.checked) {
          payload.reminders = $$('[data-rem]', ov).map(row => ({
            date: $('[data-rem-date]', row).value,
            time: $('[data-rem-time]', row).value,
          })).filter(r => r.date && r.time);
        } else {
          payload.reminders = [];
        }
        try {
          let d;
          if (isEdit) {
            d = await api(`/tasks/${taskId}`, { method: 'PATCH', body: payload });
            toast(d.queued ? `Saved — reassignment notification queued (${d.queued} message${d.queued > 1 ? 's' : ''}).` : 'Task saved.', 'success');
          } else {
            d = await api('/tasks', { method: 'POST', body: payload });
            toast(d.queued
              ? `Task created — assignment notification sent (${d.queued} message${d.queued > 1 ? 's' : ''}).`
              : 'Task created (no assignee — nothing notified).', 'success');
          }
          close();
          App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

/* ═══ Task detail ══════════════════════════════════════════════════════════ */
App.register('tasks_detail', {
  async render(view, parts) {
    const id = parts[0];
    let d;
    try { d = await api(`/tasks/${id}`); }
    catch (e) { view.innerHTML = `<div class="empty"><b>Cannot open task</b>${esc(e.message)}</div>`; return; }
    const t = d.task;
    const overdue = t.status === 'open' && t.due_at && t.due_at < new Date().toISOString();
    const isAdmin = state.user.role === 'admin';
    const canComplete = t.status === 'open' && (isAdmin || state.user.id === t.assignee_id);
    view.innerHTML = `
      <div class="page-head">
        <button class="btn btn-outline btn-sm" id="back-btn">← Back</button>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-outline" id="edit-btn">✎ Edit</button>' : ''}
        ${canComplete ? '<button class="btn btn-gold" id="complete-btn">✓ Mark completed</button>' : ''}
      </div>
      <div class="grid grid-2">
        <div class="card card-pad">
          <h2>${esc(t.title)} ${sb(t.status)}</h2>
          <p class="muted small" style="margin:4px 0 16px;">${overdue ? '🔥 This task is <b>overdue</b> — it passed its due time and is still open.' : ''}</p>
          <div class="kv">
            <div class="k">Client</div><div>${esc(t.client_name || '—')}</div>
            <div class="k">Project</div><div>${esc(t.project_name || '—')}</div>
            <div class="k">Assigned to</div><div>${esc(t.assignee_name || 'Unassigned')}</div>
            <div class="k">Priority</div><div>${pb(t.priority)}</div>
            <div class="k">Due</div><div>${esc(t.due_display || '—')}${t.due_display ? ` <span class="muted small">(${esc(d.agencyTz)})</span>` : ''}</div>
            ${t.completed_at ? `<div class="k">Completed</div><div>${esc(t.completed_at)}</div>` : ''}
          </div>
          ${t.description ? `<div style="margin-top:16px;"><div class="k muted small" style="font-weight:700;">DESCRIPTION</div><p style="font-size:14px;line-height:1.6;white-space:pre-line;margin:6px 0 0;">${esc(t.description)}</p></div>` : ''}
        </div>
        <div>
          <div class="card card-pad" style="margin-bottom:16px;">
            <h2>Reminders</h2>
            <p class="muted small" style="margin:2px 0 12px;">Each reminder fires once, exactly at its scheduled time — if the task is still open. Nothing fires automatically.</p>
            ${d.reminders.length ? d.reminders.map(r => `
              <div class="rem-pill ${r.processed_at ? 'fired' : ''}">
                <span>${r.processed_at ? (r.skip_reason ? '🚫' : '✅') : '⏰'}</span>
                <div>
                  <div>${esc(r.remind_display)} <span class="muted small">(${esc(d.agencyTz)})</span></div>
                  <div class="small ${r.skip_reason ? '' : 'muted'}" style="color:${r.skip_reason ? 'var(--red)' : ''};">${r.processed_at ? esc(r.skip_reason || 'Sent') : 'Scheduled — waiting for the exact time'}</div>
                </div>
              </div>`).join('') : '<div class="empty" style="padding:18px;"><b>No reminders</b>An Admin did not schedule a reminder for this task.</div>'}
          </div>
          <div class="card card-pad">
            <h2>Comments</h2>
            <div id="comments">
              ${d.comments.length ? d.comments.map(c => `
                <div class="comment">
                  <div class="avatar" style="width:30px;height:30px;font-size:12px;">${esc(App.initials(c.author_name))}</div>
                  <div>
                    <div class="c-body ${c.important ? 'important' : ''}">${esc(c.body)}${c.important ? ' <span class="badge b-high">IMPORTANT</span>' : ''}</div>
                    <div class="c-meta">${esc(c.author_name)} · ${esc(App.fmtWhen(c.created_at))}</div>
                  </div>
                </div>`).join('') : '<p class="muted small">No comments yet.</p>'}
            </div>
            <textarea class="input" id="comment-body" placeholder="Write a comment…"></textarea>
            <div style="display:flex;align-items:center;gap:12px;margin-top:8px;">
              <label class="check"><input type="checkbox" id="comment-important"> Mark as important</label>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" id="comment-btn">Comment</button>
            </div>
            <div class="hint">ℹ️ When a <b>team member</b> comments, admins are notified (if enabled in Settings → Admin Alerts). Marking a comment important doesn\'t spam anyone extra.</div>
          </div>
        </div>
      </div>`;
    $('#back-btn', view).addEventListener('click', () => history.back());
    const edit = $('#edit-btn', view);
    if (edit) edit.addEventListener('click', () => taskFormModal(String(t.id)));
    const complete = $('#complete-btn', view);
    if (complete) complete.addEventListener('click', async () => {
      const ok = await confirmDialog('Complete this task?', 'Pending reminders for this task will be cancelled and will NOT be sent. Admins subscribed to completion alerts will be notified.', 'Complete task');
      if (!ok) return;
      await api(`/tasks/${t.id}/complete`, { method: 'POST' });
      toast('Task completed — pending reminders cancelled.', 'success');
      App.navigate();
    });
    $('#comment-btn', view).addEventListener('click', async () => {
      const body = $('#comment-body', view).value.trim();
      if (!body) return;
      await api(`/tasks/${t.id}/comments`, { method: 'POST', body: { body, important: $('#comment-important', view).checked } });
      toast('Comment added.', 'success');
      App.navigate();
    });
  },
});

/* ═══ Projects ═════════════════════════════════════════════════════════════ */
App.register('projects', {
  async render(view) {
    const projects = await api('/projects');
    const isAdmin = state.user.role === 'admin';
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Projects</h1><p>Client projects and their updates</p></div>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="new-proj-btn">＋ New Project</button>' : ''}
      </div>
      <div class="grid grid-3">
        ${projects.map(p => `
          <div class="card card-pad rowlink" style="cursor:pointer;" data-open="${p.id}">
            <div class="muted small">🏢 ${esc(p.client_name)}</div>
            <h2 style="margin:6px 0 8px;">${esc(p.name)}</h2>
            <div style="display:flex;gap:8px;margin-bottom:10px;">
              <span class="badge ${p.status === 'active' ? 'b-open' : p.status === 'completed' ? 'b-completed' : 'b-neutral'}">${esc(p.status)}</span>
              <span class="badge b-neutral">${p.open_tasks} open · ${p.completed_tasks} done</span>
            </div>
            <p class="muted small" style="margin:0;min-height:34px;">${esc((p.description || '').slice(0, 110))}${(p.description || '').length > 110 ? '…' : ''}</p>
          </div>`).join('')}
      </div>
      ${!projects.length ? '<div class="empty"><b>No projects yet</b>Create a client first, then add a project.</div>' : ''}`;
    $$('[data-open]', view).forEach(el => el.addEventListener('click', () => { location.hash = `#/projects/${el.dataset.open}`; }));
    const nb = $('#new-proj-btn', view);
    if (nb) nb.addEventListener('click', () => {
      const meta = state.meta;
      App.modal({
        title: 'New Project',
        body: `
          <label class="field"><span>Client *</span>
            <select class="input" id="pf-client">${meta.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Project name *</span><input class="input" id="pf-name" placeholder="e.g. Social Media Management"></label>
          <label class="field"><span>Description</span><textarea class="input" id="pf-desc"></textarea></label>`,
        foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="pf-save">Create project</button>`,
        onMount(ov, close) {
          $('#pf-save', ov).addEventListener('click', async () => {
            const name = $('#pf-name', ov).value.trim();
            if (!name) { toast('Project name is required', 'error'); return; }
            try {
              await api('/projects', { method: 'POST', body: { client_id: $('#pf-client', ov).value, name, description: $('#pf-desc', ov).value } });
              toast('Project created.', 'success'); close(); App.navigate();
            } catch (e) { toast(e.message, 'error'); }
          });
        },
      });
    });
  },
});

App.register('projects_detail', {
  async render(view, parts) {
    const id = parts[0];
    const d = await api(`/projects/${id}`);
    const isAdmin = state.user.role === 'admin';
    view.innerHTML = `
      <div class="page-head">
        <button class="btn btn-outline btn-sm" id="back-btn">← Back</button>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="update-btn">＋ Project Update</button>' : ''}
      </div>
      <div class="card card-pad" style="margin-bottom:16px;">
        <div class="muted small">🏢 ${esc(d.project.client_name)}</div>
        <h1 style="margin:4px 0 6px;">${esc(d.project.name)}</h1>
        <p class="muted" style="margin:0;font-size:13.5px;">${esc(d.project.description || '')}</p>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>Tasks</h2><span class="sub">${d.tasks.filter(t => t.status === 'open').length} open</span></div>
          ${d.tasks.length ? d.tasks.map(t => taskRow(t, { compact: false })).join('') : '<div class="empty"><b>No tasks</b>in this project yet</div>'}
        </div>
        <div class="card card-pad">
          <h2>Project updates</h2>
          <p class="muted small" style="margin:2px 0 14px;">Posted manually by admins — team members are only notified on the channels chosen for each update.</p>
          ${d.updates.length ? d.updates.map(u => `
            <div class="update-item">
              <div class="u-title">${esc(u.title)}</div>
              <div class="u-msg">${esc(u.message)}</div>
              <div class="u-meta">
                <span>👤 ${esc(u.created_by_name || 'Admin')}</span>
                <span>🕐 ${esc(u.created_at)}</span>
                ${u.send_whatsapp ? cb('whatsapp') : ''}${u.send_email ? cb('email') : ''}${u.send_inapp ? cb('in_app') : ''}
              </div>
            </div>`).join('') : '<div class="empty"><b>No updates yet</b>Use “＋ Project Update” to notify the team about something important.</div>'}
        </div>
      </div>`;
    $('#back-btn', view).addEventListener('click', () => { location.hash = '#/projects'; });
    $$('[data-task]', view).forEach(row => row.addEventListener('click', () => { location.hash = `#/tasks/${row.dataset.task}`; }));
    const ub = $('#update-btn', view);
    if (ub) ub.addEventListener('click', () => projectUpdateModal(d));
  },
});

/* §19 — Manual project update */
function projectUpdateModal(d) {
  const meta = state.meta;
  App.modal({
    title: '＋ Project Update',
    wide: true,
    body: `
      <div class="callout co-gold" style="margin-bottom:14px;"><span class="c-ico">📢</span>
        <div>Use this for <b>important</b> project news only. The update is sent <b>only</b> on the channels you tick below — nothing else is generated.</div></div>
      <label class="field"><span>Title *</span><input class="input" id="pu-title" placeholder="e.g. Client approved the new content strategy"></label>
      <label class="field"><span>Message *</span><textarea class="input" id="pu-msg" placeholder="What should the team know?"></textarea></label>
      <label class="field"><span>Attachments</span>
        <input class="input" type="text" disabled placeholder="Attachment support coming soon — link files in the message for now">
      </label>
      <div style="border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:12px;">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:4px;">Notify team members</div>
        <label class="check"><input type="checkbox" id="pu-wa"> 🟢 Send WhatsApp</label>
        <label class="check"><input type="checkbox" id="pu-email"> ✉️ Send Email</label>
        <label class="check"><input type="checkbox" id="pu-inapp" checked> 🔔 Send In-App notification</label>
        <div style="margin-top:8px;font-weight:600;font-size:13px;">Recipients</div>
        <div id="pu-recipients">
          ${meta.members.filter(m => m.active && m.role !== 'admin').map(m => `
            <label class="check"><input type="checkbox" checked data-rcpt value="${m.id}"> ${esc(m.name)} <span class="muted small">— ${esc(m.title || '')}</span></label>`).join('')}
        </div>
        <div class="hint">Only members on a task/project or selected here receive it — respecting each member's own notification preferences, and Admin overrides for critical events.</div>
      </div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button>
           <button class="btn btn-gold" id="pu-send">Post update & notify</button>`,
    onMount(ov, close) {
      $('#pu-send', ov).addEventListener('click', async () => {
        const title = $('#pu-title', ov).value.trim();
        const message = $('#pu-msg', ov).value.trim();
        if (!title || !message) { toast('Title and message are required', 'error'); return; }
        const recipient_ids = $$('[data-rcpt]', ov).filter(c => c.checked).map(c => Number(c.value));
        try {
          const res = await api(`/projects/${d.project.id}/updates`, {
            method: 'POST',
            body: {
              title, message, recipient_ids,
              send_whatsapp: $('#pu-wa', ov).checked,
              send_email: $('#pu-email', ov).checked,
              send_inapp: $('#pu-inapp', ov).checked,
            },
          });
          toast(res.queued
            ? `Update posted — ${res.queued} notification${res.queued > 1 ? 's' : ''} queued for delivery.`
            : 'Update posted (no channels selected — nothing was sent).', 'success');
          close(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

/* ═══ Clients ══════════════════════════════════════════════════════════════ */
App.register('clients', {
  async render(view) {
    const clients = await api('/clients');
    const isAdmin = state.user.role === 'admin';
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Clients</h1><p>${clients.length} active clients</p></div>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn btn-gold" id="new-client-btn">＋ New Client</button>' : ''}
      </div>
      <div class="card"><div class="table-wrap"><table class="tbl">
        <tr><th>Client</th><th>Contact</th><th>Email</th><th>Phone</th><th>Projects</th><th>Open tasks</th>${isAdmin ? '<th></th>' : ''}</tr>
        ${clients.map(c => `
          <tr>
            <td class="t-title">${esc(c.name)}${c.notes ? `<div class="t-sub">${esc(c.notes)}</div>` : ''}</td>
            <td>${esc(c.contact_person || '—')}</td>
            <td>${esc(c.email || '—')}</td>
            <td>${esc(c.phone || '—')}</td>
            <td>${c.project_count}</td>
            <td>${c.open_tasks}</td>
            ${isAdmin ? `<td><button class="btn btn-sm btn-outline" data-edit="${c.id}">✎ Edit</button></td>` : ''}
          </tr>`).join('')}
      </table></div></div>
      ${!clients.length ? '<div class="empty"><b>No clients yet</b>Add your first client to start creating projects and tasks.</div>' : ''}`;
    const nb = $('#new-client-btn', view);
    if (nb) nb.addEventListener('click', () => clientModal());
    $$('[data-edit]', view).forEach(b => b.addEventListener('click', () => {
      const c = clients.find(x => String(x.id) === b.dataset.edit);
      clientModal(c);
    }));
  },
});

function clientModal(c) {
  App.modal({
    title: c ? 'Edit Client' : 'New Client',
    body: `
      <label class="field"><span>Client name *</span><input class="input" id="cf-name" value="${esc(c ? c.name : '')}"></label>
      <div class="field-row">
        <label class="field"><span>Contact person</span><input class="input" id="cf-contact" value="${esc(c ? c.contact_person : '')}"></label>
        <label class="field"><span>Phone</span><input class="input" id="cf-phone" value="${esc(c ? c.phone : '')}"></label>
      </div>
      <label class="field"><span>Email</span><input class="input" id="cf-email" value="${esc(c ? c.email : '')}"></label>
      <label class="field"><span>Notes</span><textarea class="input" id="cf-notes">${esc(c ? c.notes : '')}</textarea></label>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="cf-save">${c ? 'Save' : 'Create client'}</button>`,
    onMount(ov, close) {
      $('#cf-save', ov).addEventListener('click', async () => {
        const body = {
          name: $('#cf-name', ov).value.trim(),
          contact_person: $('#cf-contact', ov).value,
          email: $('#cf-email', ov).value,
          phone: $('#cf-phone', ov).value,
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

/* ═══ My preferences (team member self-service, §14) ═══════════════════════ */
App.register('myprefs', {
  async render(view) {
    const me = state.user;
    const [prefs, settings] = await Promise.all([api(`/team/${me.id}/prefs`), api('/settings')]);
    const critical = settings.notificationSettings.criticalEvents || [];
    const override = settings.notificationSettings.adminOverrideCritical;
    const events = state.meta.events;
    view.innerHTML = `
      <div class="page-head"><div><h1>My notification preferences</h1>
        <p>Choose which events may reach you on each channel. The Admin can still override these for critical system notifications${override ? ' (currently enabled)' : ''}.</p></div></div>
      <div class="card"><div class="table-wrap"><table class="tbl matrix">
        <tr><th>Event</th><th>🟢 WhatsApp</th><th>✉️ Email</th><th>🔔 In-App</th></tr>
        ${Object.entries(events).map(([key, label]) => `
          <tr>
            <td class="m-row-label">${esc(label)} ${critical.includes(key) ? '<span class="badge b-high" title="Admin can override member preferences for this event">critical</span>' : ''}</td>
            ${['whatsapp', 'email', 'in_app'].map(ch => `
              <td><label class="switch"><input type="checkbox" data-ev="${key}" data-ch="${ch}" ${prefs[key] && prefs[key][ch] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
          </tr>`).join('')}
      </table></div>
      <div class="card-pad" style="border-top:1px solid var(--line);display:flex;justify-content:flex-end;">
        <button class="btn btn-gold" id="save-prefs">Save preferences</button>
      </div></div>
      <div class="card card-pad" style="margin-top:16px;">
        <div class="callout co-info"><span class="c-ico">🌙</span><div>
          You will never receive daily digests, "no tasks today" notes, greetings or motivational messages — regardless of these settings. Only real events reach you.</div></div>
      </div>`;
    $('#save-prefs', view).addEventListener('click', async () => {
      const body = {};
      $$('[data-ev]', view).forEach(cbEl => {
        const ev = cbEl.dataset.ev, ch = cbEl.dataset.ch;
        body[ev] = body[ev] || {};
        body[ev][ch] = cbEl.checked;
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
            <td class="t-title">
              <span style="display:inline-flex;align-items:center;gap:9px;">
                <span class="avatar" style="width:30px;height:30px;font-size:12px;">${esc(App.initials(u.name))}</span>
                <span>${esc(u.name)}<div class="t-sub">${esc(u.title || '')}</div></span>
              </span>
            </td>
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
          Every member needs an <b>email address</b> and, for WhatsApp alerts, a <b>phone number</b> on their profile. Notification preferences control which events reach them — Admins can override member preferences for critical events (Settings → Notification Control).</div></div>
      </div>`;
    $('#new-member-btn', view).addEventListener('click', () => memberModal());
    $$('[data-edit]', view).forEach(b => b.addEventListener('click', () => {
      const u = team.find(x => String(x.id) === b.dataset.edit);
      memberModal(u);
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
        <label class="field"><span>Role title</span><input class="input" id="mf-title" value="${esc(u ? u.title : '')}" placeholder="e.g. Social Media Manager"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Email address *</span><input type="email" class="input" id="mf-email" value="${esc(u ? u.email : '')}"></label>
        <label class="field"><span>WhatsApp number</span><input class="input" id="mf-phone" value="${esc(u ? u.phone : '')}" placeholder="+92 3xx xxxxxxx"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>System role</span>
          <select class="input" id="mf-role"><option value="member" ${u && u.role === 'member' ? 'selected' : ''}>Team Member</option>
          <option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
        <label class="field"><span>${u ? 'New password (leave blank to keep)' : 'Password'}</span><input type="password" class="input" id="mf-pass" placeholder="${u ? '••••••' : 'default: tpt12345'}"></label>
      </div>
      ${u ? `<label class="check"><input type="checkbox" id="mf-active" ${u.active ? 'checked' : ''}> Active — can sign in and receive notifications</label>` : ''}`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="mf-save">${u ? 'Save' : 'Create member'}</button>`,
    onMount(ov, close) {
      $('#mf-save', ov).addEventListener('click', async () => {
        const body = {
          name: $('#mf-name', ov).value.trim(),
          title: $('#mf-title', ov).value,
          email: $('#mf-email', ov).value.trim(),
          phone: $('#mf-phone', ov).value,
          role: $('#mf-role', ov).value,
        };
        const pass = $('#mf-pass', ov).value;
        if (pass) body.password = pass;
        if (u) body.active = $('#mf-active', ov).checked;
        if (!body.name || !body.email) { toast('Name and email are required', 'error'); return; }
        try {
          if (u) await api(`/team/${u.id}`, { method: 'PATCH', body });
          else await api('/team', { method: 'POST', body });
          toast(u ? 'Member updated.' : 'Member created — default notification preferences added.', 'success');
          close(); App.loadMeta(); App.navigate();
        } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

async function prefsModal(userId, name) {
  const [prefs, settings] = await Promise.all([
    api(`/team/${userId}/prefs`),
    api('/settings'),
  ]);
  const critical = settings.notificationSettings.criticalEvents || [];
  const override = settings.notificationSettings.adminOverrideCritical;
  App.modal({
    title: `Notification preferences — ${name}`,
    wide: true,
    body: `
      ${override ? `<div class="callout co-gold" style="margin-bottom:12px;"><span class="c-ico">🛡️</span><div>Admin override for <b>critical events</b> is ON — assignments, reminders, reassignments and overdue alerts reach members even if the member turns them off here.</div></div>` : ''}
      <div class="table-wrap"><table class="tbl matrix">
        <tr><th>Event</th><th>🟢 WhatsApp</th><th>✉️ Email</th><th>🔔 In-App</th></tr>
        ${Object.entries(state.meta.events).map(([key, label]) => `
          <tr>
            <td class="m-row-label">${esc(label)} ${critical.includes(key) ? '<span class="badge b-high">critical</span>' : ''}</td>
            ${['whatsapp', 'email', 'in_app'].map(ch => `
              <td><label class="switch"><input type="checkbox" data-ev="${key}" data-ch="${ch}" ${prefs[key] && prefs[key][ch] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
          </tr>`).join('')}
      </table></div>`,
    foot: `<button class="btn btn-outline" data-close>Cancel</button><button class="btn btn-gold" id="pm-save">Save preferences</button>`,
    onMount(ov, close) {
      $('#pm-save', ov).addEventListener('click', async () => {
        const body = {};
        $$('[data-ev]', ov).forEach(cbEl => {
          const ev = cbEl.dataset.ev, ch = cbEl.dataset.ch;
          body[ev] = body[ev] || {};
          body[ev][ch] = cbEl.checked;
        });
        await api(`/team/${userId}/prefs`, { method: 'PUT', body });
        toast('Preferences saved.', 'success');
        close();
      });
    },
  });
}

/* ═══ Notification History (admin) — §15/§17/§18 ═══════════════════════════ */
App.register('history', {
  adminOnly: true,
  async render(view, parts, qs) {
    const params = new URLSearchParams();
    for (const k of ['status', 'channel', 'type', 'q']) if (qs.get(k)) params.set(k, qs.get(k));
    const d = await api(`/notifications/history?${params}`);
    const typeLabel = (k) => state.meta.events[k] || k;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Notification History</h1><p>Every message the system attempted — including transparent records of anything skipped. Full event/reference IDs guarantee no duplicates.</p></div>
        <div class="spacer"></div>
        <button class="btn btn-outline" id="run-sched">⚡ Run scheduler now</button>
      </div>
      <div class="card card-pad" style="margin-bottom:14px;">
        <div class="filters">
          <select class="input" id="f-status">
            <option value="">All statuses</option>
            ${['sent', 'pending', 'failed', 'skipped'].map(st => `<option value="${st}" ${qs.get('status') === st ? 'selected' : ''}>${st}</option>`).join('')}
          </select>
          <select class="input" id="f-channel">
            <option value="">All channels</option>
            <option value="whatsapp" ${qs.get('channel') === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
            <option value="email" ${qs.get('channel') === 'email' ? 'selected' : ''}>Email</option>
            <option value="in_app" ${qs.get('channel') === 'in_app' ? 'selected' : ''}>In-App</option>
          </select>
          <select class="input" id="f-type">
            <option value="">All types</option>
            ${Object.entries(state.meta.events).map(([k, v]) => `<option value="${k}" ${qs.get('type') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <input class="input" id="f-q" placeholder="Search recipient / subject…" value="${esc(qs.get('q') || '')}">
          <button class="btn btn-primary btn-sm" id="f-apply">Apply filters</button>
        </div>
      </div>
      <div class="card"><div class="table-wrap"><table class="tbl">
        <tr><th>Sent / created</th><th>Recipient</th><th>Type</th><th>Client / Task</th><th>Channel</th><th>Status</th><th></th></tr>
        ${d.rows.map(r => `
          <tr>
            <td>${esc(r.sent_display || r.created_display)}${r.retry_count ? `<div class="t-sub">retry #${r.retry_count}</div>` : ''}</td>
            <td class="t-title">${esc(r.recipient_label)}</td>
            <td>${esc(typeLabel(r.event_type))}</td>
            <td>${esc(r.client_name || '—')}${r.task_title ? `<div class="t-sub">${esc(r.task_title)}</div>` : ''}</td>
            <td>${cb(r.channel)}</td>
            <td>${sb(r.status)}${r.status_reason ? `<div class="t-sub">${esc(r.status_reason)}</div>` : ''}${r.error ? `<div class="t-sub" style="color:var(--red);">${esc(r.error.slice(0, 90))}</div>` : ''}</td>
            <td style="white-space:nowrap;">
              ${r.status === 'failed' ? `<button class="btn btn-sm btn-gold" data-retry="${r.id}">↻ Retry</button>` : ''}
              <button class="btn btn-sm btn-outline" data-detail="${r.id}">Details</button>
            </td>
          </tr>`).join('')}
      </table></div></div>
      ${!d.rows.length ? '<div class="empty"><b>No notifications</b>' + esc(QUIET_NOTE) + '</div>' : ''}`;
    $('#f-apply', view).addEventListener('click', () => {
      const p = new URLSearchParams();
      if ($('#f-status', view).value) p.set('status', $('#f-status', view).value);
      if ($('#f-channel', view).value) p.set('channel', $('#f-channel', view).value);
      if ($('#f-type', view).value) p.set('type', $('#f-type', view).value);
      if ($('#f-q', view).value) p.set('q', $('#f-q', view).value);
      location.hash = `#/history?${p}`;
    });
    $('#run-sched', view).addEventListener('click', async () => {
      const r = await api('/admin/run-scheduler', { method: 'POST' });
      toast(`Scheduler ran — ${r.remindersFired} reminder(s) fired, ${r.remindersSkipped} skipped by conditions, ${r.overdueDetected} overdue task(s) detected.`, 'success', 6000);
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
  },
});

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
        ${kv('Status', `${sb(r.status)}${r.status_reason ? ` — ${esc(r.status_reason)}` : ''}`)}
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
      ${r.channel === 'in_app' ? `<div class="k muted small" style="font-weight:700;margin-bottom:6px;">IN-APP MESSAGE</div><div class="wa-bubble" style="background:#f4f6fa;">${esc((meta.title || r.subject || '') + '\n' + (meta.body || r.message || ''))}</div>` : ''}`,
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

/* ═══ Email Templates (admin) — §11/§12 ════════════════════════════════════ */
App.register('templates', {
  adminOnly: true,
  async render(view) {
    const tpls = await api('/templates');
    const icons = { new_task_assigned: '📋', task_reminder: '⏰', task_reassigned: '🔁', task_reassigned_from: '↩️', project_update: '📢', task_completed: '✅', task_overdue: '🔥', whatsapp_failed: '🚫' };
    view.innerHTML = `
      <div class="page-head"><div><h1>Email Templates</h1>
        <p>Professional, branded emails for every event type. Placeholders like <span class="mono">{{team_member_name}}</span> are replaced automatically before sending.</p></div></div>
      <div class="card">
        ${tpls.map(t => `
          <div class="tpl-row" data-key="${t.key}">
            <div class="tpl-ico">${icons[t.key] || '✉️'}</div>
            <div style="flex:1;">
              <div style="font-weight:700;">${esc(t.name)}</div>
              <div class="muted small">Subject: ${esc(t.subject)}</div>
            </div>
            <span class="muted small">${esc(t.updated_at || '')}</span>
            <button class="btn btn-sm btn-outline">Edit</button>
          </div>`).join('')}
      </div>
      <div class="card card-pad" style="margin-top:16px;">
        <div class="callout co-info"><span class="c-ico">🎨</span><div>
          All emails share one branded frame — The Pie Technologies logo, navy/gold header, structured CLIENT / PROJECT / TASK details, gold CTA button and professional footer with the website and copyright.</div></div>
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
      <label class="field"><span>Heading (shown in the email banner)</span><input class="input" id="te-heading" value="${esc(tpl.heading)}"></label>
      <label class="field"><span>Body</span><textarea class="input" id="te-body" style="min-height:120px;">${esc(tpl.body)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>CTA button text</span><input class="input" id="te-cta-text" value="${esc(tpl.cta_text)}"></label>
        <label class="field"><span>CTA URL</span><input class="input" id="te-cta-url" value="${esc(tpl.cta_url)}"></label>
      </div>
      <label class="field"><span>Footer note</span><input class="input" id="te-footer" value="${esc(tpl.footer_text)}"></label>
      <div class="field">
        <span>Available placeholders (click to copy)</span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${TEMPLATE_VARS.map(v => `<button class="btn btn-sm btn-outline mono" data-var="${esc(v)}">${esc(v)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <span>Live preview</span>
        <div class="filters" style="margin-bottom:8px;">
          <button class="btn btn-sm btn-primary" id="te-refresh">↻ Refresh preview</button>
          <span class="muted small">rendered with sample data</span>
        </div>
        <iframe class="preview-frame" id="te-preview"></iframe>
      </div>`,
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
          body: {
            subject: $('#te-subject', ov).value,
            heading: $('#te-heading', ov).value,
            body: $('#te-body', ov).value,
            cta_text: $('#te-cta-text', ov).value,
            cta_url: $('#te-cta-url', ov).value,
            footer_text: $('#te-footer', ov).value,
          },
        });
        toast('Template saved — future emails will use it.', 'success');
        close(); App.navigate();
      });
    },
  });
}

/* ═══ Settings (admin) — §3/§9/§13/§22 ═════════════════════════════════════ */
App.register('settings', {
  adminOnly: true,
  async render(view, parts, qs) {
    const s = await api('/settings');
    const tab = qs.get('tab') || 'reminders';
    const tabBtn = (key, label) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`;
    view.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p>Reminder defaults, notification control and integrations — all Admin-owned</p></div></div>
      <div class="tabs">
        ${tabBtn('reminders', '⏰ Reminder Settings')}
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
            <h2>Reminder defaults (§3)</h2>
            <p class="muted small">Defaults used when scheduling reminders — there is <b>no</b> automatic daily reminder system. A reminder exists only when an Admin adds one to a task.</p>
            <div class="field-row">
              <label class="field"><span>Agency time zone</span>
                <select class="input" id="rs-tz">
                  ${commonTzs.map(tz => `<option value="${tz}" ${s.reminderSettings.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}
                  ${Intl.supportedValuesOf('timeZone').filter(tz => !commonTzs.includes(tz)).map(tz => `<option value="${tz}" ${s.reminderSettings.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}
                </select></label>
              <label class="field"><span>Default reminder time</span>
                <input type="time" class="input" id="rs-time" value="${esc(s.reminderSettings.defaultReminderTime)}"></label>
            </div>
            <button class="btn btn-gold" id="rs-save">Save reminder settings</button>
          </div>
          <div class="card card-pad">
            <h2>Night-shift friendly (§22)</h2>
            <div class="callout co-gold" style="margin-bottom:10px;"><span class="c-ico">🌙</span><div>
              The agency works night hours. Reminders fire at <b>exactly</b> the Admin-picked wall-clock time in this timezone — a 10:30&nbsp;PM reminder stays 10:30&nbsp;PM. Nothing is auto-converted to 9-to-5 business hours.</div></div>
            <div class="callout co-red"><span class="c-ico">🚫</span><div>
              Hard rule: no daily summaries, no "you have no tasks today", no morning greetings, no motivational messages. If nothing needs attention, the system sends nothing.</div></div>
            <div class="hint" style="margin-top:10px;">Current agency time: <b>${esc(state.meta.nowInAgency.date)} ${esc(state.meta.nowInAgency.time)}</b> (${esc(s.reminderSettings.timezone)})</div>
          </div>
        </div>`;
      $('#rs-save', body).addEventListener('click', async () => {
        await api('/settings/reminderSettings', { method: 'PUT', body: { timezone: $('#rs-tz', body).value, defaultReminderTime: $('#rs-time', body).value } });
        toast('Reminder settings saved.', 'success');
        await App.loadMeta();
        App.navigate();
      });
    }

    if (tab === 'notifications') {
      const evs = s.notificationSettings.events;
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h2>Channel control per event (§13)</h2><span class="sub">every channel is independent — switch off what shouldn't send</span></div>
          <div class="table-wrap"><table class="tbl matrix">
            <tr><th>Event</th><th>🟢 WhatsApp</th><th>✉️ Email</th><th>🔔 In-App</th></tr>
            ${Object.entries(state.meta.events).map(([key, label]) => `
              <tr>
                <td class="m-row-label">${esc(label)}${(s.notificationSettings.criticalEvents || []).includes(key) ? ' <span class="badge b-high">critical</span>' : ''}</td>
                ${['whatsapp', 'email', 'in_app'].map(ch => `
                  <td><label class="switch"><input type="checkbox" data-ev="${key}" data-ch="${ch}" ${evs[key] && evs[key][ch] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
              </tr>`).join('')}
          </table></div>
          <div class="card-pad" style="border-top:1px solid var(--line);">
            <label class="check" style="font-weight:600;"><input type="checkbox" id="nc-override" ${s.notificationSettings.adminOverrideCritical ? 'checked' : ''}>
              🛡 Override member preferences for critical events (assignments, reminders, reassignment, overdue)</label>
            <label class="check" style="font-weight:600;"><input type="checkbox" id="nc-prev" ${s.notificationSettings.notifyPreviousAssigneeOnReassign ? 'checked' : ''}>
              ↩️ Also notify the previous assignee when a task is reassigned away from them</label>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
              <button class="btn btn-gold" id="nc-save">Save notification control</button>
            </div>
          </div>
        </div>
        <div class="card card-pad" style="margin-top:16px;">
          <div class="callout co-info"><span class="c-ico">💡</span><div>
            These switches are the <b>global</b> master controls. Each team member can additionally choose their own preferences (Team → 🔔 Preferences) — and you can override them for critical events. A message is only sent when <b>both</b> the global switch and the member preference allow it (unless the critical override applies).</div></div>
        </div>`;
      $('#nc-save', body).addEventListener('click', async () => {
        const events = {};
        $$('[data-ev]', body).forEach(cbEl => {
          events[cbEl.dataset.ev] = events[cbEl.dataset.ev] || {};
          events[cbEl.dataset.ev][cbEl.dataset.ch] = cbEl.checked;
        });
        await api('/settings/notificationSettings', {
          method: 'PUT',
          body: {
            ...s.notificationSettings,
            events,
            adminOverrideCritical: $('#nc-override', body).checked,
            notifyPreviousAssigneeOnReassign: $('#nc-prev', body).checked,
          },
        });
        toast('Notification control saved.', 'success');
        App.navigate();
      });
    }

    if (tab === 'admin') {
      const a = s.adminNotify;
      const row = (key, label, note) => `
        <tr>
          <td class="m-row-label">${label}<div class="t-sub">${note}</div></td>
          ${['email', 'in_app'].map(ch => `
            <td><label class="switch"><input type="checkbox" data-an="${key}" data-ch="${ch}" ${a[key][ch] ? 'checked' : ''}><span class="knob"></span></label></td>`).join('')}
        </tr>`;
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h2>Admin alert preferences (§9)</h2><span class="sub">all configurable — silence what you don't need</span></div>
          <div class="table-wrap"><table class="tbl matrix">
            <tr><th>Alert</th><th>✉️ Email</th><th>🔔 In-App</th></tr>
            ${row('onTaskCompleted', 'Notify me when a task is completed', 'sent to all admins')}
            ${row('onTaskOverdue', 'Notify me when a task becomes overdue', 'one alert per task, never repeated')}
            ${row('onTaskComment', 'Notify me when a team member comments on a task', 'comments by team members only')}
            ${row('onProjectUpdate', 'Send me a copy of project updates', 'copies of updates you post')}
            ${row('onWhatsAppFailed', 'Notify me when a WhatsApp notification fails', '§17 — includes a Retry action')}
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
            <label class="field"><span>App URL (used in emails &amp; CTAs)</span><input class="input" id="in-appurl" value="${esc(it.appUrl)}"></label>
            <label class="field"><span>Website URL (email footer)</span><input class="input" id="in-weburl" value="${esc(it.websiteUrl)}"></label>
            <label class="field"><span>Admin display name</span><input class="input" id="in-adminname" value="${esc(it.adminName)}"></label>
            <button class="btn btn-gold" id="in-save">Save workspace</button>
            <div class="callout co-green" style="margin-top:14px;"><span class="c-ico">🛡</span><div>
              <b>Fail-safe by design:</b> if WhatsApp or email delivery fails, the task/project operation still succeeds, the failure is logged in Notification History, and you get a <b>Retry</b> button. Notification failures never break task management (§17).</div></div>
          </div>
          <div>
            <div class="card card-pad" style="margin-bottom:16px;">
              <h2>WhatsApp</h2>
              <p class="muted small">Currently: <b>${it.whatsapp.mode === 'cloud_api' && s.whatsappConfigured ? 'Meta WhatsApp Cloud API' : 'simulation mode'}</b> ${s.whatsappConfigured ? '<span class="badge b-sent">credentials set</span>' : '<span class="badge b-pending">not configured</span>'}</p>
              <label class="field"><span>Mode</span>
                <select class="input" id="in-wa-mode">
                  <option value="simulation" ${it.whatsapp.mode !== 'cloud_api' ? 'selected' : ''}>Simulation (log only — safe demo)</option>
                  <option value="cloud_api" ${it.whatsapp.mode === 'cloud_api' ? 'selected' : ''}>Meta WhatsApp Cloud API</option>
                </select></label>
              <label class="field"><span>Phone Number ID</span><input class="input" id="in-wa-pid" value="${esc(it.whatsapp.phoneNumberId)}" placeholder="e.g. 123456789012345"></label>
              <label class="field"><span>Permanent API token</span><input class="input" id="in-wa-token" type="password" value="${esc(it.whatsapp.apiToken)}" placeholder="EAAG…"></label>
              <label class="check"><input type="checkbox" id="in-wa-fail" ${it.whatsapp.simulateFailures ? 'checked' : ''}> Simulate failures (to test the Retry flow)</label>
            </div>
            <div class="card card-pad">
              <h2>Email (SMTP)</h2>
              <p class="muted small">Currently: <b>${it.email.mode === 'smtp' && s.emailConfigured ? 'SMTP delivery' : 'simulation mode'}</b> ${s.emailConfigured ? '<span class="badge b-sent">configured</span>' : '<span class="badge b-pending">not configured</span>'}</p>
              <div class="field-row">
                <label class="field"><span>SMTP host</span><input class="input" id="in-em-host" value="${esc(it.email.smtpHost)}" placeholder="smtp.gmail.com"></label>
                <label class="field"><span>Port</span><input class="input" id="in-em-port" value="${esc(it.email.smtpPort)}"></label>
              </div>
              <div class="field-row">
                <label class="field"><span>User</span><input class="input" id="in-em-user" value="${esc(it.email.smtpUser)}"></label>
                <label class="field"><span>Password</span><input class="input" id="in-em-pass" type="password" value="${esc(it.email.smtpPass)}"></label>
              </div>
              <div class="field-row">
                <label class="field"><span>From name</span><input class="input" id="in-em-fromname" value="${esc(it.email.fromName)}"></label>
                <label class="field"><span>From email</span><input class="input" id="in-em-from" value="${esc(it.email.fromEmail)}"></label>
              </div>
              <label class="check"><input type="checkbox" id="in-em-fail" ${it.email.simulateFailures ? 'checked' : ''}> Simulate failures (to test admin alerts)</label>
              <div class="hint">SMTP mode requires the optional <span class="mono">nodemailer</span> package (npm install nodemailer). The app never breaks when it's missing — the message is logged as failed and can be retried.</div>
              <div style="margin-top:10px;"><button class="btn btn-gold" id="in-save2">Save integrations</button></div>
            </div>
          </div>
        </div>`;
      const save = async () => {
        const out = structuredClone(it);
        out.appUrl = $('#in-appurl', body).value.trim();
        out.websiteUrl = $('#in-weburl', body).value.trim();
        out.adminName = $('#in-adminname', body).value.trim();
        out.whatsapp.mode = $('#in-wa-mode', body).value;
        out.whatsapp.phoneNumberId = $('#in-wa-pid', body).value.trim();
        out.whatsapp.apiToken = $('#in-wa-token', body).value.trim();
        out.whatsapp.simulateFailures = $('#in-wa-fail', body).checked;
        out.email.smtpHost = $('#in-em-host', body).value.trim();
        out.email.mode = out.email.smtpHost ? 'smtp' : 'simulation';
        out.email.smtpPort = Number($('#in-em-port', body).value) || 587;
        out.email.smtpUser = $('#in-em-user', body).value.trim();
        out.email.smtpPass = $('#in-em-pass', body).value;
        out.email.fromName = $('#in-em-fromname', body).value.trim();
        out.email.fromEmail = $('#in-em-from', body).value.trim();
        out.email.simulateFailures = $('#in-em-fail', body).checked;
        await api('/settings/integrationSettings', { method: 'PUT', body: out });
        toast('Integrations saved.', 'success');
      };
      $('#in-save', body).addEventListener('click', save);
      $('#in-save2', body).addEventListener('click', save);
    }
  },
});
})();
