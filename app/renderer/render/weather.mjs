/**
 * The weather over the road.
 *
 * Every Hoenn map carries a weather field, and the area build has always
 * copied it into `areas.json`; nothing had ever drawn it, so Route 119 rained
 * in the battle engine and nowhere else. This is the missing half: a thin
 * layer of falling weather over the field, from the map's own setting.
 *
 * Two things are deliberate, because a weather layer is very easy to overdo in
 * a window this small.
 *
 * **Position is random, not patterned.** Every drop, flake and cinder picks a
 * fresh x anywhere across the view each time it starts a fall, along with its
 * own speed, length and drift. Nothing is spaced on a grid or seeded off the
 * scroll, so the layer never shows the seams or columns that give away a few
 * sprites being reused.
 *
 * **It is sparse, and it waits.** A handful of particles is on screen at once,
 * and a particle that has fallen off the bottom does not come straight back —
 * it sits out a random pause first, so only a fraction of the pool is ever
 * falling. Weather here is meant to say what the sky is doing behind whatever
 * the player was actually looking at, not to fill the window with it.
 */
import { FIELD_HEIGHT, FIELD_WIDTH } from '../../shared/constants.mjs';

/**
 * What each kind of weather looks like.
 *
 * `count` is the size of the pool, `duty` the share of it that is falling at
 * any moment — the rest are waiting out their pause — so the two together are
 * how thin the layer is. `speed` and `drift` are field pixels per second.
 *
 * @type {Record<string, {
 *   count: number, duty: number, colour: string, alpha: number,
 *   speed: [number, number], drift: [number, number],
 *   length: [number, number], width: number, round?: boolean,
 * }>}
 */
export const WEATHER_STYLES = {
  rain: {
    count: 14,
    duty: 0.55,
    colour: '#a8c8f0',
    alpha: 0.45,
    speed: [150, 210],
    drift: [-26, -14],
    length: [5, 9],
    width: 1,
  },
  downpour: {
    count: 20,
    duty: 0.7,
    colour: '#9cc0ee',
    alpha: 0.5,
    speed: [190, 260],
    drift: [-34, -20],
    length: [7, 12],
    width: 1,
  },
  snow: {
    count: 12,
    duty: 0.5,
    colour: '#eef4ff',
    alpha: 0.7,
    speed: [16, 30],
    drift: [-10, 10],
    length: [1, 2],
    width: 1,
    round: true,
  },
  sandstorm: {
    count: 16,
    duty: 0.6,
    colour: '#d8c08c',
    alpha: 0.35,
    speed: [22, 44],
    drift: [-120, -70],
    length: [4, 8],
    width: 1,
  },
  ash: {
    count: 10,
    duty: 0.45,
    colour: '#cfc8c2',
    alpha: 0.4,
    speed: [12, 26],
    drift: [-14, 6],
    length: [1, 2],
    width: 1,
    round: true,
  },
};

/**
 * Emerald's weather constants, reduced to the ones worth drawing.
 *
 * The area build lower-cases whatever `WEATHER_*` the map declares, so these
 * are those names. Anything not listed — sun, shade, fog, the underwater
 * settings — draws nothing: a tint over the whole view is the time-of-day
 * grading's job, and it already does it to the background itself.
 *
 * @type {Record<string, keyof typeof WEATHER_STYLES>}
 */
export const MAP_WEATHER = {
  rain: 'rain',
  rain_thunderstorm: 'downpour',
  downpour: 'downpour',
  snow: 'snow',
  sandstorm: 'sandstorm',
  volcanic_ash: 'ash',
};

/**
 * The weather layer an area calls for, or null where the sky is doing nothing
 * this can draw.
 *
 * @param {{weather?: string|null}|null|undefined} area
 * @returns {keyof typeof WEATHER_STYLES|null}
 */
export function weatherLayerFor(area) {
  const name = String(area?.weather ?? '').toLowerCase();
  return MAP_WEATHER[name] ?? null;
}

/** A number somewhere in `[low, high)`. */
const between = ([low, high]) => low + Math.random() * (high - low);

