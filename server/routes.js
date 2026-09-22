'use strict';
/* ─── AMS REST API (API-first: consumed by web now, mobile later) ──────────
 * §9  — all business logic lives here, never in the frontend.
 * §10 — every request is authenticated server-side; roles/ownership are
 *       never trusted from the client. Team members only receive data
 *       within their work context (their clients / projects / tasks).
 * §11 — auth is token-based (bearer) so the future mobile app uses the
 *       exact same flow: login → token → call API.
 * §21 — entity responses carry consistent shapes (snake_case today plus
 *       camelCase aliases on the core fields for mobile consumers).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, getSetting, setSetting, UPLOAD_DIR } = require('./db');
const { nowIso, hashPassword, verifyPassword, token } = require('./util');
const { zonedToUtc, fmtInTz, fmtDateInTz, fmtTimeInTz, zonedParts, nowInTz } = require('./timezone');
const engine = require('./notify/engine');
const { runTick } = require('./notify/scheduler');
const { renderEmail } = require('./notify/templates');
const { verifySmtp, sendTestEmail } = require('./notify/providers');
const { logActivity, getActivity } = require('./activity');
const bus = require('./bus');

const router = express.Router();
const OPEN_STATUSES = ['pending', 'in_progress', 'on_hold'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'on_hold'];

/* ═══ Auth (centralized — shared by web & future mobile) ═══════════════════ */
function readSessionToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p[0]));
  return cookies.tpt_session || null;
}
function resolveUser(req) {
  const t = readSessionToken(req);
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
  if (s && s.expires_at > nowIso()) {
    return db.prepare('SELECT id, role, name, email, phone, title FROM users WHERE id = ?').get(s.user_id) || null;
  }
  return null;
}
router.use((req, res, next) => {
  req.user = resolveUser(req);
  next();
});
const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Not signed in' });
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'Admin access required' });

