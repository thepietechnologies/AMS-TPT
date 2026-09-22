'use strict';
/* ─── REST API ───────────────────────────────────────────────────────────── */
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const { rid, nowIso, hashPassword, verifyPassword, token, esc } = require('./util');
const { zonedToUtc, fmtInTz, fmtDateInTz, fmtTimeInTz, zonedParts } = require('./timezone');
const engine = require('./notify/engine');
const { runTick } = require('./notify/scheduler');
const { renderEmail, TEMPLATE_KEYS } = require('./notify/templates');

const router = express.Router();

/* ─── Auth ───────────────────────────────────────────────────────────────── */
router.use((req, res, next) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p[0]));
  const t = cookies.tpt_session;
  req.user = null;
  if (t) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
    if (s && s.expires_at > nowIso()) {
      req.user = db.prepare('SELECT id, role, name, email, phone, title FROM users WHERE id = ?').get(s.user_id) || null;
    }
  }
  next();
});
const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Not signed in' });
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'Admin access required' });

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'This account is deactivated' });
  const t = token();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(t, user.id, nowIso(), new Date(Date.now() + 30 * 864e5).toISOString());
  res.setHeader('Set-Cookie', `tpt_session=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`);
  res.json({ user: { id: user.id, role: user.role, name: user.name, email: user.email, title: user.title } });
});

router.post('/auth/logout', (req, res) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0] === 'tpt_session'));
  if (cookies.tpt_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(decodeURIComponent(cookies.tpt_session));
  res.setHeader('Set-Cookie', 'tpt_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => res.json({ user: req.user }));

/* ─── Meta (dropdown data + prefs catalog) ───────────────────────────────── */
router.get('/meta', requireAuth, (req, res) => {
  const tz = getSetting('reminderSettings').timezone;
  res.json({
    clients: db.prepare('SELECT id, name FROM clients WHERE archived = 0 ORDER BY name').all(),
    projects: db.prepare('SELECT p.id, p.name, p.client_id, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status != ? ORDER BY p.name').all('completed'),
    members: db.prepare("SELECT id, name, email, phone, role, title, active FROM users WHERE active = 1 ORDER BY role DESC, name").all(),
    events: engine.EVENT_LABELS,
    timezones: Intl.supportedValuesOf('timeZone'),
    agencyTz: tz,
    nowInAgency: require('./timezone').nowInTz(tz),
  });
});

/* ─── Clients ────────────────────────────────────────────────────────────── */
router.get('/clients', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS project_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status = 'open') AS open_tasks
    FROM clients c WHERE c.archived = 0 ORDER BY c.name`).all();
  res.json(rows);
});
router.post('/clients', requireAdmin, (req, res) => {
  const { name, contact_person, email, phone, notes } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Client name is required' });
  const info = db.prepare('INSERT INTO clients(name,contact_person,email,phone,notes,created_at) VALUES(?,?,?,?,?,?)')
    .run(name.trim(), contact_person || '', email || '', phone || '', notes || '', nowIso());
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid));
});
router.patch('/clients/:id', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const f = req.body || {};
  db.prepare('UPDATE clients SET name=?, contact_person=?, email=?, phone=?, notes=? WHERE id=?')
    .run(f.name ?? c.name, f.contact_person ?? c.contact_person, f.email ?? c.email, f.phone ?? c.phone, f.notes ?? c.notes, c.id);
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id));
});
router.delete('/clients/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE clients SET archived = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ─── Projects ───────────────────────────────────────────────────────────── */
router.get('/projects', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.name AS client_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'open') AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS completed_tasks
    FROM projects p JOIN clients c ON c.id = p.client_id
    WHERE p.status != 'archived' ORDER BY p.created_at DESC`).all();
  res.json(rows);
});
router.post('/projects', requireAdmin, (req, res) => {
  const { client_id, name, description, status } = req.body || {};
  if (!name || !client_id) return res.status(400).json({ error: 'Project name and client are required' });
  const info = db.prepare('INSERT INTO projects(client_id,name,description,status,created_at) VALUES(?,?,?,?,?)')
    .run(client_id, name.trim(), description || '', status || 'active', nowIso());
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
});
router.patch('/projects/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const f = req.body || {};
  db.prepare('UPDATE projects SET name=?, description=?, status=?, client_id=? WHERE id=?')
    .run(f.name ?? p.name, f.description ?? p.description, f.status ?? p.status, f.client_id ?? p.client_id, p.id);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
});

