/**
 * Drawing the travelling view: the map scrolling past and the companion
 * walking across it.
 *
 * The aim is the overworld of the handheld games rather than a character on a
 * backdrop, so four things are deliberate. The whole field is drawn at twice
 * size, which puts about fifteen tiles across the window — the framing a Game
 * Boy Advance actually had, instead of twice as much map at half the size. The
 * map fills that frame, because a letterboxed strip reads as scenery instead
 * of a place. The companion is drawn from its box icon, the only official art
 * already in proportion to a 16px tile. And the walk cycle is driven by
 * distance travelled rather than by the clock, so the sprite is tied to the
 * ground the way a stepped tile-grid sprite is — speed up the walk and the
 * legs go faster, stop and they stop mid-stride.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, FIELD_ZOOM } from '../../shared/constants.mjs';

/**
 * Where the companion's feet sit.
 *
 * Each area carries its own line — the pipeline picks the row whose blocks are
 * clear of scenery, so the companion walks down the path instead of through
 * the tree line — and this is the fallback until one is loaded.
 */
const DEFAULT_GROUND_Y = Math.round(FIELD_HEIGHT * 0.62);

let ground = DEFAULT_GROUND_Y;

/** The ground line the field is currently drawing on. */
export function groundY() {
  return ground;
}

/**
 * Put the ground line where the area wants it, in field coordinates.
 * @param {number|null|undefined} value
 */
export function setGroundY(value) {
  ground = Number.isFinite(value) ? Math.round(/** @type {number} */ (value)) : DEFAULT_GROUND_Y;
}

/**
 * How much larger than its own art an actor is drawn on the field.
 *
 * Box icons and the overworld people sheets are built for a 16-pixel tile, and
 * at that size on this window a Pokémon is a thumbnail you squint at. Half
 * again is as far as they go before they stop belonging to the map — and the
 * field is drawn at twice size, so one source pixel still lands on a whole
 * number of screen pixels.
 */
export const ACTOR_SCALE = 1.5;

/** Field pixels per second. About one tile every half-second. */
export const WALK_SPEED = 34;

/** The companion holds this column while the world slides past it. */
export const COMPANION_X = Math.round(FIELD_WIDTH * 0.32);

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
 * Run `draw` in field space: twice size, with pixels kept square.
 *
 * Everything inside works in the field's own 240x135 coordinates and comes out
 * at the window's 480x270, so a source pixel always lands on exactly four
 * screen pixels and nothing is ever drawn on a half-pixel.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {(context: CanvasRenderingContext2D) => void} draw
 */
export function inFieldSpace(context, draw) {
  context.save();
  context.imageSmoothingEnabled = false;
  context.scale(FIELD_ZOOM, FIELD_ZOOM);
  draw(context);
  context.restore();
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement|null} background
 * @param {number} offset world scroll, in field pixels
 */
export function drawBackground(context, background, offset) {
  context.fillStyle = '#101520';
  context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
  if (!background) return;

  const width = background.naturalWidth;
  const height = background.naturalHeight;
  // Anchored to the bottom, so the ground line stays put when a short map
  // contributes fewer rows than the field has.
  const top = FIELD_HEIGHT - height;

  // Modulo can be negative for a negative offset; normalise so the first tile
  // always starts at or before the left edge.
  let start = -(((offset % width) + width) % width);

  while (start < FIELD_WIDTH) {
    const x = Math.round(start);
    context.drawImage(background, x, top, width, height);
    // A map shorter than the field leaves a gap overhead; its own top row
    // fills it, so the terrain carries on instead of ending at a hard edge.
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
 * @param {number} distance field pixels covered
 * @returns {{lift: number, lean: number}}
 */
export function walkFrame(distance) {
  const step = Math.floor(distance / STRIDE) % WALK_CYCLE.length;
  return WALK_CYCLE[(step + WALK_CYCLE.length) % WALK_CYCLE.length];
}

/**
 * Draw the companion as an overworld sprite, facing the way it is going.
 *
 * Box icons are drawn three-quarters on, turned towards the viewer's left, so
 * mirroring them turns the Pokémon down the road it is walking and puts its
 * tail behind it. The lean is a shear rather than a whole-sprite shift: the
 * feet stay planted on the ground row and the displacement grows towards the
 * head, so the body rocks over its own footing. Standing still resets to the
 * neutral beat, which is what the games do when you let go of the d-pad.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{x: number, y: number, distance: number, moving: boolean, flip?: boolean, scale?: number}} options
 */
export function drawWalker(context, sprite, { x, y, distance, moving, flip = true, scale = ACTOR_SCALE }) {
  const { lift, lean } = moving ? walkFrame(distance) : WALK_CYCLE[0];

  const width = sprite.width * scale;
  const height = sprite.height * scale;
  drawShadow(context, x, y, width);

  const left = Math.round(x - width / 2);
  const top = Math.round(y - height - lift);

  context.save();
  if (flip) {
    // Mirror about the sprite's own centre column, so flipping does not move
    // it off the spot it is standing on.
    context.translate(left * 2 + width, 0);
    context.scale(-1, 1);
  }

  if (lean === 0) {
    context.drawImage(sprite.image, 0, 0, sprite.width, sprite.height, left, top, width, height);
  } else {
    // One draw per row is a few dozen tiny blits for a sprite this size, which
    // is cheaper than the offscreen canvas an equivalent transform would need.
    for (let row = 0; row < sprite.height; row++) {
      const weight = 1 - row / sprite.height;
      const shift = Math.round(lean * weight);
      context.drawImage(sprite.image, 0, row, sprite.width, 1, left + shift, top + row * scale, width, scale);
    }
  }
  context.restore();
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
