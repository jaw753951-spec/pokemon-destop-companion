/**
 * Catching a Pokémon.
 *
 * The modern (Gen 6 onward) formula: a catch value is derived from the
 * target's remaining HP, its species catch rate, the ball and any status
 * condition, then converted into a shake probability that is checked four
 * times. The capture screen shows the resulting odds before the player throws,
 * so `captureChance` exists alongside the roll itself.
 */
import { itemOf, speciesOf } from '../core/data.mjs';
import { levelOf, maxHp } from './pokemon.mjs';

/**
 * Ball multipliers that hold whatever the circumstances. A Master Ball is
 * handled as a guaranteed catch; the balls that depend on the target, the
 * place or the time are worked out in `ballBonus`.
 */
export const BALL_BONUS = {
  'master-ball': Infinity,
  'ultra-ball': 2,
  'great-ball': 1.5,
};

/**
 * The special balls (everything but the Poké, Great, Ultra and Master) are
 * worth little unless their condition is met, and a lot when it is: without
 * the condition they are a little worse than a Poké Ball, with it a half
 * again better than the games make them.
 */
export const SPECIAL_MISS = 0.6;
export const SPECIAL_BOOST = 1.5;

/**
 * @param {boolean} met whether the ball's condition holds
 * @param {number} bonus what the games give it when it does
 */
const special = (met, bonus) => (met ? bonus * SPECIAL_BOOST : SPECIAL_MISS);

/** Status multipliers, as in Gen 5 onward. */
export const STATUS_BONUS = { slp: 2.5, frz: 2.5, par: 1.5, brn: 1.5, psn: 1.5 };

/** Shake checks a throw must pass. */
export const SHAKE_CHECKS = 4;

/** Where a Net Ball's Water types are in their element. */
const NET_WATER = new Set(['water', 'beach']);
/** And its Bug types. */
const NET_BUG = new Set(['grass', 'forest', 'jungle', 'meadow']);

/** The Ultra Beasts, which a Beast Ball is made for and every other ball struggles with. */
const ULTRA_BEASTS = new Set([
  'nihilego', 'buzzwole', 'pheromosa', 'xurkitree', 'celesteela', 'kartana', 'guzzlord', 'poipole', 'naganadel',
  'stakataka', 'blacephalon',
]);

/**
 * What surrounds a throw, for the balls that care: how many balls have gone
 * before it, the companion throwing it, the species already caught, and the
 * place and hour.
 *
 * @typedef {{
 *   throws?: number,
 *   active?: import('./pokemon.mjs').Pokemon|null,
 *   caught?: Set<number>,
 *   areaTags?: string[],
 *   time?: string,
 *   berry?: string|null,
 * }} CaptureContext
 */

/**
 * @param {string} ball
 * @param {import('./pokemon.mjs').Pokemon|null} [target]
 * @param {CaptureContext} [context]
 * @returns {number}
 */
export function ballBonus(ball, target = null, context = {}) {
  if (ball === 'master-ball') return Infinity;
  const species = target ? speciesOf(target.speciesId) : null;
  // A regional form is still its species to a Beast Ball or a Moon Ball.
  const base = species?.dex ? speciesOf(species.dex) : species;
  const tags = context.areaTags ?? [];
  const beast = ULTRA_BEASTS.has(base?.slug ?? '');

  // Every ball but its own — and a Master Ball — struggles with an Ultra Beast.
  if (beast && ball !== 'beast-ball') return 0.1;
  if (ball in BALL_BONUS) return BALL_BONUS[ball];

  switch (ball) {
    case 'beast-ball':
      return beast ? 5 * SPECIAL_BOOST : 0.1;
    // The first ball thrown.
    case 'quick-ball':
      return special((context.throws ?? 0) === 0, 5);
    // Better the longer it goes on, on the games' own clock: the turns the
    // battle ran, then each ball thrown after it. It counted the balls alone,
    // which with three of them never got past a Great Ball.
    case 'timer-ball': {
      const turns = (target?.battleTurns ?? 0) + (context.throws ?? 0);
      return Math.min(4, 1 + (turns * 1229) / 4096) * SPECIAL_BOOST;
    }
    // Anything fished up, at Sun and Moon's five.
    case 'lure-ball':
      return special(Boolean(target?.fished), 5);
    // At night, or in a cave.
    case 'dusk-ball':
      return special(context.time === 'night' || tags.includes('cave'), 3);
    // A Water type in or by the water, or a Bug type in the grass or the
    // trees: the type alone was every third wild Pokémon, wherever it was.
    case 'net-ball': {
      const types = species?.types ?? [];
      const wet = types.includes('water') && (Boolean(target?.fromWater) || tags.some((tag) => NET_WATER.has(tag)));
      const leafy = types.includes('bug') && tags.some((tag) => NET_BUG.has(tag));
      return special(wet || leafy, 3.5);
    }
    // Only what was met surfing or fishing, as in the games — not everything
    // on a route that has water on it, which made it near enough a sure catch
    // for a quarter of the map.
    case 'dive-ball':
      return special(Boolean(target?.fromWater), 3.5);
    // The lower the level, the better, down from 30.
    case 'nest-ball':
      return target ? Math.max(SPECIAL_MISS, ((41 - levelOf(target)) / 10) * SPECIAL_BOOST) : SPECIAL_MISS;
    case 'repeat-ball':
      return special(Boolean(target && context.caught?.has(target.speciesId)), 3.5);
    case 'level-ball': {
      if (!target || !context.active) return SPECIAL_MISS;
      const mine = levelOf(context.active);
      const theirs = levelOf(target);
      return special(mine > theirs, mine >= theirs * 4 ? 8 : mine >= theirs * 2 ? 4 : 2);
    }
    case 'moon-ball':
      return special(Boolean(species?.evolutions?.some((evolution) => evolution.item === 'moon-stone')), 4);
    case 'fast-ball':
      return special((species?.stats?.spe ?? 0) >= 100, 4);
    case 'love-ball': {
      const active = context.active;
      if (!target || !active || active.speciesId !== target.speciesId) return SPECIAL_MISS;
      return special(Boolean(active.gender && target.gender && active.gender !== target.gender), 8);
    }
    // A Heavy Ball moves the catch rate rather than multiplying it (see
    // `catchValue`).
    default:
      return 1;
  }
}

