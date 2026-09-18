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

/** @typedef {'idle'|'attack'|'hit'|'win'|'lose'} Pose */

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
   * }} options
   */
  constructor({ sprite, x, y, facing, scale = 1 }) {
    this.sprite = sprite;
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.scale = scale;

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
      // Sprites face the viewer, so the player's side is mirrored to face right.
      flip: this.facing === 1,
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
      flip: this.facing === 1,
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
