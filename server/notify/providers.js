'use strict';
/* ─── Delivery providers ───────────────────────────────────────────────────
 * Simulation mode ships by default — nothing external is required and no
 * task ever breaks because of a notification (§17/§18).
 *
 * SMTP (§17): real nodemailer delivery when configured. Secrets are read from
 * saved settings or env vars, are never returned to the frontend (masked in
 * /api/settings), and are never committed (data/ is gitignored).
 * Test helpers: verifySmtp() (Test SMTP Connection) and a branded test email.
 */

class DeliveryError extends Error {}

const SMTP_TIMEOUT_MS = 15000;

let cachedTransport = { key: null, transporter: null };
function smtpKey(cfg) {
  return [cfg.smtpHost, cfg.smtpPort, cfg.smtpSecure, cfg.smtpUser, cfg.smtpPass, cfg.fromEmail].join('|');
}

/** Build a nodemailer transporter from saved settings + env fallbacks. */
async function getTransporter(cfg) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch {
    throw new DeliveryError('SMTP mode is selected but the nodemailer package is missing. Run: npm install nodemailer');
  }
  if (!cfg.smtpHost) throw new DeliveryError('SMTP host is not configured (Settings → Integrations).');
  const port = Number(cfg.smtpPort) || 587;
  // Auto security: 465 = implicit TLS; anything else uses STARTTLS when available
  const secure = cfg.smtpSecure === true || cfg.smtpSecure === 'true' || port === 465;
  const key = smtpKey({ ...cfg, smtpSecure: secure });
  if (cachedTransport.key === key) return { transporter: cachedTransport.transporter, secure, port };
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port,
    secure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: { rejectUnauthorized: false }, // tolerate self-signed internal relays
  });
  cachedTransport = { key, transporter };
  return { transporter, secure, port };
}

/** §17 — "Test SMTP Connection": verifies handshake/auth, returns a readable result. */
async function verifySmtp(cfg) {
  try {
    const { transporter, secure, port } = await getTransporter(cfg);
    await transporter.verify();
    return { ok: true, message: `Connected to ${cfg.smtpHost}:${port} (${secure ? 'implicit TLS' : 'STARTTLS'}) — authentication OK.` };
  } catch (err) {
    cachedTransport = { key: null, transporter: null };
    return { ok: false, message: humanizeSmtpError(err) };
  }
}

function humanizeSmtpError(err) {
  const code = err && (err.code || err.errno);
  const resp = err && (err.response || '');
  const base = String(err && err.message || err);
  if (code === 'EAUTH' || /auth|535/i.test(base + resp)) return `Authentication failed (${resp || base}). Check username/password — for Gmail use a 16-char App Password, not the account password.`;
  if (code === 'ESOCKET' || code === 'ETIMEDOUT' || code === 'ETIME') return `Connection timed out talking to the SMTP server. Check host, port and firewall — and that port ${resp ? '' : ''}matches the security (465 = TLS, 587 = STARTTLS).`;
  if (code === 'ECONNREFUSED') return 'Connection refused — wrong host/port, or the mail server is unreachable from this machine.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'SMTP host not found — check the hostname spelling and DNS.';
  if (/self[- ]signed|certificate/i.test(base)) return 'TLS certificate error — the server uses a self-signed certificate.';
  return resp ? `${base} (${resp})` : base;
}

/** Render + send the branded test email. */
async function sendTestEmail(cfg, to) {
  const { renderEmail } = require('./templates');
  const vars = {
    team_member_name: 'Test Recipient', first_name: 'Test Recipient',
    client_name: '—', project_name: '—', task_name: 'SMTP test email',
    priority: '', due_full: '', reminder_time: '',
    admin_name: 'Admin', dashboard_url: '/', website_url: cfg.websiteUrl || 'https://thepietechnologies.com/',
    logo_url: '/assets/logo-mark.png',
    year: String(new Date().getFullYear()),
  };
  const tpl = {
    subject: '✓ SMTP test successful — The Pie Technologies',
    heading: 'SMTP TEST EMAIL',
    body: 'This is a test email from your AMS notification system.\n\nIf you can read this, SMTP delivery is configured correctly and notification emails will look like this one.',
    cta_text: 'OPEN AMS',
    cta_url: '/',
    footer_text: 'You received this because an administrator tested the email configuration.',
  };
  const { html } = renderEmail(tpl, vars, {});
  return deliverEmail(cfg, { to, subject: tpl.subject, html });
}

async function deliverEmail(cfg, { to, subject, html }) {
  const { transporter } = await getTransporter(cfg);
  if (!to) throw new DeliveryError('No recipient address given.');
  const info = await transporter.sendMail({
    from: `"${cfg.fromName || 'The Pie Technologies'}" <${cfg.fromEmail || 'notifications@thepietechnologies.com'}>`,
    to, subject, html,
  });
  return { provider: 'smtp', messageId: info.messageId, response: info.response || '' };
}

async function sendEmail(integration, { to, subject, html }) {
  const cfg = integration.email || {};
  if (cfg.mode === 'smtp' && cfg.smtpHost) {
    return deliverEmail(cfg, { to, subject, html });
  }
  if (cfg.simulateFailures) throw new DeliveryError('Simulated email failure (test mode is ON in Settings → Integrations).');
  console.log(`[email:sim] → ${to} :: ${subject}`);
  return { provider: 'simulation' };
}

async function sendWhatsApp(integration, toPhone, text) {
  const cfg = integration.whatsapp || {};
  if (cfg.mode === 'cloud_api' && cfg.apiToken && cfg.phoneNumberId) {
    const res = await fetch(`https://graph.facebook.com/v20.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(toPhone).replace(/[^\d+]/g, ''),
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new DeliveryError(`WhatsApp Cloud API error ${res.status}: ${detail.slice(0, 300)}`);
    }
    return { provider: 'cloud_api' };
  }
  if (cfg.simulateFailures) throw new DeliveryError('Simulated WhatsApp failure (test mode is ON in Settings → Integrations).');
  console.log(`[whatsapp:sim] → ${toPhone}\n${text}\n`);
  return { provider: 'simulation' };
}

module.exports = { sendWhatsApp, sendEmail, verifySmtp, sendTestEmail, DeliveryError };
