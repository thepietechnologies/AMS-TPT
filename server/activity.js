'use strict';
/* ─── Activity log — real events only (client/project/task history) ──────── */
const { db, getSetting } = require('./db');
const { nowIso } = require('./util');

const ins = db.prepare(`INSERT INTO activity_log
  (entity_type,entity_id,client_id,project_id,task_id,actor_id,action,detail,created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);

/**
 * logActivity({ entityType, entityId, clientId, projectId, taskId, actorId, action, detail, at })
 * Never throws into the caller's flow — logging must not break business ops.
 */
function logActivity({ entityType, entityId, clientId = null, projectId = null, taskId = null, actorId = null, action, detail = '', at = null }) {
  try {
    ins.run(entityType, entityId, clientId, projectId, taskId, actorId, action, detail, at || nowIso());
  } catch (e) {
    console.error('[activity] log failed:', e.message);
  }
}

/** Timeline for a client / project / task — or global (latest first). */
function getActivity({ clientId, projectId, taskId, forUserId, limit = 40 } = {}) {
  const where = []; const params = [];
  if (taskId) { where.push('a.task_id = ?'); params.push(taskId); }
  else if (projectId) { where.push('a.project_id = ?'); params.push(projectId); }
  else if (clientId) { where.push('a.client_id = ?'); params.push(clientId); }
  else if (forUserId) {
    // member scope: activity on their tasks/clients, or actions they performed
    where.push('(a.actor_id = ? OR a.task_id IN (SELECT id FROM tasks WHERE assignee_id = ?) OR a.client_id IN (SELECT DISTINCT client_id FROM tasks WHERE assignee_id = ?))');
    params.push(forUserId, forUserId, forUserId);
  }
  const tz = getSetting('reminderSettings').timezone;
  const { fmtInTz } = require('./timezone');
  return db.prepare(`
    SELECT a.*, u.name AS actor_name FROM activity_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(...params, limit)
    .map(r => ({ ...r, when_display: fmtInTz(r.created_at, tz) }));
}

module.exports = { logActivity, getActivity };