/* Project detail with tasks + updates */
router.get('/projects/:id', requireAuth, (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ? ORDER BY t.status ASC, t.due_at ASC`).all(project.id).map(fmtTask);
  const updates = db.prepare(`
    SELECT pu.*, u.name AS created_by_name FROM project_updates pu LEFT JOIN users u ON u.id = pu.created_by
    WHERE pu.project_id = ? ORDER BY pu.created_at DESC`).all(project.id);
  res.json({ project, tasks, updates });
});

/* §19 — Manual project update, only the selected channels fire */
router.post('/projects/:id/updates', requireAdmin, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { title, message, send_whatsapp, send_email, send_inapp, recipient_ids } = req.body || {};
  if (!String(title || '').trim() || !String(message || '').trim()) {
    return res.status(400).json({ error: 'Title and message are required' });
  }
  const info = db.prepare(`INSERT INTO project_updates(project_id,title,message,created_by,send_whatsapp,send_email,send_inapp,created_at)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(project.id, title.trim(), message.trim(), req.user.id, send_whatsapp ? 1 : 0, send_email ? 1 : 0, send_inapp === undefined ? 1 : (send_inapp ? 1 : 0), nowIso());
  const update = db.prepare('SELECT * FROM project_updates WHERE id = ?').get(info.lastInsertRowid);

  const channelCol = { whatsapp: 'send_whatsapp', email: 'send_email', in_app: 'send_inapp' };
  const channels = ['whatsapp', 'email', 'in_app'].filter(c => update[channelCol[c]]);
  let recipients = [];
  if (Array.isArray(recipient_ids) && recipient_ids.length) {
    recipients = recipient_ids.map(id => db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id)).filter(Boolean);
  } else {
    recipients = db.prepare("SELECT * FROM users WHERE role = 'member' AND active = 1").all();
  }
  const ctx = engine.buildContext({ projectRow: project, updateRow: update, actor: req.user });
  let queued = 0;
  if (channels.length) {
    const ids = engine.enqueue({
      eventId: `project_update:${update.id}`,
      eventType: 'project_update',
      templateKey: 'project_update',
      recipients: recipients.map(r => ({ id: r.id, name: r.name, email: r.email, phone: r.phone })),
      ctx, channels,
    });
    queued += ids.length;
    // §9 — admin copy when configured
    const adminCfg = getSetting('adminNotify');
    if (adminCfg.onProjectUpdate && (adminCfg.onProjectUpdate.email || adminCfg.onProjectUpdate.in_app)) {
      const matrix = getSetting('notificationSettings').events.project_update;
      const adminChannels = ['email', 'in_app'].filter(c => adminCfg.onProjectUpdate[c] && matrix[c] && channels.includes(c));
      if (adminChannels.length) {
        queued += engine.enqueue({
          eventId: `project_update_admin:${update.id}`,
          eventType: 'project_update', templateKey: 'project_update',
          recipients: engine.admins().map(a => ({ id: a.id, name: a.name, email: a.email, phone: a.phone })),
          ctx, channels: adminChannels, skipPrefs: true,
        }).length;
      }
    }
    require('./notify/engine').processPending().catch(() => {});
  }
  res.json({ update, queued });
});

/* ─── Tasks ──────────────────────────────────────────────────────────────── */
function fmtTask(t) {
  const tz = getSetting('reminderSettings').timezone;
  const dueParts = t.due_at ? zonedParts(t.due_at, tz) : null;
  return {
    ...t,
    due_display: t.due_at ? fmtInTz(t.due_at, tz) : null,
    due_date_display: t.due_at ? fmtDateInTz(t.due_at, tz) : null,
    due_time_display: t.due_at ? fmtTimeInTz(t.due_at, tz) : null,
    due_date_part: dueParts ? dueParts.date : null,
    due_time_part: dueParts ? dueParts.time : null,
  };
}

