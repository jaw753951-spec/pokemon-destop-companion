/**
 * Render each shipped area as a seamless scrolling background, one image per
 * time of day, and emit the area manifest the field scene reads.
 */
import { join } from 'node:path';

import { fetchJson, writeOut } from '../lib/http.mjs';
import { encodePng } from '../lib/png.mjs';
import { METATILE_SIZE } from '../lib/gba-gfx.mjs';
import { openMaps } from '../lib/maps.mjs';
import { crop, gradeTime, makeSeamless, pickWalkableBand, pickWalkLane, repeatToWidth, TIME_KEYS } from '../lib/image.mjs';
import { nameBundle } from '../lib/poke.mjs';
import { AREAS, BACKGROUND_HEIGHT, EMERALD, FIELD_WIDTH, POKEAPI } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildAreas({ assetDir, dataDir, log, pool }) {
  const maps = await openMaps(pool);
  const encounters = await loadEncounterTables();
  const locationNames = await loadLocationNames(pool);

  const wantedBlocks = Math.ceil(BACKGROUND_HEIGHT / METATILE_SIZE);
  /** @type {any[]} */
  const manifest = [];

  for (const area of AREAS) {
    const { map, layout, blockdata, image: rendered } = await maps.render(area.dir);
    // Two of the thirty maps are shorter than the window; they give what they
    // have and the field fills the remainder from their own top row.
    const bandBlocks = Math.min(wantedBlocks, layout.height);
    const bandRow = pickWalkableBand(blockdata, layout.width, layout.height, bandBlocks);
    const band = crop(rendered, 0, bandRow * METATILE_SIZE, rendered.width, bandBlocks * METATILE_SIZE);
    const strip = repeatToWidth(makeSeamless(band), FIELD_WIDTH * 2);
    // Where the companion's feet go within the strip: the bottom edge of the
    // lane whose blocks are clear, rather than a fixed fraction of the window.
    const laneRow = pickWalkLane(blockdata, layout.width, bandRow, bandBlocks);
    const groundY = Math.min(strip.height, (laneRow - bandRow + 1) * METATILE_SIZE);

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
      name: nameBundle(locationNames.get(area.location) ?? [], titleize(area.location)),
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
        `music=${music ?? '-'}  mons=${manifest.at(-1).encounters.length}`,
    );
  }

  await writeOut(join(dataDir, 'areas.json'), JSON.stringify(manifest));
  return manifest;
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
