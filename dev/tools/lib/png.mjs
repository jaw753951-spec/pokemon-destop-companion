/**
 * Minimal PNG decoder/encoder.
 *
 * The pipeline needs to read the GBA decomp's 4-bpp indexed tilesets and the
 * PokeAPI sprites (RGBA8 / palette), and to write composed spritesheets and
 * area backgrounds back out. Rather than pull a native dependency we implement
 * exactly the subset of the spec those files use: non-interlaced images with
 * bit depths 1/2/4/8 in grayscale, RGB, palette, gray+alpha and RGBA.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @typedef {Object} DecodedPng
 * @property {number} width
 * @property {number} height
 * @property {Buffer} data RGBA8, `width * height * 4` bytes.
 * @property {Array<[number, number, number]>|null} palette Original PLTE, when present.
 * @property {number[]|null} indices Original palette indices, when the image was indexed.
 */

/**
 * @param {Buffer} buffer
 * @returns {DecodedPng}
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  /** @type {Array<[number, number, number]>|null} */
  let palette = null;
  /** @type {Buffer|null} */
  let transparency = null;
  /** @type {Buffer[]} */
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
      if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i < body.length; i += 3) palette.push([body[i], body[i + 1], body[i + 2]]);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);

  const scanline = unfilter(raw, width, height, bitDepth, channels);
  const samples = expandBits(scanline, width, height, bitDepth, channels);

  const data = Buffer.alloc(width * height * 4);
  /** @type {number[]|null} */
  const indices = colorType === 3 ? new Array(width * height) : null;
  const maxValue = (1 << bitDepth) - 1;
  const scale = bitDepth === 8 ? 1 : 255 / maxValue;

  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r, g, b, a = 255;
    if (colorType === 3) {
      const index = samples[s];
      if (indices) indices[i] = index;
      const entry = palette?.[index] ?? [0, 0, 0];
      [r, g, b] = entry;
      if (transparency && index < transparency.length) a = transparency[index];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = Math.round(samples[s] * scale);
      if (colorType === 4) a = Math.round(samples[s + 1] * scale);
    } else {
      r = Math.round(samples[s] * scale);
      g = Math.round(samples[s + 1] * scale);
      b = Math.round(samples[s + 2] * scale);
      if (colorType === 6) a = Math.round(samples[s + 3] * scale);
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }

  return { width, height, data, palette, indices };
}

/**
 * Reverse the per-scanline filters. Operates on whole bytes, which is correct
 * for every bit depth: sub-byte depths use a filter distance of 1 byte.
 */
function unfilter(raw, width, height, bitDepth, channels) {
  const bitsPerPixel = bitDepth * channels;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);
  const out = Buffer.alloc(bytesPerLine * height);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + bytesPerLine);
    pos += bytesPerLine;
    const target = out.subarray(y * bytesPerLine, (y + 1) * bytesPerLine);
    const prior = y > 0 ? out.subarray((y - 1) * bytesPerLine, y * bytesPerLine) : null;

    for (let x = 0; x < bytesPerLine; x++) {
      const left = x >= bytesPerPixel ? target[x - bytesPerPixel] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
      let value = line[x];
      switch (filter) {
        case 0: break;
        case 1: value += left; break;
        case 2: value += up; break;
        case 3: value += (left + up) >> 1; break;
        case 4: value += paeth(left, up, upLeft); break;
        default: throw new Error(`Unknown PNG filter ${filter}`);
      }
      target[x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Expand sub-byte samples to one array entry per sample. */
function expandBits(scanlines, width, height, bitDepth, channels) {
  if (bitDepth === 8) return scanlines;
  if (bitDepth === 16) throw new Error('16-bit PNG is not supported');

  const bytesPerLine = Math.ceil((width * bitDepth * channels) / 8);
  const out = new Uint8Array(width * height * channels);
  const mask = (1 << bitDepth) - 1;
  const perByte = 8 / bitDepth;

  for (let y = 0; y < height; y++) {
    const lineStart = y * bytesPerLine;
    for (let i = 0; i < width * channels; i++) {
      const byte = scanlines[lineStart + Math.floor(i / perByte)];
      const shift = 8 - bitDepth * ((i % perByte) + 1);
      out[y * width * channels + i] = (byte >> shift) & mask;
    }
  }
  return out;
}

/**
 * Encode RGBA8 pixels as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {Buffer|Uint8Array} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none — pixel art deflates well regardless
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {string} type @param {Buffer} body */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}