router.get('/tasks', requireAuth, (req, res) => {
  const { status, assignee_id, client_id, project_id, q } = req.query;
  const where = []; const params = [];
  if (req.user.role !== 'admin') { where.push('t.assignee_id = ?'); params.push(req.user.id); }
  if (status === 'open') where.push("t.status = 'open'");
  if (status === 'completed') where.push("t.status = 'completed'");
  if (status === 'overdue') { where.push("t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ?"); params.push(nowIso()); }
  if (assignee_id) { where.push('t.assignee_id = ?'); params.push(assignee_id); }
  if (client_id) { where.push('t.client_id = ?'); params.push(client_id); }
  if (project_id) { where.push('t.project_id = ?'); params.push(project_id); }
  if (q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN projects p ON p.id = t.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END ASC, t.due_at IS NULL, t.due_at ASC
    LIMIT 500`).all(...params).map(fmtTask);
  res.json(rows);
});

router.get('/tasks/:id', requireAuth, (req, res) => {
  const t = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role !== 'admin' && t.assignee_id !== req.user.id) return res.status(403).json({ error: 'This task is not assigned to you' });
  const tz = getSetting('reminderSettings').timezone;
  const reminders = db.prepare('SELECT * FROM task_reminders WHERE task_id = ? ORDER BY remind_at ASC').all(t.id)
    .map(r => {
      const parts = zonedParts(r.remind_at, tz);
      return { ...r, remind_display: fmtInTz(r.remind_at, tz), date_part: parts.date, time_part: parts.time };
    });
  const comments = db.prepare(`
    SELECT cm.*, u.name AS author_name, u.role AS author_role FROM comments cm
    JOIN users u ON u.id = cm.author_id WHERE cm.task_id = ? ORDER BY cm.created_at ASC`).all(t.id);
  res.json({ task: fmtTask(t), reminders, comments, agencyTz: tz });
});

/* Parse incoming reminder date/time strings into exact UTC instants */
function parseReminders(list) {
  const tz = getSetting('reminderSettings').timezone;
  return (Array.isArray(list) ? list : [])
    .filter(r => r && r.date && r.time)
    .map(r => ({ date: r.date, time: r.time, remind_at: zonedToUtc(r.date, r.time, tz).toISOString() }));
}

router.post('/tasks', requireAdmin, (req, res) => {
  const f = req.body || {};
  if (!String(f.title || '').trim()) return res.status(400).json({ error: 'Task title is required' });
  const tz = getSetting('reminderSettings').timezone;
  const dueAt = (f.due_date && f.due_time) ? zonedToUtc(f.due_date, f.due_time, tz).toISOString() : null;
  const info = db.prepare(`INSERT INTO tasks(title,description,client_id,project_id,assignee_id,priority,due_at,status,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(f.title.trim(), f.description || '', f.client_id || null, f.project_id || null, f.assignee_id || null,
      f.priority || 'Medium', dueAt, 'open', req.user.id, nowIso());
  const taskId = info.lastInsertRowid;
  for (const r of parseReminders(f.reminders)) {
    db.prepare('INSERT INTO task_reminders(task_id,remind_at,created_at) VALUES(?,?,?)').run(taskId, r.remind_at, nowIso());
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  let queued = 0;
  if (task.assignee_id) queued = notifyAssignment(task, 'task_assigned', req.user);
  require('./notify/engine').processPending().catch(() => {});
  res.json({ task: fmtTask(task), queued });
});

/** §1-A / §1-D — assignment & reassignment notifications */
function notifyAssignment(task, eventType, actor) {
  const assignee = engine.userById(task.assignee_id);
  if (!assignee) return 0;
  const ctx = engine.buildContext({ taskRow: task, recipient: assignee, actor });
  const ids = engine.enqueue({
    eventId: `${eventType}:${task.id}:${assignee.id}:${Date.now() < Date.parse(task.created_at) + 5e3 ? 'c' : 'r'}`,
    eventType,
    templateKey: eventType === 'task_assigned' ? 'new_task_assigned' : 'task_reassigned',
    recipients: [{ id: assignee.id, name: assignee.name, email: assignee.email, phone: assignee.phone }],
    ctx,
  });
  require('./notify/engine').processPending().catch(() => {});
  return ids.length;
}

router.patch('/tasks/:id', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const f = req.body || {};
  const tz = getSetting('reminderSettings').timezone;
  const dueAt = ('due_date' in f || 'due_time' in f)
    ? ((f.due_date && f.due_time) ? zonedToUtc(f.due_date, f.due_time, tz).toISOString() : null)
    : t.due_at;
  db.prepare(`UPDATE tasks SET title=?, description=?, client_id=?, project_id=?, assignee_id=?, priority=?, due_at=? WHERE id=?`)
    .run(f.title ?? t.title, f.description ?? t.description, f.client_id ?? t.client_id, f.project_id ?? t.project_id,
      f.assignee_id ?? t.assignee_id, f.priority ?? t.priority, dueAt, t.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);

  // Reminder diff — processed reminders are kept as history; pending ones follow the admin's list
  if (Array.isArray(f.reminders)) {
    const wanted = parseReminders(f.reminders).map(r => r.remind_at);
    const existing = db.prepare('SELECT * FROM task_reminders WHERE task_id = ? AND processed_at IS NULL').all(t.id);
    for (const e of existing) {
      if (!wanted.includes(e.remind_at)) db.prepare('DELETE FROM task_reminders WHERE id = ?').run(e.id);
    }
    const keep = existing.map(e => e.remind_at);
    for (const w of wanted) {
      if (!keep.includes(w)) db.prepare('INSERT INTO task_reminders(task_id,remind_at,created_at) VALUES(?,?,?)').run(t.id, w, nowIso());
    }
  }

  let queued = 0;
  if (f.assignee_id !== undefined && Number(f.assignee_id) !== Number(t.assignee_id)) {
    // §1-D — notify the new assignee
    if (task.assignee_id) queued += notifyAssignment(task, 'task_reassigned', req.user);
    // Optional (admin setting) — tell the previous assignee the task moved on
    const notif = getSetting('notificationSettings');
    if (notif.notifyPreviousAssigneeOnReassign && t.assignee_id && Number(t.assignee_id) !== Number(task.assignee_id)) {
      const prev = engine.userById(t.assignee_id);
      if (prev) {
        const ctx = engine.buildContext({ taskRow: task, recipient: prev, actor: req.user });
        queued += engine.enqueue({
          eventId: `task_reassigned_from:${task.id}:${prev.id}`,
          eventType: 'task_reassigned', templateKey: 'task_reassigned_from',
          recipients: [{ id: prev.id, name: prev.name, email: prev.email, phone: prev.phone }],
          ctx,
        }).length;
      }
    }
    require('./notify/engine').processPending().catch(() => {});
  }
  res.json({ task: fmtTask(task), queued });
});

/* §6.5 — completing a task cancels its pending reminders; §9 admin alert */
router.post('/tasks/:id/complete', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role !== 'admin' && t.assignee_id !== req.user.id) return res.status(403).json({ error: 'This task is not assigned to you' });
  if (t.status === 'completed') return res.status(400).json({ error: 'Task is already completed' });
  db.prepare("UPDATE tasks SET status='completed', completed_at=?, completed_by=?, overdue_notified=1 WHERE id=?").run(nowIso(), req.user.id, t.id);
  db.prepare(`UPDATE task_reminders SET processed_at = ?, skip_reason = ? WHERE task_id = ? AND processed_at IS NULL`)
    .run(nowIso(), 'Task completed before reminder time', t.id);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
  let queued = 0;
  const adminCfg = getSetting('adminNotify');
  if (adminCfg.onTaskCompleted && (adminCfg.onTaskCompleted.email || adminCfg.onTaskCompleted.in_app)) {
    const matrix = getSetting('notificationSettings').events.task_completed;
    const channels = ['whatsapp', 'email', 'in_app'].filter(c => adminCfg.onTaskCompleted[c] && matrix[c]);
    if (channels.length) {
      const ctx = engine.buildContext({ taskRow: task, actor: req.user });
      queued = engine.enqueue({
        eventId: `task_completed:${task.id}`,
        eventType: 'task_completed',
        recipients: engine.admins().map(a => ({ id: a.id, name: a.name, email: a.email, phone: a.phone })),
        ctx, skipPrefs: true, channels,
      }).length;
    }
  }
  require('./notify/engine').processPending().catch(() => {});
  res.json({ task: fmtTask(task), queued });
});

