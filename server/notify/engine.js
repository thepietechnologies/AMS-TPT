'use strict';
/* ─── Notification engine ──────────────────────────────────────────────────
 * Core rules enforced here (per the TPT notification charter):
 *  • Event-based ONLY — a notification must trace back to a real business
 *    event (assignment / admin-scheduled reminder / reassignment / project
 *    update / admin-configured status alert). Nothing else sends anything.
 *  • Dedup — every notification carries a unique event reference;
 *    the unique index makes double sends impossible (even if the scheduler
 *    runs twice).
 *  • Channel control — global per-event toggles (§13), per-member
 *    preferences (§14), admin override for critical events.
 *  • Failure isolation — a failed WhatsApp/email never fails the task (§17);
 *    failures are logged and retryable.
 */
const { db, getSetting } = require('../db');
const { rid, nowIso, applyVars } = require('../util');
const { fmtInTz, fmtDateInTz, fmtTimeInTz } = require('../timezone');
const { renderEmail } = require('./templates');
const { sendWhatsApp, sendEmail } = require('./providers');

const CRITICAL_EVENTS_DEFAULT = ['task_assigned', 'task_reminder', 'task_reassigned', 'task_overdue'];

const EVENT_LABELS = {
  task_assigned: 'Task Assigned',
  task_reminder: 'Task Reminder',
  task_reassigned: 'Task Reassigned',
  project_update: 'Project Update',
  task_completed: 'Task Completed',
  task_overdue: 'Task Overdue',
  task_comment: 'Task Comment',
  whatsapp_failed: 'WhatsApp Failed',
};

/* ─── Context / copy builders ────────────────────────────────────────────── */

function buildContext({ taskRow, projectRow, updateRow, commentRow, recipient, actor, extra = {} }) {
  const reminder = getSetting('reminderSettings');
  const integration = getSetting('integrationSettings');
  const tz = reminder.timezone;
  const ctx = {
    tz,
    integration,
    task: taskRow || null,
    client: null, project: projectRow || null,
    recipient, actor, update: updateRow || null, comment: commentRow || null,
    ...extra,
  };
  if (taskRow) {
    if (taskRow.client_id) ctx.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(taskRow.client_id) || null;
    if (!projectRow && taskRow.project_id) ctx.project = db.prepare('SELECT * FROM projects WHERE id = ?').get(taskRow.project_id) || null;
    if (!ctx.assignee && taskRow.assignee_id) ctx.assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(taskRow.assignee_id) || null;
  }
  if (projectRow && !ctx.client && projectRow.client_id) {
    ctx.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(projectRow.client_id) || null;
  }
  return ctx;
}

function buildVars(ctx) {
  const { task, client, project, recipient, update, comment } = ctx;
  const tz = ctx.tz;
  const integration = getSetting('integrationSettings');
  const rawAppUrl = integration.appUrl || '';
  // When the app URL is still a localhost default, use same-origin links so
  // previews/CTAs work in any host (production deployments set a real domain).
  const appUrl = /localhost|127\.0\.0\.1/.test(rawAppUrl) ? '' : rawAppUrl;
  return {
    team_member_name: (recipient && recipient.name) || 'Team Member',
    first_name: recipient ? String(recipient.name || '').split(' ')[0] : 'Team Member',
    client_name: (client && client.name) || '—',
    project_name: (project && project.name) || (task && task.project_id ? projectName(task.project_id) : '—'),
    task_name: (task && task.title) || '—',
    task_description: (task && task.description) || '',
    priority: (task && task.priority) || '',
    due_date: task && task.due_at ? fmtDateInTz(task.due_at, tz) : '',
    due_time: task && task.due_at ? fmtTimeInTz(task.due_at, tz) : '',
    due_full: task && task.due_at ? fmtInTz(task.due_at, tz) : '',
    reminder_time: ctx.reminderTime || '',
    update_title: (update && update.title) || '',
    update_message: (update && update.message) || (comment && comment.body) || '',
    admin_name: integration.adminName || 'Admin',
    dashboard_url: appUrl ? `${appUrl}/` : '/',
    website_url: integration.websiteUrl || 'https://thepietechnologies.com/',
    logo_url: appUrl ? `${appUrl}/assets/logo-mark.png` : '/assets/logo-mark.png',
    year: String(new Date().getFullYear()),
  };
}
function projectName(id) {
  const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(id);
  return p ? p.name : '';
}

