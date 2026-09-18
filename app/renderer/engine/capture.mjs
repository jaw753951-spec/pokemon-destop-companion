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
import { maxHp } from './pokemon.mjs';

/** Ball multipliers. A Master Ball is handled as a guaranteed catch. */
export const BALL_BONUS = {
  'master-ball': Infinity,
  'ultra-ball': 2,
  'great-ball': 1.5,
  'poke-ball': 1,
  'premier-ball': 1,
  'luxury-ball': 1,
  'heal-ball': 1,
  'net-ball': 1,
  'dive-ball': 1,
  'nest-ball': 1,
  'repeat-ball': 1,
  'timer-ball': 1,
  'quick-ball': 5,
  'dusk-ball': 3,
};

/** Status multipliers, as in Gen 5 onward. */
export const STATUS_BONUS = { slp: 2.5, frz: 2.5, par: 1.5, brn: 1.5, psn: 1.5 };

/** Shake checks a throw must pass. */
export const SHAKE_CHECKS = 4;

/**
 * @param {string} ball
 * @returns {number}
 */
export function ballBonus(ball) {
  if (ball in BALL_BONUS) return BALL_BONUS[ball];
  // Any other ball the player picked up behaves like a Poké Ball.
  return itemOf(ball)?.pocket === 'pokeballs' ? 1 : 1;
}

/**
 * The catch value `a`, before it becomes a shake probability.
 *
 * @param {import('./pokemon.mjs').Pokemon} target
 * @param {string} ball
 * @returns {number} `Infinity` for a Master Ball
 */
export function catchValue(target, ball) {
  const bonus = ballBonus(ball);
  if (!Number.isFinite(bonus)) return Infinity;

  const species = speciesOf(target.speciesId);
  const rate = species?.captureRate ?? 45;
  const max = maxHp(target);
  const current = Math.max(1, Math.min(max, Math.round(target.hp)));
  const status = target.status ? STATUS_BONUS[target.status] ?? 1 : 1;

  return ((3 * max - 2 * current) * rate * bonus * status) / (3 * max);
}

/**
 * The chance a single throw succeeds, as a fraction of 1.
 *
 * @param {import('./pokemon.mjs').Pokemon} target
 * @param {string} ball
 * @returns {number} 0..1
 */
export function captureChance(target, ball) {
  const a = catchValue(target, ball);
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
 * @returns {{caught: boolean, shakes: number}} how many of the four checks passed
 */
export function attemptCapture(rng, target, ball) {
  const a = catchValue(target, ball);
  if (!Number.isFinite(a) || a >= 255) return { caught: true, shakes: SHAKE_CHECKS };

  const threshold = a <= 0 ? 0 : 65536 / (255 / a) ** (3 / 16);
  let shakes = 0;
  for (let check = 0; check < SHAKE_CHECKS; check++) {
    if (rng.int(0, 65535) >= threshold) return { caught: false, shakes };
    shakes++;
  }
  return { caught: true, shakes };
}
