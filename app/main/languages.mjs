/**
 * The language sheet, as the main process sees it.
 *
 * Main needs it for one thing: deciding whether the language in a settings file
 * is one the game still ships. The renderer reads the very same file over
 * `pdc://`, so neither side has its own idea of which languages exist.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LANGUAGES_FILE, normalizeLanguages } from '../shared/languages.mjs';
import { AUTHORED_DIR } from './paths.mjs';

/** @type {import('../shared/languages.mjs').Language[]|null} */
let cached = null;

/**
 * An unreadable sheet gives an empty list rather than throwing: the settings
 * are then left as they were found, and the renderer — which cannot start
 * without the sheet — is where that failure surfaces.
 *
 * @returns {Promise<import('../shared/languages.mjs').Language[]>}
 */
export async function loadLanguages() {
  if (cached) return cached;
  try {
    cached = normalizeLanguages(JSON.parse(await readFile(join(AUTHORED_DIR, LANGUAGES_FILE), 'utf8')));
  } catch (error) {
    console.warn(`Could not read ${LANGUAGES_FILE}`, error);
    cached = [];
  }
  return cached;
}
