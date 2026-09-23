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
        // A child, a Tuber, a Ninja Boy is a 16x16 sprite, and its sheet is a
        // single row of them. Cut as 16x32, each frame was the child with an
        // empty tile under it, and the trainer stood a tile above the road.
        const frameHeight = Math.min(PERSON_FRAME.height, sheet.height);
        const layout = frameLayout(sheet, PERSON_FRAME.width, frameHeight);
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
        out[id] = { width: PERSON_FRAME.width, height: frameHeight, frames: frames.length };
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
        // A berry sheet holds the tree's growth stages as 16x32 frames: two
        // per stage, for the grown tree, the tree in flower and the tree in
        // fruit. See BERRY_STAGES in the field-events scene, which reads them.
        const layout = frameLayout(sheet, 16, 32);
        await writeOut(
          join(assetDir, 'props', 'berry-trees', `${name}.png`),
          encodePng(sheet.width, sheet.height, sheet.data),
        );
        out.berryTrees[name] = {
          width: sheet.width,
          height: sheet.height,
          frames: layout.count,
          // What the frames are, checked rather than assumed: a sheet the
          // decompilation cuts differently, or one whose fruit stage is the
          // same picture as its flowering stage — a tree with no berries on
          // it — is reported instead of shipped as a berry tree that is bare
          // when the companion walks up to pick from it.
          fruit: fruitFrames(sheet, layout),
          picked: pickedFrames(sheet, layout),
        };
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

  const bare = Object.entries(out.berryTrees)
    .filter(([, tree]) => !tree.fruit)
    .map(([name]) => name);
  log(
    `props: ${Object.keys(out.berryTrees).length} berry trees, ${Object.keys(out.stages).length} growth stages` +
      `${out.center ? ', a Pokémon Center' : ''}`,
  );
  if (bare.length) log(`  berry trees with nothing on them: ${bare.join(', ')}`);
  return out;
}

/**
 * Which frames of a berry sheet are the tree in fruit, or null if none are.
 *
 * Emerald lays a berry sheet out as three two-frame stages — grown, flowering,
 * fruiting — and the renderer needs the last pair. "The last two frames" is
 * only true while a sheet has exactly six, and "it has fruit on it" is not
 * true at all unless the fruiting frames differ from the flowering ones. Both
 * are checked here, once, at build time, so a berry tree that would be drawn
 * bare is a line in the build log rather than something a player finds.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {ReturnType<typeof frameLayout>} layout
 * @returns {[number, number]|null}
 */
function fruitFrames(sheet, layout) {
  if (layout.count < BERRY_STAGE_FRAMES * 3) return null;

  const fruit = /** @type {[number, number]} */ ([4, 5]);
  const flowering = [2, 3];
  // Every stage is a different drawing of the tree; a fruiting frame that is
  // pixel-for-pixel its flowering frame means the fruit was never drawn.
  const differs = fruit.some((frame, index) => !sameFrame(sheet, layout, frame, flowering[index]));
  return differs ? fruit : null;
}

/**
 * Which frames to show once the fruit is picked, or null to leave it to the
 * renderer.
 *
 * The tree in flower is the same shape as the tree in fruit, but its flowers
 * are a few loose pixels each, and drawn half as large again on the road they
 * read as the sprite breaking up rather than as blossom. The grown tree — the
 * stage before either, with nothing on it — is the honest picture of a tree
 * that has just been picked bare. It stands a few pixels shorter, which reads
 * well enough; what does not is the one sheet whose grown stage is a stalk a
 * third the width of the tree in fruit, where the companion's tree would
 * shrink to a twig in its hands, so a stage that much narrower is passed over.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {ReturnType<typeof frameLayout>} layout
 * @returns {[number, number]|null}
 */
function pickedFrames(sheet, layout) {
  if (layout.count < BERRY_STAGE_FRAMES * 3) return null;
  const grown = opaqueBounds(cropFrame(sheet, layout, 0));
  const fruit = opaqueBounds(cropFrame(sheet, layout, 4));
  if (!grown || !fruit) return null;
  return grown.width >= fruit.width * PICKED_MIN_WIDTH ? [0, 1] : null;
}

