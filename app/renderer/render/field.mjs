/**
 * Drawing the travelling view: the map scrolling past and the companion
 * walking across it.
 *
 * The aim is the overworld of the handheld games rather than a character on a
 * backdrop, so three things are deliberate. The map fills the window, because
 * a letterboxed strip reads as scenery instead of a place. The companion is
 * drawn from its box icon, which is the only official art that is already in
 * proportion to a 16px tile, at a size a route would actually contain. And the
 * walk cycle is driven by distance travelled rather than by the clock, so the
 * sprite is tied to the ground the way a stepped tile-grid sprite is — speed
 * up the walk and the legs go faster, stop and they stop mid-stride.
 */
import { VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';

/** Where the companion's feet sit: just below centre, as the games frame it. */
export const GROUND_Y = Math.round(VIEW_HEIGHT * 0.62);

/** World pixels per second. About one tile every half-second. */
export const WALK_SPEED = 34;

/** The companion holds this column while the world slides past it. */
export const COMPANION_X = Math.round(VIEW_WIDTH * 0.32);

/**
 * Distance covered per walk frame. The GBA moves a character one 16px tile per
 * two frames of its cycle, which is what this reproduces.
 */
export const STRIDE = 8;

/**
 * The four-beat walk: plant, step, plant, step. Each entry lifts the sprite
 * and leans its upper body, which is how a small sprite reads as walking
 * without the redrawn legs no official asset set gives us.
 *
 * @type {Array<{lift: number, lean: number}>}
 */
const WALK_CYCLE = [
  { lift: 0, lean: 0 },
  { lift: 1, lean: 1 },
  { lift: 0, lean: 0 },
  { lift: 1, lean: -1 },
];

/**
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement|null} background
 * @param {number} offset world scroll, in pixels
 */
export function drawBackground(context, background, offset) {
  context.fillStyle = '#101520';
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  if (!background) return;

  const width = background.naturalWidth;
  const height = background.naturalHeight;
  // Anchored to the bottom, so the ground line stays put when a short map
  // contributes fewer rows than the window has.
  const top = VIEW_HEIGHT - height;

  // Modulo can be negative for a negative offset; normalise so the first tile
  // always starts at or before the left edge.
  let start = -(((offset % width) + width) % width);

  while (start < VIEW_WIDTH) {
    const x = Math.round(start);
    context.drawImage(background, x, top, width, height);
    // The two short maps leave a gap overhead; their own top row fills it, so
    // the terrain carries on instead of ending at a hard edge.
    if (top > 0) context.drawImage(background, 0, 0, width, 1, x, 0, width, top);
    start += width;
  }
}

/**
 * A soft ellipse under a sprite, which grounds it against the background.
 * @param {CanvasRenderingContext2D} context
 * @param {number} x
 * @param {number} y
 * @param {number} width
 */
export function drawShadow(context, x, y, width) {
  context.save();
  context.globalAlpha = 0.25;
  context.fillStyle = '#000';
  context.beginPath();
  context.ellipse(x, y, Math.max(5, width * 0.4), Math.max(2, width * 0.15), 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/**
 * Which beat of the walk the companion is on after travelling this far.
 *
 * @param {number} distance world pixels covered
 * @returns {{lift: number, lean: number}}
 */
export function walkFrame(distance) {
  const step = Math.floor(distance / STRIDE) % WALK_CYCLE.length;
  return WALK_CYCLE[(step + WALK_CYCLE.length) % WALK_CYCLE.length];
}

/**
 * Draw the companion as an overworld sprite.
 *
 * The lean is a shear rather than a whole-sprite shift: the feet stay planted
 * on the ground row and the displacement grows towards the head, so the body
 * rocks over its own footing. Standing still resets to the neutral beat, which
 * is what the games do when you let go of the d-pad.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{x: number, y: number, distance: number, moving: boolean}} options
 */
export function drawWalker(context, sprite, { x, y, distance, moving }) {
  const { lift, lean } = moving ? walkFrame(distance) : WALK_CYCLE[0];

  drawShadow(context, x, y, sprite.width);

  const left = Math.round(x - sprite.width / 2);
  const top = Math.round(y - sprite.height - lift);

  if (lean === 0) {
    context.drawImage(sprite.image, 0, 0, sprite.width, sprite.height, left, top, sprite.width, sprite.height);
    return;
  }

  // One draw per row is a few dozen tiny blits for a sprite this size, which
  // is cheaper than the offscreen canvas an equivalent transform would need.
  for (let row = 0; row < sprite.height; row++) {
    const weight = 1 - row / sprite.height;
    const shift = Math.round(lean * weight);
    context.drawImage(sprite.image, 0, row, sprite.width, 1, left + shift, top + row, sprite.width, 1);
  }
}

/**
 * The dust a step kicks up, drawn behind the companion on the beats its feet
 * land. Small and brief — it is there to sell contact with the ground.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {{x: number, y: number, distance: number, moving: boolean}} options
 */
export function drawStepDust(context, { x, y, distance, moving }) {
  if (!moving) return;

  const progress = (distance % STRIDE) / STRIDE;
  if (progress > 0.55) return;

  const fade = 1 - progress / 0.55;
  context.save();
  context.globalAlpha = 0.28 * fade;
  context.fillStyle = '#e8e2cf';
  const spread = 3 + (1 - fade) * 4;
  context.fillRect(Math.round(x - 9 - spread), Math.round(y - 1), 2, 1);
  context.fillRect(Math.round(x - 12 - spread), Math.round(y - 3), 1, 1);
  context.restore();
}
