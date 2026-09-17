/**
 * Shared helpers for reading PokeAPI records.
 *
 * The game presents official Korean text wherever it exists. Korean coverage
 * thins out for older entries, so every lookup falls back through the version
 * groups newest-first and finally to English rather than showing nothing.
 */
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
 * Both localizations of a name, with English standing in for a missing Korean.
 * @param {Array<{name: string, language: {name: string}}>} names
 * @param {string} fallback
 */
export function nameBundle(names, fallback) {
  const en = localizedName(names, 'en') ?? fallback;
  return { ko: localizedName(names, 'ko') ?? en, en };
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
  const candidates = (entries ?? []).filter((entry) => entry.language?.name === language);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => rank(versionGroupOf(a)) - rank(versionGroupOf(b)));
  // Cartridge text is hard-wrapped to the text box; unwrap it for our own layout.
  return candidates[0][textKey].replace(/[\n\f\r­]+/g, ' ').replace(/\s+/g, ' ').trim();
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
 * Both localizations of a flavour text.
 * @param {Array<any>} entries
 * @param {string} [textKey]
 */
export function flavorBundle(entries, textKey = 'flavor_text') {
  const en = latestFlavorText(entries, 'en', textKey) ?? '';
  return { ko: latestFlavorText(entries, 'ko', textKey) ?? en, en };
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
