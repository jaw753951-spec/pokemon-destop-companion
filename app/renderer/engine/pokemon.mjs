/**
 * Creating and growing an individual Pokémon.
 *
 * A Pokémon is a plain object so it serializes straight into the save; every
 * derived value (stats, current level, which moves it could learn) is computed
 * from it on demand rather than stored twice.
 */
import { gameData, moveOf, speciesOf } from '../core/data.mjs';
import { HELD_FORMES, settleHeldForme } from './forms.mjs';
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
 * @property {Array<{move: string, pp: number, ppUp?: number}>} moves
 * @property {number} hp remaining hit points
 * @property {string|null} status `brn`, `psn`, `par`, `slp`, `frz` or null
 * @property {number} statusTurns
 * @property {string|null} heldItem
 * @property {string} ability
 * @property {'male'|'female'|null} gender null for the species that have none
 * @property {boolean} shiny
 * @property {number} caughtAt epoch milliseconds
 * @property {string|null} ball the ball it was caught in
 * @property {string} [forme] the battle-only alternate forme it is wearing, if
 *   any — set by the battle as its shape changes and gone when the battle is
 */

/**
 * How often a Pokémon is shiny.
 *
 * The cartridges roll a sixteen-bit number and compare it against the
 * trainer's own; the odds that comes to have been 1/8192 from Gold and Silver
 * through Black and White, and 1/4096 from X and Y onward. This game follows
 * the newest generation's rules everywhere else — its stats, its learnsets,
 * its type chart — so it follows them here too.
 */
export const SHINY_ODDS = 1 / 4096;

/**
 * How often a wild Pokémon turns out to be carrying something.
 *
 * Straight from the cartridge: a hundred-sided roll, under 45 and it carries
 * nothing, under 95 and it carries the common slot, otherwise the rare one.
 * A Compound Eyes in the lead — here, the companion — moves both lines, which
 * is the one thing in the game that changes them.
 *
 * A species whose two slots hold the same item always carries it; that is how
 * the games say "always" rather than with a third number.
 */
export const WILD_ITEM_ODDS = { nothing: 45, common: 95 };
export const WILD_ITEM_ODDS_COMPOUND_EYES = { nothing: 20, common: 80 };

/**
 * Roll a new Pokémon at a level.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {number} speciesId
 * @param {number} level
 * @param {{
 *   ivFloor?: number,
 *   nickname?: string|null,
 *   ball?: string|null,
 *   hiddenAbility?: boolean,
 *   shiny?: boolean,
 *   gender?: 'male'|'female'|null,
 * }} [options]
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
    ability: pickAbility(rng, species, options.hiddenAbility ?? false),
    gender: options.gender !== undefined ? options.gender : rollGender(rng, species),
    shiny: options.shiny ?? rng.chance(SHINY_ODDS),
    caughtAt: Date.now(),
    ball: options.ball ?? null,
  });

  // An Ogerpon is met in one of its four masks: the Teal it wears bare, or
  // holding one of the other three — and it keeps the mask it came in.
  const masks = HELD_FORMES.get(species.slug);
  if (masks) {
    pokemon.heldItem = rng.pick([null, ...masks.keys()]) ?? null;
    settleHeldForme(pokemon);
  }

  pokemon.moves = defaultMoves(pokemon).map((move) => ({ move, pp: moveOf(move)?.pp ?? 5 }));
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/**
 * Which of a species' abilities this one turns out to have.
 *
 * A Pokémon a trainer sends out draws from the ordinary abilities, as the
 * games' trainers do. Something met in the wild draws from the whole pool with
 * the hidden ability among them and no better or worse odds than the rest:
 * the cartridges gate hidden abilities behind raids and Ability Patches, and
 * this game has neither, so a Pokémon walking around out there is the only
 * place one can come from.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} species
 * @param {boolean} hiddenAbility whether the hidden ability is in the draw
 */
function pickAbility(rng, species, hiddenAbility) {
  const pool = hiddenAbility
    ? species.abilities
    : species.abilities.filter((entry) => !entry.hidden);
  if (pool.length) return rng.pick(pool).name;
  return species.abilities[0]?.name ?? 'none';
}

/**
 * Whether this one is male, female, or neither.
 *
 * The dex files it as eighths: -1 for a species with no gender at all, and
 * otherwise how many eighths of them are female. A Bulbasaur is 1, so one in
 * eight; a Chansey is 8, so all of them.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {any} species
 * @returns {'male'|'female'|null}
 */
export function rollGender(rng, species) {
  const rate = species?.genderRate ?? -1;
  if (rate < 0) return null;
  return rng.next() < rate / 8 ? 'female' : 'male';
}