function sessionCookie(req, t) {
  const https = (req.headers['x-forwarded-proto'] || '').includes('https') || req.headers['x-forwarded-ssl'] === 'on';
  const sameSite = https ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `tpt_session=${t}; HttpOnly; Path=/; ${sameSite}; Max-Age=${30 * 86400}`;
}
function createSession(userId) {
  const t = token();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(t, userId, nowIso(), new Date(Date.now() + 30 * 864e5).toISOString());
  return t;
}

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'This account is deactivated' });
  const t = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(req, t));
  res.json({ user: publicUser(user), token: t });
});
router.post('/auth/logout', (req, res) => {
  const t = readSessionToken(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', 'tpt_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
router.get('/auth/me', (req, res) => {
  res.json({ user: req.user, token: req.user ? readSessionToken(req) : null });
});
function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone || '', title: u.title || '' };
}

/* ═══ Real-time notifications over SSE (§13) ═══════════════════════════════ */
router.get('/events', (req, res) => {
  const qsToken = String(req.query.token || '');
  let user = null;
  if (qsToken) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(qsToken);
    if (s && s.expires_at > nowIso()) user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  }
  if (!user) user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const unsubscribe = bus.subscribe(({ userId, payload }) => {
    if (userId === user.id) {
      try { res.write(`event: notification\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* closed */ }
    }
  });
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

/* ═══ Visibility / authorization (§10) ═════════════════════════════════════ */
const isAdmin = (req) => req.user && req.user.role === 'admin';
function visibleClientIds(req) {
  if (isAdmin(req)) return null; // null = all
  return db.prepare(`SELECT DISTINCT client_id id FROM tasks WHERE assignee_id = ? AND client_id IS NOT NULL`)
    .all(req.user.id).map(r => r.id);
}
function visibleProjectIds(req) {
  if (isAdmin(req)) return null;
  return db.prepare(`SELECT DISTINCT project_id id FROM tasks WHERE assignee_id = ? AND project_id IS NOT NULL`)
    .all(req.user.id).map(r => r.id);
}
function canSeeClient(req, clientId) {
  const ids = visibleClientIds(req);
  return ids === null || ids.includes(Number(clientId));
}
function canSeeProject(req, projectId) {
  const ids = visibleProjectIds(req);
  return ids === null || ids.includes(Number(projectId));
}
function canSeeTask(req, task) {
  return isAdmin(req) || (task && task.assignee_id === req.user.id);
}

/* ═══ Serializers (§21 — consistent, mobile-ready; no sensitive fields) ════ */
function tz() { return getSetting('reminderSettings').timezone; }
function serClient(c) {
  if (!c) return null;
  let social = {};
  try { social = JSON.parse(c.social || '{}'); } catch { /* ignore */ }
  return {
    id: c.id, name: c.name, status: c.status || 'active',
    contactPerson: c.contact_person || '', email: c.email || '', phone: c.phone || '',
    website: c.website || '', social, services: c.services || '', package: c.package || '',
    startDate: c.start_date || null, notes: c.notes || '',
    clientId: c.id, createdAt: c.created_at,
  };
}
function serProject(p) {
  if (!p) return null;
  return {
    id: p.id, clientId: p.client_id, clientName: p.client_name || undefined,
    name: p.name, description: p.description || '', status: p.status,
    startDate: p.start_date || null, endDate: p.end_date || null,
    createdAt: p.created_at,
  };
}
function serTask(t) {
  if (!t) return null;
  const parts = t.due_at ? zonedParts(t.due_at, tz()) : null;
  return {
    id: t.id,
    clientId: t.client_id, projectId: t.project_id,
    clientName: t.client_name || undefined, projectName: t.project_name || undefined,
    title: t.title, description: t.description || '',
    status: t.status, priority: t.priority,
    assigneeId: t.assignee_id, assigneeName: t.assignee_name || undefined,
    dueAt: t.due_at || null, dueDate: parts ? parts.date : null, dueTime: parts ? parts.time : null,
    dueDisplay: t.due_at ? fmtInTz(t.due_at, tz()) : null,
    estimatedMinutes: t.estimated_minutes || null,
    completedAt: t.completed_at || null,
    overdue: t.status !== 'completed' && !!t.due_at && t.due_at < nowIso(),
    createdAt: t.created_at,
    // snake_case aliases used by the current web app
    client_id: t.client_id, project_id: t.project_id, assignee_id: t.assignee_id,
    assignee_name: t.assignee_name, client_name: t.client_name, project_name: t.project_name,
    due_at: t.due_at, due_display: t.due_at ? fmtInTz(t.due_at, tz()) : null,
    due_date_part: parts ? parts.date : null, due_time_part: parts ? parts.time : null,
    estimated_minutes: t.estimated_minutes || null,
  };
}

/* ═══ Meta (dropdowns etc.) ════════════════════════════════════════════════ */
router.get('/meta', requireAuth, (req, res) => {
  const t = tz();
  const clientIds = visibleClientIds(req);
  const clients = clientIds === null
    ? db.prepare("SELECT id, name, status FROM clients WHERE status != 'archived' ORDER BY name").all()
    : db.prepare(`SELECT id, name, status FROM clients WHERE status != 'archived' AND id IN (${clientIds.map(() => '?').join(',') || 'NULL'}) ORDER BY name`).all(...clientIds);
  const projIds = visibleProjectIds(req);
  const projects = projIds === null
    ? db.prepare(`SELECT p.id, p.name, p.client_id, p.status, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status != 'archived' ORDER BY p.name`).all()
    : db.prepare(`SELECT p.id, p.name, p.client_id, p.status, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status != 'archived' AND p.id IN (${projIds.map(() => '?').join(',') || 'NULL'}) ORDER BY p.name`).all(...projIds);
  // contact details are admin-only information (§10)
  const members = isAdmin(req)
    ? db.prepare("SELECT id, name, email, phone, role, title FROM users WHERE active = 1 ORDER BY role DESC, name").all()
    : db.prepare("SELECT id, name, role, title FROM users WHERE active = 1 ORDER BY role DESC, name").all();
  res.json({
    clients, projects, members,
    events: engine.EVENT_LABELS,
    taskStatuses: TASK_STATUSES,
    timezones: Intl.supportedValuesOf('timeZone'),
    agencyTz: t,
    nowInAgency: nowInTz(t),
    user: req.user,
  });
});

/* ═══ Dashboard (§19 admin / §20 member) ═══════════════════════════════════ */
router.get('/dashboard', requireAuth, (req, res) => {
  const zone = tz();
  const now = new Date().toISOString();
  const admin = isAdmin(req);
  const scope = admin ? '' : `AND t.assignee_id = ${Number(req.user.id)}`;

  const openTasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.status != 'completed'
      AND (t.project_id IS NULL OR (SELECT status FROM projects WHERE id = t.project_id) != 'archived')
      AND (t.client_id IS NULL OR (SELECT status FROM clients WHERE id = t.client_id) != 'archived')
      ${scope} ORDER BY t.due_at IS NULL, t.due_at ASC`).all();
  const today = fmtDateInTz(now, zone);
  const dueToday = openTasks.filter(t => t.due_at && fmtDateInTz(t.due_at, zone) === today);
  const overdue = openTasks.filter(t => t.due_at && t.due_at < now);

  const stats = admin ? {
    active_clients: db.prepare(`SELECT COUNT(*) c FROM clients WHERE status = 'active'`).get().c,
    active_projects: db.prepare(`SELECT COUNT(*) c FROM projects WHERE status = 'active'`).get().c,
    pending_tasks: openTasks.length,
    overdue_tasks: overdue.length,
    due_today: dueToday.length,
    team_members: db.prepare(`SELECT COUNT(*) c FROM users WHERE active = 1 AND role = 'member'`).get().c,
  } : {
    my_tasks: openTasks.length,
    due_today: dueToday.length,
    overdue: overdue.length,
    completed_week: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status='completed' AND completed_at > ? AND assignee_id = ?`)
      .get(new Date(Date.now() - 7 * 864e5).toISOString(), req.user.id).c,
    unread_notifications: db.prepare('SELECT COUNT(*) c FROM in_app_messages WHERE user_id = ? AND read = 0').get(req.user.id).c,
  };

  let teamWorkload = [];
  if (admin) {
    teamWorkload = db.prepare(`SELECT id, name, title FROM users WHERE active = 1 AND role = 'member' ORDER BY name`).all().map(m => {
      const tasks = openTasks.filter(t => t.assignee_id === m.id);
      return {
        id: m.id, name: m.name, title: m.title,
        active_tasks: tasks.length,
        due_today: tasks.filter(t => t.due_at && fmtDateInTz(t.due_at, zone) === today).length,
        overdue: tasks.filter(t => t.due_at && t.due_at < now).length,
      };
    });
  }

  // real activity only (§19 "no fake statistics")
  const recentActivity = admin
    ? getActivity({ limit: 10 })
    : getActivity({ forUserId: req.user.id, limit: 10 });
  const upcomingReminders = admin ? db.prepare(`
    SELECT r.*, t.title AS task_title, u.name AS assignee_name, c.id AS client_id, p.id AS project_id
    FROM task_reminders r JOIN tasks t ON t.id = r.task_id
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE r.processed_at IS NULL
      AND (t.project_id IS NULL OR (SELECT status FROM projects WHERE id = t.project_id) != 'archived')
      AND (t.client_id IS NULL OR (SELECT status FROM clients WHERE id = t.client_id) != 'archived')
    ORDER BY r.remind_at ASC LIMIT 6`).all()
    .map(r => ({ ...r, remind_display: fmtInTz(r.remind_at, zone) })) : [];
  const myRecentNotifications = db.prepare(`
    SELECT n.* FROM notifications n WHERE n.recipient_id = ? AND n.channel != 'push' ORDER BY n.id DESC LIMIT 8`).all(req.user.id)
    .map(r => ({ ...r, when_display: fmtInTz(r.sent_at || r.created_at, zone) }));

  res.json({
    stats,
    dueToday: dueToday.slice(0, 8).map(serTask),
    overdueTasks: overdue.slice(0, 8).map(serTask),
    myTasks: admin ? [] : openTasks.slice(0, 8).map(serTask),
    upcoming: admin ? openTasks.slice(0, 8).map(serTask) : [],
    teamWorkload,
    recentActivity,
    upcomingReminders,
    myRecentNotifications,
    agencyTz: zone,
  });
});

/* ═══ Calendar (§22 — mobile can fetch the same feed) ══════════════════════ */
router.get('/calendar', requireAuth, (req, res) => {
  const { from, to } = req.query;
  const zone = tz();
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  const start = zonedToUtc(from, '00:00', zone).toISOString();
  const end = zonedToUtc(to, '23:59', zone).toISOString();
  const scope = isAdmin(req) ? '' : `AND t.assignee_id = ${Number(req.user.id)}`;
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.due_at IS NOT NULL AND t.due_at BETWEEN ? AND ?
      AND (t.project_id IS NULL OR (SELECT status FROM projects WHERE id = t.project_id) != 'archived')
      AND (t.client_id IS NULL OR (SELECT status FROM clients WHERE id = t.client_id) != 'archived')
      ${scope} ORDER BY t.due_at ASC`).all(start, end).map(serTask);
  const reminders = db.prepare(`
    SELECT r.*, t.title AS task_title, t.assignee_id FROM task_reminders r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.remind_at BETWEEN ? AND ? ${scope} ORDER BY r.remind_at ASC`).all(start, end)
    .map(r => {
      const rp = zonedParts(r.remind_at, zone);
      return {
        id: r.id, taskId: r.task_id, taskTitle: r.task_title,
        remindAt: r.remind_at, remindDisplay: fmtInTz(r.remind_at, zone),
        remindDate: rp.date, remindTime: rp.time,
        processed: !!r.processed_at, skipReason: r.skip_reason || null,
        task_title: r.task_title,
      };
    });
  res.json({ from, to, agencyTz: zone, tasks, reminders });
});

/* ═══ Reports (admin — real aggregates only) ═══════════════════════════════ */
router.get('/reports', requireAdmin, (req, res) => {
  const zone = tz();
  const now = new Date().toISOString();
  const today = fmtDateInTz(now, zone);
  const tasksByStatus = Object.fromEntries(TASK_STATUSES.map(s => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM tasks GROUP BY status').all()) {
    if (r.status in tasksByStatus) tasksByStatus[r.status] = r.c;
  }
  const byPriority = Object.fromEntries(['Low', 'Medium', 'High', 'Urgent'].map(p => [p, 0]));
  for (const r of db.prepare("SELECT priority, COUNT(*) c FROM tasks WHERE status != 'completed' GROUP BY priority").all()) {
    if (r.priority in byPriority) byPriority[r.priority] = r.c;
  }
  const perClient = db.prepare(`
    SELECT c.id, c.name,
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id AND p.status != 'archived') AS projects,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'completed') AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'completed' AND t.due_at IS NOT NULL AND t.due_at < ?) AS overdue
    FROM clients c WHERE c.status != 'archived' ORDER BY c.name`).all(now);
  const perMember = db.prepare(`SELECT id, name FROM users WHERE active = 1 AND role='member' ORDER BY name`).all().map(m => {
    const open = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assignee_id = ? AND status != 'completed'`).get(m.id).c;
    const done = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assignee_id = ? AND status = 'completed'`).get(m.id).c;
    const overdue = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assignee_id = ? AND status != 'completed' AND due_at IS NOT NULL AND due_at < ?`).get(m.id, now).c;
    return { id: m.id, name: m.name, open, completed: done, overdue };
  });
  const notifByStatus = db.prepare('SELECT status, COUNT(*) c FROM notifications GROUP BY status').all();
  const notifByChannel = db.prepare('SELECT channel, COUNT(*) c FROM notifications GROUP BY channel').all();
  const reminders = {
    scheduled: db.prepare('SELECT COUNT(*) c FROM task_reminders WHERE processed_at IS NULL').get().c,
    fired: db.prepare('SELECT COUNT(*) c FROM task_reminders WHERE processed_at IS NOT NULL AND skip_reason IS NULL').get().c,
    skipped: db.prepare('SELECT COUNT(*) c FROM task_reminders WHERE processed_at IS NOT NULL AND skip_reason IS NOT NULL').get().c,
  };
  res.json({ agencyTz: zone, today, tasksByStatus, byPriority, perClient, perMember, notifByStatus, notifByChannel, reminders });
});

/* ═══ Clients (§2/§3 — primary business entity) ════════════════════════════ */
router.get('/clients', requireAuth, (req, res) => {
  const ids = visibleClientIds(req);
  const where = ids === null ? "c.status != 'archived'" : `c.status != 'archived' AND c.id IN (${ids.map(() => '?').join(',') || 'NULL'})`;
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id AND p.status != 'archived') AS project_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status NOT IN ('completed')) AS open_tasks
    FROM clients c WHERE ${where} ORDER BY c.name`).all(...(ids || []));
  res.json(rows.map(r => ({ ...serClient(r), projectCount: r.project_count, openTasks: r.open_tasks, project_count: r.project_count, open_tasks: r.open_tasks })));
});

router.post('/clients', requireAdmin, (req, res) => {
  const f = req.body || {};
  if (!String(f.name || '').trim()) return res.status(400).json({ error: 'Client name is required' });
  const info = db.prepare(`INSERT INTO clients(name,contact_person,email,phone,notes,website,social,services,package,start_date,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.name.trim(), f.contact_person || f.contactPerson || '', f.email || '', f.phone || '', f.notes || '',
      f.website || '', JSON.stringify(f.social || {}), f.services || '', f.package || '', f.start_date || f.startDate || null,
      'active', nowIso());
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  logActivity({ entityType: 'client', entityId: client.id, clientId: client.id, actorId: req.user.id, action: 'created', detail: `Client "${client.name}" created` });
  res.json(serClient(client));
});

router.get('/clients/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c || c.status === 'archived' && !isAdmin(req)) return res.status(404).json({ error: 'Client not found' });
  if (!canSeeClient(req, c.id)) return res.status(403).json({ error: 'You are not authorized to view this client' });
  const projects = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed')) AS open_tasks
    FROM projects p WHERE p.client_id = ? AND p.status != 'archived' ORDER BY p.created_at DESC`).all(c.id)
    .map(p => ({ ...serProject({ ...p, client_name: c.name }), openTasks: p.open_tasks, open_tasks: p.open_tasks }));
  const scope = isAdmin(req) ? '' : `AND t.assignee_id = ${Number(req.user.id)}`;
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.client_id = ? ${scope}
    ORDER BY CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at ASC`).all(c.id).map(serTask);
  res.json({
    client: serClient(c),
    projects, tasks,
    files: listAttachments('client', c.id),
    activity: getActivity({ clientId: c.id }),
  });
});

router.patch('/clients/:id', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const f = req.body || {};
  db.prepare(`UPDATE clients SET name=?, contact_person=?, email=?, phone=?, notes=?, website=?, social=?, services=?, package=?, start_date=? WHERE id=?`)
    .run(f.name ?? c.name, f.contact_person ?? f.contactPerson ?? c.contact_person, f.email ?? c.email, f.phone ?? c.phone,
      f.notes ?? c.notes, f.website ?? c.website, f.social ? JSON.stringify(f.social) : (c.social || '{}'),
      f.services ?? c.services, f.package ?? c.package, f.start_date ?? f.startDate ?? c.start_date, c.id);
  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id);
  if (f.name && f.name !== c.name) logActivity({ entityType: 'client', entityId: c.id, clientId: c.id, actorId: req.user.id, action: 'updated', detail: `Client renamed to "${f.name}"` });
  else logActivity({ entityType: 'client', entityId: c.id, clientId: c.id, actorId: req.user.id, action: 'updated', detail: 'Client details updated' });
  res.json(serClient(updated));
});

/* §7 — archive (preferred) / restore. Archiving also archives its projects
 * and stops all reminders/overdue alerts for its tasks (§23). */
router.post('/clients/:id/archive', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const archive = !!(req.body && req.body.archive);
  if (archive && c.status === 'archived') return res.json({ ok: true, client: serClient(c) });
  const when = nowIso();
  if (archive) {
    db.prepare(`UPDATE clients SET status='archived', archived=1, archived_at=? WHERE id=?`).run(when, c.id);
    db.prepare(`UPDATE projects SET status='archived' WHERE client_id=? AND status NOT IN ('completed','archived')`).run(c.id);
    cancelRemindersForClient(c.id, 'Client archived — reminders cancelled');
    logActivity({ entityType: 'client', entityId: c.id, clientId: c.id, actorId: req.user.id, action: 'archived', detail: 'Client archived (projects archived, reminders cancelled)' });
  } else {
    db.prepare(`UPDATE clients SET status='active', archived=0, archived_at=NULL WHERE id=?`).run(c.id);
    logActivity({ entityType: 'client', entityId: c.id, clientId: c.id, actorId: req.user.id, action: 'restored', detail: 'Client restored to active' });
  }
  res.json({ ok: true, client: serClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id)) });
});
router.delete('/clients/:id', requireAdmin, (req, res) => { // legacy route → archive
  req.body = { archive: true };
  router.handle({ ...req, method: 'POST', url: `/api/clients/${req.params.id}/archive` }, res);
});

function cancelRemindersForClient(clientId, reason) {
  db.prepare(`UPDATE task_reminders SET processed_at=?, skip_reason=?
    WHERE processed_at IS NULL AND task_id IN (SELECT id FROM tasks WHERE client_id=?)`).run(nowIso(), reason, clientId);
}
function cancelRemindersForProject(projectId, reason) {
  db.prepare(`UPDATE task_reminders SET processed_at=?, skip_reason=?
    WHERE processed_at IS NULL AND task_id IN (SELECT id FROM tasks WHERE project_id=?)`).run(nowIso(), reason, projectId);
}

/* ═══ Projects (§2 — managed inside clients; global view kept for admin) ═══ */
router.get('/projects', requireAuth, (req, res) => {
  const ids = visibleProjectIds(req);
  const where = ids === null ? "p.status != 'archived'" : `p.status != 'archived' AND p.id IN (${ids.map(() => '?').join(',') || 'NULL'})`;
  const rows = db.prepare(`
    SELECT p.*, c.name AS client_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('completed')) AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS completed_tasks
    FROM projects p JOIN clients c ON c.id = p.client_id WHERE ${where} ORDER BY p.created_at DESC`).all(...(ids || []));
  res.json(rows.map(r => ({ ...serProject(r), openTasks: r.open_tasks, completedTasks: r.completed_tasks, open_tasks: r.open_tasks, completed_tasks: r.completed_tasks })));
});

router.post('/projects', requireAdmin, (req, res) => {
  const { client_id, name, description, start_date, end_date } = req.body || {};
  if (!name || !client_id) return res.status(400).json({ error: 'Project name and client are required' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(400).json({ error: 'Client not found' });
  const info = db.prepare(`INSERT INTO projects(client_id,name,description,status,start_date,end_date,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(client_id, String(name).trim(), description || '', 'active', start_date || null, end_date || null, nowIso());
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
  logActivity({ entityType: 'project', entityId: project.id, clientId: project.client_id, projectId: project.id, actorId: req.user.id, action: 'created', detail: `Project "${project.name}" created` });
  res.json(serProject(project));
});

router.get('/projects/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT p.*, c.name AS client_name, c.status AS client_status FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?').get(req.params.id);
  if (!p || (p.status === 'archived' && !isAdmin(req))) return res.status(404).json({ error: 'Project not found' });
  if (!canSeeProject(req, p.id)) return res.status(403).json({ error: 'You are not authorized to view this project' });
  const scope = isAdmin(req) ? '' : `AND t.assignee_id = ${Number(req.user.id)}`;
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? ${scope}
    ORDER BY CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at ASC`).all(p.id).map(serTask);
  // assigned team = real people working on this project's tasks
  const team = [...new Map(tasks.filter(t => t.assigneeId).map(t => [t.assigneeId, { id: t.assigneeId, name: t.assigneeName }])).values()];
  const updates = db.prepare(`
    SELECT pu.*, u.name AS created_by_name FROM project_updates pu LEFT JOIN users u ON u.id = pu.created_by
    WHERE pu.project_id = ? ORDER BY pu.created_at DESC`).all(p.id);
  res.json({
    project: serProject(p),
    client: serClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id)),
    tasks, team, updates,
    files: listAttachments('project', p.id),
    activity: getActivity({ projectId: p.id }),
  });
});

router.patch('/projects/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const f = req.body || {};
  // §6 — a project's client is fixed at creation; moving projects between clients would break the hierarchy
  db.prepare(`UPDATE projects SET name=?, description=?, status=?, start_date=?, end_date=? WHERE id=?`)
    .run(f.name ?? p.name, f.description ?? p.description, f.status ?? p.status,
      f.start_date ?? f.startDate ?? p.start_date, f.end_date ?? f.endDate ?? p.end_date, p.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
  if (f.status && f.status !== p.status) {
    logActivity({ entityType: 'project', entityId: p.id, clientId: p.client_id, projectId: p.id, actorId: req.user.id, action: 'status_changed', detail: `Project status: ${p.status} → ${f.status}` });
  } else {
    logActivity({ entityType: 'project', entityId: p.id, clientId: p.client_id, projectId: p.id, actorId: req.user.id, action: 'updated', detail: 'Project details updated' });
  }
  res.json(serProject(updated));
});

/* §7 — safe archive/restore; cancels reminders of its open tasks (§23) */
router.post('/projects/:id/archive', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const archive = !!(req.body && req.body.archive);
  if (archive) {
    db.prepare(`UPDATE projects SET status='archived' WHERE id=?`).run(p.id);
    cancelRemindersForProject(p.id, 'Project archived — reminders cancelled');
    logActivity({ entityType: 'project', entityId: p.id, clientId: p.client_id, projectId: p.id, actorId: req.user.id, action: 'archived', detail: 'Project archived (reminders cancelled)' });
  } else {
    db.prepare(`UPDATE projects SET status='active' WHERE id=?`).run(p.id);
    logActivity({ entityType: 'project', entityId: p.id, clientId: p.client_id, projectId: p.id, actorId: req.user.id, action: 'restored', detail: 'Project restored to active' });
  }
  res.json({ ok: true, project: serProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id)) });
});

/* §19 — Manual project update (only selected channels fire) */
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
    queued += engine.enqueue({
      eventId: `project_update:${update.id}`,
      eventType: 'project_update', templateKey: 'project_update',
      recipients: recipients.map(r => ({ id: r.id, name: r.name, email: r.email, phone: r.phone })),
      ctx, channels,
    }).length;
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
    engine.processPending().catch(() => {});
  }
  logActivity({ entityType: 'update', entityId: update.id, clientId: project.client_id, projectId: project.id, actorId: req.user.id, action: 'posted', detail: `Project update: ${title.trim()}` });
  res.json({ update, queued });
});

/* ═══ Tasks (§5/§6/§8 — global management + enforced hierarchy) ════════════ */
router.get('/tasks', requireAuth, (req, res) => {
  const { status, client_id, project_id, assignee_id, priority, due_from, due_to, q } = req.query;
  const where = []; const params = [];
  if (!isAdmin(req)) { where.push('t.assignee_id = ?'); params.push(req.user.id); }
  if (status === 'overdue') {
    where.push(`t.status != 'completed' AND t.due_at IS NOT NULL AND t.due_at < ?`); params.push(nowIso());
  } else if (status && status !== 'all') {
    where.push('t.status = ?'); params.push(status);
  }
  if (client_id) { where.push('t.client_id = ?'); params.push(client_id); }
  if (project_id) { where.push('t.project_id = ?'); params.push(project_id); }
  if (assignee_id) { where.push('t.assignee_id = ?'); params.push(assignee_id); }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (due_from) { where.push('t.due_at >= ?'); params.push(zonedToUtc(due_from, '00:00', tz()).toISOString()); }
  if (due_to) { where.push('t.due_at <= ?'); params.push(zonedToUtc(due_to, '23:59', tz()).toISOString()); }
  if (q) { where.push('(t.title LIKE ? OR t.description LIKE ? OR c.name LIKE ? OR p.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  // §23 — archived parents are hidden from the working list (admin can opt in)
  if (req.query.include_archived !== 'true') {
    where.push(`(t.project_id IS NULL OR (SELECT status FROM projects WHERE id = t.project_id) != 'archived')`);
    where.push(`(t.client_id IS NULL OR (SELECT status FROM clients WHERE id = t.client_id) != 'archived')`);
  }
  const rows = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN projects p ON p.id = t.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'completed' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at ASC
    LIMIT 500`).all(...params).map(serTask);
  res.json(rows);
});

router.get('/tasks/:id', requireAuth, (req, res) => {
  const t = db.prepare(`
    SELECT t.*, u.name AS assignee_name, c.name AS client_name, p.name AS project_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'This task is not assigned to you' });
  const zone = tz();
  const reminders = db.prepare('SELECT * FROM task_reminders WHERE task_id = ? ORDER BY remind_at ASC').all(t.id)
    .map(r => {
      const parts = zonedParts(r.remind_at, zone);
      return { ...r, remind_display: fmtInTz(r.remind_at, zone), remindDisplay: fmtInTz(r.remind_at, zone), date_part: parts.date, time_part: parts.time, processed: !!r.processed_at };
    });
  const comments = db.prepare(`
    SELECT cm.*, u.name AS author_name, u.role AS author_role FROM comments cm
    JOIN users u ON u.id = cm.author_id WHERE cm.task_id = ? ORDER BY cm.created_at ASC`).all(t.id);
  const checklist = db.prepare('SELECT * FROM task_checklist WHERE task_id = ? ORDER BY position ASC, id ASC').all(t.id);
  res.json({
    task: serTask(t),
    client: t.client_id ? serClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(t.client_id)) : null,
    project: t.project_id ? serProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(t.project_id)) : null,
    reminders, comments, checklist,
    attachments: listAttachments('task', t.id),
    activity: getActivity({ taskId: t.id }),
    agencyTz: zone,
  });
});

/* §6 — client → project → task. The project determines the client. */
function validateTaskParent(f, existingTask = null) {
  const projectId = f.project_id !== undefined ? f.project_id : (existingTask ? existingTask.project_id : null);
  if (projectId === null || projectId === '' || projectId === undefined) {
    return { error: 'A task must belong to a project (Client → Project → Task).' };
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { error: 'Selected project does not exist' };
  if (project.status === 'archived') return { error: 'That project is archived — restore it before adding tasks' };
  // enforce client/project consistency server-side (§6)
  if (f.client_id != null && f.client_id !== '' && Number(f.client_id) !== project.client_id) {
    return { error: 'Invalid combination: the selected project does not belong to the selected client' };
  }
  return { project };
}

router.post('/tasks', requireAdmin, (req, res) => {
  const f = req.body || {};
  if (!String(f.title || '').trim()) return res.status(400).json({ error: 'Task title is required' });
  const v = validateTaskParent(f);
  if (v.error) return res.status(400).json({ error: v.error });
  const project = v.project;
  const dueAt = (f.due_date && f.due_time) ? zonedToUtc(f.due_date, f.due_time, tz()).toISOString() : null;
  const estMin = f.estimated_minutes != null && f.estimated_minutes !== ''
    ? Math.round(Number(f.estimated_minutes)) : (f.estimated_hours ? Math.round(Number(f.estimated_hours) * 60) : null);
  const info = db.prepare(`INSERT INTO tasks(title,description,client_id,project_id,assignee_id,priority,due_at,status,estimated_minutes,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.title.trim(), f.description || '', project.client_id, project.id, f.assignee_id || null,
      f.priority || 'Medium', dueAt, TASK_STATUSES.includes(f.status) && f.status !== 'completed' ? f.status : 'pending',
      estMin, req.user.id, nowIso());
  const taskId = info.lastInsertRowid;
  for (const r of parseReminders(f.reminders)) {
    db.prepare('INSERT INTO task_reminders(task_id,remind_at,created_at) VALUES(?,?,?)').run(taskId, r.remind_at, nowIso());
  }
  if (Array.isArray(f.checklist)) {
    const insC = db.prepare('INSERT INTO task_checklist(task_id,text,done,position,created_at) VALUES(?,?,?,?,?)');
    f.checklist.filter(ci => String(ci.text || '').trim()).forEach((ci, i) => insC.run(taskId, String(ci.text).trim(), ci.done ? 1 : 0, i, nowIso()));
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  logActivity({ entityType: 'task', entityId: taskId, clientId: project.client_id, projectId: project.id, taskId, actorId: req.user.id, action: 'created', detail: `Task "${task.title}" created` });
  let queued = 0;
  if (task.assignee_id) queued = notifyAssignment(task, 'task_assigned', req.user);
  engine.processPending().catch(() => {});
  res.json({ task: serTask(task), queued });
});

/** §1-A/§1-D — assignment & reassignment notifications */
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
  engine.processPending().catch(() => {});
  return ids.length;
}

function parseReminders(list) {
  return (Array.isArray(list) ? list : [])
    .filter(r => r && r.date && r.time)
    .map(r => ({ date: r.date, time: r.time, remind_at: zonedToUtc(r.date, r.time, tz()).toISOString() }));
}

router.patch('/tasks/:id', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const f = req.body || {};
  const v = validateTaskParent(f, t);
  if (v.error) return res.status(400).json({ error: v.error });
  const project = v.project;
  const dueAt = ('due_date' in f || 'due_time' in f)
    ? ((f.due_date && f.due_time) ? zonedToUtc(f.due_date, f.due_time, tz()).toISOString() : null)
    : t.due_at;
  const estMin = 'estimated_minutes' in f ? (f.estimated_minutes === null || f.estimated_minutes === '' ? null : Math.round(Number(f.estimated_minutes))) : t.estimated_minutes;
  db.prepare(`UPDATE tasks SET title=?, description=?, project_id=?, client_id=?, assignee_id=?, priority=?, due_at=?, estimated_minutes=? WHERE id=?`)
    .run(f.title ?? t.title, f.description ?? t.description, project.id, project.client_id,
      f.assignee_id !== undefined ? (f.assignee_id || null) : t.assignee_id,
      f.priority ?? t.priority, dueAt, estMin, t.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);

  // reminder diff — pending reminders follow the admin's list
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

  logActivity({ entityType: 'task', entityId: t.id, clientId: task.client_id, projectId: task.project_id, taskId: t.id, actorId: req.user.id, action: 'updated', detail: 'Task details updated' });

  let queued = 0;
  if (f.assignee_id !== undefined && Number(f.assignee_id) !== Number(t.assignee_id)) {
    if (task.assignee_id) queued += notifyAssignment(task, 'task_reassigned', req.user);
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
    logActivity({ entityType: 'task', entityId: t.id, clientId: task.client_id, projectId: task.project_id, taskId: t.id, actorId: req.user.id, action: 'assigned', detail: `Task assigned to ${engine.userById(task.assignee_id)?.name || 'someone'}` });
    engine.processPending().catch(() => {});
  }
  res.json({ task: serTask(task), queued });
});

/* §5 — status transitions: pending / in_progress / on_hold / completed */
router.post('/tasks/:id/status', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'This task is not assigned to you' });
  const status = req.body && req.body.status;
  if (!TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (t.status === status) return res.json({ task: serTask(t), queued: 0 });
  if (status === 'completed') {
    req.params.id = String(t.id);
    return router.handle({ ...req, method: 'POST', url: `/api/tasks/${t.id}/complete` }, res);
  }
  db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, t.id);
  logActivity({ entityType: 'task', entityId: t.id, clientId: t.client_id, projectId: t.project_id, taskId: t.id, actorId: req.user.id, action: 'status_changed', detail: `Status: ${t.status} → ${status}` });
  res.json({ task: serTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id)), queued: 0 });
});

