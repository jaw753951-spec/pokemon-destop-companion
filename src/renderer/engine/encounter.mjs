/**
 * Choosing what the companion runs into.
 *
 * Wild Pokémon come from the area's own encounter table where the games have
 * one, and otherwise from the types that suit the area's terrain. Either way
 * the result is pushed forward through its evolution line to match the level
 * rolled, so a route never produces a level-50 Wingull that should long since
 * have become a Pelipper.
 */
import { TAG_TYPES } from '../../shared/area-tags.mjs';
import { gameData, speciesIdBySlug, speciesOf } from '../core/data.mjs';
import { createPokemon, levelOf } from './pokemon.mjs';

/** How far a wild Pokémon's level may sit from the companion's. */
export const LEVEL_SPREAD = { min: -5, max: 15 };

/**
 * Roll a wild Pokémon for the area the companion is in.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} area
 * @param {import('./pokemon.mjs').Pokemon} companion
 * @returns {import('./pokemon.mjs').Pokemon}
 */
export function rollWildPokemon(rng, area, companion) {
  const level = rollLevel(rng, companion);
  const speciesId = pickSpecies(rng, area, level);
  return createPokemon(rng, speciesId, level);
}

/**
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {import('./pokemon.mjs').Pokemon} companion
 */
export function rollLevel(rng, companion) {
  const level = levelOf(companion);
  return Math.max(1, Math.min(100, level + rng.int(LEVEL_SPREAD.min, LEVEL_SPREAD.max)));
}

/**
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} area
 * @param {number} level
 * @param {string[]} [preferredTypes] narrows the pool, for a trainer's party
 * @returns {number} a Pokédex number
 */
export function pickSpecies(rng, area, level, preferredTypes = []) {
  const fromTable = areaSpecies(area);
  const pool = preferredTypes.length ? filterByType(fromTable, preferredTypes) : fromTable;

  const chosen = pool.length
    ? rng.pick(pool)
    : rng.pick(typePool(area, preferredTypes)) ?? 1;

  return evolveToLevel(chosen, level);
}

/**
 * Pokédex numbers the area's own encounter table names.
 * @param {any} area
 * @returns {number[]}
 */
export function areaSpecies(area) {
  return (area?.encounters ?? [])
    .map((encounter) => speciesIdBySlug(encounter.species))
    .filter((id) => id && speciesOf(id));
}

/**
 * Every species matching the area's terrain types, used when the area has no
 * table of its own or a trainer wants a particular type.
 *
 * @param {any} area
 * @param {string[]} [preferredTypes]
 * @returns {number[]}
 */
export function typePool(area, preferredTypes = []) {
  const tags = area?.tags ?? ['grass'];
  const wanted = new Set(
    preferredTypes.length ? preferredTypes : tags.flatMap((tag) => TAG_TYPES[tag] ?? []),
  );
  if (wanted.size === 0) wanted.add('normal');

  const pool = [];
  for (const species of Object.values(gameData().species)) {
    // Legendaries and mythicals are not roadside encounters.
    if (species.isLegendary || species.isMythical) continue;
    if (species.types.some((type) => wanted.has(type))) pool.push(species.id);
  }
  return pool.length ? pool : [1];
}

/**
 * @param {number[]} ids
 * @param {string[]} types
 */
function filterByType(ids, types) {
  const wanted = new Set(types);
  return ids.filter((id) => speciesOf(id)?.types.some((type) => wanted.has(type)));
}

/**
 * Follow a species' level-up evolutions as far as the given level allows.
 *
 * Only level thresholds are applied: a stone or trade evolution has no level
 * at which it "should" have happened, so those lines stay where they are.
 *
 * @param {number} speciesId
 * @param {number} level
 * @returns {number}
 */
export function evolveToLevel(speciesId, level) {
  let current = speciesId;

  // Bounded rather than `while (true)`: a malformed chain must not hang.
  for (let step = 0; step < 4; step++) {
    const species = speciesOf(current);
    if (!species) return current;

    const next = (species.evolutions ?? []).find(
      (evolution) =>
        evolution.trigger === 'level-up' &&
        typeof evolution.minLevel === 'number' &&
        evolution.minLevel <= level &&
        speciesOf(evolution.to),
    );
    if (!next) return current;
    current = next.to;
  }
  return current;
}

/**
 * Build a trainer for the area: a class that belongs there, and a party drawn
 * from the area's own pool narrowed to the types that class favours.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} area
 * @param {import('./pokemon.mjs').Pokemon} companion
 * @param {Array<any>} classes from `data/authored/trainer-classes.json`
 * @returns {{trainerClass: any, party: import('./pokemon.mjs').Pokemon[]}}
 */
export function rollTrainer(rng, area, companion, classes) {
  const tags = new Set(area?.tags ?? []);
  const local = classes.filter(
    (entry) => entry.areas.length === 0 || entry.areas.some((tag) => tags.has(tag)),
  );
  const trainerClass = rng.pick(local.length ? local : classes);

  const [minParty, maxParty] = trainerClass.party ?? [1, 3];
  const size = rng.int(minParty, Math.max(minParty, maxParty));

  const party = [];
  for (let index = 0; index < size; index++) {
    const level = rollLevel(rng, companion);
    const speciesId = pickSpecies(rng, area, level, trainerClass.types ?? []);
    party.push(createPokemon(rng, speciesId, level, { ivFloor: 8 }));
  }

  // A trainer leads with their weakest and saves their strongest for last, the
  // way the games order a party.
  party.sort((a, b) => levelOf(a) - levelOf(b));
  return { trainerClass, party };
}
