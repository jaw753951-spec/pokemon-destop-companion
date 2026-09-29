/**
 * Deterministic random numbers.
 *
 * A save carries its RNG seed, so a reloaded game continues the same stream
 * rather than re-rolling the run. `mulberry32` is used because it is tiny, fast
 * and good enough for gameplay rolls.
 */

export class Rng {
  /** @param {number} [seed] */
  constructor(seed = Date.now() >>> 0) {
    this.seed = seed >>> 0;
  }

  /** @returns {number} in [0, 1) */
  next() {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * @param {number} min inclusive
   * @param {number} max inclusive
   */
  int(min, max) {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** @param {number} chance 0..1 */
  chance(chance) {
    return this.next() < chance;
  }

  /**
   * @template T
   * @param {T[]} list
   * @returns {T}
   */
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  /**
   * Weighted pick. Weights need not sum to anything in particular.
   * @template T
   * @param {Array<{value: T, weight: number}>} entries
   * @returns {T|null}
   */
  weighted(entries) {
    const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
    if (total <= 0) return null;
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= Math.max(0, entry.weight);
      if (roll < 0) return entry.value;
    }
    return entries[entries.length - 1].value;
  }

  /**
   * @template T
   * @param {T[]} list
   * @returns {T[]} a shuffled copy
   */
  shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * A small stable number from a string, so a choice made from it never moves:
 * the same leader is met in the same stand-in every time.
 * @param {string} text
 */
export function stableHash(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash;
}