/* §6.5/§16 — completing cancels pending reminders; §9 admin alert */
router.post('/tasks/:id/complete', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'This task is not assigned to you' });
  if (t.status === 'completed') return res.status(400).json({ error: 'Task is already completed' });
  db.prepare("UPDATE tasks SET status='completed', completed_at=?, completed_by=?, overdue_notified=1 WHERE id=?").run(nowIso(), req.user.id, t.id);
  db.prepare(`UPDATE task_reminders SET processed_at = ?, skip_reason = ? WHERE task_id = ? AND processed_at IS NULL`)
    .run(nowIso(), 'Task completed before reminder time', t.id);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
  logActivity({ entityType: 'task', entityId: t.id, clientId: t.client_id, projectId: t.project_id, taskId: t.id, actorId: req.user.id, action: 'completed', detail: 'Task marked completed' });
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
  engine.processPending().catch(() => {});
  res.json({ task: serTask(task), queued });
});

router.post('/tasks/:id/comments', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'This task is not assigned to you' });
  const { body, important } = req.body || {};
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const info = db.prepare('INSERT INTO comments(task_id,author_id,body,important,created_at) VALUES(?,?,?,?,?)')
    .run(t.id, req.user.id, body.trim(), important ? 1 : 0, nowIso());
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  logActivity({ entityType: 'comment', entityId: comment.id, clientId: t.client_id, projectId: t.project_id, taskId: t.id, actorId: req.user.id, action: 'commented', detail: String(body).trim().slice(0, 120) });
  let queued = 0;
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
        engine.processPending().catch(() => {});
      }
    }
  }
  res.json({ comment, queued });
});

