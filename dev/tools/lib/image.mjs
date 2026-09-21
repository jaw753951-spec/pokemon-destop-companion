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
 * Choose the block row inside a band that the companion should walk along.
 *
 * Picking a walkable band is not enough on its own: a band is nine rows deep
 * and the sprite only stands on one of them, so a fixed ground line put the
 * companion in a tree line as often as on the path. This picks the row whose
 * own blocks and the two above it are passable — the ones the sprite's body
 * occupies — which is exactly the lane a player would walk a character down.
 *
 * @param {Buffer} blockdata `map.bin`, uint16 per block with collision in bits 10-11
 * @param {number} widthInBlocks
 * @param {number} bandRow the band's first block row
 * @param {number} bandBlocks how many block rows the band spans
 * @returns {number} the block row the companion's feet belong on
 */
export function pickWalkLane(blockdata, widthInBlocks, bandRow, bandBlocks) {
  /** Block rows the sprite's body reaches above its feet. */
  const clearance = Math.min(2, bandBlocks - 1);
  /** Where in the band a walking sprite reads best, as a fraction of it. */
  const preferred = (bandBlocks - 1) * 0.62;

  const passable = (row) => {
    let count = 0;
    for (let x = 0; x < widthInBlocks; x++) {
      const offset = ((bandRow + row) * widthInBlocks + x) * 2;
      if (offset + 1 >= blockdata.length) continue;
      if (((blockdata.readUInt16LE(offset) >> 10) & 0x03) === 0) count++;
    }
    return count / Math.max(1, widthInBlocks);
  };

  let bestRow = Math.round(preferred);
  let bestScore = -Infinity;
  for (let row = clearance; row < bandBlocks; row++) {
    // The row under the feet counts full; the ones the body passes through
    // count for less, since clipping a shoulder matters less than standing in
    // a wall.
    let score = passable(row);
    for (let above = 1; above <= clearance; above++) score += passable(row - above) * 0.6;
    score -= Math.abs(row - preferred) * 0.08;

    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bandRow + bestRow;
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

/**
 * The recolouring that turns one palette into another, read off two drawings
 * of the same thing.
 *
 * A shiny Pokémon is not a filter applied to the ordinary one — each species'
 * alternate palette was chosen by hand, and nothing about a blue Gyarados
 * predicts a red one. But the two battle sprites are the same drawing twice,
 * pixel for pixel, so laying them over each other says exactly which colour
 * became which. That mapping is what the box icon, which is only published in
 * the ordinary palette, can then be put through.
 *
 * Where one colour maps to several — anti-aliasing against a different
 * neighbour — the one it lands on most often wins.
 *
 * @param {Raster} from
 * @param {Raster} to must be the same size, and the same drawing
 * @returns {Map<number, [number, number, number]>} packed 0xRRGGBB to RGB
 */
export function paletteShift(from, to) {
  if (from.width !== to.width || from.height !== to.height) return new Map();

  /** @type {Map<number, Map<number, number>>} source colour to tallies */
  const tallies = new Map();
  for (let index = 0; index < from.data.length; index += 4) {
    if (from.data[index + 3] < 128 || to.data[index + 3] < 128) continue;
    const source = (from.data[index] << 16) | (from.data[index + 1] << 8) | from.data[index + 2];
    const target = (to.data[index] << 16) | (to.data[index + 1] << 8) | to.data[index + 2];

    let seen = tallies.get(source);
    if (!seen) tallies.set(source, (seen = new Map()));
    seen.set(target, (seen.get(target) ?? 0) + 1);
  }

  /** @type {Map<number, [number, number, number]>} */
  const shift = new Map();
  for (const [source, seen] of tallies) {
    let best = source;
    let bestCount = -1;
    for (const [target, count] of seen) {
      if (count > bestCount) {
        best = target;
        bestCount = count;
      }
    }
    shift.set(source, [(best >> 16) & 255, (best >> 8) & 255, best & 255]);
  }
  return shift;
}

/**
 * Put a drawing through a recolouring taken from another pair.
 *
 * The box icons are drawn in a different hand from the battle sprites, so an
 * icon's greens are not the sprite's greens to the byte and an exact lookup
 * would leave most of the icon untouched. Each colour therefore takes the
 * shift of the nearest one the mapping knows.
 *
 * "Nearest" is not measured in RGB. The icons are drawn far more saturated
 * than the Gen-5 battle sprites — a Charmander's icon orange is nowhere near
 * its sprite's pale peach in RGB, though both are plainly the same orange
 * belly — so an RGB match sends the body off to whatever shading colour
 * happened to sit near it and leaves it the colour it started. Matching on
 * hue and brightness instead, and discounting saturation, pairs the regions
 * a person would pair. Hue is only weighed as far as both colours have one,
 * so a grey is matched on brightness rather than on the hue it does not have.
 *
 * @param {Raster} source
 * @param {Map<number, [number, number, number]>} shift
 * @returns {Raster}
 */
export function recolour(source, shift) {
  if (shift.size === 0) return source;

  const keys = [...shift.keys()].map((key) => ({
    key,
    hsv: toHsv((key >> 16) & 255, (key >> 8) & 255, key & 255),
  }));
  /** @type {Map<number, [number, number, number]>} */
  const resolved = new Map();

  const nearest = (red, green, blue) => {
    const [hue, saturation, value] = toHsv(red, green, blue);
    let best = keys[0];
    let bestDistance = Infinity;

    for (const candidate of keys) {
      const [otherHue, otherSaturation, otherValue] = candidate.hsv;
      let hueGap = Math.abs(hue - otherHue);
      if (hueGap > 180) hueGap = 360 - hueGap;

      const distance =
        (hueGap / 180) ** 2 * Math.min(saturation, otherSaturation) * 3 +
        (value - otherValue) ** 2 * 2 +
        (saturation - otherSaturation) ** 2 * 0.25;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return /** @type {[number, number, number]} */ (shift.get(best.key));
  };

  const out = createRaster(source.width, source.height);
  out.data.set(source.data);
  for (let index = 0; index < out.data.length; index += 4) {
    if (out.data[index + 3] < 8) continue;
    const packed = (out.data[index] << 16) | (out.data[index + 1] << 8) | out.data[index + 2];
    let colour = resolved.get(packed);
    if (!colour) {
      colour = shift.get(packed) ?? nearest(out.data[index], out.data[index + 1], out.data[index + 2]);
      resolved.set(packed, colour);
    }
    out.data[index] = colour[0];
    out.data[index + 1] = colour[1];
    out.data[index + 2] = colour[2];
  }
  return out;
}

/**
 * A colour as hue (0-360), saturation and value (both 0-1).
 *
 * @param {number} red
 * @param {number} green
 * @param {number} blue
 * @returns {[number, number, number]}
 */
function toHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;

  let hue = 0;
  if (chroma > 0) {
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, max > 0 ? chroma / max : 0, max];
}
