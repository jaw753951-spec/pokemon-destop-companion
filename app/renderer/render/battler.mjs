/**
 * Drawing a Pokémon in battle, with the poses its one picture does not have.
 *
 * Every Pokémon is a single still picture, so each pose here is a timed move
 * of that picture: a bob on the spot while it waits, one push towards the
 * opponent on its attack, one push back — tinted red — on being hit, a hop on
 * winning, and a slide into the ground on fainting.
 */

import { artOf } from '../core/data.mjs';
import { idleBob } from './field.mjs';

/** @typedef {'idle'|'attack'|'hit'|'win'|'lose'|'emerge'} Pose */

/**
 * The art a Pokémon is drawn from in a battle: its Black and White sprite,
 * at the sprite's own size, as the battles those games drew it in.
 *
 * The game used to fight with Showdown's animations where there were any and
 * the modern three-dimensional renders where there were not — lit, shaded
 * and posed like models rather than drawn like sprites — and later with the
 * small fan art it walked the road in. Now the picture is the one the box and
 * the road show, and a forme, which a battle is where a shape changes, has a
 * picture of its own.
 *
 * A Pokémon is never shrunk to fit a battle: a picture made smaller would be
 * made of smaller pixels than its opponent. The far platform stands low
 * enough for nearly all of them, and the tallest few are cut off at the top
 * of the window.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null, gender?: string|null}|null|undefined} pokemon
 */
export const battlerArt = (pokemon) => artOf(pokemon);

/**
 * Whether a battler's art has to be mirrored to look the way its side faces.
 *
 * @param {import('../core/assets.mjs').Sprite} sprite
 * @param {'left'|'right'} facing
 */
export const mirrorFor = (sprite, facing) => (sprite.facing ?? 'left') !== facing;

/**
 * How big a battler is drawn, in field pixels per art pixel: one, which the
 * field's own zoom makes two screen pixels — the size the road's tiles and
 * people are drawn at, so a battle is made of the same pixels as the walk
 * that led into it. Both sides alike, as Black and White drew them.
 */
export const BATTLE_SCALE = 1;

/** How long each pose runs before falling back to idle. */
const POSE_DURATION = { idle: 0, attack: 360, hit: 360, win: 900, lose: 700, emerge: 340 };

/**
 * How long a Pokémon takes to leave for a two-turn move's wait, and to come
 * back when the move comes down.
 *
 * While it is away — up in the sky on a Fly or a Bounce, under the ground on
 * a Dig, under the water on a Dive, gone on a Phantom Force or a Shadow
 * Force — nothing of it is drawn: not the sprite, and not the effects that
 * play over it. That is the cartridges' own rule. Emerald's battle animations
 * set the attacker's sprite invisible on the charge turn, and its shadow
 * follows the sprite's visibility; Platinum's hide the battler, and draw a
 * battler's shadow only while the battler itself is drawn. Nothing is left on
 * the ground to show where it went.
 */
const AWAY_MS = 420;
const BACK_MS = 240;

/** How far one push carries a battler, in field pixels: forward to attack, back when hit. */
const PUSH_PX = 12;

/**
 * Out fast and back slow, as one push: 0 at rest, 1 at the far end.
 *
 * @param {number} progress 0 to 1 through the pose
 */
const push = (progress) => (progress < 0.3 ? progress / 0.3 : 1 - (progress - 0.3) / 0.7);

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

/**
 * A status condition's effect over the Pokémon it takes hold of — and again
 * each time it stops it moving or hurts it — after the games' own: purple
 * bubbles rising off a poisoned Pokémon, flames licking up a burned one,
 * sparks crackling round a paralysed one, Zs drifting up from a sleeping
 * one, and ice glinting over a frozen one, each with the sprite washed in the
 * condition's colour while it plays.
 */
