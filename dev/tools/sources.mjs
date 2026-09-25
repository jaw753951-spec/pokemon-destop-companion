/**
 * Where the pipeline gets its raw material, and which slices of it we ship.
 *
 * Only `raw.githubusercontent.com` is used, so the whole pipeline works from a
 * plain HTTPS client with no API keys and no tarballs.
 */

export { TAG_TYPES } from '../../app/shared/area-tags.mjs';
export { BALL_TIERS } from '../../app/shared/ball-tiers.mjs';
export { MOVE_FLAGS, MOVE_FLAG_SET } from '../../app/shared/move-flags.mjs';

export const POKEAPI = 'https://raw.githubusercontent.com/PokeAPI/api-data/master/data/api/v2';
export const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites';
export const CRIES = 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries';
export const EMERALD = 'https://raw.githubusercontent.com/pret/pokeemerald/master';
export const FIRERED = 'https://raw.githubusercontent.com/pret/pokefirered/master';
export const CRYSTAL = 'https://raw.githubusercontent.com/pret/pokecrystal/master';

/**
 * The PMD Sprite Collab: the field art every Pokémon walks the road in.
 *
 * One density of pixel art for the whole dex, walking and standing in all
 * eight directions — which the box icons the field used before are not. It is
 * published under CC BY-NC 4.0, credit given per sprite, and the build keeps
 * the list of artists the game ships so the credits screen can name them.
 */
export const SPRITE_COLLAB = 'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master';

/**
 * Where the Smogon Sprite Project's DS-style sprites sit in its repository —
 * drawn in the DS games' pixel style for every Pokémon and forme the DS games
 * never had, the art Pokémon Showdown, PokeRogue and the Essentials packs all
 * draw their battlers from. The files the build uses are kept in
 * `data/vendor/smogon/` (see `lib/vendor.mjs`).
 */
export const SMOGON_SPRITES = 'src/sprites/gen5';

/*
 * The Pokémon Essentials Gen 8/9 resource packs' follower sprites — a walking
 * sheet for every species and most formes, drawn by the fan-game community
 * and free for fan projects with credit — are kept in `data/vendor/essentials/`
 * for the species and formes the Sprite Collab has not drawn.
 */

/**
 * How a move is classified — contact, sound, powder, punch and the rest.
 *
 * PokeAPI has no field for it, and the decompilations only carry the flags
 * their own generation knew about, so a Gen-3 dump cannot say whether a move
 * is a bullet or a slicing move. Pokémon Showdown's move table states every
 * flag for every move and is served from the same plain HTTPS host as the
 * rest, which is the whole of why it is here: one file, read once, for the
 * one thing nothing else publishes.
 */
export const SHOWDOWN = 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data';

/**
 * Portraits of named characters the league needs and Emerald never drew.
 *
 * Fire Red is the same generation and the same hand, so its Elite Four sit
 * beside Hoenn's without a seam. Will and Karen were never drawn on a Game Boy
 * Advance at all, so Crystal's four-colour sprites stand in — the person, in
 * the art the game that introduced them used.
 *
 * @type {Record<string, {source: 'firered'|'crystal', path: string}>}
 */
