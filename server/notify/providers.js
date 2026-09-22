'use strict';
/* ─── Delivery providers ───────────────────────────────────────────────────
 * The system ships in SIMULATION mode so nothing external is required and no
 * task ever breaks because of a notification (§17). Add credentials in
 * Settings → Integrations to switch to the real WhatsApp Cloud API / SMTP.
 */

class DeliveryError extends Error {}

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
  // Simulation
  if (cfg.simulateFailures) throw new DeliveryError('Simulated WhatsApp failure (test mode is ON in Settings → Integrations).');
  console.log(`[whatsapp:sim] → ${toPhone}\n${text}\n`);
  return { provider: 'simulation' };
}

async function sendEmail(integration, { to, subject, html }) {
  const cfg = integration.email || {};
  if (cfg.mode === 'smtp' && cfg.smtpHost) {
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new DeliveryError('SMTP mode selected but nodemailer is not installed. Run: npm install nodemailer'); }
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: Number(cfg.smtpPort) || 587,
      secure: Number(cfg.smtpPort) === 465,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    });
    const info = await transporter.sendMail({
      from: `"${cfg.fromName || 'The Pie Technologies'}" <${cfg.fromEmail || 'notifications@thepietechnologies.com'}>`,
      to, subject, html,
    });
    return { provider: 'smtp', messageId: info.messageId };
  }
  if (cfg.simulateFailures) throw new DeliveryError('Simulated email failure (test mode is ON in Settings → Integrations).');
  console.log(`[email:sim] → ${to} :: ${subject}`);
  return { provider: 'simulation' };
}

module.exports = { sendWhatsApp, sendEmail, DeliveryError };
