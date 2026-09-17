/**
 * Drawing the travelling view: the scrolling area background and the
 * companion walking across it.
 *
 * The background strips the pipeline builds are seamless, so scrolling is just
 * a modulo of the offset. The companion holds its place on screen while the
 * world moves past it, which reads as walking without needing a walk cycle the
 * official sprites do not have.
 */
import { BACKGROUND_HEIGHT, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';

/** Where the companion's feet sit, and how fast the world slides past. */
export const GROUND_Y = BACKGROUND_HEIGHT - 12;
export const WALK_SPEED = 34;

/** The companion walks a third of the way in from the left. */
export const COMPANION_X = Math.round(VIEW_WIDTH * 0.32);

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
  // Modulo can be negative for a negative offset; normalise so the first tile
  // always starts at or before the left edge.
  let start = -(((offset % width) + width) % width);

  while (start < VIEW_WIDTH) {
    context.drawImage(background, Math.round(start), 0, width, height);
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
  context.ellipse(x, y, Math.max(6, width * 0.32), Math.max(2, width * 0.12), 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/**
 * The bob that stands in for a walk cycle: a small vertical bounce timed to
 * the sprite's own animation so the two read as one motion.
 *
 * @param {number} elapsedMs
 * @param {number} periodMs
 * @returns {number} pixels to lift the sprite by
 */
export function walkBob(elapsedMs, periodMs = 520) {
  const phase = (elapsedMs % periodMs) / periodMs;
  return Math.abs(Math.sin(phase * Math.PI * 2)) * 2.2;
}

/**
 * The strip of ground the UI sits on, below the background image.
 * @param {CanvasRenderingContext2D} context
 */
export function drawApron(context) {
  const top = BACKGROUND_HEIGHT;
  const gradient = context.createLinearGradient(0, top, 0, VIEW_HEIGHT);
  gradient.addColorStop(0, '#1b2233');
  gradient.addColorStop(1, '#10141f');
  context.fillStyle = gradient;
  context.fillRect(0, top, VIEW_WIDTH, VIEW_HEIGHT - top);

  context.fillStyle = 'rgba(255, 255, 255, 0.08)';
  context.fillRect(0, top, VIEW_WIDTH, 1);
}
