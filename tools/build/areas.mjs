/**
 * Render each shipped area as a seamless scrolling background, one image per
 * time of day, and emit the area manifest the field scene reads.
 */
import { join } from 'node:path';

import { fetchBuffer, fetchJson, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import {
  combineMetatiles,
  combineTilesets,
  METATILE_SIZE,
  parseJascPal,
  renderMap,
  sliceTiles,
  tilesetDirName,
} from '../lib/gba-gfx.mjs';
import { crop, gradeTime, makeSeamless, pickWalkableBand, repeatToWidth, TIME_KEYS } from '../lib/image.mjs';
import { AREAS, BACKGROUND_HEIGHT, EMERALD, POKEAPI, VIEW_WIDTH } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildAreas({ assetDir, dataDir, log, pool }) {
  const layouts = await loadLayouts();
  const encounters = await loadEncounterTables();
  const koreanNames = await loadKoreanLocationNames(pool);
  const tilesetCache = new Map();

  const wantedBlocks = Math.ceil(BACKGROUND_HEIGHT / METATILE_SIZE);
  /** @type {any[]} */
  const manifest = [];

  for (const area of AREAS) {
    const map = await fetchJson(`${EMERALD}/data/maps/${area.dir}/map.json`);
    const layout = layouts.get(map.layout);
    if (!layout) throw new Error(`No layout ${map.layout} for area ${area.id}`);

    const primary = await loadTileset(tilesetCache, pool, 'primary', layout.primary_tileset);
    const secondary = layout.secondary_tileset
      ? await loadTileset(tilesetCache, pool, 'secondary', layout.secondary_tileset)
      : null;

    const tileset = combineTilesets(primary, secondary);
    const metatiles = combineMetatiles(primary.metatiles, secondary ? secondary.metatiles : null);
    const blockdata = await fetchBuffer(`${EMERALD}/${layout.blockdata_filepath}`);

    const rendered = renderMap(blockdata, layout.width, layout.height, tileset, metatiles);
    // Two of the thirty maps are shorter than the window; they give what they
    // have and the field fills the remainder from their own top row.
    const bandBlocks = Math.min(wantedBlocks, layout.height);
    const bandRow = pickWalkableBand(blockdata, layout.width, layout.height, bandBlocks);
    const band = crop(rendered, 0, bandRow * METATILE_SIZE, rendered.width, bandBlocks * METATILE_SIZE);
    const strip = repeatToWidth(makeSeamless(band), VIEW_WIDTH * 2);

    for (const time of TIME_KEYS) {
      const graded = gradeTime(strip, time);
      await writeOut(
        join(assetDir, 'areas', area.id, `${time}.png`),
        encodePng(graded.width, graded.height, graded.data),
      );
    }

    const music = map.music && map.music !== 'MUS_NONE' ? map.music.toLowerCase() : null;
    manifest.push({
      id: area.id,
      name: { ko: koreanNames.get(area.location) ?? titleize(area.location), en: titleize(area.location) },
      tags: area.tags,
      width: strip.width,
      height: strip.height,
      music,
      weather: map.weather ? map.weather.replace('WEATHER_', '').toLowerCase() : 'none',
      encounters: encounters.get(map.id) ?? [],
    });

    log(`area ${area.id.padEnd(18)} ${strip.width}x${strip.height}  music=${music ?? '-'}  mons=${manifest.at(-1).encounters.length}`);
  }

  await writeOut(join(dataDir, 'areas.json'), JSON.stringify(manifest));
  return manifest;
}

/** @returns {Promise<Map<string, any>>} keyed by `LAYOUT_*` id */
async function loadLayouts() {
  const { layouts } = await fetchJson(`${EMERALD}/data/layouts/layouts.json`);
  return new Map(layouts.filter((layout) => layout && layout.id).map((layout) => [layout.id, layout]));
}

/**
 * Land encounter tables from the decompilation, flattened to
 * `{species, minLevel, maxLevel, weight}` per map.
 * @returns {Promise<Map<string, Array<{species: string, minLevel: number, maxLevel: number}>>>}
 */
async function loadEncounterTables() {
  const data = await fetchJson(`${EMERALD}/src/data/wild_encounters.json`);
  const group = data.wild_encounter_groups.find((entry) => entry.label === 'gWildMonHeaders');
  /** @type {Map<string, Array<{species: string, minLevel: number, maxLevel: number}>>} */
  const byMap = new Map();

  for (const entry of group.encounters) {
    /** @type {Map<string, {species: string, minLevel: number, maxLevel: number}>} */
    const merged = new Map();
    for (const field of ['land_mons', 'water_mons', 'rock_smash_mons', 'fishing_mons']) {
      for (const mon of entry[field]?.mons ?? []) {
        // `SPECIES_NIDORAN_F` -> `nidoran-f`, matching PokeAPI's slugs.
        const species = mon.species.replace('SPECIES_', '').toLowerCase().replace(/_/g, '-');
        const existing = merged.get(species);
        if (existing) {
          existing.minLevel = Math.min(existing.minLevel, mon.min_level);
          existing.maxLevel = Math.max(existing.maxLevel, mon.max_level);
        } else {
          merged.set(species, { species, minLevel: mon.min_level, maxLevel: mon.max_level });
        }
      }
    }
    // A map can appear twice (different versions); keep the richer table.
    const previous = byMap.get(entry.map);
    if (!previous || previous.length < merged.size) byMap.set(entry.map, [...merged.values()]);
  }
  return byMap;
}

/**
 * Official Korean location names, which PokeAPI carries for Hoenn.
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @returns {Promise<Map<string, string>>}
 */
async function loadKoreanLocationNames(pool) {
  const wanted = new Set(AREAS.map((area) => area.location));
  const index = await fetchJson(`${POKEAPI}/location/index.json`);
  /** @type {Map<string, string>} */
  const names = new Map();

  await Promise.all(
    index.results
      .filter((entry) => wanted.has(entry.name))
      .map((entry) =>
        pool(async () => {
          const location = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
          const korean = location.names.find((name) => name.language.name === 'ko');
          if (korean) names.set(entry.name, korean.name);
        }),
      ),
  );
  return names;
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
  const palettes = new Array(16);
  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
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

/** `hoenn-route-101` -> `Hoenn Route 101` */
function titleize(slug) {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
