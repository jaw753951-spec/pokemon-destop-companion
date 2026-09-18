/**
 * The language sheet, as the pipeline sees it.
 *
 * The same file the game reads decides which languages the pipeline collects
 * official names and flavour text for, so a language added to the sheet is
 * picked up by the next `npm run assets` without touching a build step.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LANGUAGES_FILE, normalizeLanguages } from '../../app/shared/languages.mjs';

const SHEET = fileURLToPath(new URL(`../../data/authored/${LANGUAGES_FILE}`, import.meta.url));

/** Every language the game ships, in the sheet's order. */
export const LANGUAGES = normalizeLanguages(JSON.parse(readFileSync(SHEET, 'utf8')));

if (LANGUAGES.length === 0) throw new Error(`${LANGUAGES_FILE} lists no languages`);