router.post('/tasks/:id/comments', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const { body, important } = req.body || {};
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const info = db.prepare('INSERT INTO comments(task_id,author_id,body,important,created_at) VALUES(?,?,?,?,?)')
    .run(t.id, req.user.id, body.trim(), important ? 1 : 0, nowIso());
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  let queued = 0;
  // §9 — admin alert when a team member comments on a task
  if (req.user.role !== 'admin') {
    const adminCfg = getSetting('adminNotify');
    if (adminCfg.onTaskComment && (adminCfg.onTaskComment.email || adminCfg.onTaskComment.in_app)) {
      const matrix = getSetting('notificationSettings').events.task_comment;
      const channels = ['email', 'in_app'].filter(c => adminCfg.onTaskComment[c] && matrix[c]);
      if (channels.length) {
        const ctx = engine.buildContext({ taskRow: t, commentRow: comment, actor: req.user });
        queued = engine.enqueue({
          eventId: `task_comment:${comment.id}`,
          eventType: 'task_comment',
          recipients: engine.admins().map(a => ({ id: a.id, name: a.name, email: a.email, phone: a.phone })),
          ctx, skipPrefs: true, channels,
        }).length;
        require('./notify/engine').processPending().catch(() => {});
      }
    }
  }
  res.json({ comment, queued });
});

