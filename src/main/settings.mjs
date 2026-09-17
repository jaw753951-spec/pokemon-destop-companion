/**
 * User settings: window scale, volumes and language.
 *
 * Kept in `userData` so it survives updates, and merged over the defaults on
 * read so a settings file written by an older version stays loadable.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SETTINGS_FILE } from './paths.mjs';

/** @typedef {{scale: number, musicVolume: number, effectVolume: number, language: 'ko'|'en', windowX: number|null, windowY: number|null}} Settings */

/** @type {Settings} */
export const DEFAULTS = {
  scale: 1,
  musicVolume: 0.6,
  effectVolume: 0.8,
  language: 'ko',
  windowX: null,
  windowY: null,
};

/** Window scale steps the settings screen offers. */
export const SCALE_STEPS = [0.75, 1, 1.25, 1.5, 2];

/** @type {Settings|null} */
let cached = null;

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    cached = sanitize({ ...DEFAULTS, ...raw });
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const current = await loadSettings();
  cached = sanitize({ ...current, ...patch });
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(cached, null, 2));
  return cached;
}

/**
 * Clamp everything to a usable range: a corrupt or hand-edited file should
 * never leave the window at zero size or the audio at a broken gain.
 * @param {Settings} settings
 * @returns {Settings}
 */
function sanitize(settings) {
  const nearest = SCALE_STEPS.reduce((best, step) =>
    Math.abs(step - settings.scale) < Math.abs(best - settings.scale) ? step : best,
  );
  return {
    scale: nearest,
    musicVolume: clamp01(settings.musicVolume),
    effectVolume: clamp01(settings.effectVolume),
    language: settings.language === 'en' ? 'en' : 'ko',
    windowX: Number.isFinite(settings.windowX) ? Math.round(settings.windowX) : null,
    windowY: Number.isFinite(settings.windowY) ? Math.round(settings.windowY) : null,
  };
}

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);