/**
 * How long a particle sits out between falls, in milliseconds.
 *
 * Derived from the duty cycle rather than tuned separately: if a particle
 * spends `duty` of its life falling, the pause is the rest of that life, so a
 * style can be made thinner by changing one number instead of two.
 *
 * @param {{duty: number, speed: [number, number]}} style
 */
function pauseFor(style) {
  const fallMs = (FIELD_HEIGHT / ((style.speed[0] + style.speed[1]) / 2)) * 1000;
  const duty = Math.min(0.95, Math.max(0.05, style.duty));
  return (fallMs * (1 - duty)) / duty;
}

/**
 * A weather layer for one kind of sky.
 *
 * Kept as an object rather than a module-level pool so the field can throw one
 * away and make another when the area changes, instead of the old weather
 * drifting into the new place.
 *
 * @param {keyof typeof WEATHER_STYLES|null} kind
 */
export function createWeather(kind) {
  const style = kind ? WEATHER_STYLES[kind] : null;

  /**
   * One particle. `wait` is how long it still has to sit out before it starts
   * falling again, which is what keeps the layer thin.
   * @type {Array<{x: number, y: number, vx: number, vy: number, length: number, wait: number}>}
   */
  const particles = [];

  /**
   * Put a particle back at the top — at a brand new x, with brand new speeds,
   * so nothing about where it fell last time survives.
   * @param {any} particle
   * @param {boolean} [anywhere] scatter it down the view rather than above it,
   *   which is how the first frame comes up already raining
   */
  const respawn = (particle, anywhere = false) => {
    if (!style) return;
    particle.x = Math.random() * (FIELD_WIDTH + 40) - 20;
    particle.y = anywhere ? Math.random() * FIELD_HEIGHT : -between([2, 24]);
    particle.vy = between(style.speed);
    particle.vx = between(style.drift);
    particle.length = between(style.length);
    // A fall, then a pause off screen: with `duty` of the pool falling, the
    // pause is what the rest of the time is spent on.
    particle.wait = anywhere ? 0 : Math.random() * pauseFor(style);
  };

  if (style) {
    for (let index = 0; index < style.count; index++) {
      const particle = { x: 0, y: 0, vx: 0, vy: 0, length: 0, wait: 0 };
      // A fraction start on screen and the rest start waiting, so the layer
      // opens at its settled density instead of arriving all at once.
      respawn(particle, Math.random() < style.duty);
      particles.push(particle);
    }
  }

  return {
    /** Whether this layer draws anything at all. */
    get active() {
      return Boolean(style);
    },

    /** @param {number} deltaMs */
    update(deltaMs) {
      if (!style) return;
      const seconds = deltaMs / 1000;

      for (const particle of particles) {
        if (particle.wait > 0) {
          particle.wait -= deltaMs;
          continue;
        }
        particle.x += particle.vx * seconds;
        particle.y += particle.vy * seconds;
        if (particle.y - particle.length > FIELD_HEIGHT || particle.x < -30 || particle.x > FIELD_WIDTH + 30) {
          respawn(particle);
        }
      }
    },

    /** @param {CanvasRenderingContext2D} context in field space */
    draw(context) {
      if (!style) return;
      context.save();
      context.globalAlpha = style.alpha;
      context.fillStyle = style.colour;

      for (const particle of particles) {
        if (particle.wait > 0) continue;
        const x = Math.round(particle.x);
        const y = Math.round(particle.y);
        if (style.round) {
          context.fillRect(x, y, style.width, Math.max(1, Math.round(particle.length)));
          continue;
        }
        // A streak leaning the way it is travelling, drawn as a short run of
        // pixels rather than a line so it stays as crisp as the field.
        const steps = Math.max(1, Math.round(particle.length));
        const lean = particle.vx / Math.max(1, particle.vy);
        for (let step = 0; step < steps; step++) {
          context.fillRect(Math.round(x - lean * step), y - step, style.width, 1);
        }
      }
      context.restore();
    },
  };
}
