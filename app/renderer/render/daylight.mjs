/**
 * The light of the hour, laid over the things the pipeline could not grade.
 *
 * Area backgrounds are rendered five times over and graded at build time, so
 * a route is properly blue at night. Everything else on the map — the Pokémon
 * Center, the berry trees, the trainers, the companion itself — is one
 * picture shared by every hour, so at midnight a building stood in full
 * daylight on a moonlit road.
 *
 * Grading each of those five times over would be five times the download for
 * art that is a few kilobytes and rarely on screen. So they are lit here
 * instead: drawn on their own layer and washed with the hour's colour, which
 * is an approximation of the pipeline's own grade and costs one fill.
 */
import { FIELD_HEIGHT, FIELD_WIDTH } from '../../shared/constants.mjs';

/**
 * The wash for each band.
 *
 * These are not guesses. The pipeline grades a background by multiplying each
 * channel and adding to it — `out = m·c + k`, the `TIME_GRADES` table in
 * `dev/tools/lib/image.mjs` — and a single fill can only do `out = (1-a)·c +
 * a·t`. The two agree on a straight line through the whole range of a channel
 * if `a` and `t` are chosen for it, so they were: the alpha was searched and
 * the colour solved by least squares against the pipeline's own numbers over
 * every value a pixel can hold. The fits land within a few units of 255 —
 * night, the harshest of them, inside eleven.
 *
 * `day` is nothing at all: the unmodified palette is the daytime one, and the
 * fit agrees, coming out as a neutral grey at two per cent.
 *
 * @type {Record<string, {colour: string, strength: number}|null>}
 */
export const DAYLIGHT = {
  dawn: { colour: 'rgb(255, 140, 255)', strength: 0.07 },
  day: null,
  afternoon: { colour: 'rgb(251, 123, 0)', strength: 0.115 },
  dusk: { colour: 'rgb(190, 0, 0)', strength: 0.25 },
  night: { colour: 'rgb(0, 2, 114)', strength: 0.455 },
};

/** The scratch layer, made once and reused every frame. */
let layer = null;

/**
 * A field-sized canvas to draw the unlit things on, cleared and ready.
 * @returns {CanvasRenderingContext2D|null}
 */
export function openDaylightLayer() {
  if (!layer) {
    const canvas = document.createElement('canvas');
    canvas.width = FIELD_WIDTH;
    canvas.height = FIELD_HEIGHT;
    layer = canvas.getContext('2d');
    if (layer) layer.imageSmoothingEnabled = false;
  }
  if (!layer) return null;
  layer.clearRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
  return layer;
}

/**
 * Light what was drawn on the layer and put it on the field.
 *
 * `source-atop` is what keeps the wash inside the pixels that were drawn: the
 * road behind them has already been graded by the pipeline and must not be
 * graded twice.
 *
 * @param {CanvasRenderingContext2D} context the field, already scaled
 * @param {string} time one of the five bands
 */
export function closeDaylightLayer(context, time) {
  if (!layer) return;
  const light = DAYLIGHT[time];

  if (light) {
    layer.save();
    layer.globalCompositeOperation = 'source-atop';
    layer.globalAlpha = light.strength;
    layer.fillStyle = light.colour;
    layer.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
    layer.restore();
  }

  context.drawImage(layer.canvas, 0, 0);
}