const STATUS_EFFECT_MS = 800;
const STATUS_EFFECTS = {
  psn: { tint: '#a040c8', strength: 0.4, main: '#a848d0', light: '#f0c8ff', shadow: '#602070' },
  brn: { tint: '#f05828', strength: 0.4, main: '#f06020', light: '#ffe060', shadow: '#a02810' },
  par: { tint: '#f8d030', strength: 0.45, main: '#f8e040', light: '#fffce0', shadow: '#a07000' },
  slp: { tint: '#8890a8', strength: 0.25, main: '#ffffff', light: '#ffffff', shadow: '#485078' },
  frz: { tint: '#80d0f0', strength: 0.5, main: '#a8e8ff', light: '#ffffff', shadow: '#3888b8' },
  confusion: { tint: '#f0a0c8', strength: 0.2, main: '#f8d840', light: '#fff8c0', shadow: '#b07800' },
  // Not a condition: the sparkle a shiny Pokémon comes out in.
  shiny: { tint: '#ffffff', strength: 0.35, main: '#fff4a0', light: '#ffffff', shadow: '#d0a000' },
};

/* The effects' little drawings, a character a field pixel (see `drawStatus`). */
const BUBBLE = ['.xxx.', 'x#o#x', 'x###x', 'x###x', '.xxx.'];
const BUBBLE_SMALL = ['.x.', 'xox', '.x.'];
const POP = ['o.o', '...', 'o.o'];
const FLAME = ['..x..', '..#..', '.x#x.', '.#o#.', 'x#oo#', 'x#oo#', '.x##.'];
const FLAME_SMALL = ['.x.', '.#.', 'x#x', '.o.'];
const BOLT = ['..xo', '.xo.', 'xo..', 'xooo', '..xo', '.xo.', 'xo..'];
const Z = ['#####', '...#.', '..#..', '.#...', '#####'];
const Z_SMALL = ['####', '..#.', '.#..', '####'];
const GLINT = ['..o..', '..#..', 'o#o#o', '..#..', '..o..'];
const GLINT_SMALL = ['.#.', '#o#', '.#.'];
const STAR = ['..x..', '.x#x.', 'x#o#x', '.x#x.', '..x..'];

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

    /** The status condition whose effect is playing, and how far through. */
    this.statusEffect = /** @type {string|null} */ (null);
    this.statusElapsed = 0;

    /**
     * Where a two-turn move has taken the Pokémon for its wait — `sky`,
     * `ground`, `water` or `vanished` — and how long since it left. Null
     * while it is on the field.
     */
    this.away = /** @type {string|null} */ (null);
    this.awayElapsed = 0;
    /** Where it is coming back from, and how far through the return. */
    this.back = /** @type {string|null} */ (null);
    this.backElapsed = 0;
  }

  /**
   * Leave the field for a two-turn move's wait.
   * @param {string} place `sky`, `ground`, `water` or `vanished`
   */
  goAway(place) {
    this.away = place;
    this.awayElapsed = 0;
    this.back = null;
  }

  /** Come back from a two-turn move's wait, as the move comes down. */
  comeBack() {
    if (!this.away) return;
    this.back = this.away;
    this.backElapsed = 0;
    this.away = null;
  }

  /** Whether nothing of the Pokémon is on screen: it has left for its wait. */
  get gone() {
    return Boolean(this.away) && this.awayElapsed >= AWAY_MS;
  }

  /**
   * Play a status condition's effect over the sprite.
   * @param {string} status `brn`, `psn`, `par`, `slp` or `frz`, or `confusion`
   */
  showStatus(status) {
    if (!(status in STATUS_EFFECTS)) return;
    this.statusEffect = status;
    this.statusElapsed = 0;
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

    if (this.statusEffect) {
      this.statusElapsed += deltaMs;
      if (this.statusElapsed >= STATUS_EFFECT_MS) this.statusEffect = null;
    }

    if (this.away) this.awayElapsed += deltaMs;
    if (this.back) {
      this.backElapsed += deltaMs;
      if (this.backElapsed >= BACK_MS) this.back = null;
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
    if (!this.sprite || !this.visible || this.gone) return;
    const transform = this.transform();
    const leaving = this.travel();
    transform.dy += leaving.dy;
    if (!leaving.shown) return;

    context.save();
    // A fainting Pokémon sinks through the line it was standing on: whatever
    // has gone below it is not drawn, so it disappears into the ground
    // instead of sliding down over the message box. A Dig and a Dive go down
    // through the same line, and come back up through it.
    if (this.pose === 'lose' || leaving.clip) {
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
    if (this.statusEffect) this.drawStatus(context);
  }

  /**
   * Where a Pokémon leaving for a two-turn move's wait, or coming back from
   * it, stands off its spot: up off the top of the screen for the sky, down
   * through the ground line for the ground and the water, and blinking out
   * of sight — as Platinum's Shadow Force blinks its user away — for the rest.
   *
   * @returns {{dy: number, clip: boolean, shown: boolean}}
   */
  travel() {
    const place = this.away ?? this.back;
    if (!place) return { dy: 0, clip: false, shown: true };
    const height = (this.sprite?.height ?? 0) * this.scale;
    // 0 on the spot, 1 all the way out.
    const out = this.away ? Math.min(1, this.awayElapsed / AWAY_MS) : 1 - Math.min(1, this.backElapsed / BACK_MS);
    switch (place) {
      case 'sky':
        // Up and away, faster as it goes: clear of the top of the window.
        return { dy: -Math.round(out * out * (this.y + 8)), clip: false, shown: true };
      case 'ground':
      case 'water':
        return { dy: Math.round(out * (height + 4)), clip: true, shown: true };
      default: {
        const elapsed = this.away ? this.awayElapsed : this.backElapsed;
        return { dy: 0, clip: false, shown: out < 1 && Math.floor(elapsed / 70) % 2 === 0 };
      }
    }
  }

  /**
   * The effect of the status condition playing, over the sprite it is on.
   *
   * Everything is drawn in whole field pixels, in the flat colours of the
   * games' own effects, and placed by the sprite's size so a Joltik's sparks
   * and a Wailord's sit on the Pokémon rather than round a fixed box.
   *
   * @param {CanvasRenderingContext2D} context
   */
  drawStatus(context) {
    const effect = this.statusEffect ? STATUS_EFFECTS[/** @type {keyof typeof STATUS_EFFECTS} */ (this.statusEffect)] : null;
    if (!this.sprite || !effect) return;
    const progress = Math.min(1, this.statusElapsed / STATUS_EFFECT_MS);
    // In, held, and out: a wash that swells and fades twice, as the games pulse it.
    const pulse = Math.abs(Math.sin(progress * Math.PI * 2));
    this.drawTint(context, effect.tint, pulse * effect.strength * (1 - progress * 0.5));

    const width = this.sprite.width * this.scale;
    const height = this.sprite.height * this.scale;
    const dy = this.transform().dy;
    const left = this.x - width / 2;
    const top = this.y + dy - height;
    const fade = progress < 0.75 ? 1 : Math.max(0, 1 - (progress - 0.75) * 4);

    context.save();
    context.globalAlpha = fade;
    /**
     * A little pixel drawing, one character a field pixel: `#` the effect's
     * colour, `o` its light, `x` its shadow, anything else left clear.
     * @param {string[]} rows
     * @param {number} x centre
     * @param {number} y centre
     */
    const stamp = (rows, x, y, shadowed = false) => {
      // A drop shadow a pixel down and right, for a shape drawn in one light
      // colour that has to read against a pale backdrop.
      if (shadowed) {
        const colour = effect.shadow;
        stampIn(rows, x + 1, y + 1, () => colour);
      }
      stampIn(rows, x, y, (character) => ({ '#': effect.main, o: effect.light, x: effect.shadow })[character]);
    };
    /**
     * @param {string[]} rows
     * @param {number} x
     * @param {number} y
     * @param {(character: string) => string|undefined} colourOf
     */
    const stampIn = (rows, x, y, colourOf) => {
      const ox = Math.round(x - rows[0].length / 2);
      const oy = Math.round(y - rows.length / 2);
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] === '.') continue;
          const colour = colourOf(row[rx]);
          if (!colour) continue;
          context.fillStyle = colour;
          context.fillRect(ox + rx, oy + ry, 1, 1);
        }
      });
    };

    switch (this.statusEffect) {
      case 'psn': {
        // Bubbles rising off the body, shrinking as they go and popping.
        for (let index = 0; index < 6; index++) {
          const step = (progress - index * 0.09) / 0.55;
          if (step <= 0 || step >= 1) continue;
          const x = left + width * (0.2 + ((index * 37) % 60) / 100);
          const y = this.y + dy - height * 0.2 - step * height * 0.7;
          stamp(step < 0.6 ? BUBBLE : step < 0.9 ? BUBBLE_SMALL : POP, x, y);
        }
        break;
      }
      case 'brn': {
        // Flames licking up from the feet, each rising and dying in turn.
        for (let index = 0; index < 5; index++) {
          const phase = (progress * 2.5 + index * 0.37) % 1;
          const x = left + width * (0.12 + index * 0.19);
          const y = this.y + dy - 4 - phase * height * 0.45;
          stamp(phase < 0.7 ? FLAME : FLAME_SMALL, x, y);
        }
        break;
      }
      case 'par': {
        // Sparks cracking on and off down both sides of the body.
        for (let index = 0; index < 4; index++) {
          if (Math.floor(progress * 12 + index * 2) % 3 === 0) continue;
          const side = index % 2 === 0 ? -1 : 1;
          const x = this.x + side * width * (0.32 + (index >> 1) * 0.1);
          const y = top + height * (0.3 + (index >> 1) * 0.35);
          stamp(side < 0 ? BOLT : BOLT.map((row) => [...row].reverse().join('')), x, y);
        }
        break;
      }
      case 'slp': {
        // Zs drifting up and away from the head one after another, growing
        // as they go, so the three stand in a rising line.
        for (let index = 0; index < 3; index++) {
          const step = (progress - index * 0.2) / 0.6;
          if (step <= 0 || step >= 1) continue;
          const x = this.x + width * 0.2 + step * 14;
          const y = top + 2 - step * 16;
          stamp(step < 0.4 ? Z_SMALL : Z, x, y, true);
        }
        break;
      }
      case 'frz': {
        // Glints of ice winking on across the body, a star of light each.
        for (let index = 0; index < 6; index++) {
          const step = (progress - index * 0.09) / 0.4;
          if (step <= 0 || step >= 1) continue;
          const x = left + width * (0.15 + ((index * 43) % 70) / 100);
          const y = top + height * (0.15 + ((index * 29) % 70) / 100);
          stamp(step < 0.3 || step > 0.7 ? GLINT_SMALL : GLINT, x, y);
        }
        break;
      }
      case 'shiny': {
        // Stars bursting outward from the Pokémon in a ring, twice, as the
        // games' sparkle does, shrinking as they fly.
        for (let wave = 0; wave < 2; wave++) {
          const step = (progress - wave * 0.3) / 0.6;
          if (step <= 0 || step >= 1) continue;
          for (let index = 0; index < 8; index++) {
            const angle = (index / 8) * Math.PI * 2 + wave * 0.4;
            const reach = 6 + step * Math.max(18, width * 0.55);
            const x = this.x + Math.cos(angle) * reach;
            const y = top + height / 2 + Math.sin(angle) * reach * 0.8;
            stamp(step < 0.6 ? STAR : GLINT_SMALL, x, y);
          }
        }
        break;
      }
      case 'confusion': {
        // Stars circling the head, three at even spacing going round twice,
        // the far side of the circle drawn a little smaller.
        const radius = Math.max(8, width * 0.3);
        for (let index = 0; index < 3; index++) {
          const angle = progress * Math.PI * 4 + (index * Math.PI * 2) / 3;
          const x = this.x + Math.cos(angle) * radius;
          const y = top - 2 + Math.sin(angle) * radius * 0.3;
          stamp(Math.sin(angle) < 0 ? GLINT_SMALL : STAR, x, y);
        }
        break;
      }
      default:
        break;
    }
    context.restore();
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
    if (this.pose === 'idle') return { ...still, dy: -idleBob(this.elapsed) * this.scale };

    const duration = POSE_DURATION[this.pose];
    const progress = duration > 0 ? Math.min(1, this.poseElapsed / duration) : 1;

    switch (this.pose) {
      case 'attack':
        // One push towards the opponent and back, level along the ground and
        // at its own size, so it stays made of the pixels it stood in.
        return { ...still, dx: Math.round(push(progress) * PUSH_PX) };
      case 'hit':
        // One push back the other way, washed red and fading as it settles.
        return { ...still, dx: -Math.round(push(progress) * PUSH_PX), flash: (1 - progress) * 0.6 };
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