/** How narrow the grown tree may be, against the tree in fruit, to stand in for it picked. */
const PICKED_MIN_WIDTH = 0.6;

/**
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {ReturnType<typeof frameLayout>} layout
 * @param {number} a
 * @param {number} b
 */
function sameFrame(sheet, layout, a, b) {
  const left = cropFrame(sheet, layout, a);
  const right = cropFrame(sheet, layout, b);
  if (left.width !== right.width || left.height !== right.height) return false;
  for (let index = 0; index < left.data.length; index++) {
    if (left.data[index] !== right.data[index]) return false;
  }
  return true;
}

/** How many animation frames a berry tree's growth stage is drawn in. */
const BERRY_STAGE_FRAMES = 2;

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

/** How many blocks square the Center is cut out as. */
const CENTER_BLOCKS = 5;

/**
 * How many times a metatile has to appear outside the crop before its colours
 * are taken to be the ground's.
 *
 * A town's grass and paving are laid down all over it; a building stands in
 * one place. A handful of uses is enough to be sure — and being sure matters,
 * because these blocks are what the ground's palette is read from.
 */
const GROUND_REPEATS = 4;

/**
 * Rub the town off the building.
 *
 * A Center is part of the town it stands in — drawn from the same metatiles as
 * the road outside it — so cutting one out brings the grass and the path along
 * with it, and the rest stop then arrives on the companion's road standing in
 * a square of somebody else's lawn.
 *
 * Two passes, because the town and the building are not divided along block
 * lines. The roof's corners are cut diagonally and the metatiles they sit in
 * hold grass *behind* the slope; the block under the doorstep holds wall and
 * lawn together. Clearing whole blocks leaves the first and eats the second.
 *
 * So: the blocks the town repeats all over are unambiguously ground, and they
 * are cleared outright and their colours noted. Then everything of those
 * colours that the outside can still reach goes too, whichever block it is
 * sitting in — which is the grass behind the roof and beside the step, and
 * nothing of the building, because a building is not the colour of a lawn.
 *
 * @param {import('../lib/image.mjs').Raster} building the cropped picture
 * @param {{blockdata: Buffer, widthInBlocks: number, fromX: number, fromY: number, blocks: number}} where
 * @returns {number} how many whole blocks were cleared
 */
export function clearScenery(building, { blockdata, widthInBlocks, fromX, fromY, blocks }) {
  /** The metatile at a place on the town's own grid. */
  const at = (bx, by) => {
    const offset = (by * widthInBlocks + bx) * 2;
    if (bx < 0 || by < 0 || offset < 0 || offset + 1 >= blockdata.length) return null;
    return blockdata.readUInt16LE(offset) & 0x3ff;
  };

  /** How often each metatile is used anywhere outside the crop. */
  const outside = new Map();
  const height = Math.floor(blockdata.length / 2 / widthInBlocks);
  for (let by = 0; by < height; by++) {
    for (let bx = 0; bx < widthInBlocks; bx++) {
      const inside = bx >= fromX && bx < fromX + blocks && by >= fromY && by < fromY + blocks;
      if (inside) continue;
      const id = at(bx, by);
      if (id !== null) outside.set(id, (outside.get(id) ?? 0) + 1);
    }
  }

  /** Whether this place in the crop is a block the town lays down all over. */
  const isGround = (bx, by) => {
    const id = at(fromX + bx, fromY + by);
    return id === null || (outside.get(id) ?? 0) >= GROUND_REPEATS;
  };

  // Flood in from every edge of the crop, across ground only. Reaching in from
  // the edge is what protects a ground-looking block walled in by the
  // building: enclosed by it, the flood never arrives.
  const seen = new Set();
  /** @type {Array<[number, number]>} */
  const queue = [];
  for (let i = 0; i < blocks; i++) {
    queue.push([i, 0], [i, blocks - 1], [0, i], [blocks - 1, i]);
  }
  while (queue.length) {
    const [bx, by] = queue.pop();
    if (bx < 0 || by < 0 || bx >= blocks || by >= blocks) continue;
    const key = by * blocks + bx;
    if (seen.has(key)) continue;
    if (!isGround(bx, by)) continue;
    seen.add(key);
    queue.push([bx + 1, by], [bx - 1, by], [bx, by + 1], [bx, by - 1]);
  }

  /** The colours those blocks are made of: the ground's own palette. */
  const palette = new Set();
  for (const key of seen) {
    const left = (key % blocks) * METATILE_SIZE;
    const top = Math.floor(key / blocks) * METATILE_SIZE;
    for (let y = top; y < Math.min(building.height, top + METATILE_SIZE); y++) {
      for (let x = left; x < Math.min(building.width, left + METATILE_SIZE); x++) {
        palette.add(colourAt(building, x, y));
      }
    }
    clearBlock(building, left, top);
  }

  bleedGround(building, palette);
  return seen.size;
}