/**
 * Give a wild Pokémon whatever it turned out to be carrying.
 *
 * Only the wild: a trainer's Pokémon is handed its item by whoever built the
 * party, which is what the cartridges do too — `SetWildMonHeldItem` refuses to
 * run at all in a trainer battle.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {Pokemon} pokemon
 * @param {{compoundEyes?: boolean}} [options] whether the lead has the ability
 *   that turns up more of them
 * @returns {string|null} what it ended up holding
 */
export function rollWildHeldItem(rng, pokemon, options = {}) {
  const slots = speciesOf(pokemon.speciesId)?.heldItems;
  if (!slots || (!slots.common && !slots.rare)) return null;

  // Both slots holding the same thing is how the games say "always".
  if (slots.common && slots.common === slots.rare) {
    pokemon.heldItem = slots.common;
    return pokemon.heldItem;
  }

  const odds = options.compoundEyes ? WILD_ITEM_ODDS_COMPOUND_EYES : WILD_ITEM_ODDS;
  const roll = rng.int(0, 99);
  if (roll < odds.nothing) return null;

  pokemon.heldItem = (roll < odds.common ? slots.common : slots.rare) ?? null;
  return pokemon.heldItem;
}

/**
 * Which slot of its species' ability list a Pokémon is filling.
 *
 * The games keep this rather than the ability itself, which is why a Pokémon
 * that evolves keeps the ability in the same place rather than the one it had
 * by name — an Eevee with Run Away becomes a Vaporeon with Water Absorb, not a
 * Vaporeon that has somehow kept running away.
 *
 * @param {Pokemon} pokemon
 * @returns {number} -1 when the ability is not one of the species' own
 */
export function abilitySlot(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  return (species?.abilities ?? []).findIndex((entry) => entry.name === pokemon.ability);
}

/**
 * The move every Pokémon falls back on when it has nothing that hits.
 *
 * Tackle is the series' own answer to the same question — it is what a starter
 * opens with and what the games hand out when a moveset would otherwise have
 * nothing in it — and every Pokémon in this game can be given it, because the
 * alternative is a Pokémon that cannot fight.
 */
export const DEFAULT_ATTACK = 'tackle';

/** Whether a move actually does damage, as opposed to setting something up. */
export const isAttack = (slug) => {
  const move = moveOf(slug);
  return Boolean(move && move.damageClass !== 'status' && (move.power ?? 0) > 0);
};

/**
 * The four most recent level-up moves available at the Pokémon's level, which
 * is what the games give a freshly encountered Pokémon — with the guarantee
 * that at least one of them hits.
 *
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
  let chosen = unique.slice(-4);

  if (chosen.length === 0) {
    // A species whose learnset starts above this level still needs something.
    const fallback = species.learnset.level.map(([, move]) => move).find((move) => moveOf(move));
    chosen = fallback ? [fallback] : [];
  }

  return withAttack(chosen, species);
}

/**
 * The same four moves, but with something that hits among them.
 *
 * Some species learn nothing but status moves for their first several levels —
 * a Smeargle knows only Sketch, a Magikarp only Splash and a Tackle it gets at
 * fifteen, a Metapod only Harden — and a companion that fights on its own for
 * hours had no way to win those fights: it stood there raising its defence
 * until something knocked it over. So the last slot is given the best hitting
 * move the species has anywhere in its level-up list, and failing that the
 * fallback above.
 *
 * The move is chosen from the species' own learnset first, so a Metapod gets
 * its own Tackle back rather than being handed one it was never meant to know.
 *
 * @param {string[]} moves
 * @param {any} species
 * @returns {string[]}
 */
function withAttack(moves, species) {
  if (moves.some(isAttack)) return moves;

  const fromSpecies = (species?.learnset?.level ?? [])
    .map(([, move]) => move)
    .filter((move) => isAttack(move));
  // The last one it would learn is the strongest thing it has a claim to.
  const attack = fromSpecies.at(-1) ?? (moveOf(DEFAULT_ATTACK) ? DEFAULT_ATTACK : null);
  if (!attack || moves.includes(attack)) return moves;

  // Replace the last slot rather than the first: a full set keeps the three
  // moves the level actually earned, and the one it gives up is the oldest of
  // the four it was carrying.
  if (moves.length >= 4) return [...moves.slice(0, 3), attack];
  return [...moves, attack];
}

/**
 * Make sure a Pokémon has something it can attack with, teaching it one if it
 * has not.
 *
 * Saves written before that was guaranteed are full of Pokémon that cannot
 * fight, and the companion is one of them, so the run repairs them on load
 * rather than leaving a player to notice it mid-battle.
 *
 * @param {Pokemon} pokemon
 * @returns {string|null} the move it was taught, if it needed one
 */
