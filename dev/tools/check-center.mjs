#!/usr/bin/env node
/**
 * One-shot check for the Pokémon Center the rest stop is built from.
 *
 * A Center is part of the town it stands in, so cutting one out brings the
 * grass along — and not along block lines either: the roof's corners are cut
 * diagonally and the metatiles behind them hold lawn. This renders the real
 * town, cuts the real building out of it, and verifies that what came out is
 * a building and nothing else.
 *
 * It also writes a picture of the result, with the day and the night it will
 * be lit to side by side, so the thing can be looked at rather than only
 * asserted about.
 *
 *   node dev/tools/check-center.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { clearScenery } from './build/actors.mjs';
import { METATILE_SIZE } from './lib/gba-gfx.mjs';
import { crop, gradeTime } from './lib/image.mjs';
import { openMaps } from './lib/maps.mjs';
import { encodePng } from './lib/png.mjs';
import { DAYLIGHT } from '../../app/renderer/render/daylight.mjs';

const TOWN = 'OldaleTown';
const BLOCKS = 5;

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const maps = await openMaps((task) => task());
const { map, layout, blockdata, image } = await maps.render(TOWN);

const warp = (map.warp_events ?? []).find((event) => String(event.dest_map).includes('POKEMON_CENTER'));
if (!warp) fail(`no Pokémon Center door in ${TOWN}`);

const fromX = Number(warp.x) - 2;
const fromY = Number(warp.y) - 4;
const building = crop(image, fromX * METATILE_SIZE, fromY * METATILE_SIZE, BLOCKS * METATILE_SIZE, BLOCKS * METATILE_SIZE);
const cleared = clearScenery(building, { blockdata, widthInBlocks: layout.width, fromX, fromY, blocks: BLOCKS });

const alphaAt = (x, y) => building.data[(y * building.width + x) * 4 + 3];
const opaque = () => {
  let count = 0;
  for (let i = 0; i < building.width * building.height; i++) if (building.data[i * 4 + 3] !== 0) count++;
  return count;
};

// The town went: the far corner of the crop is four blocks from the building
// and cannot be anything else.
if (alphaAt(4, 4) !== 0) fail('the lawn in the corner of the crop is still there');
if (cleared === 0) fail('no whole block was cleared — the crop is all building?');

// The building stayed: the doorway is at the bottom of the crop, two blocks in.
const doorX = 2 * METATILE_SIZE + METATILE_SIZE / 2;
const doorY = building.height - 4;
if (alphaAt(doorX, doorY) === 0) fail('the doorway was cleared away with the town');

// And it is still a building rather than a few surviving pixels.
const left = opaque();
const share = left / (building.width * building.height);
if (share < 0.3) fail(`only ${(share * 100).toFixed(0)}% of the crop survived`);
if (share > 0.85) fail(`${(share * 100).toFixed(0)}% survived — the town came too`);

// Nothing may be left along the top edge: the roof does not reach it.
for (let x = 0; x < building.width; x++) {
  if (alphaAt(x, 0) !== 0) fail(`the town is still on the top edge at ${x}`);
}

// A look at it, in the two lights that matter most.
const night = { width: building.width, height: building.height, data: new Uint8Array(building.data) };
const light = DAYLIGHT.night;
const [tr, tg, tb] = light.colour.match(/\d+/g).map(Number);
for (let i = 0; i < night.width * night.height; i++) {
  const offset = i * 4;
  if (night.data[offset + 3] === 0) continue;
  night.data[offset] = Math.round((1 - light.strength) * night.data[offset] + light.strength * tr);
  night.data[offset + 1] = Math.round((1 - light.strength) * night.data[offset + 1] + light.strength * tg);
  night.data[offset + 2] = Math.round((1 - light.strength) * night.data[offset + 2] + light.strength * tb);
}

const gap = 4;
const width = building.width * 3 + gap * 2;
const sheet = { width, height: building.height, data: new Uint8Array(width * building.height * 4) };
[building, gradeTime(building, 'night'), night].forEach((panel, index) => {
  const at = index * (building.width + gap);
  for (let y = 0; y < panel.height; y++) {
    for (let x = 0; x < panel.width; x++) {
      const from = (y * panel.width + x) * 4;
      const to = (y * width + at + x) * 4;
      sheet.data.set(panel.data.subarray(from, from + 4), to);
    }
  }
});

await mkdir('shots', { recursive: true });
await writeFile('shots/check-center.png', encodePng(sheet.width, sheet.height, sheet.data));

console.log(`PASS: ${cleared} of ${BLOCKS * BLOCKS} blocks were town, ${(share * 100).toFixed(0)}% of the crop is building`);
console.log('      day | the pipeline\'s night | the renderer\'s night → shots/check-center.png');