/**
 * Take the ground's colours away from wherever the outside can still reach
 * them — the grass behind a diagonal roof, the lawn beside a doorstep.
 *
 * A flood rather than a sweep: a green pixel the building encloses is part of
 * the building, whatever it is the colour of.
 *
 * @param {import('../lib/image.mjs').Raster} picture
 * @param {Set<number>} palette
 */
function bleedGround(picture, palette) {
  if (palette.size === 0) return;
  const { width, height } = picture;
  const seen = new Uint8Array(width * height);
  /** @type {number[]} */
  const queue = [];

  // Every pixel already gone is a way in, and so is the border itself.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (picture.data[index * 4 + 3] === 0 || (edge && palette.has(colourAt(picture, x, y)))) {
        seen[index] = 1;
        queue.push(index);
      }
    }
  }

  while (queue.length) {
    const index = queue.pop();
    const x = index % width;
    const y = (index - x) / width;
    picture.data[index * 4 + 3] = 0;

    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (seen[next]) continue;
      if (picture.data[next * 4 + 3] !== 0 && !palette.has(colourAt(picture, nx, ny))) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
}

/**
 * One pixel's colour as a single number, so a set can hold it.
 * @param {import('../lib/image.mjs').Raster} picture
 * @param {number} x
 * @param {number} y
 */
function colourAt(picture, x, y) {
  const offset = (y * picture.width + x) * 4;
  return (picture.data[offset] << 16) | (picture.data[offset + 1] << 8) | picture.data[offset + 2];
}

/**
 * Make one metatile's worth of a picture transparent.
 *
 * @param {import('../lib/image.mjs').Raster} raster
 * @param {number} left
 * @param {number} top
 */
function clearBlock(raster, left, top) {
  for (let y = top; y < Math.min(raster.height, top + METATILE_SIZE); y++) {
    for (let x = left; x < Math.min(raster.width, left + METATILE_SIZE); x++) {
      raster.data[(y * raster.width + x) * 4 + 3] = 0;
    }
  }
}

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
  const { map, layout: townLayout, blockdata, image } = await maps.render(CENTER_TOWN);

  const warp = (map.warp_events ?? []).find((event) => String(event.dest_map).includes('POKEMON_CENTER'));
  if (!warp) return null;

  // The building around its door: two blocks either side, and four above.
  const fromX = Number(warp.x) - 2;
  const fromY = Number(warp.y) - 4;
  const building = crop(image, fromX * METATILE_SIZE, fromY * METATILE_SIZE, CENTER_BLOCKS * METATILE_SIZE, CENTER_BLOCKS * METATILE_SIZE);
  // …and then the town rubbed off it, so it stands on the companion's road
  // rather than on a square of the lawn it was cut from.
  clearScenery(building, {
    blockdata,
    widthInBlocks: townLayout.width,
    fromX,
    fromY,
    blocks: CENTER_BLOCKS,
  });
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
