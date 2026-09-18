/**
 * Render the battle backdrops and the gym badges.
 *
 * A battle in the handheld games is fought in front of a terrain backdrop, not
 * over the map, and the Elite Four have a room of their own. Both are ordinary
 * GBA background layers in the decompilation — a 4bpp tile sheet, a 32x32
 * screen-entry tilemap and a palette — so each one is composed here once and
 * shipped as a flat PNG the battle scene can simply draw.
 *
 * Badges come from the trainer card sheet, eight 16x16 icons in a row.
 */
import { join } from 'node:path';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { parseJascPal, sliceTiles, TILE_SIZE } from '../lib/gba-gfx.mjs';
import { BATTLE_HEIGHT, BATTLE_WIDTH, EMERALD, HOENN_BADGE_TYPES } from '../sources.mjs';

/** Screen entries across one GBA screenblock. */
const MAP_COLUMNS = 32;

/**
 * The terrain palettes are loaded at background palette slot 2, so a screen
 * entry naming palette 2 means the first sixteen colours of the file and one
 * naming palette 3 the next sixteen.
 */
const FIRST_PALETTE_SLOT = 2;

/**
 * Backdrops, and which of them the game reaches for.
 *
 * `dir` is the decompilation's directory; `palette` names a file inside it
 * when the backdrop is a recolour of the same tiles, which is how the games
 * turn one building into a gym, a leader's room, and each Elite Four chamber.
 *
 * @type {Array<{id: string, dir: string, palette?: string}>}
 */
const BACKDROPS = [
  { id: 'grass', dir: 'tall_grass' },
  { id: 'long-grass', dir: 'long_grass' },
  { id: 'sand', dir: 'sand' },
  { id: 'rock', dir: 'rock' },
  { id: 'cave', dir: 'cave' },
  { id: 'water', dir: 'water' },
  { id: 'pond', dir: 'pond_water' },
  { id: 'underwater', dir: 'underwater' },
  { id: 'sky', dir: 'sky' },
  { id: 'building', dir: 'building' },
  { id: 'gym', dir: 'building', palette: 'gym' },
  { id: 'leader', dir: 'building', palette: 'leader' },
  { id: 'elite-sidney', dir: 'stadium', palette: 'sidney' },
  { id: 'elite-phoebe', dir: 'stadium', palette: 'phoebe' },
  { id: 'elite-glacia', dir: 'stadium', palette: 'glacia' },
  { id: 'elite-drake', dir: 'stadium', palette: 'drake' },
  { id: 'champion', dir: 'stadium', palette: 'wallace' },
];

/**
 * Which backdrop an area's terrain tags call for, in the order the tags are
 * tried. A tag with no entry falls through to the next one the area carries,
 * and an area whose tags are all unlisted gets the plain grass field.
 */
const TAG_BACKDROPS = {
  water: 'water',
  beach: 'sand',
  desert: 'sand',
  sand: 'sand',
  cave: 'cave',
  mountain: 'rock',
  rough: 'rock',
  volcano: 'rock',
  ash: 'sand',
  ice: 'cave',
  graveyard: 'rock',
  ruins: 'rock',
  sky: 'sky',
  urban: 'building',
  electric: 'building',
  jungle: 'long-grass',
  forest: 'long-grass',
  meadow: 'long-grass',
  rain: 'long-grass',
  grass: 'grass',
  plain: 'grass',
  safari: 'grass',
};

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildBattle({ assetDir, dataDir, log, pool }) {
  /** @type {Record<string, {width: number, height: number}>} */
  const backdrops = {};

  const cache = new Map();
  for (const entry of BACKDROPS) {
    const scene = await loadScene(cache, pool, entry.dir);
    const palette = entry.palette
      ? parseJascPal(await fetchBuffer(`${EMERALD}/graphics/battle_environment/${entry.dir}/${entry.palette}.pal`))
      : scene.palette;
    if (!palette) throw new Error(`Backdrop ${entry.id} has no palette`);

    const image = compose(scene.tiles, scene.map, palette);
    await writeOut(join(assetDir, 'battle', `${entry.id}.png`), encodePng(image.width, image.height, image.data));
    backdrops[entry.id] = { width: image.width, height: image.height };
  }
  log(`backdrops ${Object.keys(backdrops).length}`);

  const badges = await buildBadges(assetDir);
  log(`badges ${badges.length}`);

  const manifest = { backdrops, tags: TAG_BACKDROPS, badges };
  await writeOut(join(dataDir, 'battle.json'), JSON.stringify(manifest));
  return manifest;
}

