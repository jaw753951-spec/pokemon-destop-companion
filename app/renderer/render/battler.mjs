/**
 * Drawing a Pokémon in battle, with the poses the official sprites do not have.
 *
 * No official asset set contains attack, hit, victory or defeat frames — the
 * cartridges animate the idle sprite instead. So each pose here is a timed
 * transform of the same sprite: a lunge towards the opponent, a tinted shake
 * on being hit, a hop on winning, and a slump and fade on fainting. The result
 * reads as two-frame animation because each pose alternates between a settled
 * and a displaced position.
 */

import { actorScale, undrawnFormeArt, walkerArt } from './field.mjs';

/** @typedef {'idle'|'attack'|'hit'|'win'|'lose'|'emerge'} Pose */

/**
 * Shrink a battler that would not fit where it stands.
 *
 * Anything that would overrun the room it has is brought down to fit it —
 * but only in steps of half a field pixel, which the field's own zoom turns
 * into whole screen pixels. A Pokémon shrunk to an arbitrary fraction is made
 * of pixels of two sizes, and every Pokémon on screen being made of one size
 * of pixel is the whole reason the art is drawn at a fixed scale.
 *
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{width: number, height: number}} room field pixels available
 * @param {number} preferred the scale it is drawn at when it fits
 */
export function fitScale(sprite, room, preferred) {
  const fits = Math.min(room.height / sprite.height, room.width / sprite.width);
  if (preferred <= fits) return preferred;
  return Math.max(SCALE_STEP, Math.floor(fits / SCALE_STEP) * SCALE_STEP);
}

/** The smallest step a battler's scale moves in: one screen pixel per art pixel. */
const SCALE_STEP = 0.5;

/**
 * The art a Pokémon is drawn from in a battle: its **standing** art, the same
 * picture it waits on the road in.
 *
 * The game used to fight with the front and back sprites, which come from a
 * different set entirely — Showdown's animations where there are any, and the
 * modern three-dimensional renders where there are not. Those renders are lit,
 * shaded and posed like models rather than drawn like sprites, so a battle
 * looked like a different game from the walk that led into it, and which of
 * the two a player got depended on nothing more meaningful than how new the
 * species was. One set of art for the whole game is worth more than the best
 * picture of each Pokémon taken separately.
 *
 * A forme the walking art never drew is the exception: a battle is where a
 * shape changes, and a Calyrex that mounted its steed or a Cramorant with a
 * catch in its mouth has to look it, so it is fought in its battle sprite.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null}|null|undefined} pokemon
 */
export function battlerArt(pokemon) {
  return undrawnFormeArt(pokemon) ?? walkerArt(pokemon, 'idle');
}

/**
 * Whether a battler's art has to be mirrored to look the way its side faces.
 *
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {'left'|'right'} facing
 */
export const mirrorFor = (sprite, facing) => (sprite.facing ?? 'left') !== facing;

/**
 * How much bigger than its field size a Pokémon is drawn in a battle.
 *
 * A battle is a close-up: the same sprite that is ankle-high on the road fills
 * a good part of the screen here, which is exactly what the cartridges do when
 * they cut from the overworld to a fight. A whole number, so each art pixel
 * is a whole number of screen pixels.
 */
export const BATTLE_ZOOM = 2;

/**
 * And how much smaller the far side is drawn, which is the only depth cue a
 * flat backdrop has. The foe stands up the field; the companion is nearer the
 * camera than it is. Three quarters of the near side's two is one and a half,
 * which is still a whole number of screen pixels.
 */
export const FOE_DEPTH = 0.75;

/**
 * What to draw a battler at: its own field scale, brought up to battle size,
 * pushed back if it is the far one, and shrunk to fit if that overruns.
 *
 * Because it starts from the field's own {@link actorScale}, the whole roster
 * keeps one scale in battle too — a Sableye is a Sableye's size next to a
 * Snorlax rather than whatever size its icon happened to be drawn at.
 *
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{speciesId: number}|null|undefined} pokemon
 * @param {{width: number, height: number}} room
 * @param {number} [depth]
 */