export const NAMED_PORTRAITS = {
  bruno: { source: 'firered', path: 'graphics/trainers/front_pics/elite_four_bruno_front_pic.png' },
  lance: { source: 'firered', path: 'graphics/trainers/front_pics/elite_four_lance_front_pic.png' },
  koga: { source: 'firered', path: 'graphics/trainers/front_pics/leader_koga_front_pic.png' },
  will: { source: 'crystal', path: 'gfx/trainers/will.png' },
  karen: { source: 'crystal', path: 'gfx/trainers/karen.png' },
};

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
 * for. Only the two Game Boy Advance regions are here — Hoenn from Emerald and
 * Kanto from Fire Red, drawn by the same hand in the same engine — so every
 * area shares one look. PokeAPI carries Korean names for Hoenn locations but
 * not for Kanto ones, so a Kanto area names itself in `ko`.
 *
 * Only places under the sky, or in a cave, which reads as the same road
 * underfoot. The insides of buildings are left out: New Mauville's floor tiles
 * and Sky Pillar's corridors are rooms, and a companion walking the road
 * through one looked as though it had wandered indoors. The cartridge files
 * both as underground, alongside the caves, so they are named out by hand.
 *
 * @type {Array<{id: string, dir: string, location: string, tags: string[], game?: 'emerald'|'firered', region?: string, ko?: string}>}
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
  { id: 'seafloor-cavern', dir: 'SeafloorCavern_Room1', location: 'seafloor-cavern', tags: ['cave', 'water'] },
  { id: 'cave-of-origin', dir: 'CaveOfOrigin_1F', location: 'cave-of-origin', tags: ['cave', 'ruins'] },

  // Kanto, from the Fire Red decompilation: the same engine and the same hand
  // as Emerald, so the two regions share one look. PokeAPI carries no Korean
  // names for Kanto, so `ko` gives the official one. The sea routes (19-21)
  // are nearly all water, and the Sevii Islands never had a Korean release to
  // name them, so neither is here.
  { id: 'kanto-route-1', dir: 'Route1', location: 'kanto-route-1', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '1번도로' },
  { id: 'kanto-route-2', dir: 'Route2', location: 'kanto-route-2', tags: ['grass', 'forest'], game: 'firered', region: 'kanto', ko: '2번도로' },
  { id: 'kanto-route-3', dir: 'Route3', location: 'kanto-route-3', tags: ['mountain', 'rough'], game: 'firered', region: 'kanto', ko: '3번도로' },
  { id: 'kanto-route-4', dir: 'Route4', location: 'kanto-route-4', tags: ['mountain', 'grass'], game: 'firered', region: 'kanto', ko: '4번도로' },
  { id: 'kanto-route-5', dir: 'Route5', location: 'kanto-route-5', tags: ['grass', 'urban'], game: 'firered', region: 'kanto', ko: '5번도로' },
  { id: 'kanto-route-6', dir: 'Route6', location: 'kanto-route-6', tags: ['grass', 'water'], game: 'firered', region: 'kanto', ko: '6번도로' },
  { id: 'kanto-route-7', dir: 'Route7', location: 'kanto-route-7', tags: ['grass', 'urban'], game: 'firered', region: 'kanto', ko: '7번도로' },
  { id: 'kanto-route-8', dir: 'Route8', location: 'kanto-route-8', tags: ['grass', 'urban'], game: 'firered', region: 'kanto', ko: '8번도로' },
  { id: 'kanto-route-9', dir: 'Route9', location: 'kanto-route-9', tags: ['mountain', 'rough'], game: 'firered', region: 'kanto', ko: '9번도로' },
  { id: 'kanto-route-10', dir: 'Route10', location: 'kanto-route-10', tags: ['mountain', 'electric'], game: 'firered', region: 'kanto', ko: '10번도로' },
  { id: 'kanto-route-11', dir: 'Route11', location: 'kanto-route-11', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '11번도로' },
  { id: 'kanto-route-12', dir: 'Route12', location: 'kanto-route-12', tags: ['grass', 'water'], game: 'firered', region: 'kanto', ko: '12번도로' },
  { id: 'kanto-route-13', dir: 'Route13', location: 'kanto-route-13', tags: ['grass', 'meadow'], game: 'firered', region: 'kanto', ko: '13번도로' },
  { id: 'kanto-route-14', dir: 'Route14', location: 'kanto-route-14', tags: ['grass', 'meadow'], game: 'firered', region: 'kanto', ko: '14번도로' },
  { id: 'kanto-route-15', dir: 'Route15', location: 'kanto-route-15', tags: ['grass', 'meadow'], game: 'firered', region: 'kanto', ko: '15번도로' },
  { id: 'kanto-route-16', dir: 'Route16', location: 'kanto-route-16', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '16번도로' },
  { id: 'kanto-route-17', dir: 'Route17', location: 'kanto-route-17', tags: ['beach', 'plain'], game: 'firered', region: 'kanto', ko: '17번도로' },
  { id: 'kanto-route-18', dir: 'Route18', location: 'kanto-route-18', tags: ['beach', 'grass'], game: 'firered', region: 'kanto', ko: '18번도로' },
  { id: 'kanto-route-22', dir: 'Route22', location: 'kanto-route-22', tags: ['grass', 'plain'], game: 'firered', region: 'kanto', ko: '22번도로' },
  { id: 'kanto-route-23', dir: 'Route23', location: 'kanto-route-23', tags: ['mountain', 'rough'], game: 'firered', region: 'kanto', ko: '23번도로' },
  { id: 'kanto-route-24', dir: 'Route24', location: 'kanto-route-24', tags: ['grass', 'water'], game: 'firered', region: 'kanto', ko: '24번도로' },
  { id: 'kanto-route-25', dir: 'Route25', location: 'kanto-route-25', tags: ['grass', 'beach'], game: 'firered', region: 'kanto', ko: '25번도로' },
  { id: 'viridian-forest', dir: 'ViridianForest', location: 'viridian-forest', tags: ['forest'], game: 'firered', region: 'kanto', ko: '상록숲' },
  { id: 'mt-moon', dir: 'MtMoon_1F', location: 'mt-moon', tags: ['cave', 'rough'], game: 'firered', region: 'kanto', ko: '달맞이산' },
  { id: 'rock-tunnel', dir: 'RockTunnel_1F', location: 'rock-tunnel', tags: ['cave', 'rough'], game: 'firered', region: 'kanto', ko: '돌산터널' },
  { id: 'digletts-cave', dir: 'DiglettsCave_B1F', location: 'digletts-cave', tags: ['cave', 'sand'], game: 'firered', region: 'kanto', ko: '디그다의굴' },
  { id: 'seafoam-islands', dir: 'SeafoamIslands_1F', location: 'seafoam-islands', tags: ['cave', 'ice'], game: 'firered', region: 'kanto', ko: '쌍둥이섬' },
  { id: 'kanto-victory-road', dir: 'VictoryRoad_1F', location: 'kanto-victory-road-2', tags: ['cave', 'rough'], game: 'firered', region: 'kanto', ko: '챔피언로드' },
  { id: 'cerulean-cave', dir: 'CeruleanCave_1F', location: 'cerulean-cave', tags: ['cave', 'ruins'], game: 'firered', region: 'kanto', ko: '블루시티동굴' },
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

/**
 * The battle backdrop is composed at exactly the field's own size, so the
 * battle scene draws it one-to-one over the same doubled space the map uses.
 * The handheld shows the leftmost 240 columns of its 256-wide tilemap, which
 * is what cropping to the field width reproduces.
 */
export const BATTLE_WIDTH = FIELD_WIDTH;
export const BATTLE_HEIGHT = FIELD_HEIGHT;

/**
 * The eight badges on the Hoenn trainer card, in sheet order, named for the
 * type of the gym that awards each one.
 */
export const HOENN_BADGE_TYPES = [
  'rock',
  'fighting',
  'electric',
  'fire',
  'normal',
  'flying',
  'psychic',
  'water',
];

/** Cap on stored animation frames per sprite state. */
export const MAX_SPRITE_FRAMES = 10;
