/**
 * The sky a place is under, drawn over the map.
 *
 * A battle fought on Route 119 opens in rain and one in the desert opens in a
 * sandstorm, because the area's own tags say so — but the road the companion
 * walked in on was bright and still either way, so the weather arrived out of
 * nowhere the moment a fight started. This draws the same sky on the field.
 *
 * Everything is procedural: there is no weather art in the asset set, and a
 * few hundred streaks placed by arithmetic cost nothing and never need
 * downloading.
 */
import { FIELD_HEIGHT, FIELD_WIDTH } from '../../shared/constants.mjs';

/**
 * How each sky is drawn: how many marks, how fast they travel in field pixels
 * a second, and the wash laid under them.
 */
const SKIES = {
  rain: { marks: 90, speed: { x: -70, y: 320 }, length: 7, colour: 'rgba(168, 202, 240, 0.55)', wash: 'rgba(28, 44, 78, 0.22)' },
  snow: { marks: 70, speed: { x: -18, y: 46 }, length: 0, colour: 'rgba(238, 246, 255, 0.85)', wash: 'rgba(96, 122, 160, 0.18)' },
  sandstorm: { marks: 110, speed: { x: -260, y: 24 }, length: 11, colour: 'rgba(222, 196, 138, 0.5)', wash: 'rgba(168, 140, 86, 0.26)' },
  sun: { marks: 0, speed: { x: 0, y: 0 }, length: 0, colour: 'rgba(0, 0, 0, 0)', wash: 'rgba(255, 216, 140, 0.16)' },
  hail: { marks: 70, speed: { x: -40, y: 210 }, length: 3, colour: 'rgba(226, 244, 255, 0.8)', wash: 'rgba(96, 122, 160, 0.18)' },
};

/** The skies this can draw, for anyone checking before asking. */
export const WEATHER_KINDS = Object.keys(SKIES);

/**
 * One mark's place at a moment.
 *
 * Each is given a fixed starting point from its own index and then simply
 * moved: no state is kept between frames, so the weather costs nothing when
 * nobody is looking at it and never drifts out of step with itself.
 *
 * @param {number} index
 * @param {number} elapsed milliseconds since the run started
 * @param {{x: number, y: number}} speed
 */
function markAt(index, elapsed, speed) {
  // Two coprime strides scatter the marks without needing a random number
  // that would have to be remembered.
  const seedX = (index * 83) % (FIELD_WIDTH + 80);
  const seedY = (index * 47) % (FIELD_HEIGHT + 40);
  const seconds = elapsed / 1000;
  const x = wrap(seedX + speed.x * seconds, FIELD_WIDTH + 80) - 40;
  const y = wrap(seedY + speed.y * seconds, FIELD_HEIGHT + 40) - 20;
  return { x, y };
}

const wrap = (value, span) => ((value % span) + span) % span;

/**
 * Draw the weather over the field, in the field's own coordinates.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {string|null|undefined} weather
 * @param {number} elapsed milliseconds, for where the marks have got to
 */
export function drawWeather(context, weather, elapsed) {
  const sky = weather ? SKIES[weather] : null;
  if (!sky) return;

  context.save();
  if (sky.wash) {
    context.fillStyle = sky.wash;
    context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
  }

  context.strokeStyle = sky.colour;
  context.fillStyle = sky.colour;
  context.lineWidth = 1;

  for (let index = 0; index < sky.marks; index++) {
    const { x, y } = markAt(index, elapsed, sky.speed);
    if (sky.length === 0) {
      // Snow falls as flakes rather than streaks, and drifts sideways as it
      // goes so it does not read as a column of dots.
      const drift = Math.sin((elapsed / 700) + index) * 2;
      context.fillRect(Math.round(x + drift), Math.round(y), 1, 1);
      continue;
    }
    // A streak lies along the direction it is travelling in.
    const speed = Math.hypot(sky.speed.x, sky.speed.y) || 1;
    const dx = (sky.speed.x / speed) * sky.length;
    const dy = (sky.speed.y / speed) * sky.length;
    context.beginPath();
    context.moveTo(Math.round(x), Math.round(y));
    context.lineTo(Math.round(x + dx), Math.round(y + dy));
    context.stroke();
  }
  context.restore();
}
