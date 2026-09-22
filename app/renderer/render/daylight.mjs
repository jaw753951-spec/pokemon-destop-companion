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
 * The wash for each band, chosen to sit alongside `TIME_GRADES` in the
 * pipeline rather than to reproduce it exactly: a multiply-and-add over every
 * channel is not something a single fill can do, but the colour it leaves is.
 *
 * `day` is nothing at all — the unmodified palette is the daytime one.
 *
 * @type {Record<string, {colour: string, strength: number}|null>}
 */
export const DAYLIGHT = {
  dawn: { colour: 'rgb(74, 86, 140)', strength: 0.16 },
  day: null,
  afternoon: { colour: 'rgb(255, 198, 122)', strength: 0.14 },
  dusk: { colour: 'rgb(158, 74, 62)', strength: 0.28 },
  night: { colour: 'rgb(20, 30, 92)', strength: 0.46 },
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
