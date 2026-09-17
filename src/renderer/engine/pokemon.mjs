/**
 * Creating and growing an individual Pokémon.
 *
 * A Pokémon is a plain object so it serializes straight into the save; every
 * derived value (stats, current level, which moves it could learn) is computed
 * from it on demand rather than stored twice.
 */
import { gameData, moveOf, speciesOf } from '../core/data.mjs';
import {
  addEffort,
  computeStats,
  effortYield,
  experienceForLevel,
  experienceYield,
  levelForExperience,
  STATS,
} from './stats.mjs';

/**
 * @typedef {Object} Pokemon
 * @property {number} speciesId
 * @property {string|null} nickname
 * @property {number} experience
 * @property {string} nature
 * @property {Record<string, number>} ivs
 * @property {Record<string, number>} evs
 * @property {Array<{move: string, pp: number}>} moves
 * @property {number} hp remaining hit points
 * @property {string|null} status `brn`, `psn`, `par`, `slp`, `frz` or null
 * @property {number} statusTurns
 * @property {string|null} heldItem
 * @property {string} ability
 * @property {number} caughtAt epoch milliseconds
 * @property {string|null} ball the ball it was caught in
 */

/**
 * Roll a new Pokémon at a level.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {number} speciesId
 * @param {number} level
 * @param {{ivFloor?: number, nickname?: string|null, ball?: string|null}} [options]
 * @returns {Pokemon}
 */
export function createPokemon(rng, speciesId, level, options = {}) {
  const species = speciesOf(speciesId);
  if (!species) throw new Error(`Unknown species ${speciesId}`);

  const ivFloor = options.ivFloor ?? 0;
  /** @type {Record<string, number>} */
  const ivs = {};
  for (const stat of STATS) ivs[stat] = rng.int(ivFloor, 31);

  const natures = Object.keys(gameData().natures);
  const pokemon = /** @type {Pokemon} */ ({
    speciesId,
    nickname: options.nickname ?? null,
    experience: experienceForLevel(species.growthRate, Math.max(1, level)),
    nature: natures.length ? rng.pick(natures) : 'hardy',
    ivs,
    evs: Object.fromEntries(STATS.map((stat) => [stat, 0])),
    moves: [],
    hp: 0,
    status: null,
    statusTurns: 0,
    heldItem: null,
    ability: pickAbility(rng, species),
    caughtAt: Date.now(),
    ball: options.ball ?? null,
  });

  pokemon.moves = defaultMoves(pokemon).map((move) => ({ move, pp: moveOf(move)?.pp ?? 5 }));
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/**
 * Hidden abilities are rare in the wild, so they are only rolled occasionally.
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} species
 */
function pickAbility(rng, species) {
  const regular = species.abilities.filter((entry) => !entry.hidden);
  const hidden = species.abilities.filter((entry) => entry.hidden);
  if (hidden.length && rng.chance(0.05)) return rng.pick(hidden).name;
  if (regular.length) return rng.pick(regular).name;
  return species.abilities[0]?.name ?? 'none';
}

/**
 * The four most recent level-up moves available at the Pokémon's level, which
 * is what the games give a freshly encountered Pokémon.
 * @param {Pokemon} pokemon
 * @returns {string[]}
 */
export function defaultMoves(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);
  const learnable = species.learnset.level
    .filter(([at]) => at <= level)
    .map(([, move]) => move)
    .filter((move) => moveOf(move));

  const unique = [...new Set(learnable)];
  const chosen = unique.slice(-4);
  if (chosen.length) return chosen;

  // A species whose learnset starts above this level still needs something.
  const fallback = species.learnset.level.map(([, move]) => move).find((move) => moveOf(move));
  return fallback ? [fallback] : ['tackle'];
}

/** @param {Pokemon} pokemon */
export function levelOf(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  return levelForExperience(species.growthRate, pokemon.experience);
}

/** @param {Pokemon} pokemon */
export function statsOf(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  const nature = gameData().natures[pokemon.nature] ?? { increased: null, decreased: null };
  return computeStats(species.stats, pokemon.ivs, pokemon.evs, levelOf(pokemon), nature);
}

/** @param {Pokemon} pokemon */
export const maxHp = (pokemon) => statsOf(pokemon).hp;

/** @param {Pokemon} pokemon */
export const displayName = (pokemon) => pokemon.nickname || null;

/**
 * Progress towards the next level, for the experience bar.
 * @param {Pokemon} pokemon
 * @returns {{level: number, into: number, needed: number, ratio: number}}
 */
export function experienceProgress(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);
  if (level >= 100) return { level, into: 0, needed: 0, ratio: 1 };

  const floor = experienceForLevel(species.growthRate, level);
  const ceiling = experienceForLevel(species.growthRate, level + 1);
  const into = pokemon.experience - floor;
  const needed = ceiling - floor;
  return { level, into, needed, ratio: needed > 0 ? Math.min(1, into / needed) : 0 };
}

/**
 * Award experience and effort, and report what changed so the battle log can
 * narrate it.
 *
 * @param {Pokemon} pokemon
 * @param {{baseStats: Record<string, number>, baseExp: number, level: number}} defeated
 * @param {{trainerBattle?: boolean}} [options]
 * @returns {{experience: number, levelsGained: number, newLevel: number, learnable: string[]}}
 */
