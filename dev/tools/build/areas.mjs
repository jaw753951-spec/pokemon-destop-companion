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
    const { map, layout, blockdata, image: rendered, over, isWater } = await maps.render(area.dir);
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

    // Whatever the map draws over the lane itself — Route 110's Cycling Road
    // crossing overhead — is cut out as a layer of its own, so the field can
    // draw it over the companion and the companion walks under the bridge
    // rather than across the top of it. Only a bridge's columns are kept; see
    // `OVERPASS_BLOCKS` for what else is on that layer and why it is not.
    const overBand = crop(
      over,
      path.column * METATILE_SIZE,
      path.bandRow * METATILE_SIZE,
      path.columns * METATILE_SIZE,
      bandBlocks * METATILE_SIZE,
    );
    const overhead = keepOverLane(overBand, groundY);
    const overStrip = overhead ? repeatToWidth(makeSeamless(overhead), FIELD_WIDTH * 2) : null;
    const covered = overStrip ? coveredSpans(overStrip, groundY) : [];

    for (const time of TIME_KEYS) {
      const graded = gradeTime(strip, time);
      await writeOut(
        join(assetDir, 'areas', area.id, `${time}.png`),
        encodePng(graded.width, graded.height, graded.data),
      );
      if (overStrip) {
        const gradedOver = gradeTime(overStrip, time);
        await writeOut(
          join(assetDir, 'areas', area.id, `${time}-over.png`),
          encodePng(gradedOver.width, gradedOver.height, gradedOver.data),
        );
      }
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
      // Stretches of the strip, in its own pixels, where something is drawn
      // over the lane; see `overhead` above.
      ...(covered.length ? { overlay: true, covered } : {}),
      music,
      weather: map.weather ? map.weather.replace('WEATHER_', '').toLowerCase() : 'none',
      encounters: encounters.get(map.id) ?? [],
    });

    log(
      `area ${area.id.padEnd(18)} ${strip.width}x${strip.height}  ground=${groundY}  ` +
        `walk=${path.columns} blocks @row ${path.laneRow} (headroom ${path.clearance})  ` +
        `music=${music ?? '-'}  mons=${manifest.at(-1).encounters.length}` +
        (covered.length ? `  covered=${covered.map(([from, to]) => `${from}-${to}`).join(',')}` : ''),
    );
  }

  await writeOut(join(dataDir, 'areas.json'), JSON.stringify(manifest));
  return manifest;
}

/**
 * How many blocks, from the lane up, an overpass has to fill before the field
 * draws it over the companion.
 *
 * The layer above the sprites holds more than bridges: a tree's crown is on
 * it, which is how a player in the games walks behind the top of a tree, and
 * several lanes run along a row of crowns. Drawn over the companion those
 * would hide it every few steps for no reason anyone could see. A bridge is
 * the thing that is solid all the way up the band — Route 110's Cycling Road
 * crosses the whole window — so only a column solid for this many blocks is
 * taken to be one.
 */
const OVERPASS_BLOCKS = 4;

/** How much of a block has to be drawn for it to count as solid overhead. */
const OVERPASS_FILL = 0.6;

/**
 * The part of a map's over-the-sprites layer that is a bridge over the lane.
 *
 * A block column is kept, top to bottom, when its layer is solid from the
 * block the companion's feet stand in up through {@link OVERPASS_BLOCKS}
 * blocks; every other column is cleared.
 *
 * @param {import('../lib/image.mjs').Raster} over
 * @param {number} groundY the bottom edge of the lane's row, in the band
 * @returns {import('../lib/image.mjs').Raster|null} null when nothing crosses it
 */
function keepOverLane(over, groundY) {
  const drawnIn = (column, bottom) => {
    let drawn = 0;
    for (let y = bottom - METATILE_SIZE; y < bottom; y++) {
      for (let x = column; x < column + METATILE_SIZE; x++) {
        if (y >= 0 && over.data[(y * over.width + x) * 4 + 3] > 0) drawn++;
      }
    }
    return drawn / (METATILE_SIZE * METATILE_SIZE);
  };
  const columns = Math.floor(over.width / METATILE_SIZE);
  const deck = Array.from({ length: columns }, (_, index) => {
    for (let block = 0; block < OVERPASS_BLOCKS; block++) {
      if (drawnIn(index * METATILE_SIZE, groundY - block * METATILE_SIZE) < OVERPASS_FILL) return false;
    }
    return true;
  });
  // The railings either side of the deck are thinner than the deck, and are
  // as much the bridge as it is.
  const keep = deck.map(
    (isDeck, index) =>
      isDeck || ((deck[index - 1] || deck[index + 1]) && drawnIn(index * METATILE_SIZE, groundY) > 0),
  );
  if (!keep.some(Boolean)) return null;
  keep.forEach((kept, index) => {
    if (kept) return;
    for (let y = 0; y < over.height; y++) {
      for (let x = index * METATILE_SIZE; x < (index + 1) * METATILE_SIZE; x++) over.data[(y * over.width + x) * 4 + 3] = 0;
    }
  });
  return over;
}

