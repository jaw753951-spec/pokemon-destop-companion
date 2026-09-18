/**
 * The backdrop a battle is fought in front of.
 *
 * The handheld games never fight over the map: the screen cuts to a terrain
 * backdrop chosen from where you are standing, and the league has a room of
 * its own. The pipeline composes one image per backdrop at exactly the field's
 * size, so drawing one is a single blit in field space.
 */
import { FIELD_HEIGHT, FIELD_WIDTH } from '../../shared/constants.mjs';
import { loadImage } from '../core/assets.mjs';
import { gameData } from '../core/data.mjs';

/** Shown where an area's tags name nothing better. */
const FALLBACK = 'grass';

/** The Elite Four's chambers, in the order the rounds are fought. */
const LEAGUE_ROOMS = ['elite-sidney', 'elite-phoebe', 'elite-glacia', 'elite-drake'];

/** The champion's room, which the last round is fought in. */
export const CHAMPION_ROOM = 'champion';

/**
 * The backdrop for an area, from the first of its terrain tags that names one.
 *
 * @param {{tags?: string[]}|null|undefined} area
 * @returns {string}
 */
export function backdropForArea(area) {
  const tags = gameData().battle?.tags ?? {};
  for (const tag of area?.tags ?? []) {
    if (tags[tag]) return tags[tag];
  }
  return FALLBACK;
}

/**
 * The room a league round is fought in: one chamber per Elite Four member and
 * the champion's own for the last.
 *
 * @param {number} index round number, from zero
 * @param {number} rounds how many rounds the challenge has
 */
export function backdropForLeagueRound(index, rounds) {
  if (index >= rounds - 1) return CHAMPION_ROOM;
  return LEAGUE_ROOMS[index % LEAGUE_ROOMS.length];
}

/**
 * Load a backdrop, or nothing if the build has no such image — a missing
 * backdrop leaves the battle drawn over the field, which is what the game did
 * before the backdrops existed.
 *
 * @param {string} id
 * @returns {Promise<HTMLImageElement|null>}
 */
export function loadBackdrop(id) {
  if (!gameData().battle?.backdrops?.[id]) return Promise.resolve(null);
  return loadImage(`battle/${id}.png`).catch(() => null);
}

/**
 * @param {CanvasRenderingContext2D} context in field space
 * @param {HTMLImageElement} image
 */
export function drawBackdrop(context, image) {
  context.drawImage(image, 0, 0, FIELD_WIDTH, FIELD_HEIGHT);
}
