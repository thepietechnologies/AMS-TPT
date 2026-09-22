# AMS-TPT — Agency Management System

**The Pie Technologies** · Digital Marketing & Technology

A clean, stable, **API-first** Agency Management System organized around one hierarchy:

```
Client  →  Project  →  Task  →  Notifications
```

Built with Node.js 22 (Express + `node:sqlite`) and a branded vanilla-JS web UI.
The same backend, database, auth and notification system will serve the future
iOS/Android app — no rebuild required.

---

## Quick start

```bash
npm install        # express + nodemailer
npm run build      # sanity-checks all JS + frontend entry
npm run dev        # http://localhost:3000 (or: npm start)
```

**Demo accounts** (seeded on first run):

| Who | Email | Password |
| --- | --- | --- |
| Ahmed Raza — Admin | `admin@thepietechnologies.com` | `admin123` |
| John Malik — Member | `john@thepietechnologies.com` | `john123` |
| Sara Ali — Member | `sara@thepietechnologies.com` | `sara123` |
| Bilal Hussain — Member | `bilal@thepietechnologies.com` | `bilal123` |

Seed data includes a reminder that fires ~3 minutes after first launch, a task with
two reminders, checklist items, and full client profiles.

---

## What's inside

- **Clients (primary entity)** — business profile: contact, website, social links,
  services, package, start date, status, notes. Tabs: Overview / Projects / Tasks /
  Files / Activity (real activity log). Archive/restore instead of hard delete.
- **Projects** — always shown under their client (breadcrumb `Client ↓ Project ↓ Task`),
  start/end dates, status, assigned team, tasks, files, activity, manual updates.
  Archive cancels all reminders for its tasks.
- **Tasks** — Pending / In Progress / Completed / On Hold; client + project context,
  assignee, priority, due date & time, estimated time, multiple Admin-scheduled
  reminders, checklist, comments, attachments, activity history.
- **Task creation enforces the hierarchy** — pick Client → Project (only that client's
  projects are listed); the server rejects invalid client/project combinations.
- **Global Tasks page** — filters: client, project, assignee, status, priority, due-date
  range; search across task/client/project.
- **Calendar** — month grid of task due dates and scheduled reminders (agency timezone).
- **Reports** — real aggregates only: tasks by status/priority, workload per client and
  per member, reminder stats, notification delivery health.
- **Role-aware dashboards** — Admin: overview, due today, overdue, team workload, real
  activity. Member: only their own work.
- **Real-time notifications** — the bell updates instantly via Server-Sent Events
  (no refresh), with a polling fallback.
- **Notification system** — event-based and Admin-controlled, channels are independent:
  `in_app · email · whatsapp · push` (push is structured and reserved for the mobile app;
  rows are recorded as *skipped — no provider configured*). No daily digests, no
  "no tasks today", no greetings — if nothing needs attention, nothing is sent.
- **Per-task reminders** — exact Admin-picked date/time in the agency timezone
  (default PKT), multiple allowed, cancelled on completion or archive, duplicate-proof
  via unique event IDs + atomic claiming.
- **8 branded email templates** — editable with live preview and `{{placeholders}}`.

## SMTP (§17)

Settings → Integrations → **Test SMTP Connection** and **Send Test Email**.
Credentials live only on the server (masked in API responses; env vars
`SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM` seed the defaults). Failures are
human-readable (auth vs timeout vs DNS vs TLS), logged, and retryable — a failed email
never breaks task creation. `nodemailer` ships as a dependency.

## API-first (ready for the future mobile app)

All business logic — auth, permissions, clients, projects, tasks, status, reminders,
notifications, comments, files — is server-side. Every request is authenticated
(bearer token or cookie); roles and ownership are always determined by the backend.
Members only receive data within their work context.

Key endpoints (all under `/api`, bearer auth):

```
POST /auth/login → { token, user }          GET /auth/me
GET  /events                                (SSE real-time notifications)
GET  /meta · /dashboard · /calendar · /reports (admin)
GET/POST/PATCH /clients · POST /clients/:id/archive · GET /clients/:id (detail+tabs data)
GET/POST/PATCH /projects · POST /projects/:id/archive · GET /projects/:id
POST /projects/:id/updates
GET/POST/PATCH/DELETE /tasks (+filters: status, client_id, project_id, assignee_id,
                             priority, due_from, due_to, q)
POST /tasks/:id/status · /tasks/:id/complete · /tasks/:id/comments
POST /tasks/:id/checklist · PATCH/DELETE /checklist/:id
POST /attachments/:type/:id · GET /attachments/:id/download · DELETE /attachments/:id
GET  /team · /team/:id/prefs · PUT /team/:id/prefs
GET  /notifications/history · POST /notifications/:id/retry
GET  /inapp · POST /inapp/read
GET/PUT /settings/:key · POST /settings/test-smtp · POST /settings/send-test-email
GET/PUT /templates(/:key) · POST /templates/:key/preview
```

Entity responses are consistent and mobile-friendly (e.g. task:
`id, clientId, projectId, title, status, priority, assigneeId, dueDate, dueTime,
estimatedMinutes` — with snake_case aliases for the current web app).

## Notes

- **Storage**: `data/ams.sqlite` + `data/uploads/` (gitignored; delete to reseed).
- **Migrations are additive** — existing data is preserved on upgrade.
- **Scheduler**: in-process, 20 s tick; archived clients/projects silence reminders
  and overdue alerts; completed tasks cancel pending reminders.
- **Security**: scrypt password hashing, HttpOnly cookies + bearer tokens,
  role-gated and ownership-checked endpoints.
