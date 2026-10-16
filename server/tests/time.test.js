'use strict';
/**
 * Timezone correctness unit tests (audit P4): the clinic's IANA timezone is
 * authoritative for wall-clock scheduling. Asia/Hebron is UTC+2 in winter and
 * UTC+3 in summer (DST), so the same wall time maps to different UTC instants.
 */
const test = require('node:test');
const assert = require('node:assert');
const { wallToUtc, wallParts } = require('../src/util/time');

const TZ = 'Asia/Hebron';

test('time: winter wall time maps to UTC+2', () => {
  const utc = wallToUtc('2026-01-15 10:00', TZ);
  assert.equal(utc.toISOString(), '2026-01-15T08:00:00.000Z');
});

test('time: summer wall time maps to UTC+3 (DST)', () => {
  const utc = wallToUtc('2026-07-15 10:00', TZ);
  assert.equal(utc.toISOString(), '2026-07-15T07:00:00.000Z');
});

test('time: winter and summer offsets differ for the same wall clock', () => {
  const winter = wallToUtc('2026-01-15 10:00', TZ);
  const summer = wallToUtc('2026-07-15 10:00', TZ);
  assert.notEqual(summer.toISOString().slice(11, 16), winter.toISOString().slice(11, 16));
});

test('time: round trip wall -> utc -> wall is stable across DST', () => {
  for (const day of ['2026-01-15', '2026-03-26', '2026-03-28', '2026-07-15', '2026-10-23', '2026-10-25', '2026-12-31']) {
    for (const hm of ['00:30', '08:00', '12:00', '16:30', '23:30']) {
      const utc = wallToUtc(`${day} ${hm}`, TZ);
      const wall = wallParts(utc, TZ);
      assert.equal(`${wall.date} ${wall.time}`, `${day} ${hm}`, `round trip failed for ${day} ${hm}`);
    }
  }
});

test('time: other clinic timezone (Asia/Gaza) behaves identically to Hebron rules', () => {
  const gazaWinter = wallToUtc('2026-01-15 09:00', 'Asia/Gaza');
  const gazaSummer = wallToUtc('2026-07-15 09:00', 'Asia/Gaza');
  assert.equal(gazaWinter.toISOString(), '2026-01-15T07:00:00.000Z');
  assert.equal(gazaSummer.toISOString(), '2026-07-15T06:00:00.000Z');
});

test('time: UTC zone has no offset drift', () => {
  const utc = wallToUtc('2026-07-15 10:00', 'UTC');
  assert.equal(utc.toISOString(), '2026-07-15T10:00:00.000Z');
});