export function ensureAttack(pokemon) {
  if (!pokemon) return null;
  const known = (pokemon.moves ?? []).map((entry) => entry?.move).filter(Boolean);
  if (known.some(isAttack)) return null;

  const species = speciesOf(pokemon.speciesId);
  const [taught] = withAttack(known, species).filter((move) => !known.includes(move));
  if (!taught) return null;

  setMove(pokemon, Math.min(3, Math.max(0, known.length)), taught);
  return taught;
}

/** @param {Pokemon} pokemon */
export function levelOf(pokemon) {
  const species = speciesOf(pokemon.speciesId);
  return levelForExperience(species.growthRate, pokemon.experience);
}

/**
 * The base stats the Pokémon is currently wearing.
 *
 * An alternate forme carries its own set, and a battle reads them through the
 * forme the combatant is marked with — a Zen Mode below half really is twice
 * the attack and half the speed on its card. Outside a battle no forme is
 * marked, so this is the species' own numbers, which is what the screens
 * should be showing anyway.
 *
 * @param {Pokemon} pokemon
 * @param {string} [forme] the alternate forme it is currently wearing, if any
 */
export function statsOf(pokemon, forme) {
  const species = speciesOf(pokemon.speciesId);
  const base = forme
    ? (species.forms ?? []).find((form) => form.slug === forme)?.stats ?? species.stats
    : species.stats;
  const nature = gameData().natures[pokemon.nature] ?? { increased: null, decreased: null };
  return computeStats(base, pokemon.ivs, pokemon.evs, levelOf(pokemon), nature);
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
 * @param {{trainerBattle?: boolean, experienceMultiplier?: number, effortMultiplier?: number}} [options]
 * @returns {{experience: number, levelsGained: number, newLevel: number, learnable: string[]}}
 */
export function gainFromDefeat(pokemon, defeated, options = {}) {
  const before = levelOf(pokemon);
  const amount = experienceYield(
    { baseExp: defeated.baseExp, level: defeated.level },
    before,
    options.trainerBattle ? 1.5 : 1,
  );

  // A Lucky Egg pays more experience and a Macho Brace more effort; both are
  // held items, and both are applied to what the defeat was worth.
  const gained = Math.round(amount * (options.experienceMultiplier ?? 1));
  pokemon.experience += gained;

  const effort = effortYield(defeated.baseStats);
  const effortMultiplier = options.effortMultiplier ?? 1;
  pokemon.evs = addEffort(
    pokemon.evs,
    effortMultiplier === 1
      ? effort
      : Object.fromEntries(Object.entries(effort).map(([stat, value]) => [stat, value * effortMultiplier])),
  );

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
  // A new move in the slot starts at its own ceiling: what a PP Up bought
  // belonged to the move that was there, not to the slot.
  const entry = { move, pp, ppUp: 0 };
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
  for (const slot of pokemon.moves) slot.pp = maxPp(slot);
}

/**
 * A move slot's full PP, with whatever a PP Up has bought for it.
 *
 * The raise is kept on the slot rather than on the move, because two Pokémon
 * knowing the same move need not have had the same spent on it — and because
 * the move data is reference data the save must never write into.
 *
 * @param {{move: string, pp: number, ppUp?: number}} slot
 */
export function maxPp(slot) {
  const base = moveOf(slot.move)?.pp ?? slot.pp;
  return base + Math.floor(base * (slot.ppUp ?? 0));
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

  // An Everstone stops the levelling kind and nothing else, which is exactly
  // what it is for: a Pokémon can still be handed a stone while holding one.
  const everstone = gameData().items[pokemon.heldItem ?? '']?.held?.on === 'noEvolve';

  for (const evolution of species.evolutions ?? []) {
    if (!speciesOf(evolution.to)) continue;

    if (evolution.trigger === 'level-up') {
      if (everstone) continue;
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
  const slot = abilitySlot(pokemon);
  pokemon.speciesId = speciesId;
  const species = speciesOf(speciesId);
  if (!species.abilities.some((entry) => entry.name === pokemon.ability)) {
    // The same slot in the new species' list, which is what the games carry
    // across; a species with fewer abilities than the last falls back to its
    // first, and a hidden ability stays hidden where there is one to stay in.
    const kept = species.abilities[slot] ?? species.abilities[0];
    pokemon.ability = kept?.name ?? pokemon.ability;
  }
  pokemon.hp = Math.max(1, Math.round(maxHp(pokemon) * ratio));
  return pokemon;
}