export function gainFromDefeat(pokemon, defeated, options = {}) {
  const before = levelOf(pokemon);
  const amount = experienceYield(
    { baseExp: defeated.baseExp, level: defeated.level },
    before,
    options.trainerBattle ? 1.5 : 1,
  );

  pokemon.experience += amount;
  pokemon.evs = addEffort(pokemon.evs, effortYield(defeated.baseStats));

  const after = levelOf(pokemon);
  // A level-up tops up the extra hit points immediately, as the games do.
  if (after > before) pokemon.hp = Math.min(maxHp(pokemon), pokemon.hp + (after - before) * 2);

  return {
    experience: amount,
    levelsGained: after - before,
    newLevel: after,
    learnable: movesLearnedBetween(pokemon, before, after),
  };
}

/**
 * Level-up moves that became available while crossing levels.
 * @param {Pokemon} pokemon
 * @param {number} fromLevel exclusive
 * @param {number} toLevel inclusive
 */
export function movesLearnedBetween(pokemon, fromLevel, toLevel) {
  const species = speciesOf(pokemon.speciesId);
  const known = new Set(pokemon.moves.map((slot) => slot.move));
  return [
    ...new Set(
      species.learnset.level
        .filter(([at, move]) => at > fromLevel && at <= toLevel && moveOf(move) && !known.has(move))
        .map(([, move]) => move),
    ),
  ];
}

/**
 * Every move this Pokémon could have in a slot: its level-up moves up to its
 * current level, plus any TM the player has used on it.
 *
 * @param {Pokemon} pokemon
 * @param {string[]} [unlockedMachines] move slugs unlocked by TMs
 * @returns {string[]}
 */
export function availableMoves(pokemon, unlockedMachines = []) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);
  const fromLevels = species.learnset.level.filter(([at]) => at <= level).map(([, move]) => move);
  const fromMachines = unlockedMachines.filter((move) => species.learnset.machine.includes(move));
  return [...new Set([...fromLevels, ...fromMachines])].filter((move) => moveOf(move));
}

/**
 * Put a move in a slot, keeping its PP fresh.
 * @param {Pokemon} pokemon
 * @param {number} slot 0..3
 * @param {string} move
 */
export function setMove(pokemon, slot, move) {
  const pp = moveOf(move)?.pp ?? 5;
  const entry = { move, pp };
  if (slot < pokemon.moves.length) pokemon.moves[slot] = entry;
  else pokemon.moves.push(entry);
  pokemon.moves = pokemon.moves.slice(0, 4);
}

/**
 * Restore HP, PP and status — the healing event, and every league round.
 * @param {Pokemon} pokemon
 */
export function fullyHeal(pokemon) {
  pokemon.hp = maxHp(pokemon);
  pokemon.status = null;
  pokemon.statusTurns = 0;
  for (const slot of pokemon.moves) slot.pp = moveOf(slot.move)?.pp ?? slot.pp;
}

/**
 * The evolution this Pokémon is ready for, if any.
 *
 * Only triggers the companion can actually satisfy on its own are considered:
 * levelling up, holding an item, or being given a stone from the bag. Trades
 * and location-specific evolutions cannot happen here.
 *
 * @param {Pokemon} pokemon
 * @param {{item?: string|null, timeOfDay?: string}} [context]
 * @returns {{to: number, trigger: string}|null}
 */
export function pendingEvolution(pokemon, context = {}) {
  const species = speciesOf(pokemon.speciesId);
  const level = levelOf(pokemon);

  for (const evolution of species.evolutions ?? []) {
    if (!speciesOf(evolution.to)) continue;

    if (evolution.trigger === 'level-up') {
      if (evolution.minLevel && level < evolution.minLevel) continue;
      if (!evolution.minLevel && !evolution.happiness) continue;
      if (evolution.happiness && level < 20) continue;
      if (evolution.knownMove && !pokemon.moves.some((slot) => slot.move === evolution.knownMove)) continue;
      if (evolution.timeOfDay && context.timeOfDay && !matchesTime(evolution.timeOfDay, context.timeOfDay)) continue;
      if (evolution.heldItem && pokemon.heldItem !== evolution.heldItem) continue;
      return { to: evolution.to, trigger: 'level-up' };
    }

    if (evolution.trigger === 'use-item' && context.item && evolution.item === context.item) {
      return { to: evolution.to, trigger: 'use-item' };
    }
  }
  return null;
}

/**
 * @param {string} required `day`, `night`, `dusk`
 * @param {string} current one of the five background bands
 */
function matchesTime(required, current) {
  if (required === 'night') return current === 'night' || current === 'dusk';
  if (required === 'dusk') return current === 'dusk';
  return current === 'day' || current === 'dawn' || current === 'afternoon';
}

/**
 * Evolve in place, keeping level, effort, moves and nickname.
 * @param {Pokemon} pokemon
 * @param {number} speciesId
 */
export function evolveInto(pokemon, speciesId) {
  const ratio = pokemon.hp / maxHp(pokemon);
  pokemon.speciesId = speciesId;
  const species = speciesOf(speciesId);
  if (!species.abilities.some((entry) => entry.name === pokemon.ability)) {
    pokemon.ability = species.abilities[0]?.name ?? pokemon.ability;
  }
  pokemon.hp = Math.max(1, Math.round(maxHp(pokemon) * ratio));
  return pokemon;
}