export function battlerScale(sprite, pokemon, room, depth = 1) {
  return fitScale(sprite, room, actorScale(sprite, pokemon) * BATTLE_ZOOM * depth);
}

/** How long each pose runs before falling back to idle. */
const POSE_DURATION = { idle: 0, attack: 420, hit: 380, win: 900, lose: 700, emerge: 340 };

/**
 * The arrows over a stat change: how long they run, how many there are, and
 * the colours the games use.
 *
 * The cartridges play a spread of arrows sweeping up the Pokémon for a raise
 * and down it for a drop, with the sprite itself washed in the same colour
 * while they pass. Solid arrows across the width of the sprite read at this
 * size where an outlined chevron on the centre line did not.
 */
const STAT_EFFECT_MS = 620;
const STAT_ARROWS = 4;
const STAT_COLOURS = { up: '#6ee06a', down: '#ff6b6b' };

/** @type {HTMLCanvasElement|OffscreenCanvas|null} */
let sharedTint = null;

/**
 * A scratch canvas at least this big, shared by every tint, since only one is
 * ever being painted at a time.
 *
 * @param {number} width
 * @param {number} height
 */
function tintCanvas(width, height) {
  if (!sharedTint) {
    // Nowhere to paint one — a test drawing into a recording context — and a
    // tint is only ever decoration.
    if (typeof OffscreenCanvas !== 'undefined') sharedTint = new OffscreenCanvas(width, height);
    else if (typeof document !== 'undefined') sharedTint = document.createElement('canvas');
    else return null;
  }
  if (sharedTint.width < width) sharedTint.width = width;
  if (sharedTint.height < height) sharedTint.height = height;
  return sharedTint;
}

export class Battler {
  /**
   * @param {{
   *   sprite: import('../core/assets.mjs').Sprite|null,
   *   x: number,
   *   y: number,
   *   facing: 1|-1,
   *   scale?: number,
   *   flip?: boolean,
   * }} options
   */
  constructor({ sprite, x, y, facing, scale = 1, flip = false }) {
    this.sprite = sprite;
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.scale = scale;
    /**
     * Whether the art has to be mirrored to look the way this side faces.
     *
     * The two sides face each other across the backdrop: the companion on the
     * left looking right, as it faces down the road it walks, and the foe on
     * the right looking back at it. Which of them needs mirroring depends on
     * which way the art was drawn — see {@link mirrorFor}.
     */
    this.flip = flip;

    /** @type {Pose} */
    this.pose = 'idle';
    this.poseElapsed = 0;
    this.elapsed = 0;
    this.visible = true;

    /**
     * A stat change playing over the sprite: which way it went, and how far
     * through the animation it is. Zero means nothing is playing.
     */
    this.statDirection = 0;
    this.statElapsed = 0;
  }

  /**
   * Play the arrows for a stat that just moved.
   * @param {1|-1} direction up for a raise, down for a drop
   */
  showStatChange(direction) {
    this.statDirection = direction;
    this.statElapsed = 0;
  }

  /**
   * @param {Pose} pose
   */
  setPose(pose) {
    this.pose = pose;
    this.poseElapsed = 0;
  }

  /** @param {number} deltaMs */
  update(deltaMs) {
    this.elapsed += deltaMs;

    if (this.statDirection !== 0) {
      this.statElapsed += deltaMs;
      if (this.statElapsed >= STAT_EFFECT_MS) this.statDirection = 0;
    }

    if (this.pose === 'idle') return;

    this.poseElapsed += deltaMs;
    // `lose` is terminal: a fainted Pokémon stays down.
    if (this.pose !== 'lose' && this.poseElapsed >= POSE_DURATION[this.pose]) this.setPose('idle');
  }

  /** Whether the current pose has finished playing. */
  get poseDone() {
    if (this.pose === 'idle') return true;
    return this.poseElapsed >= POSE_DURATION[this.pose];
  }

