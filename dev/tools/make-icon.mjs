#!/usr/bin/env node
/**
 * Draw the application icon.
 *
 * Generated rather than hand-drawn so it is reproducible and so the only art
 * committed to the repository is our own: a dark rounded tile with a simple
 * two-tone disc, which reads at every size a launcher uses.
 *
 *   node tools/make-icon.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './lib/png.mjs';

const SIZE = 512;
const OUT = fileURLToPath(new URL('../build/', import.meta.url));

const BACKGROUND = [24, 30, 46];
const TOP = [216, 68, 60];
const BOTTOM = [246, 246, 238];
const BAND = [32, 38, 54];

const pixels = new Uint8Array(SIZE * SIZE * 4);

const centre = SIZE / 2;
const radius = SIZE * 0.36;
const bandHalf = SIZE * 0.034;
const buttonOuter = SIZE * 0.105;
const buttonInner = SIZE * 0.062;
const corner = SIZE * 0.22;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const offset = (y * SIZE + x) * 4;
    if (!insideRoundedSquare(x, y, corner)) continue;

    let colour = BACKGROUND;
    const distance = Math.hypot(x - centre, y - centre);

    if (distance <= radius) {
      colour = y < centre ? TOP : BOTTOM;
      if (Math.abs(y - centre) <= bandHalf) colour = BAND;
      if (distance <= buttonOuter) colour = BAND;
      if (distance <= buttonInner) colour = BOTTOM;
    }

    pixels[offset] = colour[0];
    pixels[offset + 1] = colour[1];
    pixels[offset + 2] = colour[2];
    pixels[offset + 3] = 255;
  }
}

/** A squircle mask, so the icon sits well in every launcher's frame. */
function insideRoundedSquare(x, y, cornerRadius) {
  const margin = SIZE * 0.045;
  const left = margin;
  const right = SIZE - margin;
  if (x < left || x > right || y < left || y > right) return false;

  const dx = Math.max(left + cornerRadius - x, 0, x - (right - cornerRadius));
  const dy = Math.max(left + cornerRadius - y, 0, y - (right - cornerRadius));
  return Math.hypot(dx, dy) <= cornerRadius;
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'icon.png'), encodePng(SIZE, SIZE, pixels));
console.log(`wrote ${join(OUT, 'icon.png')} (${SIZE}x${SIZE})`);
