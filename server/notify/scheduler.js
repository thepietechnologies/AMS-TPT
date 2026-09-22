'use strict';
/* ─── Scheduler: reminders + overdue detection + delivery worker ───────────
 * §2  — there is NO daily digest and NO automatic reminder. The only things
 *        this loop ever sends are reminders an Admin explicitly scheduled,
 *        and (if enabled) a one-time overdue alert.
 * §6  — every reminder must pass ALL condition checks before sending.
 * §16 — the dedup ledger makes double-sends impossible even if this tick
 *        runs twice.
 * §22 — reminder instants are exact UTC timestamps derived from the
 *        Admin-selected wall-clock time + agency timezone (default PKT).
 */
const { db, getSetting } = require('../db');
const { nowIso } = require('../util');
const engine = require('./engine');
const { logActivity } = require('../activity');

/* §23 — archived/deleted parents silence reminders and overdue alerts */
function parentArchived(task) {
  if (task.project_id) {
    const p = db.prepare('SELECT status FROM projects WHERE id = ?').get(task.project_id);
    if (p && p.status === 'archived') return 'Project archived — reminders stopped';
  }
  if (task.client_id) {
    const c = db.prepare('SELECT status FROM clients WHERE id = ?').get(task.client_id);
    if (c && c.status === 'archived') return 'Client archived — reminders stopped';
  }
  return null;
}

async function processDueReminders() {
  const due = db.prepare(`
    SELECT r.id AS reminder_id, r.task_id AS task_id, r.remind_at, t.*
    FROM task_reminders r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.processed_at IS NULL AND r.remind_at <= ?
    ORDER BY r.remind_at ASC`).all(nowIso());

  let fired = 0, skipped = 0;
  for (const row of due) {
    const reminderId = row.reminder_id;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id);

    // §6.1 — does the task still exist?
    if (!task) {
      db.prepare('UPDATE task_reminders SET processed_at = ?, skip_reason = ? WHERE id = ?')
        .run(nowIso(), 'Task no longer exists', reminderId);
      skipped++; continue;
    }
    // §23 — archived clients/projects must not keep triggering reminders
    const parentBlock = parentArchived(task);
    if (parentBlock) {
      db.prepare('UPDATE task_reminders SET processed_at = ?, skip_reason = ? WHERE id = ?')
        .run(nowIso(), parentBlock, reminderId);
      logActivity({ entityType: 'reminder', entityId: reminderId, clientId: task.client_id, projectId: task.project_id, taskId: task.id, action: 'reminder_skipped', detail: parentBlock });
      skipped++; continue;
    }
    const assignee = task.assignee_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(task.assignee_id) : null;

    // §6.2 — is the task assigned?
    if (!assignee || !assignee.active) {
      auditSkippedReminder(reminderId, task, null, 'Task has no active assignee — nothing sent');
      db.prepare('UPDATE task_reminders SET processed_at = ?, skip_reason = ? WHERE id = ?')
        .run(nowIso(), 'Task not assigned', reminderId);
      skipped++; continue;
    }
    // §6.5 — is the task already completed?
    if (task.status === 'completed') {
      auditSkippedReminder(reminderId, task, assignee, 'Task completed before the reminder time — reminder not sent');
      db.prepare('UPDATE task_reminders SET processed_at = ?, skip_reason = ? WHERE id = ?')
        .run(nowIso(), 'Task completed before reminder time', reminderId);
      skipped++; continue;
    }

    // All conditions satisfied → deliver (dedup guard inside enqueue, §6.6)
    const ctx = engine.buildContext({
      taskRow: task,
      recipient: assignee,
      extra: { reminderTime: fmtReminder(reminderId) },
    });
    engine.enqueue({
      eventId: `task_reminder:${reminderId}`,
      eventType: 'task_reminder',
      recipients: [{ id: assignee.id, name: assignee.name, email: assignee.email, phone: assignee.phone }],
      ctx,
    });
    db.prepare('UPDATE task_reminders SET processed_at = ? WHERE id = ?').run(nowIso(), reminderId);
    logActivity({ entityType: 'reminder', entityId: reminderId, clientId: task.client_id, projectId: task.project_id, taskId: task.id, action: 'reminder_sent', detail: 'Reminder sent at the scheduled time' });
    fired++;
  }
  return { remindersFired: fired, remindersSkipped: skipped };
}

