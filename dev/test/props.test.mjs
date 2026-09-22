/**
 * Cutting the Pokémon Center out of the town it stands in.
 *
 * A Center is drawn from the same metatiles as the road outside it, so the
 * crop brings the grass along — and not tidily, because the town and the
 * building are not divided along block lines. The roof's corners are cut
 * diagonally and the blocks they sit in hold grass behind the slope; the block
 * under the doorstep holds wall and lawn together.
 *
 * So the build works in two passes, and both are driven here against a town
 * made up for the purpose, where it is known which pixel is which.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearScenery } from '../../dev/tools/build/actors.mjs';

const BLOCK = 16;

/** Colours, so a pixel can be asked what it was painted as. */
const GRASS = [40, 160, 60];
const ROOF = [200, 60, 60];
const WALL = [230, 230, 240];

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
  (plan.building ?? []).forEach((row, by) => {
    row.forEach((id, bx) => {
      if (id === null) return;
      blockdata.writeUInt16LE(id, ((plan.at.y + by) * plan.width + (plan.at.x + bx)) * 2);
    });
  });
  return blockdata;
}

/**
 * A crop, painted block by block: whatever `paint` says each block looks like.
 *
 * @param {number} blocks
 * @param {(bx: number, by: number, x: number, y: number) => number[]} paint
 */
function raster(blocks, paint) {
  const width = blocks * BLOCK;
  const picture = { width, height: width, data: new Uint8Array(width * width * 4) };
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(Math.floor(x / BLOCK), Math.floor(y / BLOCK), x % BLOCK, y % BLOCK);
      const offset = (y * width + x) * 4;
      picture.data[offset] = r;
      picture.data[offset + 1] = g;
      picture.data[offset + 2] = b;
      picture.data[offset + 3] = 255;
    }
  }
  return picture;
}

/** @param {any} picture */
const alphaAt = (picture, x, y) => picture.data[(y * picture.width + x) * 4 + 3];

/** Which blocks of the crop came out wholly transparent. */
function clearedGrid(picture, blocks) {
  const grid = [];
  for (let by = 0; by < blocks; by++) {
    const row = [];
    for (let bx = 0; bx < blocks; bx++) {
      let gone = true;
      for (let y = 0; y < BLOCK && gone; y++) {
        for (let x = 0; x < BLOCK; x++) {
          if (alphaAt(picture, bx * BLOCK + x, by * BLOCK + y) !== 0) { gone = false; break; }
        }
      }
      row.push(gone);
    }
    grid.push(row);
  }
  return grid;
}

/** The nine-block building the tests set into their towns. */
const BUILDING = [
  [101, 102, 103],
  [104, 105, 106],
  [107, 108, 109],
];
const inBuilding = (bx, by) => bx >= 1 && bx <= 3 && by >= 1 && by <= 3;

test('the ground goes and the building stays', () => {
  const blockdata = town({ width: 20, height: 20, ground: 1, building: BUILDING, at: { x: 6, y: 6 } });
  const picture = raster(5, (bx, by) => (inBuilding(bx, by) ? ROOF : GRASS));

  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  const cleared = clearedGrid(picture, 5);

  for (let by = 0; by < 5; by++) {
    for (let bx = 0; bx < 5; bx++) {
      assert.equal(cleared[by][bx], !inBuilding(bx, by), `block ${bx},${by}`);
    }
  }
});

