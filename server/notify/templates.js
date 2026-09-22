'use strict';
/* ─── Email templates: seeds + branded renderer ────────────────────────────
 * Admin-editable via Settings → Email Templates. Placeholders like
 * {{team_member_name}} are replaced before sending (see util.applyVars).
 * The structured CLIENT / PROJECT / TASK details card and the branded frame
 * are generated automatically so every email looks professional.
 */
const { esc, applyVars } = require('../util');

const TEMPLATE_KEYS = [
  'new_task_assigned',
  'task_reminder',
  'task_reassigned',
  'task_reassigned_from',
  'project_update',
  'task_completed',
  'task_overdue',
  'whatsapp_failed',
];

const SEED_TEMPLATES = {
  new_task_assigned: {
    name: 'New Task Assigned',
    subject: 'New Task Assigned — {{task_name}}',
    heading: 'NEW TASK ASSIGNED',
    body: `Hi {{team_member_name}},

You have been assigned a new task. Please review the details below and log in to your dashboard for the complete brief.`,
    cta_text: 'VIEW TASK',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because a task was assigned to you in the TPT management system.',
  },
  task_reminder: {
    name: 'Task Reminder',
    subject: 'Task Reminder — {{task_name}} is due {{due_date}}',
    heading: 'TASK REMINDER',
    body: `Hi {{team_member_name}},

This is a reminder for your assigned task. Please complete it before the deadline.`,
    cta_text: 'VIEW TASK',
    cta_url: '{{dashboard_url}}',
    footer_text: 'This reminder was scheduled by an administrator in the TPT management system.',
  },
  task_reassigned: {
    name: 'Task Reassigned (New Assignee)',
    subject: 'Task Assigned to You — {{task_name}}',
    heading: 'TASK ASSIGNED TO YOU',
    body: `Hi {{team_member_name}},

A task has been assigned to you. Please check your dashboard for the full details.`,
    cta_text: 'VIEW TASK',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because a task was assigned to you in the TPT management system.',
  },
  task_reassigned_from: {
    name: 'Task Reassigned (Previous Assignee)',
    subject: 'Task Reassigned — {{task_name}}',
    heading: 'TASK REASSIGNED',
    body: `Hi {{team_member_name}},

The task below has been reassigned to another team member and is no longer on your queue. No action is needed from you.`,
    cta_text: 'VIEW TASK',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because a task previously assigned to you was reassigned.',
  },
  project_update: {
    name: 'Project Update',
    subject: 'Project Update — {{project_name}}',
    heading: 'PROJECT UPDATE',
    body: `Hi {{team_member_name}},

There has been an update to your project. Please check the TPT dashboard for details.`,
    cta_text: 'VIEW PROJECT',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because an administrator posted an update on a project you work on.',
  },
  task_completed: {
    name: 'Task Completed',
    subject: 'Task Completed — {{task_name}}',
    heading: 'TASK COMPLETED',
    body: `Hi {{team_member_name}},

The task below has been marked as completed.`,
    cta_text: 'VIEW TASK',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because task-completion alerts are enabled for your account.',
  },
  task_overdue: {
    name: 'Task Overdue',
    subject: 'Task Overdue — {{task_name}}',
    heading: 'TASK OVERDUE',
    body: `Hi {{team_member_name}},

The task below has passed its due date and is still incomplete. Please complete it as soon as possible or contact the administrator.`,
    cta_text: 'VIEW TASK',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because overdue-task alerts are enabled in the TPT management system.',
  },
  whatsapp_failed: {
    name: 'WhatsApp Notification Failed (Admin)',
    subject: '⚠ WhatsApp Notification Failed — {{task_name}}',
    heading: 'WHATSAPP NOTIFICATION FAILED',
    body: `Hi {{admin_name}},

A WhatsApp notification could not be delivered. The task itself was processed successfully — only the WhatsApp message failed.

You can retry the notification from Notification History in the admin dashboard.`,
    cta_text: 'OPEN NOTIFICATION HISTORY',
    cta_url: '{{dashboard_url}}',
    footer_text: 'You are receiving this email because WhatsApp-failure alerts are enabled for administrators.',
  },
};

/* ─── Branded layout (table-based, inline styles → renders in Gmail/Outlook) ── */

const BRAND = {
  navy: '#0d1b2e',
  navySoft: '#14263d',
  gold: '#f2a71b',
  goldDark: '#d98e06',
  ink: '#1c2b3a',
  muted: '#66788c',
  line: '#e4e9f0',
  bg: '#eef1f6',
  cardBg: '#f7f9fc',
  website: 'https://thepietechnologies.com/',
};

function detailsRow(label, value) {
  if (!value) return '';
  return `
    <tr>
      <td style="padding:9px 18px;border-bottom:1px solid ${BRAND.line};width:34%;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:1px;color:${BRAND.muted};">${esc(label)}</td>
      <td style="padding:9px 18px;border-bottom:1px solid ${BRAND.line};font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${BRAND.ink};font-weight:600;">${esc(value)}</td>
    </tr>`;
}

