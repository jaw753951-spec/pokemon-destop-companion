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
import { combineMetatiles, combineTilesets, parseJascPal, renderMap, sliceTiles, tilesetDirName } from './gba-gfx.mjs';
import { EMERALD } from '../sources.mjs';

/** How many palettes a tileset can carry. */
const PALETTE_COUNT = 16;

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

      return { map, layout, blockdata, image: renderMap(blockdata, layout.width, layout.height, tileset, metatiles) };
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

  const tileset = { tiles, palettes, metatiles: await fetchBuffer(`${base}/metatiles.bin`) };
  cache.set(key, tileset);
  return tileset;
}
