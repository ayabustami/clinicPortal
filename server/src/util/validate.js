'use strict';
const { badRequest } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(value, field, { required = false, max = 2000, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`, { [field]: 'required' });
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`, { [field]: 'invalid' });
  const v = trim ? value.trim() : value;
  if (v.length > max) throw badRequest(`${field} is too long (max ${max} characters)`, { [field]: 'too_long' });
  return v;
}

function email(value, field = 'email', { required = false } = {}) {
  const v = str(value, field, { required, max: 254 });
  if (v && !EMAIL_RE.test(v)) throw badRequest(`${field} is not a valid email address`, { [field]: 'invalid_email' });
  return v;
}

function int(value, field, { required = false, min, max, def } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`, { [field]: 'required' });
    return def !== undefined ? def : null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number`, { [field]: 'invalid' });
  if (min !== undefined && n < min) throw badRequest(`${field} must be at least ${min}`, { [field]: 'too_small' });
  if (max !== undefined && n > max) throw badRequest(`${field} must be at most ${max}`, { [field]: 'too_large' });
  return n;
}

function moneyCents(value, field, { required = false } = {}) {
  // Accepts cents (integer) or decimal currency strings like "150" / "150.50".
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`, { [field]: 'required' });
    return null;
  }
  let cents;
  if (typeof value === 'number') {
    cents = Math.round(value * 100);
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw badRequest(`${field} must be a positive amount`, { [field]: 'invalid' });
    cents = Math.round(parseFloat(raw) * 100);
  } else {
    throw badRequest(`${field} must be an amount`, { [field]: 'invalid' });
  }
  if (cents < 0) throw badRequest(`${field} cannot be negative`, { [field]: 'negative' });
  return cents;
}

function isoDate(value, field, { required = false } = {}) {
  const v = str(value, field, { required, max: 10 });
  if (!v) return null;
  if (!DATE_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
    throw badRequest(`${field} must be a valid date (YYYY-MM-DD)`, { [field]: 'invalid_date' });
  }
  return v;
}

function oneOf(value, field, options, { required = false, def } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`, { [field]: 'required' });
    return def !== undefined ? def : null;
  }
  if (!options.includes(value)) {
    throw badRequest(`${field} must be one of: ${options.join(', ')}`, { [field]: 'invalid_choice' });
  }
  return value;
}

function arrayField(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${field} is required`, { [field]: 'required' });
    return null;
  }
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array`, { [field]: 'invalid' });
  return value;
}

function bool(value, def = false) {
  if (value === undefined || value === null) return def;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === 1 || value === '1';
}

module.exports = { str, email, int, moneyCents, isoDate, oneOf, arrayField, bool, TIME_RE };
