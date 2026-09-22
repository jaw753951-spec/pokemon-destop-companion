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

/** How long each pose runs before falling back to idle. */
const POSE_DURATION = { idle: 0, attack: 420, hit: 380, win: 900, lose: 700 };

/**
 * How long the arrows over a stat change stay up, and how many there are.
 *
 * The cartridges play a column of chevrons climbing the sprite for a raise and
 * falling down it for a drop; three of them over two-thirds of a second is
 * that animation at this size, and it is the only thing on screen that says a
 * stat moved before the message box gets to the words.
 */
const STAT_EFFECT_MS = 640;
const STAT_ARROWS = 3;

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
     * The two sprite sets already point at each other across the field: a
     * front sprite is drawn three-quarters towards the viewer's left, where
     * the player's Pokémon stands, and a back sprite shows the companion from
     * behind facing right, where the foe stands. So neither is mirrored — only
     * the stand-in front sprite used for a species with no back art, which
     * would otherwise have the companion looking over its shoulder.
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

    context.save();
    // Fade out over the second half, so the arrows leave rather than vanish.
    context.globalAlpha = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
    context.strokeStyle = up ? '#7ad06d' : '#e2686a';
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (let index = 0; index < STAT_ARROWS; index++) {
      // Each arrow starts a third of the way behind the one before it, so the
      // three read as one column travelling rather than three blinking.
      const step = Math.max(0, Math.min(1, progress * 1.6 - index * 0.2));
      if (step <= 0) continue;
      const travel = (up ? -1 : 1) * (height * 0.35 + step * height * 0.5);
      const y = this.y - (up ? 0 : height * 0.8) + travel;
      const width = 4;

      context.beginPath();
      context.moveTo(this.x - width, y + (up ? width : -width));
      context.lineTo(this.x, y);
      context.lineTo(this.x + width, y + (up ? width : -width));
      context.stroke();
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
