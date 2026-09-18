/**
 * RGBA raster helpers shared by the asset build steps.
 *
 * Everything here works on plain `{width, height, data}` records holding
 * straight (non-premultiplied) RGBA8, which is what `png.mjs` and `gif.mjs`
 * hand back and what `encodePng` expects.
 */

/**
 * @typedef {Object} Raster
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array|Buffer} data
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {Raster}
 */
export function createRaster(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * @param {Raster} source
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {Raster}
 */
export function crop(source, x, y, width, height) {
  const out = createRaster(width, height);
  for (let row = 0; row < height; row++) {
    const sourceY = y + row;
    if (sourceY < 0 || sourceY >= source.height) continue;
    for (let column = 0; column < width; column++) {
      const sourceX = x + column;
      if (sourceX < 0 || sourceX >= source.width) continue;
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (row * width + column) * 4;
      out.data[to] = source.data[from];
      out.data[to + 1] = source.data[from + 1];
      out.data[to + 2] = source.data[from + 2];
      out.data[to + 3] = source.data[from + 3];
    }
  }
  return out;
}

/** @param {Raster} source @returns {Raster} */
export function mirrorX(source) {
  const out = createRaster(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const from = (y * source.width + (source.width - 1 - x)) * 4;
      const to = (y * source.width + x) * 4;
      out.data.set(source.data.subarray(from, from + 4), to);
    }
  }
  return out;
}

/**
 * Concatenate rasters left to right. They must share a height.
 * @param {Raster[]} parts
 * @returns {Raster}
 */
export function concatX(parts) {
  const height = parts[0].height;
  const width = parts.reduce((sum, part) => sum + part.width, 0);
  const out = createRaster(width, height);
  let offset = 0;
  for (const part of parts) {
    for (let y = 0; y < height; y++) {
      const from = y * part.width * 4;
      out.data.set(part.data.subarray(from, from + part.width * 4), (y * width + offset) * 4);
    }
    offset += part.width;
  }
  return out;
}

/**
 * Turn a band into a strip that loops without a seam, by appending a mirrored
 * copy with the shared edge columns dropped ("ping-pong" tiling). Mirrored
 * terrain reads naturally in a top-down map, and the join is pixel-exact.
 *
 * @param {Raster} band
 * @returns {Raster}
 */
export function makeSeamless(band) {
  if (band.width < 3) return band;
  const mirrored = mirrorX(band);
  return concatX([band, crop(mirrored, 1, 0, band.width - 2, band.height)]);
}

/**
 * Repeat a seamless strip until it is at least `minWidth` wide, so the field
 * scene can always scroll a full view width past the wrap point.
 *
 * @param {Raster} strip
 * @param {number} minWidth
 * @returns {Raster}
 */
export function repeatToWidth(strip, minWidth) {
  if (strip.width >= minWidth) return strip;
  const copies = Math.ceil(minWidth / strip.width);
  return concatX(new Array(copies).fill(strip));
}

/**
 * Colour grades applied to an area background to suggest the time of day.
 * Values are `[multiply r,g,b, add r,g,b]` in 0..1 / -255..255.
 * @type {Record<string, {multiply: [number, number, number], add: [number, number, number]}>}
 */
export const TIME_GRADES = {
  // 아침 — cool, slightly hazy dawn light
  dawn: { multiply: [1.0, 0.96, 0.95], add: [14, 6, 16] },
  // 점심 — the unmodified daytime palette
  day: { multiply: [1.0, 1.0, 1.0], add: [0, 0, 0] },
  // 오후 — low golden sun
  afternoon: { multiply: [1.04, 0.98, 0.86], add: [10, 2, -6] },
  // 저녁 — sunset reds bleeding into shadow
  dusk: { multiply: [0.92, 0.72, 0.68], add: [26, 2, 8] },
  // 밤 — moonlit blue, well darkened
  night: { multiply: [0.48, 0.52, 0.78], add: [2, 4, 22] },
};

/** @type {Array<keyof typeof TIME_GRADES>} */
export const TIME_KEYS = ['dawn', 'day', 'afternoon', 'dusk', 'night'];

/**
 * @param {Raster} source
 * @param {keyof typeof TIME_GRADES} time
 * @returns {Raster}
 */
