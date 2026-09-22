'use strict';
/* ─── Timezone helpers (night-shift friendly — never assume 9-to-5) ─────────
 * All timestamps are stored in UTC (ISO strings). Admin-entered wall-clock
 * times are interpreted in the agency timezone (default: Asia/Karachi, PKT)
 * and converted to exact UTC instants — never auto-shifted to "business hours".
 */

function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '0' : parts.hour;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hour, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}

/** Convert a wall-clock time "YYYY-MM-DD HH:mm" in `timeZone` to a UTC Date. */
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);
  const off1 = tzOffsetMs(new Date(naive), timeZone);
  let utc = naive - off1;
  const off2 = tzOffsetMs(new Date(utc), timeZone);
  if (off2 !== off1) utc = naive - off2; // DST edge — settle in one step
  return new Date(utc);
}

/** Format a UTC instant as wall-clock in a timezone. */
function fmtInTz(iso, timeZone, opts = {}) {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    ...opts,
  }).format(d);
}

function fmtDateInTz(iso, timeZone) {
  return fmtInTz(iso, timeZone, { hour: undefined, minute: undefined });
}

function fmtTimeInTz(iso, timeZone) {
  return fmtInTz(iso, timeZone, { year: undefined, month: undefined, day: undefined });
}

/** Current wall-clock date "YYYY-MM-DD" and time "HH:mm" in a timezone. */
function nowInTz(timeZone) {
  return zonedParts(new Date(), timeZone);
}

/** Wall-clock parts of any instant (Date or ISO string): { date: "YYYY-MM-DD", time: "HH:mm" }. */
function zonedParts(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
  };
}

module.exports = { tzOffsetMs, zonedToUtc, fmtInTz, fmtDateInTz, fmtTimeInTz, nowInTz, zonedParts };
