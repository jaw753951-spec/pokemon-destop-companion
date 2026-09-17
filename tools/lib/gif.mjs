/**
 * Minimal animated-GIF decoder.
 *
 * Pokémon sprites arrive from PokeAPI as animated GIFs (Gen-5 Black/White and
 * Showdown). The renderer wants deterministic spritesheets instead, so the
 * pipeline decodes each GIF here into fully-composed RGBA frames plus their
 * delays, and `sprites.mjs` packs those into a horizontal strip.
 */

/**
 * @typedef {Object} GifFrame
 * @property {Buffer} data RGBA8 for the whole canvas, `width * height * 4`.
 * @property {number} delayMs
 */

/**
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, frames: GifFrame[]}}
 */
export function decodeGif(buffer) {
  const signature = buffer.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('Not a GIF file');

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  const backgroundIndex = buffer[11];

  let pos = 13;
  /** @type {number[][]|null} */
  let globalTable = null;
  if (packed & 0x80) {
    const size = 2 << (packed & 0x07);
    globalTable = readColorTable(buffer, pos, size);
    pos += size * 3;
  }

  /** @type {GifFrame[]} */
  const frames = [];
  const canvas = Buffer.alloc(width * height * 4); // transparent
  let previous = Buffer.from(canvas);

  let delayMs = 100;
  let transparentIndex = -1;
  let disposal = 0;

  while (pos < buffer.length) {
    const block = buffer[pos++];

    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      const label = buffer[pos++];
      if (label === 0xf9) {
        const size = buffer[pos++];
        const flags = buffer[pos];
        disposal = (flags >> 2) & 0x07;
        delayMs = buffer.readUInt16LE(pos + 1) * 10;
        transparentIndex = flags & 0x01 ? buffer[pos + 3] : -1;
        pos += size;
        pos = skipSubBlocks(buffer, pos);
      } else {
        pos = skipSubBlocks(buffer, pos);
      }
      continue;
    }

    if (block !== 0x2c) throw new Error(`Unexpected GIF block 0x${block.toString(16)} at ${pos - 1}`);

    const left = buffer.readUInt16LE(pos);
    const top = buffer.readUInt16LE(pos + 2);
    const frameWidth = buffer.readUInt16LE(pos + 4);
    const frameHeight = buffer.readUInt16LE(pos + 6);
    const frameFlags = buffer[pos + 8];
    pos += 9;

    let table = globalTable;
    if (frameFlags & 0x80) {
      const size = 2 << (frameFlags & 0x07);
      table = readColorTable(buffer, pos, size);
      pos += size * 3;
    }
    if (!table) throw new Error('GIF frame has no color table');
    const interlaced = Boolean(frameFlags & 0x40);

    const minCodeSize = buffer[pos++];
    const { data: compressed, end } = readSubBlocks(buffer, pos);
    pos = end;

    const indices = lzwDecode(compressed, minCodeSize, frameWidth * frameHeight);

    if (disposal === 3) previous = Buffer.from(canvas);

    for (let y = 0; y < frameHeight; y++) {
      const sourceRow = interlaced ? deinterlacedRow(y, frameHeight) : y;
      for (let x = 0; x < frameWidth; x++) {
        const index = indices[sourceRow * frameWidth + x];
        if (index === transparentIndex) continue;
        const canvasX = left + x;
        const canvasY = top + y;
        if (canvasX >= width || canvasY >= height) continue;
        const target = (canvasY * width + canvasX) * 4;
        const color = table[index] ?? [0, 0, 0];
        canvas[target] = color[0];
        canvas[target + 1] = color[1];
        canvas[target + 2] = color[2];
        canvas[target + 3] = 255;
      }
    }

    frames.push({ data: Buffer.from(canvas), delayMs: delayMs || 100 });

    if (disposal === 2) {
      // Restore the frame's rectangle to the (transparent) background.
      for (let y = top; y < Math.min(top + frameHeight, height); y++) {
        canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(left + frameWidth, width)) * 4);
      }
    } else if (disposal === 3) {
      previous.copy(canvas);
    }

    transparentIndex = -1;
    disposal = 0;
  }

  if (frames.length === 0) throw new Error('GIF contained no frames');
  void backgroundIndex;
  return { width, height, frames };
}

function readColorTable(buffer, offset, size) {
  const table = new Array(size);
  for (let i = 0; i < size; i++) {
    table[i] = [buffer[offset + i * 3], buffer[offset + i * 3 + 1], buffer[offset + i * 3 + 2]];
  }
  return table;
}

function skipSubBlocks(buffer, pos) {
  while (buffer[pos] !== 0) pos += buffer[pos] + 1;
  return pos + 1;
}

function readSubBlocks(buffer, pos) {
  /** @type {Buffer[]} */
  const parts = [];
  while (buffer[pos] !== 0) {
    const size = buffer[pos];
    parts.push(buffer.subarray(pos + 1, pos + 1 + size));
    pos += size + 1;
  }
  return { data: Buffer.concat(parts), end: pos + 1 };
}

/** GIF interlacing: four passes over the rows. */
function deinterlacedRow(y, height) {
  const pass1 = Math.ceil(height / 8);
  const pass2 = Math.ceil((height - 4) / 8);
  const pass3 = Math.ceil((height - 2) / 4);
  if (y < pass1) return y * 8;
  if (y < pass1 + pass2) return (y - pass1) * 8 + 4;
  if (y < pass1 + pass2 + pass3) return (y - pass1 - pass2) * 4 + 2;
  return (y - pass1 - pass2 - pass3) * 2 + 1;
}

/**
 * @param {Buffer} input
 * @param {number} minCodeSize
 * @param {number} pixelCount
 * @returns {Uint8Array}
 */
function lzwDecode(input, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output = new Uint8Array(pixelCount);

  /** @type {Int32Array} */
  let prefix = new Int32Array(4096);
  /** @type {Uint8Array} */
  let suffix = new Uint8Array(4096);
  /** @type {Uint8Array} */
  const stack = new Uint8Array(4096);

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  let inputPos = 0;
  let previousCode = -1;
  let outputPos = 0;
  let firstByte = 0;

  while (outputPos < pixelCount) {
    while (bitCount < codeSize) {
      if (inputPos >= input.length) return output;
      bitBuffer |= input[inputPos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      next = endCode + 1;
      previousCode = -1;
      prefix = new Int32Array(4096);
      suffix = new Uint8Array(4096);
      continue;
    }
    if (code === endCode) break;

    let current = code;
    let stackTop = 0;

    if (code >= next) {
      // The "code not yet in the table" case: emit previous + its first byte.
      stack[stackTop++] = firstByte;
      current = previousCode;
    }
    while (current >= clearCode) {
      stack[stackTop++] = suffix[current];
      current = prefix[current];
    }
    firstByte = current;
    stack[stackTop++] = firstByte;

    while (stackTop > 0 && outputPos < pixelCount) output[outputPos++] = stack[--stackTop];

    if (previousCode !== -1 && next < 4096) {
      prefix[next] = previousCode;
      suffix[next] = firstByte;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    previousCode = code;
  }

  return output;
}
