/** Shared display metadata and formatters. */

export const STATUS_META = {
  scheduled:   { label: 'Scheduled',   color: '#3b82f6', bg: '#eff6ff', fg: '#1e5fd6', border: '#bfdbfe' },
  confirmed:   { label: 'Confirmed',   color: '#0e9384', bg: '#e5f6f3', fg: '#0b6e63', border: '#a9e2d9' },
  checked_in:  { label: 'Checked in',  color: '#f59e0b', bg: '#fff7e6', fg: '#a16207', border: '#fde4ad' },
  in_progress: { label: 'In progress', color: '#8b5cf6', bg: '#f4efff', fg: '#6d3bd6', border: '#ddd0fb' },
  completed:   { label: 'Completed',   color: '#65a30d', bg: '#f2f8e5', fg: '#42650b', border: '#d5e8b2' },
  cancelled:   { label: 'Cancelled',   color: '#94a3b8', bg: '#f1f5f9', fg: '#475569', border: '#dbe2ea' },
  no_show:     { label: 'No-show',     color: '#e11d48', bg: '#ffeef1', fg: '#be123c', border: '#fbc6d2' },
};

export const STATUS_ORDER = ['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'];

export const ROLES = {
  platform_admin: 'Platform Admin',
  owner: 'Clinic Owner',
  receptionist: 'Receptionist',
  doctor: 'Doctor',
  accountant: 'Accountant',
};

/* Clinic currency — configured per clinic on the server (default ILS).
 * AuthProvider syncs this from /meta/bootstrap; money() renders with it. */
let CURRENCY = 'ILS';
export function setCurrency(code) {
  if (typeof code === 'string' && /^[A-Z]{3}$/.test(code)) CURRENCY = code;
}
export function getCurrency() { return CURRENCY; }

export function money(cents, currency) {
  if (cents === null || cents === undefined) return '—';
  const code = currency || CURRENCY;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code,
      minimumFractionDigits: code === 'JPY' ? 0 : 2,
      maximumFractionDigits: code === 'JPY' ? 0 : 2,
    }).format(cents / 100);
  } catch {
    // Unknown ISO code — fall back to a plain amount with the code as suffix.
    return `${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
  }
}

/** Time-of-day greeting; handles honorifics like "Dr. Sara". */
export function greetingName(fullName = '') {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (/^(dr\.?|د\.)$/i.test(parts[0])) return parts.slice(0, 2).join(' ');
  return parts[0];
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function fmtTime(dateOrIso) {
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDate(dateOrIso, opts = {}) {
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return d.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', ...opts });
}

export function fmtDateShort(dateOrIso) {
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function ageFromDob(dob) {
  if (!dob) return null;
  const b = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age;
}

/** local Date -> "YYYY-MM-DD" */
export function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** local Date -> "HH:MM" */
export function toLocalTimeStr(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Combine "YYYY-MM-DD" + "HH:MM" (browser local) into a UTC ISO string. */
export function localToUtcIso(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${timeStr}:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
