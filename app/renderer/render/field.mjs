/**
 * Drawing the travelling view: the map scrolling past and the companion
 * walking across it.
 *
 * The aim is the overworld of the handheld games rather than a character on a
 * backdrop, so four things are deliberate. The whole field is drawn at twice
 * size, which puts about fifteen tiles across the window — the framing a Game
 * Boy Advance actually had, instead of twice as much map at half the size. The
 * map fills that frame, because a letterboxed strip reads as scenery instead
 * of a place. The companion walks in the PMD Sprite Collab's art, drawn at one
 * density for the whole dex and at one scale here. And the walk cycle is driven by
 * distance travelled rather than by the clock, so the sprite is tied to the
 * ground the way a stepped tile-grid sprite is — speed up the walk and the
 * legs go faster, stop and they stop mid-stride.
 */
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FIELD_ZOOM,
  HOLD_BOOST_GLIDE_MS,
  HOLD_BOOST_RAMP_MS,
} from '../../shared/constants.mjs';
import { artOf } from '../core/data.mjs';

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
 * How much larger than its own art a Pokémon is drawn on the field: not at
 * all, for every one of them.
 *
 * The field used to draw each species from its box icon at a scale worked out
 * from its Pokédex height, so no two Pokémon were made of the same size of
 * pixel and hardly any of them of whole ones. They walk in the PMD Sprite
 * Collab's art now, which is drawn to one density and already sized to the
 * Pokémon, so there is nothing left to correct for: one scale for the whole
 * dex, and the field's own zoom makes each art pixel two screen pixels.
 */
export const POKEMON_SCALE = 1;

/**
 * What to draw a Pokémon's field art at: {@link POKEMON_SCALE}, whoever it is.
 * Anything without art of its own is drawn at the scale the props use.
 *
 * @param {{width: number, height: number}|null|undefined} sprite
 * @param {{speciesId: number}|null|undefined} [pokemon]
 * @returns {number}
 */
export function actorScale(sprite, pokemon) {
  void pokemon;
  return sprite?.height ? POKEMON_SCALE : ACTOR_SCALE;
}

/** How tall a Pokémon without art is taken to be, for what is drawn over it. */
export const ACTOR_HEIGHT = 24;

/**
 * How tall that Pokémon actually comes out, which is what anything drawn over
 * its head — a carried berry, say — has to clear.
 *
 * @param {{width: number, height: number}|null|undefined} sprite
 * @param {{speciesId: number}|null|undefined} [pokemon]
 */
export function actorHeight(sprite, pokemon) {
  if (!sprite?.height) return ACTOR_HEIGHT;
  return Math.round(sprite.height * actorScale(sprite, pokemon));
}

/**
 * The art a Pokémon walks or stands in, and which way that art faces.
 *
 * The Sprite Collab's strips face right, down the road; a species the collab
 * has not drawn falls back on its box icon, which faces left and is a single
 * still picture. Standing art falls back on walking art for a species drawn
 * walking but never standing.
 *
 * @param {{speciesId: number, shiny?: boolean}|null|undefined} pokemon
 * @param {'walk'|'idle'} [pose]
 * @returns {{path: string, meta: {width: number, height: number, frames: number, delay: number, durations?: number[], facing: 'left'|'right'}}|null}
 */
export function walkerArt(pokemon, pose = 'walk') {
  const art = artOf(pokemon, pose) ?? (pose === 'idle' ? artOf(pokemon, 'walk') : null);
  if (art) return { path: art.path, meta: { ...art.meta, facing: 'right' } };
  const icon = artOf(pokemon, 'icon');
  if (!icon) return null;
  return { path: icon.path, meta: { ...icon.meta, frames: 1, delay: 1000, facing: 'left' } };
}

/** Field pixels per second. About one tile every half-second. */
export const WALK_SPEED = 34;

/**
 * How far the hurry has come on after another frame, from 0 (the ordinary
 * pace) to 1 (all of it): up while the pointer is held, gliding down after.
 *
 * @param {number} level where it was
 * @param {boolean} held whether the pointer is down
 * @param {number} deltaMs
 */
export function nextBoost(level, held, deltaMs) {
  if (held) return Math.min(1, level + deltaMs / HOLD_BOOST_RAMP_MS);
  return Math.max(0, level - deltaMs / HOLD_BOOST_GLIDE_MS);
}

/**
 * The multiple of the ordinary pace a hurry this far on comes to, eased at
 * both ends so the change of speed has no corner in it.
 *
 * @param {number} level from {@link nextBoost}
 * @param {number} full the multiple at full hurry
 */
export function boostPace(level, full) {
  const t = Math.min(1, Math.max(0, level));
  return 1 + (full - 1) * t * t * (3 - 2 * t);
}

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
 * Draw what the map puts over the people on it — a bridge overhead — tiled
 * exactly as the background under it is.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement|null} overlay
 * @param {number} offset
 */