/* §5 — checklist */
router.post('/tasks/:id/checklist', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'This task is not assigned to you' });
  const text = String(req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Checklist item text is required' });
  const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM task_checklist WHERE task_id=?').get(t.id).p;
  const info = db.prepare('INSERT INTO task_checklist(task_id,text,done,position,created_at) VALUES(?,?,?,?,?)').run(t.id, text, 0, pos, nowIso());
  logActivity({ entityType: 'task', entityId: t.id, clientId: t.client_id, projectId: t.project_id, taskId: t.id, actorId: req.user.id, action: 'checklist_added', detail: `Added checklist item: ${text}` });
  res.json({ item: db.prepare('SELECT * FROM task_checklist WHERE id = ?').get(info.lastInsertRowid) });
});
router.patch('/checklist/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM task_checklist WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(item.task_id);
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'Not allowed' });
  const done = (req.body && req.body.done !== undefined) ? !!req.body.done : !!item.done;
  db.prepare('UPDATE task_checklist SET done=? WHERE id=?').run(done ? 1 : 0, item.id);
  if (done !== !!item.done) {
    logActivity({ entityType: 'task', entityId: t.id, clientId: t.client_id, projectId: t.project_id, taskId: t.id, actorId: req.user.id, action: 'checklist_toggled', detail: `${done ? 'Completed' : 'Reopened'}: ${item.text}` });
  }
  res.json({ item: db.prepare('SELECT * FROM task_checklist WHERE id = ?').get(item.id) });
});
router.delete('/checklist/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM task_checklist WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(item.task_id);
  if (!canSeeTask(req, t)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM task_checklist WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

/* §7 — hard task delete (admin only, with confirm dialog in UI). */
router.delete('/tasks/:id', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  for (const a of db.prepare("SELECT * FROM attachments WHERE entity_type='task' AND entity_id=?").all(t.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, a.stored_name)); } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id); // cascades reminders/comments/checklist
  res.json({ ok: true });
});