/**
 * What a Heavy Ball adds to the catch rate: less for a light target, more for
 * a heavy one, in Gen 7's bands. Weights are in tenths of a kilogram.
 *
 * @param {string} ball
 * @param {any} species
 */
function heavyBallShift(ball, species) {
  if (ball !== 'heavy-ball') return 0;
  const kilograms = (species?.weight ?? 0) / 10;
  return kilograms >= 300 ? 30 : kilograms >= 200 ? 20 : kilograms >= 100 ? 0 : -20;
}

/**
 * The catch value `a`, before it becomes a shake probability.
 *
 * @param {import('./pokemon.mjs').Pokemon} target
 * @param {string} ball
 * @param {CaptureContext} [context]
 * @returns {number} `Infinity` for a Master Ball
 */
export function catchValue(target, ball, context = {}) {
  const bonus = ballBonus(ball, target, context);
  if (!Number.isFinite(bonus)) return Infinity;

  const species = speciesOf(target.speciesId);
  const rate = Math.max(1, (species?.captureRate ?? 45) + heavyBallShift(ball, species));
  const max = maxHp(target);
  const current = Math.max(1, Math.min(max, Math.round(target.hp)));
  const status = target.status ? STATUS_BONUS[target.status] ?? 1 : 1;
  // A Razz Berry given before the throw.
  const berry = context.berry ? itemOf(context.berry)?.capture?.catchRate ?? 1 : 1;

  return ((3 * max - 2 * current) * rate * bonus * status * berry) / (3 * max);
}

/**
 * The chance a single throw succeeds, as a fraction of 1.
 *
 * @param {import('./pokemon.mjs').Pokemon} target
 * @param {string} ball
 * @param {CaptureContext} [context]
 * @returns {number} 0..1
 */
export function captureChance(target, ball, context = {}) {
  const a = catchValue(target, ball, context);
  if (!Number.isFinite(a) || a >= 255) return 1;
  if (a <= 0) return 0;

  const b = 65536 / (255 / a) ** (3 / 16);
  return Math.min(1, (b / 65536) ** SHAKE_CHECKS);
}

/**
 * Throw a ball.
 *
 * @param {import('../core/rng.mjs').Rng} rng
 * @param {import('./pokemon.mjs').Pokemon} target
 * @param {string} ball
 * @param {CaptureContext} [context]
 * @returns {{caught: boolean, shakes: number}} how many of the four checks passed
 */
export function attemptCapture(rng, target, ball, context = {}) {
  const a = catchValue(target, ball, context);
  if (!Number.isFinite(a) || a >= 255) return { caught: true, shakes: SHAKE_CHECKS };

  const threshold = a <= 0 ? 0 : 65536 / (255 / a) ** (3 / 16);
  let shakes = 0;
  for (let check = 0; check < SHAKE_CHECKS; check++) {
    if (rng.int(0, 65535) >= threshold) return { caught: false, shakes };
    shakes++;
  }
  return { caught: true, shakes };
}
