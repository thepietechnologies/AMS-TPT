'use strict';
/* ─── Database: schema + defaults + seed ─────────────────────────────────── */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { hashPassword } = require('./util');
const { zonedToUtc } = require('./timezone');
const { SEED_TEMPLATES, TEMPLATE_KEYS } = require('./notify/templates');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'ams.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');

/* ─── Schema ─────────────────────────────────────────────────────────────── */
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL DEFAULT 'member',          -- 'admin' | 'member'
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  password TEXT NOT NULL,
  title TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused | completed
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_by INTEGER,
  send_whatsapp INTEGER NOT NULL DEFAULT 0,
  send_email INTEGER NOT NULL DEFAULT 0,
  send_inapp INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'Medium',      -- Low | Medium | High | Urgent
  due_at TEXT,                                  -- UTC ISO
  status TEXT NOT NULL DEFAULT 'open',          -- open | completed
  completed_at TEXT,
  completed_by INTEGER,
  overdue_notified INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,                      -- exact UTC instant chosen by Admin
  processed_at TEXT,                            -- set once the scheduler has handled it
  skip_reason TEXT,                             -- why nothing was sent (if applicable)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  important INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  whatsapp INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 1,
  in_app INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type)
);
CREATE TABLE IF NOT EXISTS email_templates (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_text TEXT DEFAULT '',
  cta_url TEXT DEFAULT '',
  footer_text TEXT DEFAULT '',
  updated_at TEXT
);
/* Core notification log — also the dedup ledger (unique event reference) */
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,                       -- unique reference for the business event
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,                        -- whatsapp | email | in_app
  recipient_id INTEGER,
  recipient_label TEXT DEFAULT '',
  client_id INTEGER, project_id INTEGER, task_id INTEGER,
  subject TEXT DEFAULT '',
  message TEXT DEFAULT '',                      -- plain-text body (whatsapp / in-app)
  meta TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | sent | delivered | failed | skipped
  status_reason TEXT DEFAULT '',
  error TEXT DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  scheduled_at TEXT,
  sent_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedup
  ON notifications(event_id, channel, recipient_id, recipient_label);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);
CREATE TABLE IF NOT EXISTS in_app_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  notification_id INTEGER,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  link TEXT DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

/* ─── Settings (JSON store with strict event-based defaults) ─────────────── */
const DEFAULT_SETTINGS = {
  /* §13 — per-event channel control. Anything not listed here is OFF. */
  notificationSettings: {
    events: {
      task_assigned:   { whatsapp: true,  email: true,  in_app: true  },
      task_reminder:   { whatsapp: true,  email: true,  in_app: true  },
      task_reassigned: { whatsapp: true,  email: true,  in_app: true  },
      project_update:  { whatsapp: true,  email: true,  in_app: true  },
      task_completed:  { whatsapp: false, email: true,  in_app: true  },
      task_overdue:    { whatsapp: false, email: true,  in_app: true  },
      task_comment:    { whatsapp: false, email: true,  in_app: true  },
      whatsapp_failed: { whatsapp: false, email: true,  in_app: true  },
    },
    adminOverrideCritical: true,          // §14 — Admin can override member prefs for critical events
    criticalEvents: ['task_assigned', 'task_reminder', 'task_reassigned', 'task_overdue'],
    notifyPreviousAssigneeOnReassign: false, // §1-D — optional
  },
  /* §3 — night-shift friendly reminder defaults (NOT auto reminders) */
  reminderSettings: {
    timezone: 'Asia/Karachi',             // PKT / UTC+5 — configurable
    defaultReminderTime: '22:00',         // 10:00 PM
  },
  /* §9 — Admin email/in-app alerts, all configurable */
  adminNotify: {
    onTaskCompleted:  { email: true,  in_app: true  },
    onTaskOverdue:    { email: true,  in_app: true  },
    onTaskComment:    { email: true,  in_app: true  },
    onProjectUpdate:  { email: false, in_app: true  },
    onWhatsAppFailed: { email: true,  in_app: true  },
  },
  /* Provider configuration — simulation until real credentials are added */
  integrationSettings: {
    appUrl: 'http://localhost:3000',
    websiteUrl: 'https://thepietechnologies.com/',
    adminName: 'Admin',
    whatsapp: {
      mode: 'simulation',                 // 'simulation' | 'cloud_api'
      phoneNumberId: '', apiToken: '',    // Meta WhatsApp Cloud API
      simulateFailures: false,            // test the retry flow
    },
    email: {
      mode: 'simulation',                 // 'simulation' | 'smtp'
      smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
      fromName: 'The Pie Technologies', fromEmail: 'notifications@thepietechnologies.com',
      simulateFailures: false,
    },
  },
};