/* ═══ Attachments (files on client / project / task) ═══════════════════════ */
function listAttachments(entityType, entityId) {
  const rows = db.prepare(`
    SELECT a.*, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC`).all(entityType, entityId);
  const zone = tz();
  return rows.map(r => ({
    id: r.id, name: r.name, mime: r.mime, size: r.size,
    uploadedBy: r.uploaded_by_name || '—',
    createdAt: r.created_at,
    when_display: fmtInTz(r.created_at, zone),
    url: `/api/attachments/${r.id}/download`,
  }));
}
function attachmentContext(entityType, entityId) {
  if (entityType === 'task') {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(entityId);
    return t ? { row: t, client_id: t.client_id, project_id: t.project_id, task_id: t.id } : null;
  }
  if (entityType === 'project') {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(entityId);
    return p ? { row: p, client_id: p.client_id, project_id: p.id, task_id: null } : null;
  }
  if (entityType === 'client') {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(entityId);
    return c ? { row: c, client_id: c.id, project_id: null, task_id: null } : null;
  }
  return null;
}
router.post('/attachments/:type/:id', requireAuth, (req, res) => {
  const type = String(req.params.type);
  if (!['client', 'project', 'task'].includes(type)) return res.status(400).json({ error: 'Invalid attachment target' });
  const ctx = attachmentContext(type, Number(req.params.id));
  if (!ctx) return res.status(404).json({ error: 'Target not found' });
  if (type === 'task' && !canSeeTask(req, ctx.row)) return res.status(403).json({ error: 'Not allowed' });
  if (type !== 'task' && !isAdmin(req)) return res.status(403).json({ error: 'Only admins can attach files to clients and projects' });
  const { name, mime, data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: 'File name and data are required' });
  const buf = Buffer.from(String(data), 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 8 MB)' });
  if (!buf.length) return res.status(400).json({ error: 'File is empty' });
  const stored = crypto.randomBytes(10).toString('hex') + '_' + String(name).replace(/[^\w.\- ]+/g, '_').slice(-80);
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  const info = db.prepare(`INSERT INTO attachments(entity_type,entity_id,client_id,project_id,task_id,name,mime,size,stored_name,uploaded_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(type, ctx.row.id, ctx.client_id, ctx.project_id, ctx.task_id, String(name).slice(0, 200),
      mime || 'application/octet-stream', buf.length, stored, req.user.id, nowIso());
  if (type === 'task') {
    logActivity({ entityType: 'task', entityId: ctx.row.id, clientId: ctx.client_id, projectId: ctx.project_id, taskId: ctx.task_id, actorId: req.user.id, action: 'file_attached', detail: `Attached file: ${name}` });
  }
  res.json({ attachment: { id: info.lastInsertRowid, name, size: buf.length } });
});
router.get('/attachments/:id/download', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'File not found' });
  if (a.entity_type === 'task') {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(a.entity_id);
    if (!canSeeTask(req, t)) return res.status(403).json({ error: 'Not allowed' });
  } else if (a.entity_type === 'project' && !canSeeProject(req, a.entity_id)) {
    return res.status(403).json({ error: 'Not allowed' });
  } else if (a.entity_type === 'client' && !canSeeClient(req, a.entity_id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const fp = path.join(UPLOAD_DIR, a.stored_name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing from storage' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.name)}"`);
  res.send(fs.readFileSync(fp));
});
router.delete('/attachments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'File not found' });
  if (!isAdmin(req) && a.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Only admins (or the uploader) can delete files' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, a.stored_name)); } catch { /* ignore */ }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

/* ═══ Team (admin) ═════════════════════════════════════════════════════════ */
router.get('/team', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, role, name, email, phone, title, active, created_at FROM users ORDER BY role DESC, name').all();
  const openTasks = db.prepare("SELECT assignee_id, COUNT(*) c FROM tasks WHERE status != 'completed' GROUP BY assignee_id").all();
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
  const ins = db.prepare('INSERT INTO notification_prefs(user_id,event_type,whatsapp,email,in_app,push) VALUES(?,?,1,1,1,0)');
  for (const ev of Object.keys(engine.EVENT_LABELS)) ins.run(uid, ev);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)));
});
router.patch('/team/:id', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const f = req.body || {};
  db.prepare('UPDATE users SET name=?, email=?, phone=?, title=?, active=? WHERE id=?')
    .run(f.name ?? u.name, (f.email ?? u.email).trim(), f.phone ?? u.phone, f.title ?? u.title,
      f.active === undefined ? u.active : (f.active ? 1 : 0), u.id);
  if (f.password) db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPassword(String(f.password)), u.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});
