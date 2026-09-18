/**
 * Where the pipeline gets its raw material, and which slices of it we ship.
 *
 * Only `raw.githubusercontent.com` is used, so the whole pipeline works from a
 * plain HTTPS client with no API keys and no tarballs.
 */

export { TAG_TYPES } from '../../app/shared/area-tags.mjs';
export { BALL_TIERS } from '../../app/shared/ball-tiers.mjs';

export const POKEAPI = 'https://raw.githubusercontent.com/PokeAPI/api-data/master/data/api/v2';
export const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites';
export const CRIES = 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries';
export const EMERALD = 'https://raw.githubusercontent.com/pret/pokeemerald/master';

/** Highest National Dex number the game ships (Gen 9, Pecharunt). */
export const MAX_SPECIES = 1025;

/** The version group whose rules the game follows, newest first for fallback. */
export const VERSION_GROUP_PRIORITY = [
  'scarlet-violet',
  'sword-shield',
  'brilliant-diamond-and-shining-pearl',
  'lets-go-pikachu-lets-go-eevee',
  'ultra-sun-ultra-moon',
  'sun-moon',
  'omega-ruby-alpha-sapphire',
  'x-y',
  'black-2-white-2',
  'black-white',
  'heartgold-soulsilver',
  'platinum',
  'diamond-pearl',
  'emerald',
  'firered-leafgreen',
  'ruby-sapphire',
  'crystal',
  'gold-silver',
  'yellow',
  'red-blue',
];

/**
 * Areas the companion can wander through.
 *
 * Every entry is a real Hoenn map from the Emerald decompilation: `dir` names
 * the map directory (which yields its layout, music and weather), `location`
 * is the PokeAPI location whose official Korean name we display, and `tags`
 * drive wild-encounter fallbacks for species the game has no encounter data
 * for. Sticking to one region keeps the art consistent and, crucially, keeps
 * every area name available in official Korean — PokeAPI carries Korean names
 * for Hoenn locations but not for Kanto ones.
 *
 * @type {Array<{id: string, dir: string, location: string, tags: string[]}>}
 */
export const AREAS = [
  { id: 'route101', dir: 'Route101', location: 'hoenn-route-101', tags: ['grass', 'plain'] },
  { id: 'route102', dir: 'Route102', location: 'hoenn-route-102', tags: ['grass', 'water'] },
  { id: 'route103', dir: 'Route103', location: 'hoenn-route-103', tags: ['grass', 'beach'] },
  { id: 'route104', dir: 'Route104', location: 'hoenn-route-104', tags: ['beach', 'forest'] },
  { id: 'route110', dir: 'Route110', location: 'hoenn-route-110', tags: ['grass', 'urban'] },
  { id: 'route111', dir: 'Route111', location: 'hoenn-route-111', tags: ['desert', 'sand'] },
  { id: 'route112', dir: 'Route112', location: 'hoenn-route-112', tags: ['mountain', 'volcano'] },
  { id: 'route113', dir: 'Route113', location: 'hoenn-route-113', tags: ['volcano', 'ash'] },
  { id: 'route114', dir: 'Route114', location: 'hoenn-route-114', tags: ['mountain', 'rough'] },
  { id: 'route115', dir: 'Route115', location: 'hoenn-route-115', tags: ['beach', 'mountain'] },
  { id: 'route116', dir: 'Route116', location: 'hoenn-route-116', tags: ['grass', 'rough'] },
  { id: 'route117', dir: 'Route117', location: 'hoenn-route-117', tags: ['grass', 'meadow'] },
  { id: 'route118', dir: 'Route118', location: 'hoenn-route-118', tags: ['beach', 'water'] },
  { id: 'route119', dir: 'Route119', location: 'hoenn-route-119', tags: ['jungle', 'rain'] },
  { id: 'route120', dir: 'Route120', location: 'hoenn-route-120', tags: ['jungle', 'water'] },
  { id: 'route121', dir: 'Route121', location: 'hoenn-route-121', tags: ['grass', 'meadow'] },
  { id: 'route123', dir: 'Route123', location: 'hoenn-route-123', tags: ['grass', 'meadow'] },
  { id: 'petalburg-woods', dir: 'PetalburgWoods', location: 'petalburg-woods', tags: ['forest'] },
  { id: 'granite-cave', dir: 'GraniteCave_1F', location: 'granite-cave', tags: ['cave', 'rough'] },
  { id: 'fiery-path', dir: 'FieryPath', location: 'fiery-path', tags: ['volcano', 'cave'] },
  { id: 'jagged-pass', dir: 'JaggedPass', location: 'jagged-pass', tags: ['mountain', 'volcano'] },
  { id: 'meteor-falls', dir: 'MeteorFalls_1F_1R', location: 'meteor-falls', tags: ['cave', 'water'] },
  { id: 'mt-pyre', dir: 'MtPyre_Exterior', location: 'mt-pyre', tags: ['mountain', 'graveyard'] },
  { id: 'safari-zone', dir: 'SafariZone_South', location: 'hoenn-safari-zone', tags: ['grass', 'safari'] },
  { id: 'shoal-cave', dir: 'ShoalCave_LowTideEntranceRoom', location: 'shoal-cave', tags: ['cave', 'ice'] },
  { id: 'victory-road', dir: 'VictoryRoad_1F', location: 'hoenn-victory-road', tags: ['cave', 'rough'] },
  { id: 'sky-pillar', dir: 'SkyPillar_1F', location: 'sky-pillar', tags: ['ruins', 'sky'] },
  { id: 'new-mauville', dir: 'NewMauville_Inside', location: 'new-mauville', tags: ['urban', 'electric'] },
  { id: 'seafloor-cavern', dir: 'SeafloorCavern_Room1', location: 'seafloor-cavern', tags: ['cave', 'water'] },
  { id: 'cave-of-origin', dir: 'CaveOfOrigin_1F', location: 'cave-of-origin', tags: ['cave', 'ruins'] },
];

/** The three Kanto starters the game opens with, in Pokédex order. */
export const STARTERS = [1, 4, 7];

/** Window geometry: roughly one sixteenth of the screen's area. */
export const VIEW_WIDTH = 480;
export const VIEW_HEIGHT = 270;

/** The field is drawn at twice size; see `FIELD_ZOOM` in the shared constants. */
export const FIELD_ZOOM = 2;
export const FIELD_WIDTH = VIEW_WIDTH / FIELD_ZOOM;
export const FIELD_HEIGHT = VIEW_HEIGHT / FIELD_ZOOM;

/**
 * The scrolling background fills the field, as the map does in the real games.
 * A map shorter than this contributes every row it has.
 */
export const BACKGROUND_HEIGHT = FIELD_HEIGHT;

/** Cap on stored animation frames per sprite state. */
export const MAX_SPRITE_FRAMES = 10;