export function gradeTime(source, time) {
  const { multiply, add } = TIME_GRADES[time];
  const out = createRaster(source.width, source.height);
  for (let i = 0; i < source.width * source.height; i++) {
    const offset = i * 4;
    out.data[offset] = clamp8(source.data[offset] * multiply[0] + add[0]);
    out.data[offset + 1] = clamp8(source.data[offset + 1] * multiply[1] + add[1]);
    out.data[offset + 2] = clamp8(source.data[offset + 2] * multiply[2] + add[2]);
    out.data[offset + 3] = source.data[offset + 3];
  }
  return out;
}

const clamp8 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value | 0);

/**
 * Tight bounding box of non-transparent pixels, or null when fully transparent.
 * @param {Raster} source
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function opaqueBounds(source) {
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (source.data[(y * source.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Make a colour fully transparent wherever it appears. GBA sprite sheets mark
 * transparency with palette entry 0 rather than an alpha channel.
 * @param {Raster} source
 * @param {[number, number, number]} color
 * @returns {Raster}
 */
export function keyOut(source, color) {
  const out = { width: source.width, height: source.height, data: Uint8Array.from(source.data) };
  for (let i = 0; i < source.width * source.height; i++) {
    const offset = i * 4;
    if (out.data[offset] === color[0] && out.data[offset + 1] === color[1] && out.data[offset + 2] === color[2]) {
      out.data[offset + 3] = 0;
    }
  }
  return out;
}

/**
 * Choose the most walkable horizontal band of a map, so the companion appears
 * to travel along a real path rather than through scenery.
 *
 * @param {Buffer} blockdata `map.bin`, uint16 per block with collision in bits 10-11
 * @param {number} widthInBlocks
 * @param {number} heightInBlocks
 * @param {number} bandBlocks how many block rows the band spans
 * @returns {number} the best starting block row
 */
export function pickWalkableBand(blockdata, widthInBlocks, heightInBlocks, bandBlocks) {
  if (heightInBlocks <= bandBlocks) return 0;

  /** @type {Array<{passable: number, variety: number}>} */
  const rows = [];
  for (let y = 0; y < heightInBlocks; y++) {
    let passable = 0;
    /** @type {Set<number>} */
    const kinds = new Set();
    for (let x = 0; x < widthInBlocks; x++) {
      const offset = (y * widthInBlocks + x) * 2;
      if (offset + 1 >= blockdata.length) continue;
      const block = blockdata.readUInt16LE(offset);
      if (((block >> 10) & 0x03) === 0) passable++;
      kinds.add(block & 0x03ff);
    }
    rows.push({ passable, variety: kinds.size });
  }

  let bestRow = 0;
  let bestScore = -Infinity;
  for (let start = 0; start + bandBlocks <= heightInBlocks; start++) {
    let score = 0;
    for (let offset = 0; offset < bandBlocks; offset++) {
      // Weight the middle rows highest: that is where the sprite actually walks.
      const distance = Math.abs(offset - (bandBlocks - 1) / 2);
      const row = rows[start + offset];
      score += (row.passable - row.variety * VARIETY_PENALTY) * (1 + (bandBlocks / 2 - distance));
    }
    if (score > bestScore) {
      bestScore = score;
      bestRow = start;
    }
  }
  return bestRow;
}

/**
 * How hard to push the band away from cluttered rows.
 *
 * Open ground and a tree line can be equally walkable, so counting passable
 * blocks alone happily picks the noisiest strip of the map. Charging each row
 * for the number of distinct metatiles it uses breaks that tie towards plain
 * terrain, which is what a route looks like where you actually walk it.
 */
const VARIETY_PENALTY = 2;

/**
 * Resample an animation down to at most `maxFrames`, preserving its total
 * duration by sampling at even time steps.
 *
 * @template {{delayMs: number}} T
 * @param {T[]} frames
 * @param {number} maxFrames
 * @returns {T[]}
 */
export function resampleFrames(frames, maxFrames) {
  if (frames.length <= maxFrames) return frames;

  const total = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
  const step = total / maxFrames;
  /** @type {T[]} */
  const out = [];
  let cursor = 0;
  let elapsed = 0;

  for (let i = 0; i < maxFrames; i++) {
    const target = i * step;
    while (cursor < frames.length - 1 && elapsed + frames[cursor].delayMs <= target) {
      elapsed += frames[cursor].delayMs;
      cursor++;
    }
    out.push({ ...frames[cursor], delayMs: Math.round(step) });
  }
  return out;
}
