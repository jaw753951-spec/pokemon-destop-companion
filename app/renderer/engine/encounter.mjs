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
 * One that comes out the same species as the last is drawn again, once. A
 * route's commonest Pokémon is common — Route 113 is mostly Spinda — but
 * three of it in a row reads as the game stuck rather than the route being
 * what it is. The second draw stands, so a route of one Pokémon still has it.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} area
 * @param {import('./pokemon.mjs').Pokemon} companion
 * @param {number|null} [previous] the species of the wild Pokémon met last
 * @returns {import('./pokemon.mjs').Pokemon}
 */
export function rollWildPokemon(rng, area, companion, previous = null) {
  const level = rollLevel(rng, companion);
  const draw = () => (rng.chance(STRAY_CHANCE) ? pickStray(rng, area, level) : pickSpecies(rng, area, level));
  let speciesId = draw();
  if (previous !== null && speciesId === previous) speciesId = draw();
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
 * How often a wild Pokémon is not one the area's own table names.
 *
 * The tables are Hoenn's and Kanto's, so on their own they could only ever
 * produce the three hundred-odd species those two regions have — and a
 * companion that walks for months never met a Pokémon from anywhere else. A
 * share of the wild comes from the whole Pokédex instead, so every species is
 * out there somewhere; the table still decides most of what a route is.
 */
export const STRAY_CHANCE = 0.3;

/** How much likelier a stray is when its type suits the terrain. */
const STRAY_TERRAIN_WEIGHT = 3;

/**
 * And how much rarer when it is a rare one ({@link isRare}): out there, but a
 * once-in-a-long-while meeting rather than a route's regular.
 */
const STRAY_LEGEND_WEIGHT = 0.05;

/**
 * The Paradox Pokémon and the Ultra Beasts, which PokeAPI flags as neither
 * legendary nor mythical — so they used to walk the road as often as a
 * Dratini, and all thirty-one of them together seven times as often as every
 * legendary and mythical put together.
 */
const RARE_SLUGS = new Set([
  // Paradox, ancient
  'great-tusk', 'scream-tail', 'brute-bonnet', 'flutter-mane', 'slither-wing', 'sandy-shocks',
  'roaring-moon', 'walking-wake', 'gouging-fire', 'raging-bolt',
  // Paradox, future
  'iron-treads', 'iron-bundle', 'iron-hands', 'iron-jugulis', 'iron-moth', 'iron-thorns',
  'iron-valiant', 'iron-leaves', 'iron-boulder', 'iron-crown',
  // Ultra Beasts
  'nihilego', 'buzzwole', 'pheromosa', 'xurkitree', 'celesteela', 'kartana', 'guzzlord',
  'poipole', 'naganadel', 'stakataka', 'blacephalon',
]);

/**
 * Whether a species is one the road only rarely turns up: a legendary — the
 * lesser ones and the box art alike, which PokeAPI flags the same — a
 * mythical, a Paradox Pokémon or an Ultra Beast.
 *
 * @param {{slug?: string, isLegendary?: boolean, isMythical?: boolean}|null|undefined} species
 */
export function isRare(species) {
  return Boolean(species && (species.isLegendary || species.isMythical || RARE_SLUGS.has(species.slug ?? '')));
}

/**
 * A wild Pokémon from anywhere in the Pokédex, leaning towards the types the
 * area's terrain suits, at the stage of its line the level calls for.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} area
 * @param {number} level
 * @returns {number} a Pokédex number
 */
export function pickStray(rng, area, level) {
  const wanted = new Set((area?.tags ?? []).flatMap((tag) => TAG_TYPES[tag] ?? []));
  const entries = Object.values(gameData().species).map((species) => ({
    value: species.id,
    weight:
      (species.types.some((type) => wanted.has(type)) ? STRAY_TERRAIN_WEIGHT : 1) *
      (isRare(species) ? STRAY_LEGEND_WEIGHT : 1),
  }));
  const chosen = rng.weighted(entries) ?? 1;
  return evolveToLevel(devolveToLevel(chosen, level), level);
}

/**
 * Walk a species back down its line to the stage a level can have reached.
 *
 * A Charizard drawn for a level-5 encounter is a Charmander; only level
 * thresholds are undone, the same way `evolveToLevel` only applies them — a
 * Vaporeon has no level it is too young for, so it stays one.
 *
 * @param {number} speciesId
 * @param {number} level
 * @returns {number}
 */
export function devolveToLevel(speciesId, level) {
  let current = speciesId;
  for (let step = 0; step < 4; step++) {
    const species = speciesOf(current);
    const previous = species?.evolvesFrom ? speciesOf(species.evolvesFrom) : null;
    if (!previous) return current;
    const into = (previous.evolutions ?? []).find((evolution) => evolution.to === current);
    if (!into || into.trigger !== 'level-up' || typeof into.minLevel !== 'number' || into.minLevel <= level) {
      return current;
    }
    current = previous.id;
  }
  return current;
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
  const pool = preferredTypes.length ? fromTable.filter((entry) => filterByType([entry.value], preferredTypes).length) : fromTable;

  const chosen = pool.length
    ? rng.weighted(pool) ?? pool[0].value
    : rng.pick(typePool(area, preferredTypes)) ?? 1;

  return evolveToLevel(chosen, level);
}

/**
 * The Pokémon the area's own encounter table names, each weighted by how
 * often the cartridge meets it there — softened.
 *
 * The table's own shares (the `areas` build step
 * reads them off the slots) make a route's rare Pokémon rare: Route 113's
 * Skarmory is one encounter in twenty, and its Absol, Kecleon and Clefairy
 * the same. Taken as they are, they also let one Pokémon swamp a route: the
 * same Spinda seven times in ten. The square root keeps the order and most
 * of the gap — Spinda, Slugma and Skarmory at 70, 25 and 5 come out 54, 32
 * and 14 — without the road being the one Pokémon.
 *
 * A table from before the shares were kept weighs every species alike.
 *
 * @param {any} area
 * @returns {Array<{value: number, weight: number}>}
 */
export function areaSpecies(area) {
  return (area?.encounters ?? [])
    .map((encounter) => ({ value: speciesIdBySlug(encounter.species), weight: Math.sqrt(encounter.weight ?? 1) }))
    .filter((entry) => entry.value && speciesOf(entry.value));
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
    // Legendaries, mythicals, Paradoxes and Ultra Beasts are not roadside
    // encounters, nor what an ordinary trainer carries.
    if (isRare(species)) continue;
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