export function drawOverlay(context, overlay, offset) {
  if (!overlay) return;
  const width = overlay.naturalWidth;
  const height = overlay.naturalHeight;
  const top = FIELD_HEIGHT - height;
  let start = -(((offset % width) + width) % width);
  while (start < FIELD_WIDTH) {
    context.drawImage(overlay, Math.round(start), top, width, height);
    start += width;
  }
}

/**
 * How far either side of a bridge an event is kept away, in field pixels.
 *
 * A trainer half under the deck, or a Pokémon Center with a bridge through
 * its roof, is not a picture the map was ever meant to show.
 */
export const OVERPASS_MARGIN = 40;

/**
 * Whether a stretch of road runs under, or too close to, something the map
 * draws over the lane.
 *
 * @param {{width: number, covered?: Array<[number, number]>}|null|undefined} area
 * @param {[number, number]} ground strip coordinates before wrapping, as
 *   `eventGround` gives them
 * @param {number} [margin]
 */
export function nearOverpass(area, [from, to], margin = OVERPASS_MARGIN) {
  const spans = area?.covered;
  if (!spans?.length || !area.width) return false;
  const width = area.width;
  // Each span stands once per repeat of the strip; the stretch is compared
  // with the copies either side of it as well as its own.
  const base = Math.floor(from / width) * width;
  for (const shift of [base - width, base, base + width]) {
    for (const [start, end] of spans) {
      if (from < shift + end + margin && to > shift + start - margin) return true;
    }
  }
  return false;
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
  // Relative to whatever the sprite is drawn at, so a companion fading into
  // a doorway takes its shadow with it.
  context.globalAlpha *= 0.25;
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
 * Which frame of its walk a Pokémon is on after travelling this far.
 *
 * Driven by distance like the four-beat walk above, so the feet keep pace
 * with the road — a hurried companion steps faster, one stopped in front of a
 * berry tree does not step at all — and timed by the strip's own frame
 * lengths, taken at the ordinary walking pace.
 *
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {number} distance field pixels covered
 */
export function strideFrame(sprite, distance) {
  return sprite.frameAt(Math.max(0, (distance / WALK_SPEED) * 1000));
}

/**
 * Draw a Pokémon as an overworld sprite, facing the way it is going.
 *
 * Art with frames of its own animates: its walk while it moves, by distance,
 * and whatever strip it was handed — its standing one, for a stopped
 * companion — by the clock while it does not. A single still drawing, the box
 * icon a species without walking art falls back on, is made to walk instead:
 * the lean is a shear rather than a whole-sprite shift, so the feet stay
 * planted on the ground row and the displacement grows towards the head, and
 * the body rocks over its own footing.
 *
 * Art facing the other way is mirrored about its own centre column.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{
 *   x: number,
 *   y: number,
 *   distance: number,
 *   moving: boolean,
 *   facing?: 'left'|'right',
 *   scale?: number,
 *   lift?: number,
 *   time?: number,
 * }} options `lift` raises the sprite off the ground without its shadow, for
 *   a companion busy with something where it stands; `time` is the clock a
 *   standing strip plays by
 */
export function drawWalker(
  context,
  sprite,
  { x, y, distance, moving, facing = 'right', scale = POKEMON_SCALE, lift: raised = 0, time = 0 },
) {
  const animated = sprite.frames > 1;
  const frame = !animated ? 0 : moving ? strideFrame(sprite, distance) : sprite.frameAt(time);
  const { lift, lean } = moving && !animated ? walkFrame(distance) : WALK_CYCLE[0];
  const flip = (sprite.facing ?? 'left') !== facing;
  const sx = frame * sprite.width;

  // Whole pixels in the field's own space: a sprite whose scale leaves it half
  // a pixel wide lands on a half pixel at one edge and a whole one at the
  // other, and the walk cycle then makes that edge shimmer.
  const width = Math.round(sprite.width * scale);
  const height = Math.round(sprite.height * scale);
  // The shadow stays on the ground whatever the sprite is doing above it,
  // which is what makes a bob read as leaving the ground rather than as the
  // whole thing sliding up the screen.
  drawShadow(context, x, y, width);

  const left = Math.round(x - width / 2);
  const top = Math.round(y - height - lift - raised);

  context.save();
  if (flip) {
    // Mirror about the sprite's own centre column, so flipping does not move
    // it off the spot it is standing on.
    context.translate(left * 2 + width, 0);
    context.scale(-1, 1);
  }

  if (lean === 0) {
    context.drawImage(sprite.image, sx, 0, sprite.width, sprite.height, left, top, width, height);
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
        sx,
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
  context.globalAlpha *= 0.28 * fade;
  context.fillStyle = '#e8e2cf';
  const spread = 3 + (1 - fade) * 4;
  context.fillRect(Math.round(x - 9 - spread), Math.round(y - 1), 2, 1);
  context.fillRect(Math.round(x - 12 - spread), Math.round(y - 3), 1, 1);
  context.restore();
}