/** Plain-text WhatsApp copy — matches the exact approved formats (§1). */
function whatsappText(eventType, ctx, v) {
  const lines = [];
  const sign = '— The Pie Technologies';
  if (eventType === 'task_assigned' || eventType === 'task_reassigned') {
    lines.push(eventType === 'task_assigned' ? '*New Task Assigned*' : '*Task Assigned to You*');
    lines.push('');
    lines.push(`Hi ${v.first_name},`);
    lines.push('');
    lines.push(eventType === 'task_assigned'
      ? 'A new task has been assigned to you.'
      : 'A task has been assigned to you:');
    if (v.client_name !== '—') lines.push('');
    lines.push(`Client: ${v.client_name}`);
    if (v.project_name !== '—') lines.push(`Project: ${v.project_name}`);
    lines.push(`Task: ${v.task_name}`);
    if (v.priority) lines.push(`Priority: ${v.priority}`);
    if (v.due_full) lines.push(`Due: ${v.due_full}`);
    lines.push('');
    lines.push('Please log in to your TPT dashboard to view the complete task details.');
    lines.push('');
    lines.push(sign);
  } else if (eventType === 'task_reminder') {
    lines.push('*Task Reminder*');
    lines.push('');
    lines.push(`Hi ${v.first_name},`);
    lines.push('');
    lines.push('This is a reminder for your assigned task:');
    lines.push('');
    lines.push(`Client: ${v.client_name}`);
    if (v.project_name !== '—') lines.push(`Project: ${v.project_name}`);
    lines.push(`Task: ${v.task_name}`);
    if (v.due_full) lines.push(`Due: ${v.due_full}`);
    lines.push('');
    lines.push('Please complete the task before the deadline.');
    lines.push('');
    lines.push(sign);
  } else if (eventType === 'project_update') {
    lines.push('*Project Update*');
    lines.push('');
    lines.push(`Hi ${v.first_name},`);
    lines.push('');
    lines.push('There has been an update to your project:');
    lines.push('');
    lines.push(`Client: ${v.client_name}`);
    lines.push(`Project: ${v.project_name}`);
    lines.push('');
    lines.push('Update:');
    lines.push(v.update_title || '');
    lines.push(v.update_message || '');
    lines.push('');
    lines.push('Please check the TPT dashboard for details.');
    lines.push('');
    lines.push(sign);
  } else if (eventType === 'task_overdue') {
    lines.push('*Task Overdue*');
    lines.push('');
    lines.push(`Hi ${v.first_name},`);
    lines.push('');
    lines.push('The following task is overdue and still incomplete:');
    lines.push('');
    lines.push(`Client: ${v.client_name}`);
    lines.push(`Task: ${v.task_name}`);
    if (v.due_full) lines.push(`Due: ${v.due_full}`);
    lines.push('');
    lines.push('Please complete it as soon as possible.');
    lines.push('');
    lines.push(sign);
  } else if (eventType === 'task_completed') {
    lines.push('*Task Completed*');
    lines.push('');
    lines.push(`${v.task_name} has been marked as completed.`);
    lines.push('');
    lines.push(`Client: ${v.client_name}`);
    lines.push(`Completed by: ${ctx.actor ? ctx.actor.name : 'Team member'}`);
    lines.push('');
    lines.push(sign);
  } else if (eventType === 'whatsapp_failed') {
    lines.push('*WhatsApp Notification Failed*');
    lines.push('');
    lines.push(`A WhatsApp notification for "${v.task_name || 'an event'}" could not be delivered to ${ctx.failedRecipient || 'the recipient'}.`);
    lines.push('');
    lines.push('The task was processed successfully — only the WhatsApp message failed. You can retry it from Notification History.');
    lines.push('');
    lines.push(sign);
  } else if (eventType === 'task_comment') {
    lines.push('*New Task Comment*');
    lines.push('');
    lines.push(`${ctx.actor ? ctx.actor.name : 'A team member'} commented on "${v.task_name}":`);
    lines.push('');
    lines.push(v.update_message || '');
    lines.push('');
    lines.push(sign);
  } else {
    lines.push(`*${EVENT_LABELS[eventType] || 'Notification'}*`, '', v.task_name || '');
  }
  return lines.filter(l => l !== undefined).join('\n');
}