  /**
   * @param {CanvasRenderingContext2D} context
   */
  draw(context) {
    if (!this.sprite || !this.visible) return;
    const transform = this.transform();

    context.save();
    // A fainting Pokémon sinks through the line it was standing on: whatever
    // has gone below it is not drawn, so it disappears into the ground
    // instead of sliding down over the message box.
    if (this.pose === 'lose') {
      context.beginPath();
      context.rect(0, 0, context.canvas.width, this.y);
      context.clip();
    }
    context.globalAlpha = transform.alpha;
    context.translate(this.x + transform.dx * this.facing, this.y + transform.dy);
    if (transform.rotate) {
      context.rotate(transform.rotate * this.facing);
    }
    context.translate(-this.x, -this.y);

    this.sprite.draw(context, this.x, this.y, {
      frame: this.sprite.frameAt(this.elapsed),
      flip: this.flip,
      scale: this.scale * transform.scale,
    });
    context.restore();

    if (transform.flash > 0) this.drawFlash(context, transform.flash);
    if (transform.glow > 0) this.drawTint(context, '#ffffff', transform.glow);
    if (this.statDirection !== 0) this.drawStatChange(context);
  }

  /**
   * The chevrons for a stat change, over the sprite it happened to.
   *
   * They are drawn in the field's own coordinates rather than scaled with the
   * sprite, so a stat drop on a Diglett reads as clearly as one on a Wailord.
   *
   * @param {CanvasRenderingContext2D} context
   */
  drawStatChange(context) {
    if (!this.sprite) return;
    const progress = Math.min(1, this.statElapsed / STAT_EFFECT_MS);
    const up = this.statDirection > 0;
    const height = this.sprite.height * this.scale;
    const width = this.sprite.width * this.scale;
    const colour = up ? STAT_COLOURS.up : STAT_COLOURS.down;

    // The sprite is washed in the same colour while the arrows pass, which is
    // what makes the games' version read as something happening *to* the
    // Pokémon rather than as decoration drawn near it.
    this.drawTint(context, colour, (1 - progress) * 0.34);

    context.save();
    // Fade out over the last third, so the arrows leave rather than vanish.
    context.globalAlpha = progress < 0.66 ? 1 : Math.max(0, 1 - (progress - 0.66) * 3);
    context.fillStyle = colour;

    for (let index = 0; index < STAT_ARROWS; index++) {
      // Each arrow starts a little behind the one before it, so the four read
      // as one sweep travelling rather than four blinking. The first is up
      // from the opening frame — the stagger is for the ones behind it.
      const raw = progress * 1.5 - index * 0.16;
      if (index > 0 && raw <= 0) continue;
      const step = Math.max(0, Math.min(1, raw));

      // Spread across the sprite rather than stacked on its centre line, so
      // the sweep covers the Pokémon the way the cartridges' does.
      const lane = index / Math.max(1, STAT_ARROWS - 1) - 0.5;
      const x = this.x + lane * width * 0.55;
      // Up: from the feet to over the head. Down: from the head to the feet.
      const y = up ? this.y - step * height : this.y - height + step * height;
      const arm = Math.max(3, width * 0.12);
      const tip = up ? -arm : arm;

      context.beginPath();
      context.moveTo(x, y + tip);
      context.lineTo(x - arm, y - tip * 0.2);
      context.lineTo(x - arm * 0.4, y - tip * 0.2);
      context.lineTo(x - arm * 0.4, y - tip);
      context.lineTo(x + arm * 0.4, y - tip);
      context.lineTo(x + arm * 0.4, y - tip * 0.2);
      context.lineTo(x + arm, y - tip * 0.2);
      context.closePath();
      context.fill();
    }
    context.restore();
  }

