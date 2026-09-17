/**
 * Pack every Pokémon's animated sprite into a horizontal strip, plus the box
 * icon and cry the rest of the game needs.
 *
 * Sources are tried best-first: the Showdown animations cover almost the whole
 * dex, Gen-5 Black/White fills a few gaps, and the static artwork is the last
 * resort for the newest species. Whatever we end up with, the renderer treats
 * it the same way — a strip of equal-sized frames with one shared delay — and
 * derives the attack/hit/win/lose poses by transforming it at runtime, since
 * no official asset set contains those.
 */
import { join } from 'node:path';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { decodeGif } from '../lib/gif.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, opaqueBounds, resampleFrames } from '../lib/image.mjs';
import { CRIES, MAX_SPECIES, MAX_SPRITE_FRAMES, SPRITES } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildSprites({ assetDir, dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;
  /** @type {Record<number, any>} */
  const manifest = {};
  const missing = { front: [], back: [], icon: [], cry: [] };
  let done = 0;

  await Promise.all(
    Array.from({ length: limit }, (_, index) => index + 1).map((id) =>
      pool(async () => {
        const entry = {};

        const front = await buildStrip(FRONT_SOURCES.map((path) => path(id)));
        if (front) {
          await writeOut(join(assetDir, 'pokemon', String(id), 'front.png'), front.png);
          entry.front = front.meta;
        } else {
          missing.front.push(id);
        }

        const back = await buildStrip(BACK_SOURCES.map((path) => path(id)));
        if (back) {
          await writeOut(join(assetDir, 'pokemon', String(id), 'back.png'), back.png);
          entry.back = back.meta;
        } else {
          missing.back.push(id);
        }

        const icon = await firstAvailable(ICON_SOURCES.map((path) => path(id)));
        if (icon) {
          await writeOut(join(assetDir, 'pokemon', String(id), 'icon.png'), icon);
          entry.icon = true;
        } else {
          missing.icon.push(id);
        }

        const cry = await fetchBuffer(`${CRIES}/pokemon/latest/${id}.ogg`, { allowMissing: true });
        if (cry) {
          await writeOut(join(assetDir, 'cries', `${id}.ogg`), cry);
          entry.cry = true;
        } else {
          missing.cry.push(id);
        }

        manifest[id] = entry;
        done++;
        if (done % 100 === 0) log(`sprites ${done}/${limit}`);
      }),
    ),
  );

  await writeOut(join(dataDir, 'sprites.json'), JSON.stringify(manifest));

  const animated = Object.values(manifest).filter((entry) => entry.front?.frames > 1).length;
  log(`sprites ${Object.keys(manifest).length} (${animated} animated)`);
  for (const [kind, ids] of Object.entries(missing)) {
    if (ids.length) log(`  missing ${kind}: ${ids.length} (${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''})`);
  }
  return manifest;
}

const FRONT_SOURCES = [
  (id) => `${SPRITES}/pokemon/other/showdown/${id}.gif`,
  (id) => `${SPRITES}/pokemon/versions/generation-v/black-white/animated/${id}.gif`,
  (id) => `${SPRITES}/pokemon/other/home/${id}.png`,
  (id) => `${SPRITES}/pokemon/${id}.png`,
];

const BACK_SOURCES = [
  (id) => `${SPRITES}/pokemon/other/showdown/back/${id}.gif`,
  (id) => `${SPRITES}/pokemon/versions/generation-v/black-white/animated/back/${id}.gif`,
  (id) => `${SPRITES}/pokemon/back/${id}.png`,
];

const ICON_SOURCES = [
  (id) => `${SPRITES}/pokemon/versions/generation-viii/icons/${id}.png`,
  (id) => `${SPRITES}/pokemon/versions/generation-vii/icons/${id}.png`,
  (id) => `${SPRITES}/pokemon/${id}.png`,
];

/** @param {string[]} urls */
async function firstAvailable(urls) {
  for (const url of urls) {
    const buffer = await fetchBuffer(url, { allowMissing: true });
    if (buffer) return buffer;
  }
  return null;
}

/**
 * Decode the first source that exists, trim every frame to the animation's
 * shared bounding box, and lay the frames out side by side.
 *
 * @param {string[]} urls
 * @returns {Promise<{png: Buffer, meta: {width: number, height: number, frames: number, delay: number}}|null>}
 */
async function buildStrip(urls) {
  for (const url of urls) {
    const buffer = await fetchBuffer(url, { allowMissing: true });
    if (!buffer) continue;

    const decoded = url.endsWith('.gif') ? decodeGif(buffer) : decodeStatic(buffer);
    const frames = resampleFrames(decoded.frames, MAX_SPRITE_FRAMES);

    const bounds = unionBounds(decoded.width, decoded.height, frames);
    if (!bounds) continue;

    const trimmed = frames.map((frame) =>
      crop({ width: decoded.width, height: decoded.height, data: frame.data }, bounds.x, bounds.y, bounds.width, bounds.height),
    );
    const strip = concatX(trimmed);

    return {
      png: encodePng(strip.width, strip.height, strip.data),
      meta: {
        width: bounds.width,
        height: bounds.height,
        frames: trimmed.length,
        delay: Math.max(40, Math.round(frames[0]?.delayMs ?? 100)),
      },
    };
  }
  return null;
}

/** Wrap a still image as a one-frame animation. */
function decodeStatic(buffer) {
  const png = decodePng(buffer);
  return { width: png.width, height: png.height, frames: [{ data: png.data, delayMs: 200 }] };
}

/**
 * The union of every frame's opaque area, so all frames stay registered to one
 * another after trimming.
 */
function unionBounds(width, height, frames) {
  let box = null;
  for (const frame of frames) {
    const bounds = opaqueBounds({ width, height, data: frame.data });
    if (!bounds) continue;
    box = box
      ? {
          x: Math.min(box.x, bounds.x),
          y: Math.min(box.y, bounds.y),
          right: Math.max(box.right, bounds.x + bounds.width),
          bottom: Math.max(box.bottom, bounds.y + bounds.height),
        }
      : { x: bounds.x, y: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
  }
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.right - box.x, height: box.bottom - box.y };
}


