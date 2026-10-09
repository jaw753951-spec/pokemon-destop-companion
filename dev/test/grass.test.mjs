/**
 * The companion going into the grass on its lane rather than walking across
 * the top of it, and the lane keeping out of doorways.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sinkIntoGrass } from '../tools/build/areas.mjs';
import { GAMES } from '../tools/lib/maps.mjs';

const BLOCK = 16;

/** A raster this big, every pixel this colour (alpha last). */
const raster = (width, height, rgba) => {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) data.set(rgba, index * 4);
  return { width, height, data };
};

const alphaAt = (image, x, y) => image.data[(y * image.width + x) * 4 + 3];

test('the blades of a grass block on the lane are laid over the walker, and nothing else is', () => {
  const band = raster(BLOCK * 3, BLOCK * 3, [10, 200, 30, 255]);
  const over = raster(BLOCK * 3, BLOCK * 3, [0, 0, 0, 0]);
  // Something of the map's own already over the third block, a tree's crown.
  over.data.set([1, 2, 3, 255], ((2 * BLOCK - 1) * over.width + 2 * BLOCK) * 4);
  // Blades along the block's bottom row only.
  const mask = Array.from({ length: BLOCK * BLOCK }, (_, index) => Math.floor(index / BLOCK) === BLOCK - 1);
  const groundY = 2 * BLOCK;

  sinkIntoGrass(over, band, groundY, (index) => (index === 1 ? null : mask));

  assert.equal(alphaAt(over, 0, groundY - 1), 255, 'the first block is grass: its blades are over the walker');
  assert.deepEqual([...over.data.subarray(((groundY - 1) * over.width) * 4, ((groundY - 1) * over.width) * 4 + 3)], [10, 200, 30], 'in the map\'s own colours');
  assert.equal(alphaAt(over, 0, groundY - 2), 0, 'only where the picture has blades');
  assert.equal(alphaAt(over, BLOCK, groundY - 1), 0, 'the second block is not grass');
  assert.equal(alphaAt(over, 0, groundY), 0, 'nothing below the lane');
  assert.deepEqual([...over.data.subarray(((groundY - 1) * over.width + 2 * BLOCK) * 4, ((groundY - 1) * over.width + 2 * BLOCK) * 4 + 4)], [1, 2, 3, 255], 'what the map already draws there is kept');
});

test('each game says which of its blocks are grass and which are doorways', () => {
  assert.ok(GAMES.emerald.longGrass.has(0x03), "Emerald's long grass");
  assert.equal(GAMES.firered.longGrass.size, 0, 'Fire Red has none');
  for (const game of ['emerald', 'firered']) assert.ok(GAMES[game].tallGrass.has(0x02), `${game}'s tall grass`);
  assert.ok(GAMES.firered.tallGrass.has(0xd1), "the grass on Fire Red's Cycling Road slope");
  // The arrow warp at a gatehouse's mouth, in both.
  for (const game of ['emerald', 'firered']) assert.ok(GAMES[game].warps.has(0x62), `${game}'s east arrow warp`);
  assert.ok(!GAMES.emerald.warps.has(0x02) && !GAMES.emerald.warps.has(0x00), 'grass and plain ground are not doorways');
});
