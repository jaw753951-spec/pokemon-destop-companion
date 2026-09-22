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
import { speciesOf } from '../core/data.mjs';

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
 *
 * This is the figure for the things that really are tile art: trainers, berry
 * trees, the props an event puts on the road. A Pokémon is sized by
 * {@link actorScale} instead — see there for why.
 */
export const ACTOR_SCALE = 1.5;

/**
 * How tall a Pokémon of average size stands on the field, in field pixels.
 *
 * The box icons are not drawn to a common scale. They are drawn to fill a grid
 * cell, so a Sableye — half a metre of Pokémon — arrives 30 pixels tall while
 * a Caterpie arrives at 16, and at a flat multiplier the Sableye towered over
 * the road at nearly half the window's height. Sizing off the art meant the
 * roster had no scale at all: what you saw was how much of a cell the artist
 * filled, which is not a fact about the Pokémon.
 *
 * So the drawing is normalised away and the **Pokédex** decides instead: every
 * species is drawn to a height computed from its own listed height, which is
 * the one measurement that means the same thing for all 1,025 of them.
 */
export const ACTOR_HEIGHT = 26;

/**
 * How strongly the dex's height moves a species off that figure.
 *
 * A straight ratio is useless here — Wailord is fifty times Caterpie's height
 * and cannot be drawn fifty times as tall — so the ratio is taken to a
 * fractional power, which is the usual way to put a range this wide on a
 * screen. At 0.4 a Wailord ends up about four times a Caterpie: plainly the
 * bigger animal, still something the window can hold.
 */
const ACTOR_HEIGHT_EXPONENT = 0.4;

/** The band every Pokémon's drawn height is kept inside, in field pixels. */
const ACTOR_HEIGHT_RANGE = { min: 18, max: 44 };

/**
 * And the band its scale is kept inside, whatever the sum says.
 *
 * Blowing a 14-pixel icon up past double turns it to mush, and shrinking a
 * large one below six-tenths loses the details that make it recognisable, so
 * the art gets a say after the dex has had its one.
 */
const ACTOR_SCALE_RANGE = { min: 0.6, max: 2 };

/** The height the dex lists for a species, in metres. */
function speciesHeightM(pokemon) {
  // PokeAPI files height in decimetres; a species the dex has no figure for is
  // treated as a metre, which is close to the median.
  const decimetres = pokemon ? speciesOf(pokemon.speciesId)?.height : null;
  return decimetres > 0 ? decimetres / 10 : 1;
}

/**
 * What to draw a Pokémon's field art at so the whole roster shares one scale.
 *
 * @param {{width: number, height: number}|null|undefined} sprite
 * @param {{speciesId: number}|null|undefined} pokemon
 * @returns {number}
 */
export function actorScale(sprite, pokemon) {
  if (!sprite?.height) return ACTOR_SCALE;

  const wanted = clamp(
    ACTOR_HEIGHT * speciesHeightM(pokemon) ** ACTOR_HEIGHT_EXPONENT,
    ACTOR_HEIGHT_RANGE.min,
    ACTOR_HEIGHT_RANGE.max,
  );
  return clamp(wanted / sprite.height, ACTOR_SCALE_RANGE.min, ACTOR_SCALE_RANGE.max);
}

/**
 * How tall that Pokémon actually comes out, which is what anything drawn over
 * its head — a carried berry, say — has to clear.
 *
 * @param {{width: number, height: number}|null|undefined} sprite
 * @param {{speciesId: number}|null|undefined} pokemon
 */
export function actorHeight(sprite, pokemon) {
  if (!sprite?.height) return ACTOR_HEIGHT;
  return Math.round(sprite.height * actorScale(sprite, pokemon));
}

/** @param {number} value @param {number} low @param {number} high */
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

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

  // Whole pixels in the field's own space: a sprite whose scale leaves it half
  // a pixel wide lands on a half pixel at one edge and a whole one at the
  // other, and the walk cycle then makes that edge shimmer.
  const width = Math.round(sprite.width * scale);
  const height = Math.round(sprite.height * scale);
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
    //
    // Each row is drawn from where it starts to where the *next* one starts,
    // both rounded the same way, so consecutive rows always abut exactly. The
    // old version gave every row the same fractional height at a fractional
    // offset, which at most scales left hairlines of background showing
    // through the sprite on the beats it leans — the "you can see the map
    // through it while it walks" report.
    for (let row = 0; row < sprite.height; row++) {
      const weight = 1 - row / sprite.height;
      const shift = Math.round(lean * weight);
      const rowTop = top + Math.round(row * scale);
      const rowBottom = top + Math.round((row + 1) * scale);
      context.drawImage(
        sprite.image,
        0,
        row,
        sprite.width,
        1,
        left + shift,
        rowTop,
        width,
        Math.max(1, rowBottom - rowTop),
      );
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