test('grass behind a diagonal roof goes with the rest of the grass', () => {
  // The real shape of the problem: the block at the roof's corner holds the
  // slope and the lawn behind it, and no amount of block counting separates
  // them. The top-left block of the building is painted half and half.
  const blockdata = town({ width: 20, height: 20, ground: 1, building: BUILDING, at: { x: 6, y: 6 } });
  const picture = raster(5, (bx, by, x, y) => {
    if (!inBuilding(bx, by)) return GRASS;
    // Above the diagonal in the corner block is sky the town shows through.
    if (bx === 1 && by === 1 && x + y < BLOCK) return GRASS;
    return ROOF;
  });

  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });

  // The grass in the corner is gone…
  assert.equal(alphaAt(picture, BLOCK + 2, BLOCK + 2), 0, 'grass behind the slope should go');
  // …and the roof under it has not been touched.
  assert.equal(alphaAt(picture, BLOCK + 14, BLOCK + 14), 255, 'the roof should stay');
  // Nor has the rest of the building.
  assert.equal(alphaAt(picture, 2 * BLOCK + 8, 2 * BLOCK + 8), 255);
});

test('a wall sharing its block with the lawn keeps the wall', () => {
  // The block under the doorstep: wall on the right of it, lawn on the left.
  // Clearing the block outright — which counting uses alone would do, since
  // the town has one more of it somewhere — took the corner off the building.
  const shared = [
    [101, 102, 103],
    [104, 105, 106],
    [96, 108, 109],
  ];
  const blockdata = town({ width: 20, height: 20, ground: 1, building: shared, at: { x: 6, y: 6 } });
  // That block is used once more, far away.
  blockdata.writeUInt16LE(96, (2 * 20 + 18) * 2);

  const picture = raster(5, (bx, by, x) => {
    if (!inBuilding(bx, by)) return GRASS;
    if (bx === 1 && by === 3) return x < BLOCK / 2 ? GRASS : WALL;
    return WALL;
  });

  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });

  assert.equal(alphaAt(picture, BLOCK + 2, 3 * BLOCK + 8), 0, 'the lawn half should go');
  assert.equal(alphaAt(picture, BLOCK + 12, 3 * BLOCK + 8), 255, 'the wall half should stay');
});

test('ground colour the building encloses is part of the building', () => {
  // A courtyard, a green awning, a painted sign: whatever it is, the outside
  // cannot reach it, so it is not the town.
  const blockdata = town({ width: 20, height: 20, ground: 1, building: BUILDING, at: { x: 6, y: 6 } });
  const picture = raster(5, (bx, by) => {
    if (!inBuilding(bx, by)) return GRASS;
    return bx === 2 && by === 2 ? GRASS : ROOF;
  });

  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });

  assert.equal(alphaAt(picture, 2 * BLOCK + 8, 2 * BLOCK + 8), 255, 'the enclosed block should survive');
  assert.equal(alphaAt(picture, 8, 8), 0, 'the corner is still town');
});

test('a building that reaches the edge of the crop keeps that edge', () => {
  const wide = [
    [101, 102, 103, 110, 111],
    [104, 105, 106, 112, 113],
  ];
  const blockdata = town({ width: 20, height: 20, ground: 1, building: wide, at: { x: 5, y: 7 } });
  const isWide = (bx, by) => by === 2 || by === 3;
  const picture = raster(5, (bx, by) => (isWide(bx, by) ? ROOF : GRASS));

  clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  const cleared = clearedGrid(picture, 5);

  for (let bx = 0; bx < 5; bx++) {
    assert.equal(cleared[2][bx], false, `building block ${bx},2`);
    assert.equal(cleared[3][bx], false, `building block ${bx},3`);
    assert.equal(cleared[0][bx], true, `grass ${bx},0`);
  }
});

test('nothing is cleared from a crop that is all building', () => {
  const building = Array.from({ length: 5 }, (_, by) =>
    Array.from({ length: 5 }, (_, bx) => 200 + by * 5 + bx));
  const blockdata = town({ width: 20, height: 20, ground: 1, building, at: { x: 5, y: 5 } });
  const picture = raster(5, () => ROOF);

  const cleared = clearScenery(picture, { blockdata, widthInBlocks: 20, fromX: 5, fromY: 5, blocks: 5 });
  assert.equal(cleared, 0);
  assert.equal(alphaAt(picture, 0, 0), 255);
  assert.equal(alphaAt(picture, 79, 79), 255);
});
