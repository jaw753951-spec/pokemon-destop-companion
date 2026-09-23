/**
 * A Pokémon as the field draws it, for the screens that show one outside it.
 *
 * The Pokémon tab and the starter table used to show the battle sprite — a
 * different drawing, facing the other way, at a different size — so the
 * companion looked like one Pokémon on the road and another in the menu. This
 * draws the field's own art with the field's own `drawWalker`: the box icon,
 * turned down the road, at the size the Pokédex gives it, standing on its
 * shadow.
 */
import { FIELD_ZOOM } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { artOf } from '../core/data.mjs';
import { el } from '../core/dom.mjs';
import { actorScale, drawWalker } from '../render/field.mjs';

/**
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null}} pokemon
 * @param {{zoom?: number, maxHeight?: number, label?: string}} [options] `zoom`
 *   is screen pixels per field pixel — the field's own two by default, so the
 *   Pokémon is the size it walks at; `maxHeight` shrinks one too tall for the
 *   space it is given
 * @returns {HTMLElement|null} null when the species has no field art
 */
export function walkerPortrait(pokemon, { zoom = FIELD_ZOOM, maxHeight = Infinity, label = '' } = {}) {
  const art = artOf(pokemon, 'icon');
  if (!art) return null;

  const canvas = /** @type {HTMLCanvasElement} */ (el('canvas.walker-portrait', { role: 'img', 'aria-label': label }));
  loadSprite(art.path, { ...art.meta, frames: 1, delay: 1000 })
    .then((sprite) => {
      const scale = actorScale(sprite, pokemon);
      const width = Math.round(sprite.width * scale);
      const height = Math.round(sprite.height * scale);
      // Room under the feet for the shadow, which is as deep as drawShadow
      // makes it for a sprite this wide.
      const below = Math.ceil(Math.max(2, width * 0.15)) + 1;
      const fieldWidth = width + 2;
      const fieldHeight = height + below;

      canvas.width = fieldWidth * zoom;
      canvas.height = fieldHeight * zoom;
      const fit = Math.min(1, maxHeight / canvas.height);
      canvas.style.width = `${Math.round(canvas.width * fit)}px`;
      canvas.style.height = `${Math.round(canvas.height * fit)}px`;

      const context = canvas.getContext('2d');
      if (!context) return;
      context.imageSmoothingEnabled = false;
      context.scale(zoom, zoom);
      drawWalker(context, sprite, { x: fieldWidth / 2, y: height, distance: 0, moving: false, scale });
    })
    .catch(() => {
      // A missing icon leaves an empty frame rather than a broken screen.
    });
  return canvas;
}