/**
 * The tiles, tilemap and default palette of one backdrop directory, fetched
 * once however many recolours are built from it.
 */
async function loadScene(cache, pool, dir) {
  const cached = cache.get(dir);
  if (cached) return cached;

  const scene = await pool(async () => {
    const base = `${EMERALD}/graphics/battle_environment/${dir}`;
    const [tiles, map, palette] = await Promise.all([
      fetchBuffer(`${base}/tiles.png`),
      fetchBuffer(`${base}/map.bin`),
      // The Elite Four's room ships no default palette: every one of its
      // chambers is a named recolour, so the entry always names one.
      fetchBuffer(`${base}/palette.pal`, { allowMissing: true }),
    ]);
    return { tiles: sliceTiles(decodePng(tiles)), map, palette: palette ? parseJascPal(palette) : null };
  });

  cache.set(dir, scene);
  return scene;
}

/**
 * Draw the top of the tilemap — the part the message box does not cover — into
 * an RGBA image the width of the window.
 *
 * A screen entry is a tile index, two flip bits and a palette slot. Pixels of
 * index 0 are the transparent colour, which in a battle shows the flat
 * backdrop behind the layer; the palette's first real colour stands in for it,
 * which is what that backdrop is a shade of.
 *
 * @param {Uint8Array[]} tiles
 * @param {Buffer} map
 * @param {Array<[number, number, number]>} palette
 */
function compose(tiles, map, palette) {
  const width = BATTLE_WIDTH;
  const height = BATTLE_HEIGHT;
  const data = new Uint8Array(width * height * 4);
  const backdrop = palette[1] ?? [0, 0, 0];

  for (let row = 0; row * TILE_SIZE < height; row++) {
    for (let column = 0; column < MAP_COLUMNS; column++) {
      const offset = (row * MAP_COLUMNS + column) * 2;
      if (offset + 1 >= map.length) continue;

      const entry = map.readUInt16LE(offset);
      const tile = tiles[entry & 0x3ff] ?? EMPTY_TILE;
      const flipX = (entry >> 10) & 1;
      const flipY = (entry >> 11) & 1;
      const slot = ((entry >> 12) & 0xf) - FIRST_PALETTE_SLOT;

      for (let y = 0; y < TILE_SIZE; y++) {
        const destY = row * TILE_SIZE + y;
        if (destY >= height) break;
        for (let x = 0; x < TILE_SIZE; x++) {
          const destX = column * TILE_SIZE + x;
          if (destX >= width) break;

          const index = tile[(flipY ? TILE_SIZE - 1 - y : y) * TILE_SIZE + (flipX ? TILE_SIZE - 1 - x : x)];
          const color = index === 0 ? backdrop : palette[slot * 16 + index] ?? backdrop;
          const out = (destY * width + destX) * 4;
          data[out] = color[0];
          data[out + 1] = color[1];
          data[out + 2] = color[2];
          data[out + 3] = 255;
        }
      }
    }
  }

  return { width, height, data };
}

const EMPTY_TILE = new Uint8Array(TILE_SIZE * TILE_SIZE);

/**
 * The eight Hoenn badges, cut out of the trainer card sheet and named for the
 * type of the gym that awards them — the game generates leaders for every
 * region, so a badge is identified by type rather than by its own name.
 */
async function buildBadges(assetDir) {
  const sheet = decodePng(await fetchBuffer(`${EMERALD}/graphics/trainer_card/badges.png`));
  const size = sheet.height;
  /** @type {string[]} */
  const built = [];

  for (const [index, type] of HOENN_BADGE_TYPES.entries()) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const source = (y * sheet.width + index * size + x) * 4;
        const out = (y * size + x) * 4;
        data[out] = sheet.data[source];
        data[out + 1] = sheet.data[source + 1];
        data[out + 2] = sheet.data[source + 2];
        // Index 0 is the sheet's transparent colour, as on every GBA sheet.
        data[out + 3] = sheet.indices?.[y * sheet.width + index * size + x] === 0 ? 0 : 255;
      }
    }
    await writeOut(join(assetDir, 'badges', `${type}.png`), encodePng(size, size, data));
    built.push(type);
  }

  return built;
}
