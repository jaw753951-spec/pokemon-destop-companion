/**
 * The field event scheduler.
 *
 * Once a minute the game rolls one of five events. They start out equally
 * likely, but whichever fired last is damped — to half, then to a twentieth,
 * then out of the running entirely — with the probability it gives up shared
 * equally among the other four. Firing anything else restores it at once. The
 * effect is that runs of the same event become progressively unlikely without
 * ever being made impossible on the first repeat.
 */

/** @typedef {'berry'|'ball'|'wild'|'trainer'|'heal'} EventKind */

/** @type {EventKind[]} */
export const EVENT_KINDS = ['berry', 'ball', 'wild', 'trainer', 'heal'];

/** Each event's share of the roll when nothing is damped. */
export const BASE_WEIGHT = 100 / EVENT_KINDS.length;

/**
 * What the most recent event's weight drops to after firing it once, twice,
 * and three or more times in a row.
 */
export const REPEAT_WEIGHTS = [10, 1, 0];

export class EventScheduler {
  /**
   * @param {{last?: EventKind|null, streak?: number}} [state]
   */
  constructor(state = {}) {
    /** @type {EventKind|null} */
    this.last = state.last ?? null;
    this.streak = state.streak ?? 0;
  }

  /**
   * The current probability of each event, in percent. Always sums to 100.
   * @returns {Record<EventKind, number>}
   */
  weights() {
    /** @type {Record<string, number>} */
    const weights = {};
    for (const kind of EVENT_KINDS) weights[kind] = BASE_WEIGHT;
    if (!this.last || this.streak <= 0) return /** @type {any} */ (weights);

    const damped = REPEAT_WEIGHTS[Math.min(this.streak, REPEAT_WEIGHTS.length) - 1];
    const surrendered = BASE_WEIGHT - damped;
    weights[this.last] = damped;
    for (const kind of EVENT_KINDS) {
      if (kind !== this.last) weights[kind] += surrendered / (EVENT_KINDS.length - 1);
    }
    return /** @type {any} */ (weights);
  }

  /**
   * Roll the next event and record it.
   * @param {import('../core/rng.mjs').Rng} rng
   * @returns {EventKind}
   */
  roll(rng) {
    const weights = this.weights();
    const chosen = rng.weighted(EVENT_KINDS.map((kind) => ({ value: kind, weight: weights[kind] })));
    const kind = /** @type {EventKind} */ (chosen ?? EVENT_KINDS[0]);

    this.streak = kind === this.last ? this.streak + 1 : 1;
    this.last = kind;
    return kind;
  }

  /** @returns {{last: EventKind|null, streak: number}} */
  toJSON() {
    return { last: this.last, streak: this.streak };
  }
}