function layout({ heading, bodyHtml, details, ctaText, ctaUrl, footerText, vars, noteHtml }) {
  const logoUrl = vars.logo_url;
  const year = vars.year || new Date().getFullYear();
  const website = vars.website_url || BRAND.website;
  const rows = detailsRow('CLIENT', details.client_name)
    + detailsRow('PROJECT', details.project_name)
    + detailsRow('TASK', details.task_name)
    + detailsRow('PRIORITY', details.priority)
    + detailsRow('DUE DATE', details.due)
    + detailsRow('ASSIGNED TO', details.assignee)
    + detailsRow('REMINDER', details.reminder);
  const detailsCard = rows ? `
      <tr><td style="padding:6px 24px 0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cardBg};border:1px solid ${BRAND.line};border-radius:10px;overflow:hidden;">
          <tr><td style="padding:12px 18px 4px 18px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:1.5px;color:${BRAND.goldDark};">TASK DETAILS</td></tr>
          ${rows}
          <tr><td style="height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>
        </table>
      </td></tr>` : '';
  const note = noteHtml ? `
      <tr><td style="padding:14px 24px 0 24px;">
        <div style="background:#fff7e6;border-left:4px solid ${BRAND.gold};border-radius:6px;padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#7a5410;">${noteHtml}</div>
      </td></tr>` : '';
  const cta = ctaText && ctaUrl ? `
      <tr><td style="padding:22px 24px 4px 24px;" align="center">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="border-radius:8px;background:${BRAND.gold};" align="center">
            <a href="${esc(ctaUrl)}" target="_blank" style="display:inline-block;padding:13px 34px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1.2px;color:#0d1b2e;text-decoration:none;border-radius:8px;">${esc(ctaText)}</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td align="center" style="padding:8px 24px 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">Please log in to your TPT dashboard to view the complete details.</td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(heading)} — The Pie Technologies</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(13,27,46,.10);">
    <!-- Header -->
    <tr><td style="background:${BRAND.navy};padding:20px 28px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:12px;"><img src="${esc(logoUrl)}" width="44" height="44" alt="The Pie Technologies" style="display:block;border-radius:10px;"></td>
        <td align="left" style="font-family:Georgia,'Times New Roman',serif;">
          <div style="font-size:17px;font-weight:bold;color:#ffffff;letter-spacing:2.5px;">THE PIE</div>
          <div style="font-size:11px;color:${BRAND.gold};letter-spacing:4.5px;font-weight:bold;">TECHNOLOGIES</div>
        </td>
      </tr></table>
    </tr>
    <tr><td style="height:4px;background:${BRAND.gold};font-size:0;line-height:0;">&nbsp;</td></tr>
    <!-- Title -->
    <tr><td style="padding:28px 24px 0 24px;" align="center">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:21px;font-weight:800;letter-spacing:2px;color:${BRAND.navy};">${esc(heading)}</div>
      <div style="width:46px;height:3px;background:${BRAND.gold};margin:12px auto 0 auto;border-radius:2px;"></div>
    </td></tr>
    <!-- Body -->
    <tr><td style="padding:18px 24px 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;line-height:1.75;color:${BRAND.ink};white-space:pre-line;">${bodyHtml}</td></tr>
    ${detailsCard}
    ${note}
    ${cta}
    <tr><td style="height:26px;line-height:26px;font-size:0;">&nbsp;</td></tr>
    <!-- Footer -->
    <tr><td style="background:${BRAND.navySoft};padding:22px 28px;" align="center">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#ffffff;letter-spacing:1px;">The Pie Technologies</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9db1c7;margin-top:4px;letter-spacing:.5px;">Digital Marketing &amp; Technology</div>
      <div style="margin-top:10px;"><a href="${esc(website)}" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.gold};text-decoration:none;font-weight:bold;">${esc(website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#7a8ea6;margin-top:12px;line-height:1.6;">${esc(footerText || '')}<br>&copy; ${year} The Pie Technologies. All rights reserved.</div>
    </td></tr>
  </table>
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#9aa7b8;padding:14px 8px;">Sent by The Pie Technologies management system &middot; This is an event-based notification, not marketing email.</div>
</td></tr></table>
</body></html>`;
}

/**
 * Render an admin-editable template row + context vars → { subject, html }.
 * `details` drives the structured info card; body placeholders use `vars`.
 */
function renderEmail(tpl, vars, details = {}) {
  const subject = applyVars(tpl.subject, vars);
  const heading = applyVars(tpl.heading, vars);
  const bodyHtml = applyVars(tpl.body, vars).replace(/\n/g, '<br>').replace(/([^>\r\n]?)(\r\n|\n\r|\r)/g, '$1<br>$2');
  const ctaText = applyVars(tpl.cta_text || '', vars).trim();
  const ctaUrl = applyVars(tpl.cta_url || '', vars).trim();
  const footerText = applyVars(tpl.footer_text || '', vars);
  return { subject, html: layout({ heading, bodyHtml, details, ctaText, ctaUrl, footerText, vars }) };
}

module.exports = { TEMPLATE_KEYS, SEED_TEMPLATES, renderEmail, layout, BRAND };
