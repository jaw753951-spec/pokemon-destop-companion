/**
 * Render each shipped area as a seamless scrolling background, one image per
 * time of day, and emit the area manifest the field scene reads.
 */
import { join } from 'node:path';

import { fetchJson, writeOut } from '../lib/http.mjs';
import { encodePng } from '../lib/png.mjs';
import { METATILE_SIZE } from '../lib/gba-gfx.mjs';
import { openMaps } from '../lib/maps.mjs';
import { crop, gradeTime, makeSeamless, pickWalkPath, repeatToWidth, TIME_KEYS } from '../lib/image.mjs';
import { nameBundle } from '../lib/poke.mjs';
import { AREAS, BACKGROUND_HEIGHT, EMERALD, FIELD_WIDTH, FIRERED, POKEAPI } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildAreas({ assetDir, dataDir, log, pool }) {
  // One map index and one encounter table per decompilation an area comes
  // from, opened the first time an area asks for it.
  /** @type {Map<string, Promise<any>>} */
  const mapsByGame = new Map();
  /** @type {Map<string, Promise<Map<string, any[]>>>} */
  const encountersByGame = new Map();
  const mapsFor = (game) => {
    if (!mapsByGame.has(game)) mapsByGame.set(game, openMaps(pool, game));
    return /** @type {Promise<any>} */ (mapsByGame.get(game));
  };
  const encountersFor = (game) => {
    if (!encountersByGame.has(game)) encountersByGame.set(game, loadEncounterTables(game === 'firered' ? FIRERED : EMERALD));
    return /** @type {Promise<Map<string, any[]>>} */ (encountersByGame.get(game));
  };
  const locationNames = await loadLocationNames(pool);

  const wantedBlocks = Math.ceil(BACKGROUND_HEIGHT / METATILE_SIZE);
  /** @type {any[]} */
  const manifest = [];

  for (const area of AREAS) {
    const game = area.game ?? 'emerald';
    const maps = await mapsFor(game);
    const encounters = await encountersFor(game);
    const { map, layout, blockdata, image: rendered, isWater } = await maps.render(area.dir);
    // Two of the thirty maps are shorter than the window; they give what they
    // have and the field fills the remainder from their own top row.
    const bandBlocks = Math.min(wantedBlocks, layout.height);
    // The walk decides the crop, rather than the crop deciding the walk: the
    // strip is cut to a stretch of map the companion can cross end to end, so
    // the loop it walks has no hillside or tree in it at any point. See
    // `pickWalkPath` for why a whole-width strip could not manage that.
    const path = pickWalkPath(blockdata, layout.width, layout.height, bandBlocks, isWater);
    const band = crop(
      rendered,
      path.column * METATILE_SIZE,
      path.bandRow * METATILE_SIZE,
      path.columns * METATILE_SIZE,
      bandBlocks * METATILE_SIZE,
    );
    const strip = repeatToWidth(makeSeamless(band), FIELD_WIDTH * 2);
    // Where the companion's feet go within the strip: the bottom edge of the
    // lane whose blocks are clear, rather than a fixed fraction of the window.
    const groundY = Math.min(strip.height, (path.laneRow - path.bandRow + 1) * METATILE_SIZE);

    for (const time of TIME_KEYS) {
      const graded = gradeTime(strip, time);
      await writeOut(
        join(assetDir, 'areas', area.id, `${time}.png`),
        encodePng(graded.width, graded.height, graded.data),
      );
    }

    const music = musicFor(map.music, game);
    const name = nameBundle(locationNames.get(area.location) ?? [], titleize(area.location));
    // PokeAPI has no Korean for Kanto; the area says the official name itself.
    if (area.ko) name.ko = area.ko;
    manifest.push({
      id: area.id,
      name,
      region: area.region ?? 'hoenn',
      tags: area.tags,
      width: strip.width,
      height: strip.height,
      groundY,
      music,
      weather: map.weather ? map.weather.replace('WEATHER_', '').toLowerCase() : 'none',
      encounters: encounters.get(map.id) ?? [],
    });

    log(
      `area ${area.id.padEnd(18)} ${strip.width}x${strip.height}  ground=${groundY}  ` +
        `walk=${path.columns} blocks @row ${path.laneRow} (headroom ${path.clearance})  ` +
        `music=${music ?? '-'}  mons=${manifest.at(-1).encounters.length}`,
    );
  }

  await writeOut(join(dataDir, 'areas.json'), JSON.stringify(manifest));
  return manifest;
}

/**
 * The track a map plays, as the audio step names it.
 *
 * Emerald's own maps name their tracks directly. Fire Red's name Fire Red's
 * — `MUS_ROUTE1` — and Emerald's sound folder carries the same songs under an
 * `mus_rg_` prefix, which is where the audio step fetches every track from.
 *
 * @param {string|undefined} constant
 * @param {string} game
 */
function musicFor(constant, game) {
  if (!constant || constant === 'MUS_NONE') return null;
  const name = constant.toLowerCase();
  return game === 'firered' ? name.replace(/^mus_/, 'mus_rg_') : name;
}

/**
 * Land encounter tables from the decompilation, flattened to
 * `{species, minLevel, maxLevel, weight}` per map.
 *
 * Fire Red files each map twice, once per version; the two are merged, so a
 * route has both games' Pokémon on it.
 *
 * @param {string} base the decompilation's URL
 * @returns {Promise<Map<string, Array<{species: string, minLevel: number, maxLevel: number}>>>}
 */
async function loadEncounterTables(base) {
  const data = await fetchJson(`${base}/src/data/wild_encounters.json`);
  const group = data.wild_encounter_groups.find((entry) => entry.label === 'gWildMonHeaders');
  /** @type {Map<string, Array<{species: string, minLevel: number, maxLevel: number}>>} */
  const byMap = new Map();

  for (const entry of group.encounters) {
    /** @type {Map<string, {species: string, minLevel: number, maxLevel: number}>} */
    const merged = new Map((byMap.get(entry.map) ?? []).map((mon) => [mon.species, { ...mon }]));
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
    // A map can appear twice (different versions); both tables are kept.
    byMap.set(entry.map, [...merged.values()]);
  }
  return byMap;
}

/**
 * The official name of each shipped location in every language PokeAPI has one
 * for, left as PokeAPI's own list so the caller can bundle it against the right
 * fallback. Hoenn is the region with the widest coverage, which is why the game
 * stays in it.
 *
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @returns {Promise<Map<string, Array<{name: string, language: {name: string}}>>>}
 */
async function loadLocationNames(pool) {
  const wanted = new Set(AREAS.map((area) => area.location));
  const index = await fetchJson(`${POKEAPI}/location/index.json`);
  /** @type {Map<string, Array<{name: string, language: {name: string}}>>} */
  const names = new Map();

  await Promise.all(
    index.results
      .filter((entry) => wanted.has(entry.name))
      .map((entry) =>
        pool(async () => {
          const location = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
          names.set(entry.name, location.names ?? []);
        }),
      ),
  );
  return names;
}

/** `hoenn-route-101` -> `Hoenn Route 101` */
function titleize(slug) {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
