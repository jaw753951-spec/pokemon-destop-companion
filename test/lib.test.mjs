import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePng, encodePng } from '../tools/lib/png.mjs';
import {
  concatX,
  createRaster,
  crop,
  gradeTime,
  makeSeamless,
  mirrorX,
  opaqueBounds,
  pickWalkableBand,
  resampleFrames,
} from '../tools/lib/image.mjs';
import { parseJascPal, tilesetDirName, combineMetatiles } from '../tools/lib/gba-gfx.mjs';

/** Build a small RGBA raster from a `(x, y) -> [r,g,b,a]` function. */
function raster(width, height, fn) {
  const out = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.data.set(fn(x, y), (y * width + x) * 4);
  }
  return out;
}

test('png encodes and decodes losslessly', () => {
  const source = raster(7, 5, (x, y) => [x * 30, y * 40, (x + y) * 10, x === 0 ? 0 : 255]);
  const decoded = decodePng(encodePng(source.width, source.height, source.data));
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.data], [...source.data]);
});

test('crop clamps to the source bounds', () => {
  const source = raster(4, 4, (x, y) => [x, y, 0, 255]);
  const out = crop(source, 2, 2, 4, 4);
  assert.equal(out.width, 4);
  assert.deepEqual([...out.data.subarray(0, 4)], [2, 2, 0, 255]);
  // Outside the source stays zeroed rather than wrapping.
  assert.deepEqual([...out.data.subarray(8, 12)], [0, 0, 0, 0]);
});

test('mirrorX reverses columns', () => {
  const source = raster(3, 1, (x) => [x, 0, 0, 255]);
  const out = mirrorX(source);
  assert.deepEqual([out.data[0], out.data[4], out.data[8]], [2, 1, 0]);
});

test('concatX joins rasters left to right', () => {
  const a = raster(2, 2, () => [1, 0, 0, 255]);
  const b = raster(3, 2, () => [2, 0, 0, 255]);
  const out = concatX([a, b]);
  assert.equal(out.width, 5);
  assert.equal(out.data[0], 1);
  assert.equal(out.data[2 * 4], 2);
});

test('makeSeamless loops without a duplicated edge column', () => {
  const band = raster(5, 1, (x) => [x * 10, 0, 0, 255]);
  const strip = makeSeamless(band);
  assert.equal(strip.width, 8); // 5 + (5 - 2)
  const column = (i) => strip.data[i * 4];
  // The band runs forward, then mirrors back, and wrapping past the end lands
  // on the band's first column again — no repeated pixel at either join.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(column), [0, 10, 20, 30, 40, 30, 20, 10]);
});

test('gradeTime darkens night and leaves day untouched', () => {
  const source = raster(1, 1, () => [200, 200, 200, 128]);
  const day = gradeTime(source, 'day');
  assert.deepEqual([...day.data], [200, 200, 200, 128]);

  const night = gradeTime(source, 'night');
  assert.ok(night.data[0] < 200 && night.data[2] < 200, 'night should darken');
  assert.ok(night.data[2] > night.data[0], 'night should skew blue');
  assert.equal(night.data[3], 128, 'alpha is preserved');
});

test('opaqueBounds finds the tight box, or null when empty', () => {
  const source = raster(5, 5, (x, y) => (x === 3 && y === 1 ? [1, 2, 3, 255] : [0, 0, 0, 0]));
  assert.deepEqual(opaqueBounds(source), { x: 3, y: 1, width: 1, height: 1 });
  assert.equal(opaqueBounds(raster(2, 2, () => [0, 0, 0, 0])), null);
});

test('pickWalkableBand prefers rows whose blocks are passable', () => {
  const width = 4;
  const height = 6;
  const blocks = Buffer.alloc(width * height * 2);
  // Rows 3 and 4 are open; everything else is solid (collision bit set).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const passable = y === 3 || y === 4;
      blocks.writeUInt16LE(passable ? 0 : 1 << 10, (y * width + x) * 2);
    }
  }
  const start = pickWalkableBand(blocks, width, height, 2);
  assert.equal(start, 3);
});

test('pickWalkableBand returns 0 when the map is not taller than the band', () => {
  assert.equal(pickWalkableBand(Buffer.alloc(8), 2, 2, 4), 0);
});

test('resampleFrames caps frame count while keeping total duration', () => {
  const frames = Array.from({ length: 40 }, (_, i) => ({ id: i, delayMs: 30 }));
  const out = resampleFrames(frames, 8);
  assert.equal(out.length, 8);
  assert.equal(out.reduce((sum, f) => sum + f.delayMs, 0), 1200);
  assert.equal(out[0].id, 0);
  assert.ok(out[7].id > out[0].id, 'later samples come from later frames');
});

test('resampleFrames leaves short animations alone', () => {
  const frames = [{ delayMs: 100 }, { delayMs: 100 }];
  assert.equal(resampleFrames(frames, 8), frames);
});

test('tilesetDirName converts decomp symbols to directory names', () => {
  assert.equal(tilesetDirName('gTileset_General'), 'general');
  assert.equal(tilesetDirName('gTileset_PetalburgWoods'), 'petalburg_woods');
  assert.equal(tilesetDirName('gTileset_MtPyre'), 'mt_pyre');
});

test('parseJascPal reads the 16 palette entries', () => {
  const text = ['JASC-PAL', '0100', '3', '24 41 82', '255 255 255', '0 0 0', ''].join('\r\n');
  assert.deepEqual(parseJascPal(Buffer.from(text, 'ascii')), [
    [24, 41, 82],
    [255, 255, 255],
    [0, 0, 0],
  ]);
});

test('combineMetatiles places secondary metatiles after the primary block', () => {
  const primary = Buffer.alloc(16 * 2); // two metatiles
  primary.writeUInt16LE(0x1234, 0);
  const secondary = Buffer.alloc(16);
  secondary.writeUInt16LE(0x0abc, 0);

  const combined = combineMetatiles(primary, secondary);
  assert.equal(combined[0], 0x1234);
  assert.equal(combined[512 * 8], 0x0abc);
  assert.equal(combined.length, (512 + 1) * 8);
});