  /**
   * A colour washed over the sprite's own pixels, and nothing around them.
   *
   * @param {CanvasRenderingContext2D} context
   * @param {string} colour
   * @param {number} strength
   */
  drawTint(context, colour, strength) {
    if (!this.sprite || strength <= 0) return;
    const sprite = this.sprite;
    const transform = this.transform();

    // The silhouette is coloured on a canvas of its own and then laid over
    // the sprite. Colouring it in place, with \`source-atop\` on the battle's
    // canvas, coloured everything already drawn there too — the backdrop
    // included — so every hit washed the whole screen red.
    const tint = tintCanvas(sprite.width, sprite.height);
    const paint = /** @type {CanvasRenderingContext2D|null} */ (/** @type {any} */ (tint)?.getContext('2d') ?? null);
    if (!tint || !paint) return;
    paint.globalCompositeOperation = 'copy';
    paint.drawImage(sprite.image, sprite.frameAt(this.elapsed) * sprite.width, 0, sprite.width, sprite.height, 0, 0, sprite.width, sprite.height);
    paint.globalCompositeOperation = 'source-atop';
    paint.fillStyle = colour;
    paint.fillRect(0, 0, sprite.width, sprite.height);

    const scale = this.scale * transform.scale;
    const width = sprite.width * scale;
    const height = sprite.height * scale;
    const left = Math.round(this.x - width / 2);
    const top = Math.round(this.y - height);

    context.save();
    context.globalAlpha = strength;
    context.translate(transform.dx * this.facing, transform.dy);
    if (this.flip) {
      context.translate(left + width, top);
      context.scale(-1, 1);
      context.drawImage(/** @type {any} */ (tint), 0, 0, sprite.width, sprite.height, 0, 0, width, height);
    } else {
      context.drawImage(/** @type {any} */ (tint), 0, 0, sprite.width, sprite.height, left, top, width, height);
    }
    context.restore();
  }

  /**
   * A red wash over the sprite's silhouette, which is what a hit reads as at
   * this size. Drawing the sprite again in `source-atop` keeps the tint inside
   * the sprite's own pixels.
   *
   * @param {CanvasRenderingContext2D} context
   * @param {number} strength
   */
  drawFlash(context, strength) {
    this.drawTint(context, '#ff4040', strength);
  }

  /**
   * The offset, scale, rotation, alpha and tint for the pose at its current
   * point in time.
   * @returns {{dx: number, dy: number, scale: number, rotate: number, alpha: number, flash: number, glow: number}}
   */
  transform() {
    const still = { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1, flash: 0, glow: 0 };
    if (this.pose === 'idle') return still;

    const duration = POSE_DURATION[this.pose];
    const progress = duration > 0 ? Math.min(1, this.poseElapsed / duration) : 1;

    switch (this.pose) {
      case 'attack': {
        // Out fast, back slow — a lunge rather than a drift.
        const swing = progress < 0.35 ? progress / 0.35 : 1 - (progress - 0.35) / 0.65;
        return { ...still, dx: swing * 16, dy: -swing * 3, scale: 1 + swing * 0.06 };
      }
      case 'hit': {
        // Three quick shakes, with the tint fading out across them.
        const shake = Math.sin(progress * Math.PI * 6) * (1 - progress) * 5;
        return { ...still, dx: -shake, flash: (1 - progress) * 0.6 };
      }
      case 'win': {
        const hop = Math.abs(Math.sin(progress * Math.PI * 2)) * (1 - progress * 0.4);
        return { ...still, dy: -hop * 9, scale: 1 + hop * 0.04 };
      }
      case 'lose': {
        // Straight down and out of sight, which is what the cartridges do: the
        // sprite slides below the ground it was standing on and is cut off at
        // that line as it goes, rather than tipping over and dimming in place.
        // `draw` does the cutting; the height it has to travel is its own.
        const height = (this.sprite?.height ?? 0) * this.scale;
        return { ...still, dy: progress * (height + 4), alpha: 1 };
      }
      case 'emerge': {
        // Out of the ball: from a speck to its full size, white at first and
        // coming into its own colours as it grows.
        const eased = 1 - (1 - progress) ** 3;
        return { ...still, scale: 0.12 + 0.88 * eased, alpha: Math.min(1, 0.4 + progress), glow: (1 - progress) * 0.9 };
      }
      default:
        return still;
    }
  }
}
