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
import { createPokemon, levelOf, rollWildHeldItem } from './pokemon.mjs';

/**
 * How far a wild Pokémon's level may sit from the companion's.
 *
 * The spread narrows as the companion gets weaker: a level 5 starter meeting
 * a level 20 bird is not a challenge, it is a blackout, so the earliest
 * routes keep their wilds within a couple of levels either way and the range
 * opens up as the team — and its movepool — grows into it.
 */
export const LEVEL_SPREAD = { min: -6, max: 6 };

/** The most Pokémon a trainer on the road is ever given. */
export const PARTY_CAP = 3;

/**
 * The spread actually on offer at a given level, widest at the top.
 *
 * A wild Pokémon used to be able to turn up fifteen levels above the
 * companion, which is not a fight — it is a blackout with extra steps, and on
 * a game that plays itself the player cannot even run. The road is meant to be
 * somewhere a companion walks, so the wilds now sit around the companion
 * rather than above it.
 *
 * | level | down | up |
 * |-------|------|----|
 * |   1–7 |   -2 | +2 |
 * |  8–14 |   -3 | +5 |
 * | 15–24 |   -4 | +9 |
 * |   25+ |   -5 | +15 |
 *
 * @param {number} level
 */
export function spreadFor(level) {
  if (level <= 7) return { min: -2, max: 1 };
  if (level <= 14) return { min: -3, max: 2 };
  if (level <= 24) return { min: -4, max: 4 };
  return LEVEL_SPREAD;
}

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
  // Out here the hidden ability is in the draw with the rest. Nothing else in
  // this game hands one out — there are no raids and the Ability Patch is a
  // thing the player has to find first — so the wild is where they come from.
  const wild = createPokemon(rng, speciesId, level, { hiddenAbility: true });

  // And whatever it turned out to be carrying, which the cartridges roll off
  // the lead party Pokémon's ability — the companion, here.
  rollWildHeldItem(rng, wild, { compoundEyes: companion?.ability === 'compound-eyes' });
  return wild;
}

/**
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {import('./pokemon.mjs').Pokemon} companion
 */
export function rollLevel(rng, companion) {
  const level = levelOf(companion);
  const spread = spreadFor(level);
  return Math.max(1, Math.min(100, level + rng.int(spread.min, spread.max)));
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
  // Parties start small: one Pokémon until the companion has seen its first
  // few levels through, then the class's own range as the team fills out.
  // Early trainers with three monsters a level-5 starter cannot out-trade
  // made the first ten minutes a coin flip on which trainer walked up.
  const companionLevel = levelOf(companion);
  // One Pokémon while the companion is finding its feet, then two, then
  // three — and never the six a class may claim on paper. A companion is one
  // Pokémon; six of anything is a wall, not a fight.
  const cap = companionLevel <= 5 ? 1 : companionLevel <= 11 ? 2 : Math.min(maxParty, PARTY_CAP);
  const high = Math.max(minParty, Math.min(maxParty, cap));
  const size = companionLevel <= 5 ? minParty : rng.int(minParty, high);

  const party = [];
  for (let index = 0; index < size; index++) {
    const level = rollLevel(rng, companion);
    const speciesId = pickSpecies(rng, area, level, trainerClass.types ?? []);
    // No floor on the genes: an ordinary trainer's Pokémon is somebody's
    // ordinary Pokémon, not a bred one.
    party.push(createPokemon(rng, speciesId, level));
  }

  // A trainer leads with their weakest and saves their strongest for last, the
  // way the games order a party.
  party.sort((a, b) => levelOf(a) - levelOf(b));
  giveTrainerItems(rng, party, 'trainer');
  return { trainerClass, party };
}

/**
 * What the Pokémon a person sends out is carrying.
 *
 * The cartridges do not roll this — a trainer's party is typed out by hand,
 * item and all — so the rule here is read off the party data rather than
 * invented. Counting Emerald's 770 ordinary trainer parties: 1487 Pokémon, of
 * which 55 hold anything at all, and all but a handful of those hold an Oran
 * Berry. Every gym leader's ace holds a berry — an Oran early, a Sitrus or a
 * Chesto once the badges are in — and so does every Elite Four member's and
 * the champion's, and nothing else on their teams does.
 *
 * So: an ordinary trainer's Pokémon almost never carries one, and someone
 * worth a badge saves it for the Pokémon they lead with last.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {import('./pokemon.mjs').Pokemon[]} party sorted weakest first
 * @param {'trainer'|'leader'|'champion'} rank
 */
export function giveTrainerItems(rng, party, rank) {
  if (party.length === 0) return party;

  if (rank === 'trainer') {
    // 55 of 1487, which is one in twenty-seven.
    for (const pokemon of party) {
      if (!pokemon.heldItem && rng.chance(TRAINER_ITEM_CHANCE)) pokemon.heldItem = 'oran-berry';
    }
    return party;
  }

  const ace = party[party.length - 1];
  if (!ace.heldItem) ace.heldItem = levelOf(ace) < SITRUS_LEVEL ? 'oran-berry' : 'sitrus-berry';
  return party;
}

/** How often an ordinary trainer's Pokémon carries anything: 55 of 1487. */
const TRAINER_ITEM_CHANCE = 55 / 1487;

/** The level the leaders' berries stop being Orans, roughly where Emerald's do. */
const SITRUS_LEVEL = 25;
