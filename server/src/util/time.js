'use strict';
/**
 * Timezone helpers. Appointments are stored in UTC; clinic working hours are
 * defined in the clinic's IANA timezone. All conversions use the ICU data
 * bundled with Node.js (full-icu is default since Node 13).
 */

function nowIso() {
  return new Date().toISOString();
}

function parseIso(value) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Get wall-clock parts of a UTC instant in an IANA timezone. */
function wallParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // midnight edge in some ICU versions
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, '0')}:${parts.minute}`,
    seconds: `${parts.second}`,
    weekday: weekdayMap[parts.weekday],
    weekdayName: parts.weekday,
  };
}

/** Offset (minutes) between the timezone's wall clock and UTC at the given instant. */
function tzOffsetMinutes(date, timeZone) {
  const wall = wallParts(date, timeZone);
  const asUtc = Date.UTC(
    parseInt(wall.date.slice(0, 4), 10),
    parseInt(wall.date.slice(5, 7), 10) - 1,
    parseInt(wall.date.slice(8, 10), 10),
    parseInt(wall.time.slice(0, 2), 10),
    parseInt(wall.time.slice(3, 5), 10)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Convert a wall-clock string ("YYYY-MM-DD HH:MM") in a timezone to a UTC Date.
 *
 * Iterative offset refinement: compute the offset at the naive instant, then
 * re-check the offset at the candidate UTC instant. This is exact for all wall
 * times that exist, including times adjacent to DST transitions. Edge cases:
 *  - Wall times inside a spring-forward gap do not exist; we map them with the
 *    pre-gap result (deterministic, documented behavior).
 *  - Ambiguous fall-back times resolve deterministically to the later offset.
 */
function wallToUtc(wallString, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallString.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const approx = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  const offset1 = tzOffsetMinutes(approx, timeZone);
  const utc1 = new Date(approx.getTime() - offset1 * 60000);
  const offset2 = tzOffsetMinutes(utc1, timeZone);
  if (offset2 === offset1) return utc1;
  const utc2 = new Date(approx.getTime() - offset2 * 60000);
  // Accept the refined candidate only when it is self-consistent (wall time exists at offset2).
  if (tzOffsetMinutes(utc2, timeZone) === offset2) return utc2;
  return utc1; // DST gap: keep the first-pass mapping
}

/** Format a UTC instant as "HH:MM" in the given timezone. */
function fmtTimeInTz(date, timeZone) {
  return wallParts(date, timeZone).time;
}

/** Format a UTC instant as "YYYY-MM-DD" in the given timezone. */
function fmtDateInTz(date, timeZone) {
  return wallParts(date, timeZone).date;
}

/** Add minutes to a Date, returning a new Date. */
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function todayLocalDate(timeZone) {
  return fmtDateInTz(new Date(), timeZone);
}

/**
 * Start/end UTC instants of the clinic-local day containing `date`.
 * Uses the clinic IANA timezone so DST boundaries stay exact.
 */
function dayBoundsUtc(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const wall = fmt.format(date instanceof Date ? date : new Date(date)); // clinic-local YYYY-MM-DD
  const [y, mo, d] = wall.split('-').map(Number);
  const nextWall = fmt.format(new Date(Date.UTC(y, mo - 1, d + 1)));
  // Half-open interval [day 00:00, next day 00:00) in clinic wall time:
  // DST-short/long days stay exact because both bounds go through wallToUtc.
  return [wallToUtc(`${wall}T00:00`, timezone).toISOString(), wallToUtc(`${nextWall}T00:00`, timezone).toISOString()];
}

module.exports = { dayBoundsUtc,
  nowIso, parseIso, wallParts, tzOffsetMinutes, wallToUtc,
  fmtTimeInTz, fmtDateInTz, addMinutes, todayLocalDate,
};
