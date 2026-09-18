/**
 * The supported-language sheet.
 *
 * Which languages exist is data, not code: `data/authored/i18n/languages.json`
 * lists every one the game ships, and the main process (which validates the
 * setting), the renderer (which loads the strings) and the asset pipeline
 * (which collects the official names) all read that same sheet. Adding a
 * language is one row there plus its string file.
 *
 * This module only shapes what the sheet says; each side reads the file the way
 * it can — `fs` in main and the tools, `fetch` over `pdc://` in the renderer.
 */

/** Where the sheet lives, relative to the authored data root. */
export const LANGUAGES_FILE = 'i18n/languages.json';

/**
 * @typedef {Object} Language
 * @property {string} code the value stored in the settings, the `<html lang>`,
 *   and the key this language's text is filed under in the generated data
 * @property {string} label the language's own name for itself, as the settings
 *   screen shows it
 * @property {string} strings its UI string file, relative to the authored root
 * @property {string|null} source the PokeAPI language name its official names
 *   and flavour text come from, or null for a language PokeAPI has no text for
 * @property {string|null} grammar a grammar helper its strings need, such as
 *   `korean` for particle agreement
 * @property {string|null} fallback the language to read when this one is
 *   missing a string, so a partial translation still reads
 * @property {boolean} isDefault whether a fresh install starts in it
 */

/**
 * Read the sheet into the shape the rest of the code expects, filling in what
 * a row leaves out. A row is only dropped when it has no code at all, since
 * everything else has a sensible default.
 *
 * @param {{languages?: Array<any>}|null|undefined} sheet
 * @returns {Language[]}
 */
export function normalizeLanguages(sheet) {
  const rows = Array.isArray(sheet?.languages) ? sheet.languages : [];
  const seen = new Set();
  /** @type {Language[]} */
  const languages = [];

  for (const row of rows) {
    const code = typeof row?.code === 'string' ? row.code.trim() : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    languages.push({
      code,
      label: typeof row.label === 'string' && row.label ? row.label : code,
      strings: typeof row.strings === 'string' && row.strings ? row.strings : `i18n/${code}.json`,
      source: typeof row.source === 'string' && row.source ? row.source : null,
      grammar: typeof row.grammar === 'string' && row.grammar ? row.grammar : null,
      fallback: typeof row.fallback === 'string' && row.fallback ? row.fallback : null,
      isDefault: row.default === true,
    });
  }

  return languages;
}

/**
 * @param {Language[]} languages
 * @param {string|null|undefined} code
 * @returns {Language|null}
 */
export function findLanguage(languages, code) {
  return languages.find((language) => language.code === code) ?? null;
}

/**
 * The language a fresh install starts in: the row that claims it, or the first
 * one the sheet lists.
 *
 * @param {Language[]} languages
 * @returns {Language|null}
 */
export function defaultLanguage(languages) {
  return languages.find((language) => language.isDefault) ?? languages[0] ?? null;
}

/**
 * The order to read a language's text in: itself, whatever it falls back to,
 * and then every other language the sheet lists.
 *
 * The tail matters as much as the declared fallback — it is what lets a
 * language be added with only some of its strings written, or with no name data
 * generated for it yet, and still show something in every screen.
 *
 * @param {Language[]} languages
 * @param {string|null|undefined} code
 * @returns {string[]}
 */
export function fallbackChain(languages, code) {
  /** @type {string[]} */
  const chain = [];
  const visit = (next) => {
    const language = findLanguage(languages, next);
    // A fallback loop would otherwise spin here, so each language is taken once.
    if (!language || chain.includes(language.code)) return;
    chain.push(language.code);
    visit(language.fallback);
  };

  visit(code);
  for (const language of languages) visit(language.code);
  return chain;
}
