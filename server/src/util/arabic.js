'use strict';
/**
 * Arabic-aware search normalization.
 * Used ONLY to build searchable derivative columns — stored display names are
 * never modified. Conservative rules: folds well-known equivalence classes
 * (alef variants, ya/alef-maksura, ta-marbuta/ha, diacritics, tatweel),
 * strips punctuation and collapses whitespace, lowercases Latin.
 */

const DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // tashkeel + quranic marks + tatweel
const ALEF_VARIANTS_RE = /[\u0622\u0623\u0625\u0671\u0672\u0673]/g; // آ أ إ ٱ ٲ ٳ → ا
const TA_MARBUTA_RE = /\u0629/g; // ة → ه
const ALEF_MAKSURA_RE = /\u0649/g; // ى → ي
const HAMZA_ON_WAW_RE = /\u0624/g; // ؤ → و
const HAMZA_ON_YA_RE = /\u0626/g; // ئ → ي
const NON_ALNUM_RE = /[^\p{L}\p{N}\s]/gu;
const WS_RE = /\s+/g;

function normalizeArabic(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(DIACRITICS_RE, '')
    .replace(ALEF_VARIANTS_RE, '\u0627')
    .replace(TA_MARBUTA_RE, '\u0647')
    .replace(ALEF_MAKSURA_RE, '\u064A')
    .replace(HAMZA_ON_WAW_RE, '\u0648')
    .replace(HAMZA_ON_YA_RE, '\u064A')
    .replace(NON_ALNUM_RE, ' ')
    .replace(WS_RE, ' ')
    .trim()
    .toLowerCase();
}

module.exports = { normalizeArabic };
