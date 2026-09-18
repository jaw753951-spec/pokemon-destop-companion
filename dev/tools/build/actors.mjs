/**
 * Extract the Gen-3 overworld and battle art for everything that is not a
 * Pokémon: trainers, berry trees and the item ball the pickup event spawns.
 *
 * GBA sprite sheets mark transparency with palette entry 0 rather than an
 * alpha channel, and pack their frames as a single column-major strip, so each
 * sheet is keyed out and re-cut to the frame size its caller expects.
 */
import { join } from 'node:path';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, keyOut, opaqueBounds } from '../lib/image.mjs';
import { METATILE_SIZE } from '../lib/gba-gfx.mjs';
import { openMaps } from '../lib/maps.mjs';
import { CRYSTAL, EMERALD, FIRERED, NAMED_PORTRAITS } from '../sources.mjs';

/** Overworld people sheets are 16x32 frames; battle portraits are 64x64. */
const PERSON_FRAME = { width: 16, height: 32 };

/**
 * Frame indices within a 9-frame overworld sheet. East is drawn by mirroring
 * the west frames, exactly as the games do.
 */
const PERSON_FRAMES = { south: 0, north: 1, west: 2, walkWest: [7, 8] };

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildActors({ assetDir, dataDir, log, pool }) {
  const portraits = await buildTrainerPortraits(assetDir, pool, log);
  const overworld = await buildOverworldPeople(assetDir, pool, log);
  const props = await buildProps(assetDir, pool, log);

  const manifest = { portraits, overworld, props };
  await writeOut(join(dataDir, 'actors.json'), JSON.stringify(manifest));
  return manifest;
}

/**
 * Battle portraits for every trainer class and named trainer, including the
 * gym leaders. The decompilation's graphics header is the authoritative list.
 */
async function buildTrainerPortraits(assetDir, pool, log) {
  const header = (await fetchBuffer(`${EMERALD}/src/data/graphics/trainers.h`)).toString('utf8');
  const names = [
    ...new Set([...header.matchAll(/graphics\/trainers\/front_pics\/([a-z0-9_]+)\.png/g)].map((m) => m[1])),
  ];

  /** @type {Record<string, {width: number, height: number}>} */
  const out = {};
  await Promise.all(
    names.map((name) =>
      pool(async () => {
        const source = await fetchBuffer(`${EMERALD}/graphics/trainers/front_pics/${name}.png`, {
          allowMissing: true,
        });
        if (!source) return;
        const trimmed = trimKeyed(decodePng(source));
        if (!trimmed) return;
        await writeOut(
          join(assetDir, 'trainers', 'portraits', `${name}.png`),
          encodePng(trimmed.width, trimmed.height, trimmed.data),
        );
        out[name] = { width: trimmed.width, height: trimmed.height };
      }),
    ),
  );

  const named = await buildNamedPortraits(assetDir, pool);
  Object.assign(out, named);

  log(`trainer portraits ${Object.keys(out).length}/${names.length + Object.keys(named).length}`);
  return out;
}

/**
 * The people the league sends out, from whichever game drew them.
 *
 * Only Hoenn's champions are in this decompilation, and the game picks its
 * Elite Four from every region there is a roster for. The two Kanto-era
 * decompilations cover several of the rest — Fire Red draws them in the same
 * hand as everything else here, and Crystal draws the two nobody else does, in
 * four colours and proud of it. Everyone still missing falls back to a trainer
 * class of their speciality, which the league screen does at draw time.
 */
async function buildNamedPortraits(assetDir, pool) {
  const roots = { emerald: EMERALD, firered: FIRERED, crystal: CRYSTAL };

  /** @type {Record<string, {width: number, height: number}>} */
  const out = {};
  await Promise.all(
    Object.entries(NAMED_PORTRAITS).map(([id, { source, path }]) =>
      pool(async () => {
        const file = await fetchBuffer(`${roots[source]}/${path}`, { allowMissing: true });
        if (!file) return;
        const trimmed = trimKeyed(decodePng(file));
        if (!trimmed) return;
        await writeOut(
          join(assetDir, 'trainers', 'portraits', `${id}.png`),
          encodePng(trimmed.width, trimmed.height, trimmed.data),
        );
        out[id] = { width: trimmed.width, height: trimmed.height };
      }),
    ),
  );
  return out;
}