function inAppCopy(eventType, ctx, v) {
  switch (eventType) {
    case 'task_assigned': return { title: 'New task assigned', body: `${v.task_name} — ${v.client_name}${v.due_full ? ` · due ${v.due_full}` : ''}`, link: `#/tasks/${ctx.task.id}` };
    case 'task_reassigned': return { title: 'Task assigned to you', body: `${v.task_name} — ${v.client_name}${v.due_full ? ` · due ${v.due_full}` : ''}`, link: `#/tasks/${ctx.task.id}` };
    case 'task_reassigned_from': return { title: 'Task reassigned', body: `${v.task_name} has been reassigned to another team member.`, link: `#/tasks/${ctx.task.id}` };
    case 'task_reminder': return { title: 'Task reminder', body: `${v.task_name}${v.due_full ? ` · due ${v.due_full}` : ''}`, link: `#/tasks/${ctx.task.id}` };
    case 'task_overdue': return { title: 'Task overdue', body: `${v.task_name}${v.due_full ? ` · was due ${v.due_full}` : ''}`, link: `#/tasks/${ctx.task.id}` };
    case 'task_completed': return { title: 'Task completed', body: `${v.task_name} — completed by ${ctx.actor ? ctx.actor.name : 'team member'}`, link: `#/tasks/${ctx.task.id}` };
    case 'project_update': return { title: `Project update: ${v.project_name}`, body: `${v.update_title}${v.update_title ? ' — ' : ''}${v.update_message}`, link: `#/projects/${ctx.project ? ctx.project.id : (ctx.task ? ctx.task.project_id : '')}` };
    case 'task_comment': return { title: `New comment on "${v.task_name}"`, body: `${ctx.actor ? ctx.actor.name : 'A team member'}: ${v.update_message}`, link: `#/tasks/${ctx.task.id}` };
    case 'whatsapp_failed': return { title: 'WhatsApp notification failed', body: `Delivery to ${ctx.failedRecipient || 'recipient'} failed for "${v.task_name || 'an event'}". Retry from Notification History.`, link: '#/history' };
    default: return { title: EVENT_LABELS[eventType] || 'Notification', body: v.task_name || '', link: '#/dashboard' };
  }
}

/* ─── Enqueue ────────────────────────────────────────────────────────────── */