function fmtReminder(reminderId) {
  const r = db.prepare('SELECT remind_at FROM task_reminders WHERE id = ?').get(reminderId);
  if (!r) return '';
  const { fmtInTz } = require('../timezone');
  const tz = getSetting('reminderSettings').timezone;
  return `Scheduled for ${fmtInTz(r.remind_at, tz)}`;
}

/** One transparent audit line (status = skipped) so admins see WHY nothing was sent. */
function auditSkippedReminder(reminderId, task, assignee, reason) {
  try {
    db.prepare(`INSERT INTO notifications
      (event_id,event_type,channel,recipient_id,recipient_label,client_id,project_id,task_id,subject,message,meta,status,status_reason,scheduled_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`task_reminder_skip:${reminderId}`, 'task_reminder', 'in_app',
        assignee ? assignee.id : null, assignee ? assignee.name : '—',
        task.client_id, task.project_id, task.id,
        'Reminder not sent', reason, '{}', 'skipped', reason, nowIso(), nowIso());
  } catch { /* dedup collision — already audited */ }
}

async function detectOverdue() {
  const adminCfg = getSetting('adminNotify');
  const overdue = db.prepare(`
    SELECT * FROM tasks t
    WHERE t.status NOT IN ('completed') AND t.due_at IS NOT NULL AND t.due_at < ? AND t.overdue_notified = 0
      AND (t.project_id IS NULL OR (SELECT status FROM projects WHERE id = t.project_id) != 'archived')
      AND (t.client_id IS NULL OR (SELECT status FROM clients WHERE id = t.client_id) != 'archived')
    ORDER BY t.due_at ASC`).all(nowIso());

  let count = 0;
  for (const task of overdue) {
    db.prepare('UPDATE tasks SET overdue_notified = 1 WHERE id = ?').run(task.id); // one alert per task, ever
    count++;
    const assignee = task.assignee_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(task.assignee_id) : null;
    if (assignee) {
      const ctx = engine.buildContext({ taskRow: task, recipient: assignee });
      engine.enqueue({
        eventId: `task_overdue:${task.id}:${assignee.id}`,
        eventType: 'task_overdue',
        recipients: [{ id: assignee.id, name: assignee.name, email: assignee.email, phone: assignee.phone }],
        ctx,
      });
    }
    if (adminCfg.onTaskOverdue && (adminCfg.onTaskOverdue.email || adminCfg.onTaskOverdue.in_app)) {
      const matrix = getSetting('notificationSettings').events.task_overdue;
      const channels = ['email', 'in_app'].filter(c => adminCfg.onTaskOverdue[c] && matrix[c]);
      if (channels.length) {
        const ctx = engine.buildContext({ taskRow: task, recipient: null });
        engine.enqueue({
          eventId: `task_overdue_admin:${task.id}`,
          eventType: 'task_overdue',
          recipients: engine.admins().map(a => ({ id: a.id, name: a.name, email: a.email, phone: a.phone })),
          ctx, skipPrefs: true, channels,
        });
      }
    }
  }
  return { overdueDetected: count };
}

let running = false;
async function runTick() {
  if (running) return { skipped: true, reason: 'previous tick still running' };
  running = true;
  try {
    const reminders = await processDueReminders();
    const overdue = await detectOverdue();
    const queued = await engine.processPending();
    return { ...reminders, ...overdue, queued, at: nowIso() };
  } finally {
    running = false;
  }
}

function startScheduler() {
  // Run once at boot, then every 20 s. A 20 s cadence keeps reminder delivery
  // within half a minute of the exact Admin-chosen minute.
  runTick().catch(err => console.error('[scheduler] boot tick failed:', err.message));
  setInterval(() => runTick().catch(err => console.error('[scheduler] tick failed:', err.message)), 20000);
  console.log('[scheduler] running — reminder checks every 20s (event-based only, no digests)');
}

module.exports = { runTick, startScheduler };
