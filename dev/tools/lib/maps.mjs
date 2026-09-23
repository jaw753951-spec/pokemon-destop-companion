/**
 * Drawing a map from the decompilation.
 *
 * A map is a layout — width, height, a block data file and the two tilesets it
 * addresses — and the layouts are listed in one index. Two build steps need
 * the same thing from that: the routes the companion walks along, and the
 * league's rooms. Both get it here, so neither owns the fetching.
 */
import { fetchBuffer, fetchJson } from './http.mjs';
import { decodePng } from './png.mjs';
import {
  combineMetatiles,
  combineTilesets,
  METATILES_IN_PRIMARY,
  parseJascPal,
  renderMap,
  sliceTiles,
  tilesetDirName,
} from './gba-gfx.mjs';
import { EMERALD } from '../sources.mjs';

/** How many palettes a tileset can carry. */
const PALETTE_COUNT = 16;

/**
 * The metatile behaviours the cartridge lets a player surf on
 * (`TILE_FLAG_SURFABLE` in `src/metatile_behavior.c`): ponds, the sea, deep
 * water, waterfalls and currents. Their collision is clear — a Pokémon can
 * cross them, on a Surfer's back — so the collision bits alone let the walk
 * go straight across a lake. Shallow water and puddles are not among them:
 * those are waded, as on the cartridge.
 */
export const SURFABLE_BEHAVIORS = new Set([
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x18, 0x19, 0x1a, 0x22, 0x2a, 0x50, 0x51, 0x52, 0x53, 0x6c, 0x6d, 0x6f,
]);

/**
 * Open the map index, ready to draw any map in it.
 *
 * Tilesets are fetched once however many maps share them, which most of Hoenn
 * does — the thirty areas between them use a handful.
 *
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 */
export async function openMaps(pool) {
  const { layouts } = await fetchJson(`${EMERALD}/data/layouts/layouts.json`);
  const index = new Map(layouts.filter((layout) => layout && layout.id).map((layout) => [layout.id, layout]));
  const cache = new Map();

  return {
    /**
     * Draw one map, and hand back what it was drawn from.
     *
     * @param {string} dir the map's directory, such as `Route101`
     * @returns {Promise<{
     *   map: any,
     *   layout: any,
     *   blockdata: Buffer,
     *   image: {width: number, height: number, data: Uint8Array},
     *   isWater: (x: number, y: number) => boolean,
     * }>}
     */
    async render(dir) {
      const map = await fetchJson(`${EMERALD}/data/maps/${dir}/map.json`);
      const layout = index.get(map.layout);
      if (!layout) throw new Error(`No layout ${map.layout} for map ${dir}`);

      const primary = await loadTileset(cache, pool, 'primary', layout.primary_tileset);
      const secondary = layout.secondary_tileset
        ? await loadTileset(cache, pool, 'secondary', layout.secondary_tileset)
        : null;

      const tileset = combineTilesets(primary, secondary);
      const metatiles = combineMetatiles(primary.metatiles, secondary ? secondary.metatiles : null);
      const blockdata = await fetchBuffer(`${EMERALD}/${layout.blockdata_filepath}`);

      // A block's behaviour lives with its metatile, in whichever tileset the
      // metatile's number falls in: the primary's first, then the secondary's.
      const behaviorOf = (metatileId) => {
        const [attributes, index] =
          metatileId < METATILES_IN_PRIMARY
            ? [primary.attributes, metatileId]
            : [secondary?.attributes ?? null, metatileId - METATILES_IN_PRIMARY];
        if (!attributes || (index + 1) * 2 > attributes.length) return 0;
        return attributes.readUInt16LE(index * 2) & 0xff;
      };
      const isWater = (x, y) => {
        const offset = (y * layout.width + x) * 2;
        if (x < 0 || y < 0 || x >= layout.width || offset + 1 >= blockdata.length) return false;
        return SURFABLE_BEHAVIORS.has(behaviorOf(blockdata.readUInt16LE(offset) & 0x3ff));
      };

      return {
        map,
        layout,
        blockdata,
        image: renderMap(blockdata, layout.width, layout.height, tileset, metatiles),
        isWater,
      };
    },
  };
}

/**
 * @param {Map<string, any>} cache
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @param {'primary'|'secondary'} role
 * @param {string} symbol
 */
async function loadTileset(cache, pool, role, symbol) {
  const key = `${role}/${symbol}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const base = `${EMERALD}/data/tilesets/${role}/${tilesetDirName(symbol)}`;
  const tiles = sliceTiles(decodePng(await fetchBuffer(`${base}/tiles.png`)));

  /** @type {Array<Array<[number, number, number]>>} */
  const palettes = new Array(PALETTE_COUNT);
  await Promise.all(
    Array.from({ length: PALETTE_COUNT }, (_, index) =>
      pool(async () => {
        const file = await fetchBuffer(`${base}/palettes/${String(index).padStart(2, '0')}.pal`, {
          allowMissing: true,
        });
        if (file) palettes[index] = parseJascPal(file);
      }),
    ),
  );

  const tileset = {
    tiles,
    palettes,
    metatiles: await fetchBuffer(`${base}/metatiles.bin`),
    // One u16 per metatile, its behaviour in the low byte.
    attributes: await fetchBuffer(`${base}/metatile_attributes.bin`, { allowMissing: true }),
  };
  cache.set(key, tileset);
  return tileset;
}
