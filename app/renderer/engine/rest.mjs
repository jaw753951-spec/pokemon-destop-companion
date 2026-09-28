/**
 * When the road puts up a Pokémon Center.
 *
 * The rest stop used to be one of the minute's five rolls, so a fifth of the
 * road was a full heal and a bag of supplies whatever state the companion was
 * in — often straight after the last one, on a companion without a scratch.
 * It is now called for instead: the companion blacking out still walks it to
 * one, and so does running short of any of the four things a Center gives.
 *
 * | shortage  | when                                                         |
 * |-----------|--------------------------------------------------------------|
 * | `hp`      | health at a quarter or less, once the bag's top-up has run    |
 * | `pp`      | every attacking move out of PP, or a quarter of all PP left   |
 * | `potions` | not one medicine in the bag that restores HP                  |
 * | `balls`   | not one Poké Ball of any kind in the bag                      |
 *
 * Each shortage calls **one** rest stop. It is remembered as answered until it
 * clears — health back up, a potion in the bag again — so a companion that
 * stays out of balls is not marched to a Center every minute; it takes the
 * shortage ending and coming back to call another. The visit itself clears all
 * four, since it heals, restores PP and hands out potions and balls.
 */
import { moveOf } from '../core/data.mjs';
import { maxHp, maxPp } from './pokemon.mjs';

/** Health at or under this share of the bar is a shortage. */
export const REST_HP = 1 / 4;

/** PP left across every move at or under this share of the total is a shortage. */
export const REST_PP = 1 / 4;

/** @typedef {'hp'|'pp'|'potions'|'balls'} Shortage */

/**
 * What the companion and the bag are short of, right now.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {Shortage[]}
 */
export function shortages(session) {
  const pokemon = session.active;
  /** @type {Shortage[]} */
  const short = [];
  if (!pokemon) return short;

  if (pokemon.hp <= maxHp(pokemon) * REST_HP) short.push('hp');
  if (lowOnPp(pokemon)) short.push('pp');

  const potions = session.pocket('medicine').some(({ item }) => item?.use?.hp !== undefined);
  if (!potions) short.push('potions');
  if (session.pocket('pokeballs').length === 0) short.push('balls');
  return short;
}

/**
 * Whether the companion's moves are running dry: every attack spent — it has
 * nothing left to fight with but Struggle — or a quarter of its PP left all
 * told.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function lowOnPp(pokemon) {
  const slots = (pokemon.moves ?? []).filter((slot) => slot?.move);
  if (slots.length === 0) return false;

  const attacks = slots.filter((slot) => (moveOf(slot.move)?.damageClass ?? 'status') !== 'status');
  if (attacks.length > 0 && attacks.every((slot) => slot.pp <= 0)) return true;

  const left = slots.reduce((sum, slot) => sum + Math.max(0, slot.pp), 0);
  const full = slots.reduce((sum, slot) => sum + maxPp(slot), 0);
  return full > 0 && left <= full * REST_PP;
}

/**
 * Call a rest stop for the next event if a new shortage has begun.
 *
 * Asked each time the event clock comes round, before the roll. An event the
 * game has already decided on — a blackout's own rest stop, a Honey's wild
 * Pokémon — goes first, and the shortage is left unanswered to be asked about
 * again next time.
 *
 * @param {import('./session.mjs').Session} session
 * @returns {Shortage[]} the shortages that called it, empty if none did
 */
export function callRestStop(session) {
  return answerShortages(session.events, shortages(session));
}

/**
 * The bookkeeping half of {@link callRestStop}: given what is short now, force
 * a rest stop for whatever is newly short, and remember it as answered.
 *
 * @param {import('./events.mjs').EventScheduler} scheduler
 * @param {Shortage[]} now
 * @returns {Shortage[]}
 */
export function answerShortages(scheduler, now) {
  // A shortage that has cleared is forgotten, so it calls again if it comes back.
  scheduler.shortages = scheduler.shortages.filter((entry) => now.includes(/** @type {Shortage} */ (entry)));

  const fresh = now.filter((entry) => !scheduler.shortages.includes(entry));
  if (fresh.length === 0 || scheduler.forced) return [];

  scheduler.shortages = [...scheduler.shortages, ...fresh];
  scheduler.force('heal');
  return fresh;
}