const insNotification = db.prepare(`INSERT INTO notifications
  (event_id,event_type,channel,recipient_id,recipient_label,client_id,project_id,task_id,subject,message,meta,status,status_reason,scheduled_at,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function admins() {
  return db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
}
function userById(id) {
  return id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
}

/**
 * Queue one business event for delivery across channels.
 *  options:
 *   eventId      — unique dedup reference for this exact event
 *   eventType    — key in channel-control matrix + prefs
 *   templateKey  — email template (defaults to eventType)
 *   recipients   — [{ id?, name, email, phone, label? }]
 *   ctx          — buildContext() result
 *   channels     — optional override (e.g. manual project-update checkboxes)
 *   skipPrefs    — true for admin-alert events governed by adminNotify toggles
 */
function enqueue({ eventId, eventType, templateKey, recipients, ctx, channels, skipPrefs = false }) {
  const notif = getSetting('notificationSettings');
  const matrix = notif.events[eventType] || { whatsapp: false, email: false, in_app: false };
  const critical = (notif.criticalEvents || CRITICAL_EVENTS_DEFAULT).includes(eventType);
  const override = !!notif.adminOverrideCritical && critical;
  const active = Array.isArray(channels) ? channels : ['whatsapp', 'email', 'in_app'].filter(c => matrix[c]);
  const queued = [];

  for (const rcpt of recipients) {
    const prefs = rcpt.id
      ? db.prepare('SELECT * FROM notification_prefs WHERE user_id = ? AND event_type = ?').get(rcpt.id, eventType)
      : null;
    const vars = buildVars({ ...ctx, recipient: rcpt });
    const waText = whatsappText(templateKey === 'task_reassigned_from' ? 'task_reassigned' : eventType, ctx, vars);
    const app = inAppCopy(templateKey || eventType, ctx, vars);

    for (const channel of active) {
      if (!Array.isArray(channels) && !matrix[channel]) continue;        // §13 global control
      if (!skipPrefs && prefs && !prefs[channel]) {                       // §14 member prefs
        if (!override) {
          insNotification.run(eventId, eventType, channel, rcpt.id || null, rcpt.label || rcpt.name || '—',
            ctx.client ? ctx.client.id : null, ctx.project ? ctx.project.id : null, ctx.task ? ctx.task.id : null,
            '', '', JSON.stringify({ skip: 'recipient_preferences' }),
            'skipped', 'Disabled in this member\'s notification preferences', nowIso(), nowIso());
          continue;
        }
      }
      const meta = {};
      if (channel === 'email') {
        const tpl = db.prepare('SELECT * FROM email_templates WHERE key = ?').get(templateKey || eventType);
        if (!tpl) continue;
        const details = {
          client_name: vars.client_name, project_name: vars.project_name,
          task_name: vars.task_name, priority: vars.priority,
          due: vars.due_full || vars.due_date, assignee: rcpt.name,
          reminder: vars.reminder_time,
        };
        const rendered = renderEmail(tpl, vars, details);
        meta.subject = rendered.subject; meta.html = rendered.html; meta.to = rcpt.email;
      } else if (channel === 'whatsapp') {
        meta.text = waText; meta.to = rcpt.phone;
      } else {
        meta.title = app.title; meta.body = app.body; meta.link = app.link;
      }
      if (channel === 'email' && !rcpt.email) { rcptWarn(rcpt, 'email'); continue; }
      if (channel === 'whatsapp' && !rcpt.phone) { rcptWarn(rcpt, 'whatsapp'); continue; }

      // §16 — dedup: the unique index makes this insert fail on any re-run
      const info = insNotification.run(
        eventId, eventType, channel, rcpt.id || null, rcpt.label || rcpt.name || '—',
        ctx.client ? ctx.client.id : null, ctx.project ? ctx.project.id : null, ctx.task ? ctx.task.id : null,
        channel === 'email' ? meta.subject : (meta.title || ''),
        channel === 'email' ? snippetFromHtml(meta.html) : (meta.text || meta.body || ''),
        JSON.stringify(meta), 'pending', '', nowIso(), nowIso());
      if (info.changes > 0) queued.push(info.lastInsertRowid);
    }
  }
  return queued;
}

function rcptWarn(rcpt, channel) {
  console.warn(`[notify] ${channel} skipped for ${rcpt.name || rcpt.label}: no ${channel === 'email' ? 'email address' : 'WhatsApp number'} on profile`);
}
function snippetFromHtml(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 220);
}

/* ─── Delivery worker ────────────────────────────────────────────────────── */

const selectPending = db.prepare("SELECT * FROM notifications WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY id ASC");
const claimRow = db.prepare("UPDATE notifications SET status = 'sending', scheduled_at = ? WHERE id = ? AND status = 'pending'");
const reclaimStale = db.prepare("UPDATE notifications SET status = 'pending' WHERE status = 'sending' AND scheduled_at < ?");
const markSent = db.prepare("UPDATE notifications SET status = 'sent', sent_at = ?, error = '' WHERE id = ?");
const markFailed = db.prepare("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?");
const insInApp = db.prepare('INSERT INTO in_app_messages(user_id,notification_id,event_type,title,body,link,created_at) VALUES(?,?,?,?,?,?,?)');

/* Serialize delivery so overlapping callers (API + scheduler) can't double-send */
let deliveryChain = Promise.resolve();
function deliverOne(row) {
  const integration = getSetting('integrationSettings');
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* ignore */ }

  if (row.channel === 'in_app') {
    if (row.recipient_id) {
      insInApp.run(row.recipient_id, row.id, row.event_type, meta.title || row.subject, meta.body || row.message, meta.link || '', nowIso());
    }
    markSent.run(nowIso(), row.id);
    return { ok: true };
  }
  if (row.channel === 'whatsapp') {
    return sendWhatsApp(integration, meta.to || (row.recipient_label || ''), meta.text || row.message)
      .then(() => { markSent.run(nowIso(), row.id); return { ok: true }; })
      .catch(err => { markFailed.run(String(err.message || err), row.id); return { ok: false, err }; });
  }
  if (row.channel === 'email') {
    return sendEmail(integration, { to: meta.to, subject: meta.subject, html: meta.html })
      .then(() => { markSent.run(nowIso(), row.id); return { ok: true }; })
      .catch(err => { markFailed.run(String(err.message || err), row.id); return { ok: false, err }; });
  }
  return Promise.resolve({ ok: true });
}

async function processPending() {
  // chain onto any in-flight delivery loop; reclaim rows stuck in 'sending' > 2 min
  reclaimStale.run(new Date(Date.now() - 2 * 60e3).toISOString());
  const run = deliveryChain.catch(() => {}).then(async () => {
    const rows = selectPending.all(nowIso());
    let failedWhatsapp = [];
    for (const row of rows) {
      // Atomic claim — if another worker already took it, skip (§16 no double sends)
      const claimed = claimRow.run(nowIso(), row.id);
      if (claimed.changes === 0) continue;
      try {
        const res = await deliverOne(row);
        if (!res.ok && row.channel === 'whatsapp') failedWhatsapp.push(row);
      } catch (err) {
        markFailed.run(String(err.message || err), row.id);
        if (row.channel === 'whatsapp') failedWhatsapp.push(row);
      }
    }
    // §9/§17 — tell admins when a WhatsApp delivery fails (deduped per notification)
    const adminCfg = getSetting('adminNotify');
    if (adminCfg.onWhatsAppFailed && (adminCfg.onWhatsAppFailed.email || adminCfg.onWhatsAppFailed.in_app)) {
      for (const row of failedWhatsapp) {
        const rcptName = row.recipient_label || 'team member';
        const task = row.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id) : null;
        const ctx = buildContext({ taskRow: task, extra: { failedRecipient: rcptName } });
        enqueue({
          eventId: `whatsapp_failed:${row.id}`,
          eventType: 'whatsapp_failed',
          recipients: admins().map(a => ({ id: a.id, name: a.name, email: a.email, phone: a.phone })),
          ctx, skipPrefs: true,
          channels: ['email', 'in_app'].filter(c => adminCfg.onWhatsAppFailed[c]),
        });
      }
      if (failedWhatsapp.length) {
        const inner = selectPending.all(nowIso());
        for (const row of inner) {
          const claimed = claimRow.run(nowIso(), row.id);
          if (claimed.changes === 0) continue;
          try { await deliverOne(row); } catch (err) { markFailed.run(String(err.message || err), row.id); }
        }
      }
    }
    return rows.length;
  });
  deliveryChain = run;
  return run;
}

async function retryNotification(id) {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  if (!row) throw new Error('Notification not found');
  if (row.status !== 'failed') throw new Error('Only failed notifications can be retried');
  db.prepare("UPDATE notifications SET status = 'pending', retry_count = retry_count + 1, error = '' WHERE id = ?").run(id);
  await processPending();
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
}

module.exports = {
  enqueue, processPending, retryNotification, buildContext,
  buildVars, whatsappText, inAppCopy, admins, userById,
  EVENT_LABELS,
};
