/**
 * Cutting the Pokémon Center out of the town it stands in.
 *
 * A Center is drawn from the same metatiles as the road outside it, so the
 * crop brings the grass along. The build tells one from the other by how often
 * the town repeats a block — and this drives that rule against a town made up
 * for the purpose, where it is known which blocks are which.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearScenery } from '../../dev/tools/build/actors.mjs';

const BLOCK = 16;

/**
 * A town: a field of one repeated ground block with a building set into it.
 *
 * @param {{width: number, height: number, ground: number, building: number[][], at: {x: number, y: number}}} plan
 */
function town(plan) {
  const blockdata = Buffer.alloc(plan.width * plan.height * 2);
  for (let by = 0; by < plan.height; by++) {
    for (let bx = 0; bx < plan.width; bx++) {
      blockdata.writeUInt16LE(plan.ground, (by * plan.width + bx) * 2);
    }
  }
  plan.building.forEach((row, by) => {
    row.forEach((id, bx) => {
      if (id === null) return;
      blockdata.writeUInt16LE(id, ((plan.at.y + by) * plan.width + (plan.at.x + bx)) * 2);
    });
  });
  return blockdata;
}

/** A crop of `blocks` square, every pixel opaque to begin with. */
function raster(blocks) {
  const width = blocks * BLOCK;
  return { width, height: width, data: new Uint8Array(width * width * 4).fill(255) };
}

/** Which blocks of the crop were cleared. */
function clearedGrid(picture, blocks) {
  const grid = [];
  for (let by = 0; by < blocks; by++) {
    const row = [];
    for (let bx = 0; bx < blocks; bx++) {
      row.push(picture.data[(by * BLOCK * picture.width + bx * BLOCK) * 4 + 3] === 0);
    }
    grid.push(row);
  }
  return grid;
}

test('the ground goes and the building stays', () => {
  // A 3x3 building of blocks that appear once each, in a field of grass.
  const building = [
    [101, 102, 103],
    [104, 105, 106],
    [107, 108, 109],
  ];
  const blockdata = town({ width: 20, height: 20, ground: 1, building, at: { x: 6, y: 6 } });

  // The crop is 5 blocks square with the building in the middle of it.
  const picture = raster(5);
  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  const cleared = clearedGrid(picture, 5);

  for (let by = 0; by < 5; by++) {
    for (let bx = 0; bx < 5; bx++) {
      const inside = bx >= 1 && bx <= 3 && by >= 1 && by <= 3;
      assert.equal(cleared[by][bx], !inside, `block ${bx},${by}`);
    }
  }
});

test('a common block walled in by the building is left alone', () => {
  // The middle of the building reuses the town's own grass block — a courtyard,
  // a doormat, a shadow. Counting repeats alone would punch a hole in it; it is
  // never reached from the edge, so it stays.
  const building = [
    [101, 102, 103],
    [104, 1, 106],
    [107, 108, 109],
  ];
  const blockdata = town({ width: 20, height: 20, ground: 1, building, at: { x: 6, y: 6 } });

  const picture = raster(5);
  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  const cleared = clearedGrid(picture, 5);

  assert.equal(cleared[2][2], false, 'the enclosed block should survive');
  assert.equal(cleared[0][0], true, 'the corner is still grass');
});

test('a building that reaches the edge of the crop keeps that edge', () => {
  const building = [
    [101, 102, 103, 110, 111],
    [104, 105, 106, 112, 113],
  ];
  const blockdata = town({ width: 20, height: 20, ground: 1, building, at: { x: 5, y: 7 } });

  const picture = raster(5);
  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  const cleared = clearedGrid(picture, 5);

  // Rows 2 and 3 of the crop are the building, edge to edge, and survive.
  for (let bx = 0; bx < 5; bx++) {
    assert.equal(cleared[2][bx], false, `building block ${bx},2`);
    assert.equal(cleared[3][bx], false, `building block ${bx},3`);
  }
  // The rows above and below it are still the town.
  for (let bx = 0; bx < 5; bx++) assert.equal(cleared[0][bx], true, `grass ${bx},0`);
});

test('nothing is cleared from a crop that is all building', () => {
  const building = Array.from({ length: 5 }, (_, by) =>
    Array.from({ length: 5 }, (_, bx) => 200 + by * 5 + bx));
  const blockdata = town({ width: 20, height: 20, ground: 1, building, at: { x: 5, y: 5 } });

  const picture = raster(5);
  const cleared = clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  assert.equal(cleared, 0);
});
