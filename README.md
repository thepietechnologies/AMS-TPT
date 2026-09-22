# AMS-TPT — Agency Management System

**The Pie Technologies** · Digital Marketing & Technology

A complete Agency Management System (clients → projects → tasks) built around a strict,
**event-based, Admin-controlled notification system**. Built with Node.js (Express +
`node:sqlite`), zero external services required to run, and a polished branded web UI.

---

## Quick start

```bash
npm install        # express only (node:sqlite is built into Node 22+)
npm start          # http://localhost:3000
```

**Demo accounts** (seeded automatically on first run):

| Who | Email | Password |
| --- | --- | --- |
| Ahmed Raza — Admin | `admin@thepietechnologies.com` | `admin123` |
| John Malik — Social Media Manager | `john@thepietechnologies.com` | `john123` |
| Sara Ali — Graphic Designer | `sara@thepietechnologies.com` | `sara123` |
| Bilal Hussain — SEO Specialist | `bilal@thepietechnologies.com` | `bilal123` |

> Seed data includes a reminder that fires ~3 minutes after first launch so you can watch
> the scheduler work live (Notification History), a task with **two** reminders, and an
> overdue-ready task.

---

## The notification charter (core product requirement)

The system is **minimal, useful, event-based, and fully Admin-controlled**.
If nothing requires attention, **it sends nothing**.

**Never sent:** daily summaries, "you have no tasks today", morning greetings, motivational
or end-of-day messages, repeated notifications for the same event, or anything not tied to
a real business event.

**Only these events can notify** (each independently switchable per channel):

| Event | WhatsApp | Email | In-App | Who |
| --- | --- | --- | --- | --- |
| Task assigned | ✅ on | ✅ on | ✅ on | assignee |
| Task reminder *(Admin-scheduled only)* | ✅ on | ✅ on | ✅ on | assignee |
| Task reassigned | ✅ on | ✅ on | ✅ on | new assignee (previous assignee optional) |
| Project update *(Admin-posted)* | ✅ on | ✅ on | ✅ on | selected team members |
| Task completed | ⬜ off | ✅ on | ✅ on | Admins (configurable) |
| Task overdue | ⬜ off | ✅ on | ✅ on | assignee + Admins (configurable) |
| Team-member comment | ⬜ off | ✅ on | ✅ on | Admins (configurable) |
| WhatsApp delivery failed | — | ✅ on | ✅ on | Admins (configurable) |

### How the rules map to the product

| Rule | Where it lives |
| --- | --- |
| No daily WhatsApp summary / no automatic reminders | Scheduler only ever sends reminders an Admin explicitly created |
| Admin-controlled reminder defaults + timezone (default **PKT / UTC+5**) | **Settings → Reminder Settings** |
| Per-task reminders, exact date & time, multiple allowed | Task form → *Enable reminder(s)* → date/time picker rows |
| Reminder conditions (§6) — task exists · assigned · enabled · time arrived · **not completed** · not already sent | `server/notify/scheduler.js` + unique dedup index |
| Night-shift friendly — Admin times respected exactly, never shifted to 9-to-5 | All times stored UTC, entered/rendered in the agency timezone |
| Channel control per event (§13) | **Settings → Notification Control** (global matrix) |
| Per-member preferences + Admin override for critical events (§14) | **Team → 🔔 Preferences** and **My Preferences** |
| Notification history with full audit (§15) | **Notification History** — statuses: pending / sent / delivered / failed / skipped (+ skip reasons) |
| Duplicate prevention via unique event/reference IDs (§16) | `notifications` table unique index + atomic row claiming |
| Failure isolation — task never fails because a notification failed (§17) | delivery errors logged; **Retry** button in history; admin alerted |
| Manual project update with per-channel checkboxes (§19) | Project page → **＋ Project Update** |
| In-app notification center (§20) | Bell menu — real events only |

### Reminder guardrails

- A reminder fires **once**, at the exact Admin-picked minute (20 s scheduler cadence).
- If the task is completed first → reminder is cancelled and logged as
  *"Task completed before reminder time — not sent."*
- If the task has no active assignee → logged as skipped, nothing sent.
- Running the scheduler twice (or restarting mid-flight) can never duplicate a message.

---

## Email & WhatsApp

- **Emails**: table-based, responsive, branded HTML — logo header, navy/gold palette,
  structured CLIENT / PROJECT / TASK details card, gold CTA button, website + copyright
  footer. Seven editable templates (+ a previous-assignee variant) in
  **Settings → Email Templates** with live preview and `{{placeholders}}`:
  `{{team_member_name}}`, `{{client_name}}`, `{{project_name}}`, `{{task_name}}`,
  `{{task_description}}`, `{{priority}}`, `{{due_date}}`, `{{due_time}}`,
  `{{dashboard_url}}`, `{{admin_name}}` and more.
- **WhatsApp copy** matches the approved formats exactly (New Task Assigned / Task Reminder /
  Project Update / Task Assigned to You …), rendered as chat bubbles in history details.
- **Providers** ship in **simulation mode** (safe demo, everything logged). Add credentials in
  **Settings → Integrations** to go live:
  - WhatsApp: Meta **WhatsApp Cloud API** (phone number ID + permanent token)
  - Email: any **SMTP** server (optionally install `nodemailer`)
  - "Simulate failures" switches let you exercise the failure → admin-alert → Retry flow.

## Tech notes

- **Stack**: Node 22, Express 5, `node:sqlite` (no native builds), vanilla-JS SPA frontend.
- **Storage**: `data/ams.sqlite` (auto-created; delete the folder to reseed).
- **Scheduler**: in-process, 20 s tick — reminders, one-time overdue detection, delivery.
- **Timezones**: all instants stored UTC; input/output in the configurable agency timezone
  via `Intl` — DST-safe, night hours fully respected.
- **Security**: scrypt-hashed passwords, HttpOnly session cookies, role-gated APIs.
