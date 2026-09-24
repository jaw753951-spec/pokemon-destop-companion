/**
 * Shared helpers for reading PokeAPI records.
 *
 * The game presents official text in every language the sheet lists. Coverage
 * thins out for older entries and for languages PokeAPI carries less of, so
 * every lookup falls back through the version groups newest-first and then
 * along the language's own fallback chain rather than showing nothing.
 */
import { fallbackChain } from '../../../app/shared/languages.mjs';
import { LANGUAGES } from '../languages.mjs';
import { VERSION_GROUP_PRIORITY } from '../sources.mjs';

const PRIORITY = new Map(VERSION_GROUP_PRIORITY.map((group, index) => [group, index]));

/** Version groups we have never heard of sort after every known one. */
const rank = (group) => PRIORITY.get(group) ?? Number.MAX_SAFE_INTEGER;

/**
 * @param {Array<{name: string, language: {name: string}}>} names
 * @param {string} language
 * @returns {string|null}
 */
export function localizedName(names, language) {
  return names?.find((entry) => entry.language.name === language)?.name ?? null;
}

/**
 * One piece of text per language in the sheet.
 *
 * `read` is given a PokeAPI language name and returns that language's text, or
 * null when the record has none; every gap is then filled from the first
 * language along its fallback chain that does, and from `fallback` if none did.
 *
 * @param {(language: string) => string|null} read
 * @param {string} fallback
 * @returns {Record<string, string>}
 */
export function bundle(read, fallback) {
  /** @type {Record<string, string>} */
  const texts = {};
  for (const language of LANGUAGES) {
    // A language with no source is one PokeAPI has no text for; it is filled in
    // from its fallback below.
    const text = language.source ? read(language.source) : null;
    if (text) texts[language.code] = text;
  }

  for (const language of LANGUAGES) {
    if (texts[language.code]) continue;
    const donor = fallbackChain(LANGUAGES, language.code).find((code) => texts[code]);
    texts[language.code] = donor ? texts[donor] : fallback;
  }
  return texts;
}

/**
 * Every localization of a name.
 * @param {Array<{name: string, language: {name: string}}>} names
 * @param {string} fallback
 */
export function nameBundle(names, fallback) {
  return bundle((language) => localizedName(names, language), fallback);
}

/**
 * Every localization of a species' genus ("Seed Pokémon").
 * @param {Array<{genus: string, language: {name: string}}>} genera
 */
export function genusBundle(genera) {
  return bundle(
    (language) => genera?.find((entry) => entry.language.name === language)?.genus ?? null,
    '',
  );
}

/**
 * Newest flavour text in a language, preferring the most recent version group
 * the entry actually appeared in.
 *
 * @param {Array<any>} entries
 * @param {string} language
 * @param {string} textKey `flavor_text` for species/moves, `text` for items
 * @returns {string|null}
 */
export function latestFlavorText(entries, language, textKey = 'flavor_text') {
  const unwrap = (entry) => entry[textKey].replace(/[\n\f\r­]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Scarlet and Violet describe every move they dropped with the same line —
  // "This move can't be used" — which is the newest text for 170-odd moves
  // and says nothing about any of them. The game before it is asked instead.
  const candidates = (entries ?? []).filter(
    (entry) => entry.language?.name === language && !isRetiredPlaceholder(unwrap(entry)),
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => rank(versionGroupOf(a)) - rank(versionGroupOf(b)));
  // Cartridge text is hard-wrapped to the text box; unwrap it for our own layout.
  return unwrap(candidates[0]);
}

/**
 * Whether a line is the placeholder a game prints for a move it no longer
 * lets anything use, in any of the languages it ships.
 *
 * @param {string} text
 */
export function isRetiredPlaceholder(text) {
  return /^dummy data$|can.t be used\. It.s recommended|사용할 수 없는 기술입니다|使えない技です|使用できない技です|无法使用的招式|無法使用的招式|kann nicht eingesetzt werden|ne peut pas être utilisée|non può essere usata|no se puede usar/i.test(
    // The dumps keep their line breaks as a literal backslash-n.
    String(text ?? '').replace(/\\n|\s+/g, ' '),
  );
}

function versionGroupOf(entry) {
  if (entry.version_group?.name) return entry.version_group.name;
  // Species flavour text is keyed by version, not version group; the version
  // name is close enough to order by because both share the game's slug.
  const version = entry.version?.name;
  if (!version) return '';
  return VERSION_GROUP_PRIORITY.find((group) => group.includes(version) || version.includes(group)) ?? version;
}

/**
 * Every localization of a flavour text.
 * @param {Array<any>} entries
 * @param {string} [textKey]
 */
export function flavorBundle(entries, textKey = 'flavor_text') {
  return bundle((language) => latestFlavorText(entries, language, textKey), '');
}

/** `/api/v2/pokemon/25/` -> `25` */
export function idFromUrl(url) {
  const match = /\/(\d+)\/?$/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Pick the newest version group present in a Pokémon's move list for a given
 * learn method, so a species that vanished before Gen 9 still gets a learnset.
 *
 * @param {Array<any>} moves the `moves` array of a `pokemon` record
 * @param {string} method e.g. `level-up`, `machine`
 * @returns {string|null}
 */
export function newestVersionGroupFor(moves, method) {
  let best = null;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const move of moves) {
    for (const detail of move.version_group_details) {
      if (detail.move_learn_method.name !== method) continue;
      const group = detail.version_group.name;
      const groupRank = rank(group);
      if (groupRank < bestRank) {
        bestRank = groupRank;
        best = group;
      }
    }
  }
  return best;
}

/** Short stat keys, in the canonical Pokémon order. */
export const STAT_KEYS = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  'special-attack': 'spa',
  'special-defense': 'spd',
  speed: 'spe',
};