router.get('/team/:id/prefs', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').all(req.params.id);
  res.json(Object.fromEntries(rows.map(r => [r.event_type, { whatsapp: !!r.whatsapp, email: !!r.email, in_app: !!r.in_app, push: !!r.push }])));
});
router.put('/team/:id/prefs', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (req.user.role !== 'admin' && req.user.id !== u.id) return res.status(403).json({ error: 'Not allowed' });
  const prefs = req.body || {};
  const ins = db.prepare(`INSERT INTO notification_prefs(user_id,event_type,whatsapp,email,in_app,push) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,event_type) DO UPDATE SET whatsapp=excluded.whatsapp, email=excluded.email, in_app=excluded.in_app, push=excluded.push`);
  db.exec('BEGIN');
  try {
    for (const ev of Object.keys(prefs)) {
      const p = prefs[ev] || {};
      ins.run(u.id, ev, p.whatsapp ? 1 : 0, p.email ? 1 : 0, p.in_app ? 1 : 0, p.push ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

/* ═══ Notifications: history, retry, in-app center ═════════════════════════ */
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
  const zone = tz();
  res.json({
    rows: rows.map(r => ({
      ...r,
      sent_display: r.sent_at ? fmtInTz(r.sent_at, zone) : null,
      created_display: fmtInTz(r.created_at, zone),
    })),
    tz: zone,
  });
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

/* ═══ Settings — secrets never leave the server (§17) ══════════════════════ */
const SETTING_KEYS = ['notificationSettings', 'reminderSettings', 'adminNotify', 'integrationSettings'];
function maskIntegrations(it) {
  const out = structuredClone(it);
  out.email.smtpPass = '';
  out.email.smtpHasPassword = !!it.email.smtpPass;
  out.whatsapp.apiToken = '';
  out.whatsapp.hasApiToken = !!it.whatsapp.apiToken;
  return out;
}
router.get('/settings', requireAdmin, (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  out.integrationSettings = maskIntegrations(out.integrationSettings);
  out.whatsappConfigured = !!(getSetting('integrationSettings').whatsapp.apiToken && getSetting('integrationSettings').whatsapp.phoneNumberId);
  const emailCfg = getSetting('integrationSettings').email;
  out.emailConfigured = !!(emailCfg.smtpHost && emailCfg.smtpPass);
  out.nodemailerInstalled = (() => { try { require.resolve('nodemailer'); return true; } catch { return false; } })();
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
  if (key === 'integrationSettings') {
    // §17 — secrets: empty means "keep existing" (masked in the UI)
    const current = getSetting('integrationSettings');
    if (!val.email) val.email = {};
    if (!val.whatsapp) val.whatsapp = {};
    if (!val.email.smtpPass) val.email.smtpPass = current.email.smtpPass || '';
    if (!val.whatsapp.apiToken) val.whatsapp.apiToken = current.whatsapp.apiToken || '';
    delete val.email.smtpHasPassword;
    delete val.whatsapp.hasApiToken;
  }
  setSetting(key, val);
  const out = key === 'integrationSettings' ? maskIntegrations(getSetting(key)) : getSetting(key);
  res.json(out);
});

/* §17 — Test SMTP Connection / Send Test Email */
router.post('/settings/test-smtp', requireAdmin, async (req, res) => {
  const saved = getSetting('integrationSettings').email;
  const f = (req.body || {});
  const cfg = {
    smtpHost: f.smtpHost ?? saved.smtpHost,
    smtpPort: f.smtpPort ?? saved.smtpPort,
    smtpSecure: f.smtpSecure ?? saved.smtpSecure,
    smtpUser: f.smtpUser ?? saved.smtpUser,
    smtpPass: f.smtpPass || saved.smtpPass, // empty → stored credential
    fromEmail: f.fromEmail ?? saved.fromEmail,
  };
  const result = await verifySmtp(cfg);
  res.json(result);
});
router.post('/settings/send-test-email', requireAdmin, async (req, res) => {
  const saved = getSetting('integrationSettings');
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  const cfg = { ...saved.email, websiteUrl: saved.websiteUrl };
  if (!cfg.smtpHost) return res.status(400).json({ error: 'SMTP is not configured (Settings → Integrations)' });
  try {
    const r = await sendTestEmail(cfg, to);
    logActivity({ entityType: 'notification', entityId: 0, actorId: req.user.id, action: 'smtp_test', detail: `Test email sent to ${to}` });
    res.json({ ok: true, message: `Test email sent to ${to}${r.response ? ` — ${r.response}` : ''}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ═══ Email templates (admin) ══════════════════════════════════════════════ */
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
    team_member_name: 'John Malik', first_name: 'John', client_name: 'Velocity Solar Power',
    project_name: 'Social Media Management', task_name: 'Create Facebook Post',
    task_description: 'Design and publish a promotional post announcing the winter discount.',
    priority: 'High', due_date: 'September 25, 2026', due_time: '5:00 PM',
    due_full: 'September 25, 2026 at 5:00 PM', reminder_time: 'September 25, 2026 at 3:00 PM',
    update_title: 'Client approved the new content strategy',
    update_message: 'The client approved the new content strategy. Proceed with scheduled posts.',
    admin_name: 'Ahmed Raza',
    dashboard_url: '/', website_url: getSetting('integrationSettings').websiteUrl || 'https://thepietechnologies.com/',
    logo_url: '/assets/logo-mark.png',
    year: String(new Date().getFullYear()),
    ...overrides,
  };
  const details = {
    client_name: sample.client_name, project_name: sample.project_name, task_name: sample.task_name,
    priority: sample.priority, due: sample.due_full, assignee: sample.team_member_name, reminder: sample.reminder_time,
  };
  if (req.params.key === 'project_update') { details.task_name = ''; details.due = ''; }
  if (req.params.key === 'whatsapp_failed') { details.task_name = sample.task_name; details.due = ''; details.assignee = 'John Malik'; }
  res.json({ ...renderEmail(tpl, sample, details) });
});

/* ═══ Scheduler (admin manual trigger) ═════════════════════════════════════ */
router.post('/admin/run-scheduler', requireAdmin, async (req, res) => {
  res.json(await runTick());
});

module.exports = router;
