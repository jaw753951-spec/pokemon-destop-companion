/**
 * Terrain tags an area carries, and the Pokémon types that suit each.
 *
 * Wild encounters come from the area's own table where the games have one;
 * this map is the fallback for areas and trainers that need a wider pool, and
 * it is shared with the asset pipeline so the tags in `areas.json` and the
 * ones the game reads can never drift apart.
 *
 * @type {Record<string, string[]>}
 */
export const TAG_TYPES = {
  grass: ['normal', 'grass', 'bug', 'flying'],
  plain: ['normal', 'flying'],
  meadow: ['grass', 'bug', 'fairy', 'normal'],
  forest: ['bug', 'grass', 'poison', 'dark'],
  jungle: ['grass', 'bug', 'poison', 'water'],
  beach: ['water', 'normal', 'flying'],
  water: ['water', 'ice'],
  desert: ['ground', 'rock', 'fire'],
  sand: ['ground', 'rock'],
  mountain: ['rock', 'ground', 'fighting', 'flying'],
  rough: ['rock', 'ground', 'fighting'],
  cave: ['rock', 'ground', 'dark', 'poison'],
  volcano: ['fire', 'rock', 'ground'],
  ash: ['fire', 'ground', 'normal'],
  ice: ['ice', 'water'],
  graveyard: ['ghost', 'dark', 'psychic'],
  ruins: ['psychic', 'ghost', 'rock', 'dragon'],
  sky: ['flying', 'dragon', 'psychic'],
  urban: ['electric', 'steel', 'poison', 'normal'],
  electric: ['electric', 'steel'],
  safari: ['normal', 'grass', 'bug', 'ground'],
  rain: ['water', 'grass', 'bug'],
};

/**
 * The weather a place is under, for the tags that describe one.
 *
 * The maps carry a weather field of their own, but it is not this: Emerald
 * files almost every outdoor map as `WEATHER_SUNNY`, which means ordinary
 * daylight rather than the harsh sunlight a Sunny Day calls up, and Route
 * 119's rain is set by the route's own script rather than by its header. So
 * the sky comes from the tags, which were written to say what a place is like
 * — Route 119 is tagged `rain` because it rains there, Route 111 `desert`
 * because it is a sandstorm, Shoal Cave `ice` because it is full of it.
 *
 * A battle fought in one of these opens under that weather, and it does not
 * run out, because nobody called for it.
 *
 * @type {Record<string, string>}
 */
export const TAG_WEATHER = {
  rain: 'rain',
  desert: 'sandstorm',
  sand: 'sandstorm',
  ice: 'snow',
};

/**
 * The weather an area is under, if its tags name one.
 * @param {{tags?: string[]}|null|undefined} area
 * @returns {string|null}
 */
export function weatherForArea(area) {
  for (const tag of area?.tags ?? []) {
    if (TAG_WEATHER[tag]) return TAG_WEATHER[tag];
  }
  return null;
}