/**
 * Walking sprites for the trainer classes that appear on the field. Each entry
 * becomes a two-frame westward walk plus a standing frame.
 */
async function buildOverworldPeople(assetDir, pool, log) {
  const header = (await fetchBuffer(`${EMERALD}/src/data/object_events/object_event_graphics.h`)).toString('utf8');
  const paths = [
    ...new Set(
      [...header.matchAll(/graphics\/object_events\/pics\/people\/([a-z0-9_/]+)\.png/g)].map((m) => m[1]),
    ),
  ];

  /** @type {Record<string, {width: number, height: number, frames: number}>} */
  const out = {};
  await Promise.all(
    paths.map((path) =>
      pool(async () => {
        const source = await fetchBuffer(`${EMERALD}/graphics/object_events/pics/people/${path}.png`, {
          allowMissing: true,
        });
        if (!source) return;
        const sheet = keyed(decodePng(source));
        const layout = frameLayout(sheet, PERSON_FRAME.width, PERSON_FRAME.height);
        if (layout.count < 9) return;

        const frames = [PERSON_FRAMES.west, ...PERSON_FRAMES.walkWest].map((index) =>
          cropFrame(sheet, layout, index),
        );
        const strip = concatX(frames);
        const id = path.replace(/\//g, '_');
        await writeOut(
          join(assetDir, 'trainers', 'field', `${id}.png`),
          encodePng(strip.width, strip.height, strip.data),
        );
        out[id] = { width: PERSON_FRAME.width, height: PERSON_FRAME.height, frames: frames.length };
      }),
    ),
  );

  log(`trainer field sprites ${Object.keys(out).length}/${paths.length}`);
  return out;
}

/**
 * Berry trees (one sheet per berry, three growth stages) and the item ball,
 * which the berry and item events spawn on the field.
 */
async function buildProps(assetDir, pool, log) {
  const header = (await fetchBuffer(`${EMERALD}/src/data/object_events/object_event_graphics.h`)).toString('utf8');
  const berries = [
    ...new Set(
      [...header.matchAll(/graphics\/object_events\/pics\/berry_trees\/([a-z0-9_]+)\.png/g)].map((m) => m[1]),
    ),
  ].filter((name) => !STAGE_SHEETS.has(name));

  /** @type {{berryTrees: Record<string, any>, stages: Record<string, any>, ball: any, center: any}} */
  const out = { berryTrees: {}, stages: {}, ball: null, center: null };

  await Promise.all([
    ...berries.map((name) =>
      pool(async () => {
        const source = await fetchBuffer(`${EMERALD}/graphics/object_events/pics/berry_trees/${name}.png`, {
          allowMissing: true,
        });
        if (!source) return;
        const sheet = keyed(decodePng(source));
        // A berry sheet holds the tree's growth stages as 16x32 frames; the
        // last one is the ripe tree the harvest event picks from.
        const frameCount = frameLayout(sheet, 16, 32).count;
        await writeOut(
          join(assetDir, 'props', 'berry-trees', `${name}.png`),
          encodePng(sheet.width, sheet.height, sheet.data),
        );
        out.berryTrees[name] = { width: sheet.width, height: sheet.height, frames: frameCount };
      }),
    ),
    ...[...STAGE_SHEETS].map((name) =>
      pool(async () => {
        const source = await fetchBuffer(`${EMERALD}/graphics/object_events/pics/berry_trees/${name}.png`, {
          allowMissing: true,
        });
        if (!source) return;
        const sheet = keyed(decodePng(source));
        await writeOut(
          join(assetDir, 'props', 'berry-trees', `${name}.png`),
          encodePng(sheet.width, sheet.height, sheet.data),
        );
        out.stages[name] = { width: sheet.width, height: sheet.height };
      }),
    ),
    pool(async () => {
      const source = await fetchBuffer(`${EMERALD}/graphics/object_events/pics/misc/item_ball.png`);
      const sheet = keyed(decodePng(source));
      await writeOut(join(assetDir, 'props', 'item-ball.png'), encodePng(sheet.width, sheet.height, sheet.data));
      out.ball = { width: sheet.width, height: sheet.height };
    }),
  ]);

  out.center = await buildPokemonCenter(assetDir, pool);

  log(
    `props: ${Object.keys(out.berryTrees).length} berry trees, ${Object.keys(out.stages).length} growth stages` +
      `${out.center ? ', a Pokémon Center' : ''}`,
  );
  return out;
}

/**
 * How a sheet is cut into frames. Decomp sheets are row-major: a sheet wider
 * than one frame lays them out horizontally, otherwise vertically.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function frameLayout(sheet, frameWidth, frameHeight) {
  const columns = Math.max(1, Math.floor(sheet.width / frameWidth));
  const rows = Math.max(1, Math.floor(sheet.height / frameHeight));
  return { columns, rows, frameWidth, frameHeight, count: columns * rows };
}

/**
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {ReturnType<typeof frameLayout>} layout
 * @param {number} index
 */
function cropFrame(sheet, layout, index) {
  const column = index % layout.columns;
  const row = Math.floor(index / layout.columns);
  return crop(sheet, column * layout.frameWidth, row * layout.frameHeight, layout.frameWidth, layout.frameHeight);
}

/** Shared growth-stage art that is not tied to a particular berry. */
/**
 * The Pokémon Center the rest stop plays out at, cut out of a real town.
 *
 * There is no standalone sprite of one: a Center is part of the town it stands
 * in, drawn from the same metatiles as the road outside it. So a town is
 * rendered and the building cut out of it — located by the warp that leads
 * inside, which is the door, rather than by coordinates copied off a map.
 *
 * The door is a sprite, though: the games animate it over the map, three
 * frames from shut to open, which is exactly what a Pokémon walking in needs.
 *
 * @param {string} assetDir
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 */
async function buildPokemonCenter(assetDir, pool) {
  const maps = await openMaps(pool);
  const { map, image } = await maps.render(CENTER_TOWN);

  const warp = (map.warp_events ?? []).find((event) => String(event.dest_map).includes('POKEMON_CENTER'));
  if (!warp) return null;

  // The building around its door: two blocks either side, and four above.
  const left = (Number(warp.x) - 2) * METATILE_SIZE;
  const top = (Number(warp.y) - 4) * METATILE_SIZE;
  const building = crop(image, left, top, 5 * METATILE_SIZE, 5 * METATILE_SIZE);
  await writeOut(
    join(assetDir, 'props', 'poke-center.png'),
    encodePng(building.width, building.height, building.data),
  );

  // The door's frames, laid out along a strip like every other animation here.
  const sheet = keyed(decodePng(await fetchBuffer(`${EMERALD}/graphics/door_anims/poke_center.png`)));
  const layout = frameLayout(sheet, DOOR_FRAME.width, DOOR_FRAME.height);
  const frames = Array.from({ length: layout.count }, (_, index) => cropFrame(sheet, layout, index));
  const strip = concatX(frames);
  await writeOut(join(assetDir, 'props', 'poke-center-door.png'), encodePng(strip.width, strip.height, strip.data));

  return {
    width: building.width,
    height: building.height,
    door: {
      // Where the door sits inside the building, so the frames land on it.
      x: 2 * METATILE_SIZE,
      y: building.height - DOOR_FRAME.height,
      width: DOOR_FRAME.width,
      height: DOOR_FRAME.height,
      frames: frames.length,
    },
  };
}

/** The town the Pokémon Center is cut from: the first one the game shows you. */
const CENTER_TOWN = 'OldaleTown';

/** A door animation frame: one tile wide, two tall, as every Gen-3 door is. */
const DOOR_FRAME = { width: 16, height: 32 };

const STAGE_SHEETS = new Set(['sprout', 'dirt_pile']);

/**
 * GBA sprite sheets use palette index 0 as transparency; that colour is the
 * first entry of the PNG's own palette.
 * @param {import('../lib/png.mjs').DecodedPng} png
 */
function keyed(png) {
  const key = png.palette?.[0] ?? [0, 0, 0];
  return keyOut({ width: png.width, height: png.height, data: png.data }, key);
}

/** @param {import('../lib/png.mjs').DecodedPng} png */
function trimKeyed(png) {
  const raster = keyed(png);
  const bounds = opaqueBounds(raster);
  if (!bounds) return null;
  return crop(raster, bounds.x, bounds.y, bounds.width, bounds.height);
}
