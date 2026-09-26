/**
 * A Pokémon as the field draws it, for the screens that show one outside it.
 *
 * The Pokémon tab and the starter table used to show the battle sprite — a
 * different drawing, facing the other way, at a different size — so the
 * companion looked like one Pokémon on the road and another in the menu. This
 * draws its one picture with the field's own `drawWalker`: the same picture,
 * facing down the road, at the field's scale, standing on its shadow and
 * bobbing the way it does when it stops on the road.
 */
import { FIELD_ZOOM } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { el } from '../core/dom.mjs';
import { fieldArtOf } from '../core/data.mjs';
import { actorScale, drawWalker, IDLE_BOB_HEIGHT } from '../render/field.mjs';

/**
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null}} pokemon
 * @param {{zoom?: number, maxHeight?: number, label?: string}} [options] `zoom`
 *   is screen pixels per field pixel — the field's own two by default, so the
 *   Pokémon is the size it walks at; `maxHeight` brings one too tall for the
 *   space it is given down a whole step of zoom at a time, so it stays made of
 *   whole pixels
 * @returns {HTMLElement|null} null when the species has no field art
 */
export function walkerPortrait(pokemon, { zoom = FIELD_ZOOM, maxHeight = Infinity, label = '' } = {}) {
  const art = fieldArtOf(pokemon);
  if (!art) return null;

  const canvas = /** @type {HTMLCanvasElement} */ (el('canvas.walker-portrait', { role: 'img', 'aria-label': label }));
  loadSprite(art.path, art.meta)
    .then((sprite) => {
      const scale = actorScale(sprite, pokemon);
      const width = Math.round(sprite.width * scale);
      const height = Math.round(sprite.height * scale);
      // Room under the feet for the shadow, which is as deep as drawShadow
      // makes it for a sprite this wide.
      const below = Math.ceil(Math.max(2, width * 0.15)) + 1;
      // And room over the head for the bob to rise into.
      const above = Math.ceil(IDLE_BOB_HEIGHT * scale);
      const fieldWidth = width + 2;
      const fieldHeight = above + height + below;

      let fit = zoom;
      while (fit > 1 && fieldHeight * fit > maxHeight) fit -= 1;
      canvas.width = fieldWidth * fit;
      canvas.height = fieldHeight * fit;
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;

      const context = canvas.getContext('2d');
      if (!context) return;
      context.imageSmoothingEnabled = false;
      const paint = () => {
        context.setTransform(fit, 0, 0, fit, 0, 0);
        context.clearRect(0, 0, fieldWidth, fieldHeight);
        drawWalker(context, sprite, { x: fieldWidth / 2, y: above + height, distance: 0, moving: false, scale, time: performance.now() });
      };
      paint();

      // The bob plays for as long as the portrait is on screen, and stops
      // once the screen showing it has been replaced.
      const timer = window.setInterval(() => {
        if (!canvas.isConnected) {
          window.clearInterval(timer);
          return;
        }
        paint();
      }, 50);
    })
    .catch(() => {
      // A missing picture leaves an empty frame rather than a broken screen.
    });
  return canvas;
}
