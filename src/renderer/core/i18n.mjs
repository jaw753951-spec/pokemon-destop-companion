/**
 * Localization.
 *
 * UI strings come from `data/authored/i18n`; Pokémon, move, item and area
 * names come from the generated data, where every record carries both a `ko`
 * and an `en` field. `t` is for the former, `name` for the latter.
 */
import { loadJson } from './bridge.mjs';
import { resolveParticles } from './korean.mjs';

/** @type {Record<string, string>} */
let strings = {};
/** @type {'ko'|'en'} */
let current = 'ko';

/** @param {'ko'|'en'} language */
export async function setLanguage(language) {
  current = language === 'en' ? 'en' : 'ko';
  strings = await loadJson('authored', `i18n/${current}.json`);
  document.documentElement.lang = current;
}

/** @returns {'ko'|'en'} */
export const language = () => current;

/**
 * Look up a UI string, substituting `{placeholders}`.
 *
 * A missing key returns the key itself: a visibly wrong label in the UI is
 * easier to spot and fix than a silent blank.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [values]
 * @returns {string}
 */
export function t(key, values) {
  const template = strings[key] ?? key;
  const filled = values
    ? template.replace(/\{(\w+)\}/g, (match, key2) => (key2 in values ? String(values[key2]) : match))
    : template;
  return current === 'ko' ? resolveParticles(filled) : filled;
}

/**
 * The current language's side of a `{ko, en}` pair from the generated data.
 * @param {{ko?: string, en?: string}|null|undefined} bundle
 * @param {string} [fallback]
 * @returns {string}
 */
export function name(bundle, fallback = '') {
  if (!bundle) return fallback;
  return bundle[current] || bundle.en || bundle.ko || fallback;
}

/**
 * Korean has no plural forms and both languages read the same here, so
 * playtime is formatted rather than translated.
 * @param {number} milliseconds
 */
export function formatPlaytime(milliseconds) {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}