router.delete('/tasks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ─── Team ───────────────────────────────────────────────────────────────── */
router.get('/team', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, role, name, email, phone, title, active, created_at FROM users ORDER BY role DESC, name').all();
  const openTasks = db.prepare("SELECT assignee_id, COUNT(*) c FROM tasks WHERE status='open' GROUP BY assignee_id").all();
  const map = Object.fromEntries(openTasks.map(r => [r.assignee_id, r.c]));
  res.json(users.map(u => ({ ...u, open_tasks: map[u.id] || 0 })));
});
router.post('/team', requireAdmin, (req, res) => {
  const { name, email, phone, title, password, role } = req.body || {};
  if (!String(name || '').trim() || !String(email || '').trim()) return res.status(400).json({ error: 'Name and email are required' });
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(String(email).trim())) {
    return res.status(400).json({ error: 'A user with this email already exists' });
  }
  const info = db.prepare('INSERT INTO users(role,name,email,phone,password,title,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(role === 'admin' ? 'admin' : 'member', name.trim(), email.trim(), phone || '', hashPassword(String(password || 'tpt12345')), title || '', nowIso());
  const uid = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO notification_prefs(user_id,event_type,whatsapp,email,in_app) VALUES(?,?,1,1,1)');
  for (const ev of Object.keys(engine.EVENT_LABELS)) ins.run(uid, ev);
  res.json(db.prepare('SELECT id, role, name, email, phone, title, active FROM users WHERE id = ?').get(uid));
});
router.patch('/team/:id', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const f = req.body || {};
  db.prepare('UPDATE users SET name=?, email=?, phone=?, title=?, active=? WHERE id=?')
    .run(f.name ?? u.name, (f.email ?? u.email).trim(), f.phone ?? u.phone, f.title ?? u.title,
      f.active === undefined ? u.active : (f.active ? 1 : 0), u.id);
  if (f.password) db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPassword(String(f.password)), u.id);
  res.json(db.prepare('SELECT id, role, name, email, phone, title, active FROM users WHERE id = ?').get(u.id));
});
router.get('/team/:id/prefs', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').all(req.params.id);
  res.json(Object.fromEntries(rows.map(r => [r.event_type, { whatsapp: !!r.whatsapp, email: !!r.email, in_app: !!r.in_app }])));
});
router.put('/team/:id/prefs', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  // Members may manage their own preferences; admins may manage anyone's
  if (req.user.role !== 'admin' && req.user.id !== u.id) return res.status(403).json({ error: 'Not allowed' });
  const prefs = req.body || {};
  const ins = db.prepare(`INSERT INTO notification_prefs(user_id,event_type,whatsapp,email,in_app) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,event_type) DO UPDATE SET whatsapp=excluded.whatsapp, email=excluded.email, in_app=excluded.in_app`);
  db.exec('BEGIN');
  try {
    for (const ev of Object.keys(prefs)) {
      const p = prefs[ev] || {};
      ins.run(u.id, ev, p.whatsapp ? 1 : 0, p.email ? 1 : 0, p.in_app ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

/* ─── Notifications: history, retry, in-app center ───────────────────────── */
router.get('/notifications/history', requireAdmin, (req, res) => {
  const { status, channel, type, q, limit } = req.query;
  const where = []; const params = [];
  if (status) { where.push('n.status = ?'); params.push(status); }
  if (channel) { where.push('n.channel = ?'); params.push(channel); }
  if (type) { where.push('n.event_type = ?'); params.push(type); }
  if (q) { where.push('(n.recipient_label LIKE ? OR n.subject LIKE ? OR n.message LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`
    SELECT n.*, t.title AS task_title, c.name AS client_name, p.name AS project_name
    FROM notifications n
    LEFT JOIN tasks t ON t.id = n.task_id
    LEFT JOIN clients c ON c.id = n.client_id
    LEFT JOIN projects p ON p.id = n.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY n.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 200, 500));
  const tz = getSetting('reminderSettings').timezone;
  res.json({ rows: rows.map(r => ({ ...r, sent_display: r.sent_at ? fmtInTz(r.sent_at, tz) : null, created_display: fmtInTz(r.created_at, tz) })), tz });
});
router.post('/notifications/:id/retry', requireAdmin, async (req, res) => {
  try {
    const row = await engine.retryNotification(Number(req.params.id));
    res.json({ ok: true, row: { ...row, meta: undefined } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/inapp', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM in_app_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) c FROM in_app_messages WHERE user_id = ? AND read = 0').get(req.user.id).c;
  res.json({ rows, unread });
});
router.post('/inapp/read', requireAuth, (req, res) => {
  const { ids, all } = req.body || {};
  if (all) db.prepare('UPDATE in_app_messages SET read = 1 WHERE user_id = ?').run(req.user.id);
  else if (Array.isArray(ids) && ids.length) {
    const upd = db.prepare('UPDATE in_app_messages SET read = 1 WHERE user_id = ? AND id = ?');
    db.exec('BEGIN');
    try {
      for (const id of ids) upd.run(req.user.id, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  res.json({ ok: true });
});

/* ─── Settings ───────────────────────────────────────────────────────────── */
const SETTING_KEYS = ['notificationSettings', 'reminderSettings', 'adminNotify', 'integrationSettings'];
router.get('/settings', requireAdmin, (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  out.whatsappConfigured = !!(out.integrationSettings.whatsapp.apiToken && out.integrationSettings.whatsapp.phoneNumberId);
  out.emailConfigured = !!out.integrationSettings.email.smtpHost;
  res.json(out);
});
router.put('/settings/:key', requireAdmin, (req, res) => {
  const key = req.params.key;
  if (!SETTING_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown settings key' });
  const val = req.body;
  if (key === 'reminderSettings') {
    if (val.timezone && !Intl.supportedValuesOf('timeZone').includes(val.timezone)) {
      return res.status(400).json({ error: 'Unknown timezone' });
    }
    if (val.defaultReminderTime && !/^\d{2}:\d{2}$/.test(val.defaultReminderTime)) {
      return res.status(400).json({ error: 'Default reminder time must be HH:mm (24h)' });
    }
  }
  setSetting(key, val);
  res.json(getSetting(key));
});

/* ─── Email templates ────────────────────────────────────────────────────── */
router.get('/templates', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT key, name, subject, updated_at FROM email_templates ORDER BY key').all());
});
router.get('/templates/:key', requireAdmin, (req, res) => {
  const tpl = db.prepare('SELECT * FROM email_templates WHERE key = ?').get(req.params.key);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
});
router.put('/templates/:key', requireAdmin, (req, res) => {
  const tpl = db.prepare('SELECT * FROM email_templates WHERE key = ?').get(req.params.key);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const f = req.body || {};
  db.prepare('UPDATE email_templates SET subject=?, heading=?, body=?, cta_text=?, cta_url=?, footer_text=?, updated_at=? WHERE key=?')
    .run(f.subject ?? tpl.subject, f.heading ?? tpl.heading, f.body ?? tpl.body, f.cta_text ?? tpl.cta_text,
      f.cta_url ?? tpl.cta_url, f.footer_text ?? tpl.footer_text, nowIso(), tpl.key);
  res.json(db.prepare('SELECT * FROM email_templates WHERE key = ?').get(tpl.key));
});
router.post('/templates/:key/preview', requireAdmin, (req, res) => {
  const tpl = db.prepare('SELECT * FROM email_templates WHERE key = ?').get(req.params.key);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const overrides = (req.body && req.body.vars) || {};
  const sample = {
    team_member_name: 'John Malik', first_name: 'John', client_name: 'ABC Roofing',
    project_name: 'Social Media Management', task_name: 'Create Facebook Post',
    task_description: 'Design and publish a promotional post announcing the winter discount.',
    priority: 'High', due_date: 'September 25, 2026', due_time: '5:00 PM',
    due_full: 'September 25, 2026 at 5:00 PM', reminder_time: 'September 25, 2026 at 3:00 PM',
    update_title: 'Client approved the new content strategy',
    update_message: 'The client approved the new content strategy. Proceed with scheduled posts.',
    admin_name: 'Ahmed Raza',
    dashboard_url: getSetting('integrationSettings').appUrl || 'http://localhost:3000',
    website_url: getSetting('integrationSettings').websiteUrl || 'https://thepietechnologies.com/',
    logo_url: `${getSetting('integrationSettings').appUrl || ''}/assets/logo-mark.png`,
    year: String(new Date().getFullYear()),
    ...overrides,
  };
  const details = {
    client_name: sample.client_name, project_name: sample.project_name, task_name: sample.task_name,
    priority: sample.priority, due: sample.due_full, assignee: sample.team_member_name, reminder: sample.reminder_time,
  };
  if (req.params.key === 'project_update') { details.task_name = ''; details.due = ''; }
  if (req.params.key === 'whatsapp_failed') { details.task_name = sample.task_name; details.due = ''; details.assignee = 'John Malik'; }
  // preview renders in-app (iframe) — use a same-origin logo so it always displays
  sample.logo_url = '/assets/logo-mark.png';
  res.json({ ...renderEmail(tpl, sample, details) });
});

/* ─── Scheduler + dashboard ──────────────────────────────────────────────── */
router.post('/admin/run-scheduler', requireAdmin, async (req, res) => {
  res.json(await runTick());
});

router.get('/dashboard', requireAuth, (req, res) => {
  const tz = getSetting('reminderSettings').timezone;
  const now = new Date().toISOString();
  const mine = req.user.role === 'admin' ? '' : `AND t.assignee_id = ${Number(req.user.id)}`;
  const openTasks = db.prepare(`SELECT t.* FROM tasks t WHERE t.status = 'open' ${mine}`).all();
  const stats = {
    open_tasks: openTasks.length,
    due_today: openTasks.filter(t => t.due_at && fmtDateInTz(t.due_at, tz) === fmtDateInTz(now, tz)).length,
    overdue: openTasks.filter(t => t.due_at && t.due_at < now).length,
    completed_week: db.prepare(`SELECT COUNT(*) c FROM tasks t WHERE t.status='completed' AND t.completed_at > ? ${mine}`)
      .get(new Date(Date.now() - 7 * 864e5).toISOString()).c,
    active_projects: db.prepare("SELECT COUNT(*) c FROM projects WHERE status = 'active'").get().c,
    clients: db.prepare('SELECT COUNT(*) c FROM clients WHERE archived = 0').get().c,
    unread_notifications: db.prepare('SELECT COUNT(*) c FROM in_app_messages WHERE user_id = ? AND read = 0').get(req.user.id).c,
  };

  let upcoming = [];
  if (req.user.role === 'admin') {
    upcoming = db.prepare(`
      SELECT r.*, t.title AS task_title, t.assignee_id, u.name AS assignee_name
      FROM task_reminders r JOIN tasks t ON t.id = r.task_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE r.processed_at IS NULL ORDER BY r.remind_at ASC LIMIT 6`).all()
      .map(r => ({ ...r, remind_display: fmtInTz(r.remind_at, tz) }));
  }
  const recent = db.prepare(`
    SELECT n.*, t.title AS task_title, c.name AS client_name, p.name AS project_name
    FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id LEFT JOIN clients c ON c.id = n.client_id LEFT JOIN projects p ON p.id = n.project_id
    ${req.user.role === 'admin' ? '' : 'WHERE n.recipient_id = ' + Number(req.user.id)}
    ORDER BY n.id DESC LIMIT 8`).all()
    .map(r => ({ ...r, when_display: fmtInTz(r.sent_at || r.created_at, tz) }));
  const myTasks = db.prepare(`
    SELECT t.*, c.name AS client_name, p.name AS project_name, u.name AS assignee_name
    FROM tasks t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.status = 'open' ${req.user.role === 'admin' ? '' : 'AND t.assignee_id = ' + Number(req.user.id)}
    ORDER BY t.due_at IS NULL, t.due_at ASC LIMIT 8`).all().map(fmtTask);
  res.json({ stats, upcoming, recent, myTasks, agencyTz: tz });
});

module.exports = router;