const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return structuredClone(DEFAULT_SETTINGS[key]);
  try {
    const val = JSON.parse(row.value);
    // merge over defaults so new fields appear after upgrades
    return typeof val === 'object' && val && !Array.isArray(val)
      ? deepMerge(structuredClone(DEFAULT_SETTINGS[key] || {}), val) : val;
  } catch { return structuredClone(DEFAULT_SETTINGS[key]); }
};
const setSetting = (key, value) => {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
};
function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k]);
    else base[k] = over[k];
  }
  return base;
}

/* ─── Seed ───────────────────────────────────────────────────────────────── */
function seed() {
  const now = new Date().toISOString();
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const insUser = db.prepare('INSERT INTO users(role,name,email,phone,password,title,created_at) VALUES(?,?,?,?,?,?,?)');
    insUser.run('admin', 'Ahmed Raza', 'admin@thepietechnologies.com', '+92 300 0000000', hashPassword('admin123'), 'Founder & Admin', now);
    insUser.run('member', 'John Malik', 'john@thepietechnologies.com', '+92 300 1234567', hashPassword('john123'), 'Social Media Manager', now);
    insUser.run('member', 'Sara Ali', 'sara@thepietechnologies.com', '+92 301 2345678', hashPassword('sara123'), 'Graphic Designer', now);
    insUser.run('member', 'Bilal Hussain', 'bilal@thepietechnologies.com', '+92 302 3456789', hashPassword('bilal123'), 'SEO Specialist', now);
  }

  if (db.prepare('SELECT COUNT(*) c FROM clients').get().c === 0) {
    const insClient = db.prepare('INSERT INTO clients(name,contact_person,email,phone,notes,created_at) VALUES(?,?,?,?,?,?)');
    const c1 = insClient.run('ABC Roofing', 'David Miller', 'david@abcroofing.com', '+1 555 0100', 'Premium client — monthly retainer', now).lastInsertRowid;
    const c2 = insClient.run('GreenLeaf Café', 'Hina Sheikh', 'hina@greenleafcafe.pk', '+92 42 111222', 'Local café chain, Lahore', now).lastInsertRowid;
    const c3 = insClient.run('Skyline Realty', 'Omar Farooq', 'omar@skylinerealty.pk', '+92 21 333444', 'Real estate developer', now).lastInsertRowid;
    const c4 = insClient.run('FitZone Gym', 'Kamran Akmal', 'kamran@fitzone.pk', '+92 30 555666', 'Fitness chain — SEO campaign', now).lastInsertRowid;

    const insProject = db.prepare('INSERT INTO projects(client_id,name,description,status,created_at) VALUES(?,?,?,?,?)');
    const p1 = insProject.run(c1, 'Social Media Management', 'Monthly content calendar, posts and engagement for ABC Roofing.', 'active', now).lastInsertRowid;
    const p2 = insProject.run(c2, 'Google Business Profile Optimization', 'Profile setup, weekly posts and review management.', 'active', now).lastInsertRowid;
    const p3 = insProject.run(c3, 'Website Redesign', 'New homepage, listings pages and lead capture flow.', 'active', now).lastInsertRowid;
    const p4 = insProject.run(c4, 'SEO Campaign — Q4', 'Technical SEO, content plan and monthly reporting.', 'active', now).lastInsertRowid;

    const users = db.prepare('SELECT * FROM users WHERE role = ?').all('member');
    const john = users.find(u => u.name.startsWith('John'));
    const sara = users.find(u => u.name.startsWith('Sara'));
    const bilal = users.find(u => u.name.startsWith('Bilal'));
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
    const TZ = 'Asia/Karachi';

    const insTask = db.prepare(`INSERT INTO tasks(title,description,client_id,project_id,assignee_id,priority,due_at,status,created_by,created_at)
                                VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const insReminder = db.prepare('INSERT INTO task_reminders(task_id,remind_at,created_at) VALUES(?,?,?)');

    // 1) The spec's flagship example — due tomorrow 5:00 PM, reminder same day 3:00 PM
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const due1 = zonedToUtc(fmt(day(1)), '17:00', TZ);
    const t1 = insTask.run('Create Facebook Post', 'Design and publish a promotional post announcing the winter roof-inspection discount. Include client-approved artwork and hashtags.', c1, p1, john.id, 'High', due1.toISOString(), 'open', admin.id, now).lastInsertRowid;
    insReminder.run(t1, zonedToUtc(fmt(day(1)), '15:00', TZ).toISOString(), now);

    // 2) Due in 2 days — will be used to demo reassignment
    const due2 = zonedToUtc(fmt(day(2)), '17:00', TZ);
    insTask.run('Update Google Business Profile', 'Refresh business hours, upload new interior photos and publish the weekly offer post.', c2, p2, john.id, 'Medium', due2.toISOString(), 'open', admin.id, now);

    // 3) Multiple reminders (§5) — day before 10:00 PM and due-day 2:00 PM
    const due3 = zonedToUtc(fmt(day(3)), '18:00', TZ);
    const t3 = insTask.run('Monthly SEO Report', 'Compile rankings, traffic and backlink summary for FitZone. Deliver the signed-off PDF to the client.', c4, p4, bilal.id, 'High', due3.toISOString(), 'open', admin.id, now).lastInsertRowid;
    insReminder.run(t3, zonedToUtc(fmt(day(2)), '22:00', TZ).toISOString(), now);
    insReminder.run(t3, zonedToUtc(fmt(day(3)), '14:00', TZ).toISOString(), now);

    // 4) Fires ~3 minutes after first launch — lets you watch the scheduler work live
    const soon = new Date(Date.now() + 3 * 60 * 1000);
    const due4 = zonedToUtc(fmt(day(1)), '11:00', TZ);
    const t4 = insTask.run('Client follow-up call — content strategy', 'Call David at ABC Roofing to confirm the approved content strategy before publishing this week\'s posts.', c1, p1, john.id, 'Urgent', due4.toISOString(), 'open', admin.id, now).lastInsertRowid;
    insReminder.run(t4, soon.toISOString(), now);

    // 5) Assigned to Sara, due tomorrow night (night-shift friendly)
    const due5 = zonedToUtc(fmt(day(1)), '23:30', TZ);
    insTask.run('Homepage hero redesign — concepts', 'Prepare two hero-section concepts for Skyline Realty with revised lead-capture CTA placement.', c3, p3, sara.id, 'Urgent', due5.toISOString(), 'open', admin.id, now);

    // 6) Completed task (shows completed state; no reminder will fire)
    const t6 = insTask.run('Logo variants for FitZone campaign', 'Deliver light/dark logo variants for the SEO report cover.', c4, p4, sara.id, 'Low', zonedToUtc(fmt(day(-1)), '18:00', TZ).toISOString(), 'completed', admin.id, now).lastInsertRowid;
    db.prepare('UPDATE tasks SET completed_at = ?, completed_by = ? WHERE id = ?').run(new Date(Date.now() - 26 * 3600e3).toISOString(), admin.id, t6);

    // Seed one project update history entry
    db.prepare('INSERT INTO project_updates(project_id,title,message,created_by,send_whatsapp,send_email,send_inapp,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(p1, 'Client approved the new content strategy', 'David from ABC Roofing approved the revised content strategy. Proceed with the winter campaign posts as scheduled.', admin.id, 0, 0, 1, new Date(Date.now() - 20 * 3600e3).toISOString());
  }

  // Templates (insert missing / refresh names, keep admin edits)
  const upTpl = db.prepare(`INSERT INTO email_templates(key,name,subject,heading,body,cta_text,cta_url,footer_text,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET name=excluded.name`);
  for (const k of TEMPLATE_KEYS) {
    const s = SEED_TEMPLATES[k];
    upTpl.run(k, s.name, s.subject, s.heading, s.body, s.cta_text, s.cta_url, s.footer_text, now);
  }

  // Member notification preferences (§14) — sensible defaults, all main events on
  if (db.prepare('SELECT COUNT(*) c FROM notification_prefs').get().c === 0) {
    const ins = db.prepare('INSERT INTO notification_prefs(user_id,event_type,whatsapp,email,in_app) VALUES(?,?,?,?,?)');
    for (const u of db.prepare('SELECT id FROM users').all()) {
      for (const ev of Object.keys(EVENT_TYPES)) {
        ins.run(u.id, ev, 1, 1, 1);
      }
    }
  }
}

/* Canonical notification EVENT types (independent of email template keys) */
const EVENT_TYPES = {
  task_assigned: 'Task Assigned',
  task_reminder: 'Task Reminder',
  task_reassigned: 'Task Reassigned',
  project_update: 'Project Update',
  task_completed: 'Task Completed',
  task_overdue: 'Task Overdue',
  task_comment: 'Task Comment',
  whatsapp_failed: 'WhatsApp Failed',
};

seed();

module.exports = { db, getSetting, setSetting, DEFAULT_SETTINGS };
