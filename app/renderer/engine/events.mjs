/**
 * The field event scheduler.
 *
 * Once a minute the game rolls one of five events. They start out equally
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
 */

/** @typedef {'berry'|'ball'|'wild'|'trainer'|'heal'} EventKind */

/** @type {EventKind[]} */
export const EVENT_KINDS = ['berry', 'ball', 'wild', 'trainer', 'heal'];

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
    this.forced = state.forced ?? null;
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
   * @param {import('../core/rng.mjs').Rng} rng
   * @returns {EventKind}
   */
  roll(rng) {
    if (this.forced) {
      const forced = this.forced;
      this.forced = null;
      this.remember(forced);
      return forced;
    }

    const weights = this.weights();
    const chosen = rng.weighted(EVENT_KINDS.map((kind) => ({ value: kind, weight: weights[kind] })));
    const kind = /** @type {EventKind} */ (chosen ?? EVENT_KINDS[0]);

    this.remember(kind);
    return kind;
  }

  /**
   * Push an event onto the memory, dropping whatever falls off the end.
   * @param {EventKind} kind
   */
  remember(kind) {
    this.recent = [kind, ...this.recent].slice(0, MEMORY);
  }

  /** @returns {{recent: EventKind[], forced: EventKind|null}} */
  toJSON() {
    return { recent: [...this.recent], forced: this.forced };
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
