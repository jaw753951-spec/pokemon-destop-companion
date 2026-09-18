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
