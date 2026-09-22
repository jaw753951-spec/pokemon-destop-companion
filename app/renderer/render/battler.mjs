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

import { artOf } from '../core/data.mjs';
import { actorScale } from './field.mjs';

/** @typedef {'idle'|'attack'|'hit'|'win'|'lose'} Pose */

/**
 * Shrink a battler that would not fit where it stands.
 *
 * The sprite sets run from a Diglett to an Eternatus drawn 447 pixels tall —
 * four times the height of this window — so at full size the big ones are a
 * cropped shin. Anything that would overrun the room it has is scaled to fill
 * that room instead, in both directions, so the largest Pokémon is the largest
 * thing on screen rather than the least visible.
 *
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {{width: number, height: number}} room field pixels available
 * @param {number} preferred the scale it is drawn at when it fits
 */
export function fitScale(sprite, room, preferred) {
  const fits = Math.min(room.height / sprite.height, room.width / sprite.width);
  return Math.min(preferred, fits);
}

/**
 * The art a Pokémon is drawn from in a battle: its **box icon**, the same
 * picture it walks the field and fills a box slot with.
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
 * @param {{speciesId: number, shiny?: boolean}|null|undefined} pokemon
 */
export function battlerArt(pokemon) {
  const art = artOf(pokemon, 'icon');
  if (!art) return null;
  // Box icons are a single still drawing; the walk animates them by moving
  // them, and a battle by the poses above.
  return { path: art.path, meta: { ...art.meta, frames: 1, delay: 1000 } };
}

/**
 * How much bigger than its field size a Pokémon is drawn in a battle.
 *
 * A battle is a close-up: the same sprite that is ankle-high on the road fills
 * a good part of the screen here, which is exactly what the cartridges do when
 * they cut from the overworld to a fight.
 */
export const BATTLE_ZOOM = 2.2;

/**
 * And how much smaller the far side is drawn, which is the only depth cue a
 * flat backdrop has. The foe stands up the field; the companion is nearer the
 * camera than it is.
 */
export const FOE_DEPTH = 0.8;

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
const POSE_DURATION = { idle: 0, attack: 420, hit: 380, win: 900, lose: 700 };

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
     * A box icon is drawn three-quarters on, turned towards the viewer's left
     * — the same drawing the field walks with. The foe stands on the right and
     * is already looking the right way; the companion stands on the left and
     * is mirrored, so the two face each other across the backdrop exactly as
     * the companion faces down the road it walks.
     */
    this.flip = flip;

    /** @type {Pose} */
    this.pose = 'idle';
    this.poseElapsed = 0;
    this.elapsed = 0;
    this.visible = true;
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
    if (!this.sprite) return;
    const transform = this.transform();
    context.save();
    context.globalAlpha = strength;
    context.globalCompositeOperation = 'source-atop';
    context.translate(this.x + transform.dx * this.facing, this.y + transform.dy);
    context.translate(-this.x, -this.y);
    this.sprite.draw(context, this.x, this.y, {
      frame: this.sprite.frameAt(this.elapsed),
      flip: this.flip,
      scale: this.scale * transform.scale,
    });
    context.fillStyle = '#ff4040';
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  /**
   * The offset, scale, rotation, alpha and tint for the pose at its current
   * point in time.
   * @returns {{dx: number, dy: number, scale: number, rotate: number, alpha: number, flash: number}}
   */
  transform() {
    const still = { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1, flash: 0 };
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
        // Sink, tip over and fade.
        return {
          ...still,
          dy: progress * 14,
          rotate: progress * 0.5,
          alpha: 1 - progress * 0.85,
        };
      }
      default:
        return still;
    }
  }
}
