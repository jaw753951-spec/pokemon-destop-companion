/**
 * The field event scheduler.
 *
 * Once a minute the game rolls one of four events. They start out equally
 * likely, and the scheduler remembers the **last two** it fired: the one that
 * just happened is worth 1%, the one before it 10%, and the probability those
 * two give up is shared equally among the events that are neither. So a run of
 * the same event is all but impossible, an A-B-A flip-flop is unlikely, and
 * anything the companion has not seen for three events is back on full odds.
 *
 * This replaced a streak counter that damped only the most recent event, in
 * three steps (20 → 10 → 1 → 0): it could not tell the difference between
 * "berry, berry" and "berry, ball, berry", so the two-event ping-pong it left
 * behind was exactly as likely as anything else.
 *
 * The rest stop is not one of the four. It used to be a fifth of every roll,
 * which handed out a full heal and a bag of supplies whether the companion
 * needed them or not; now it is only ever called — by a blackout, or by the
 * companion running short of something (see `rest.mjs`) — and never rolled.
 */

/** @typedef {'berry'|'ball'|'wild'|'trainer'|'heal'} EventKind */

/**
 * The events the minute's roll chooses between.
 * @type {EventKind[]}
 */
export const EVENT_KINDS = ['berry', 'ball', 'wild', 'trainer'];

/**
 * The events that only happen when the game calls for them.
 * @type {EventKind[]}
 */
export const CALLED_KINDS = ['heal'];

/** Each event's share of the roll when nothing is damped. */
export const BASE_WEIGHT = 100 / EVENT_KINDS.length;

/**
 * What the events the scheduler remembers are worth, most recent first.
 *
 * Two entries, so the memory is two events deep. An event that is both — the
 * same kind twice in a row — takes the lower of the two, which is the point of
 * damping it in the first place.
 */
export const RECENT_WEIGHTS = [1, 10];

/** How many events back the scheduler remembers. */
export const MEMORY = RECENT_WEIGHTS.length;

export class EventScheduler {
  /**
   * @param {{
   *   recent?: EventKind[],
   *   last?: EventKind|null,
   *   streak?: number,
   *   forced?: EventKind|null,
   *   shortages?: string[],
   * }} [state] `last`/`streak` are the shape older saves carry
   */
  constructor(state = {}) {
    /**
     * The kinds that fired, most recent first, at most `MEMORY` of them.
     * @type {EventKind[]}
     */
    this.recent = normalizeRecent(state);
    /**
     * An event the game has decided on regardless of the odds — a companion
     * that has just fainted is walked to a rest stop rather than into whatever
     * the dice say next.
     * @type {EventKind|null}
     */
    this.forced = [...EVENT_KINDS, ...CALLED_KINDS].includes(/** @type {any} */ (state.forced)) ? state.forced ?? null : null;
    /**
     * The shortages a rest stop has already been called for, so each calls
     * one once rather than every minute it lasts. See `rest.mjs`.
     * @type {string[]}
     */
    this.shortages = Array.isArray(state.shortages) ? state.shortages.filter((entry) => typeof entry === 'string') : [];
  }

  /** The event that fired most recently, or null before any has. */
  get last() {
    return this.recent[0] ?? null;
  }

  /**
   * Make the next roll return this kind, whatever the weights say.
   * @param {EventKind} kind
   */
  force(kind) {
    this.forced = kind;
  }

  /**
   * The current probability of each event, in percent. Always sums to 100.
   * @returns {Record<EventKind, number>}
   */
  weights() {
    /** @type {Record<string, number>} */
    const weights = {};
    for (const kind of EVENT_KINDS) weights[kind] = BASE_WEIGHT;

    /** The kinds that are damped, so the rest can share what they gave up. */
    const damped = new Set();
    this.recent.slice(0, MEMORY).forEach((kind, index) => {
      if (!EVENT_KINDS.includes(kind)) return;
      // Remembered twice — the same event two rolls running — keeps the
      // harsher of the two figures rather than the more recent one.
      weights[kind] = Math.min(weights[kind], RECENT_WEIGHTS[index]);
      damped.add(kind);
    });

    const open = EVENT_KINDS.filter((kind) => !damped.has(kind));
    if (open.length === 0) return /** @type {any} */ (weights);

    const surrendered = 100 - EVENT_KINDS.reduce((total, kind) => total + weights[kind], 0);
    for (const kind of open) weights[kind] += surrendered / open.length;
    return /** @type {any} */ (weights);
  }

  /**
   * Roll the next event and record it.
   *
   * @param {import('../core/rng.mjs').Rng} rng
   * @param {{wild?: number}} [modifiers] what the companion is carrying makes
   *   of the odds: a Cleanse Tag's two thirds on a wild Pokémon turning up
   * @returns {EventKind}
   */
  roll(rng, modifiers = {}) {
    if (this.forced) {
      const forced = this.forced;
      this.forced = null;
      this.remember(forced);
      return forced;
    }

    const weights = this.weights();
    if (modifiers.wild !== undefined) weights.wild *= modifiers.wild;
    const chosen = rng.weighted(EVENT_KINDS.map((kind) => ({ value: kind, weight: weights[kind] })));
    const kind = /** @type {EventKind} */ (chosen ?? EVENT_KINDS[0]);

    this.remember(kind);
    return kind;
  }

  /**
   * Push an event onto the memory, dropping whatever falls off the end.
   *
   * Only the rolled events are remembered: a rest stop the game called is not
   * one the dice need damping, and letting it take a slot would free the
   * event before it from its damping early.
   *
   * @param {EventKind} kind
   */
  remember(kind) {
    if (!EVENT_KINDS.includes(kind)) return;
    this.recent = [kind, ...this.recent].slice(0, MEMORY);
  }

  /** @returns {{recent: EventKind[], forced: EventKind|null, shortages: string[]}} */
  toJSON() {
    return { recent: [...this.recent], forced: this.forced, shortages: [...this.shortages] };
  }
}

/**
 * The remembered events, from whichever shape the save was written in.
 *
 * A save from before the memory existed carries the one event it damped and
 * how long the run was; the run is worth nothing now, but the event itself
 * still belongs at the front of the memory — a player reloading mid-run should
 * not be handed the event they have just had three of.
 *
 * @param {{recent?: any, last?: any}} state
 * @returns {EventKind[]}
 */
function normalizeRecent(state) {
  const stored = Array.isArray(state.recent) ? state.recent : state.last ? [state.last] : [];
  return stored.filter((kind) => EVENT_KINDS.includes(kind)).slice(0, MEMORY);
}