/**
 * The stretches of a finished overlay strip that cover the lane, as
 * `[from, to)` pixel spans.
 *
 * @param {import('../lib/image.mjs').Raster} strip
 * @param {number} groundY
 * @returns {Array<[number, number]>}
 */
function coveredSpans(strip, groundY) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  let start = -1;
  for (let x = 0; x <= strip.width; x++) {
    let covers = false;
    for (let y = groundY - METATILE_SIZE; x < strip.width && y < groundY && !covers; y++) {
      covers = strip.data[(y * strip.width + x) * 4 + 3] > 0;
    }
    if (covers && start < 0) start = x;
    if (!covers && start >= 0) {
      spans.push([start, x]);
      start = -1;
    }
  }
  return spans;
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
 * Encounter tables from the decompilation, flattened to
 * `{species, minLevel, maxLevel, weight}` per map, `weight` being the
 * species' share of the map's encounters in per cent.
 *
 * The share is the cartridge's own: a table is twelve land slots at 20, 20,
 * 10, 10, 10, 10, 5, 5, 4, 4, 1 and 1 per cent, and a species is the sum of
 * the slots it fills. This used to keep only the list of species, so every
 * Pokémon a map named was drawn as often as every other — Route 113's
 * Skarmory, one slot in twenty, as often as its Spinda, seven in ten.
 *
 * Only the Pokémon met walking count where a map has any: the companion
 * keeps to the ground, so what lives in the water or under a rod is not on
 * its road. A map with no ground table at all — a sea route, a flooded
 * cave's mouth — falls back on surfing and fishing, half and half.
 *
 * Fire Red files each map twice, once per version; the two are merged, so a
 * route has both games' Pokémon on it, each version's table counting for
 * half.
 *
 * @param {string} base the decompilation's URL
 * @returns {Promise<Map<string, Array<{species: string, minLevel: number, maxLevel: number, weight: number}>>>}
 */
async function loadEncounterTables(base) {
  const data = await fetchJson(`${base}/src/data/wild_encounters.json`);
  const group = data.wild_encounter_groups.find((entry) => entry.label === 'gWildMonHeaders');
  /** @type {Record<string, number[]>} each method's slot rates, in per cent */
  const rates = Object.fromEntries(group.fields.map((field) => [field.type, field.encounter_rates]));

  /** @type {Map<string, Map<string, {species: string, minLevel: number, maxLevel: number, weight: number}>>} */
  const byMap = new Map();
  /** @type {Map<string, number>} how many tables each map has, so versions share it */
  const tables = new Map();

  for (const entry of group.encounters) {
    const methods = entry.land_mons ? ['land_mons'] : ['water_mons', 'fishing_mons'].filter((field) => entry[field]);
    if (!methods.length) continue;
    const merged = byMap.get(entry.map) ?? new Map();
    byMap.set(entry.map, merged);
    tables.set(entry.map, (tables.get(entry.map) ?? 0) + 1);

    for (const field of methods) {
      const slots = entry[field].mons ?? [];
      const slotRates = rates[field] ?? [];
      // Fishing's rates are three rods' worth, each summing to a hundred.
      const total = slotRates.slice(0, slots.length).reduce((sum, rate) => sum + rate, 0) || 1;
      slots.forEach((mon, slot) => {
        // `SPECIES_NIDORAN_F` -> `nidoran-f`, matching PokeAPI's slugs.
        const species = mon.species.replace('SPECIES_', '').toLowerCase().replace(/_/g, '-');
        const share = ((slotRates[slot] ?? 0) / total) * (100 / methods.length);
        const existing = merged.get(species);
        if (existing) {
          existing.minLevel = Math.min(existing.minLevel, mon.min_level);
          existing.maxLevel = Math.max(existing.maxLevel, mon.max_level);
          existing.weight += share;
        } else {
          merged.set(species, { species, minLevel: mon.min_level, maxLevel: mon.max_level, weight: share });
        }
      });
    }
  }

  /** @type {Map<string, Array<{species: string, minLevel: number, maxLevel: number, weight: number}>>} */
  const out = new Map();
  for (const [map, merged] of byMap) {
    const versions = tables.get(map) ?? 1;
    out.set(
      map,
      [...merged.values()]
        .map((mon) => ({ ...mon, weight: Math.round((mon.weight / versions) * 100) / 100 }))
        .sort((a, b) => b.weight - a.weight),
    );
  }
  return out;
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
