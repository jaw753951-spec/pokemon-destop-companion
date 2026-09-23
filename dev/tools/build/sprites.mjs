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
 *
 * Every one of them is built twice, because a shiny Pokémon is a different
 * picture rather than a recolour that could be computed: the palettes were
 * chosen by hand per species, and a Gyarados is red where nothing about the
 * blue one predicts it. So the shiny art is fetched from the same sources and
 * laid out the same way, and the manifest carries its own measurements — the
 * trimming is done per image, and two palettes do not always leave the same
 * number of transparent columns at the edge.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { decodeGif } from '../lib/gif.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, opaqueBounds, paletteShift, recolour, resampleFrames } from '../lib/image.mjs';
import { CRIES, MAX_SPECIES, MAX_SPRITE_FRAMES, SPRITES } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildSprites({ assetDir, dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;
  /** @type {Record<number, any>} */
  const manifest = {};
  const missing = { front: [], back: [], icon: [], cry: [], form: [] };
  let done = 0;

  // The alternate formes the dex step kept, read from what it emitted rather
  // than duplicated here — the same table, so the two steps can never disagree
  // about which species change shape. A species can wear more than one (a
  // Castform keeps one per weather), so the table is a species to its list.
  const species = JSON.parse(await readFile(join(dataDir, 'species.json'), 'utf8'));
  const formes = new Map();
  for (const entry of Object.values(species)) {
    if (entry.forms?.length) formes.set(entry.id, entry.forms);
  }

  await Promise.all(
    Array.from({ length: limit }, (_, index) => index + 1).map((id) =>
      pool(async () => {
        // The ordinary art hangs off the entry itself and the shiny art off a
        // `shiny` of its own, so a screen that has never heard of shininess
        // reads exactly what it always read.
        const entry = { shiny: {} };

        /** @type {Record<string, any>} */
        const fronts = {};
        for (const variant of VARIANTS) {
          const into = variant.shiny ? entry.shiny : entry;

          const front = await buildStrip(FRONT_SOURCES.map((path) => path(id, variant.shiny)));
          fronts[variant.suffix] = front;
          if (front) {
            await writeOut(join(assetDir, 'pokemon', String(id), `front${variant.suffix}.png`), front.png);
            into.front = front.meta;
          } else if (!variant.shiny) {
            missing.front.push(id);
          }

          const back = await buildStrip(BACK_SOURCES.map((path) => path(id, variant.shiny)));
          if (back) {
            await writeOut(join(assetDir, 'pokemon', String(id), `back${variant.suffix}.png`), back.png);
            into.back = back.meta;
          } else if (!variant.shiny) {
            missing.back.push(id);
          }
        }

        const icon = await buildIcon(ICON_SOURCES.map((path) => path(id)));
        if (icon) {
          await writeOut(join(assetDir, 'pokemon', String(id), 'icon.png'), icon.png);
          entry.icon = icon.meta;

          // No published icon set is drawn in the alternate palettes, so the
          // shiny icon is the ordinary one put through the recolouring the two
          // battle sprites spell out between them.
          const shiny = shinyIcon(icon, fronts[''], fronts['-shiny']);
          if (shiny) {
            await writeOut(join(assetDir, 'pokemon', String(id), 'icon-shiny.png'), shiny.png);
            entry.shiny.icon = shiny.meta;
          }
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

        // The alternate formes the dex step kept, by the variety id each
        // carried across, each getting a front strip of its own beside the
        // default's — so a battle that changes shape has a picture to change
        // to. The Showdown set draws a shiny forme as a picture of its own,
        // so both palettes are fetched the same way the default's are; where
        // a palette never built, the screen falls back to the ordinary one.
        // A forme's back is published only for some — a masked Ogerpon has
        // one, which is the side of it the player's own is seen from — so it
        // is fetched where it exists and the default's stands in elsewhere.
        // No icon is published for any forme; those stay the default's.
        const forms = formes.get(id);
        for (const forme of forms ?? []) {
          // A forme is filed under its variety's id, or — for the type formes,
          // which are forms of a single variety — under its own name.
          const art = forme.art ?? forme.id;
          const sources = [
            `${SPRITES}/pokemon/other/showdown/${art}.gif`,
            `${SPRITES}/pokemon/versions/generation-v/black-white/animated/${art}.gif`,
            `${SPRITES}/pokemon/other/showdown/${art}.png`,
            `${SPRITES}/pokemon/other/home/${art}.png`,
            `${SPRITES}/pokemon/${art}.png`,
          ];
          for (const variant of VARIANTS) {
            const strip = await buildStrip(sources.map((path) => shinyPath(path, variant.shiny)));
            if (!strip) {
              if (!variant.shiny) missing.form.push(`${id} (${forme.slug})`);
              continue;
            }
            await writeOut(
              join(assetDir, 'pokemon', String(id), `front-form-${forme.slug}${variant.suffix}.png`),
              strip.png,
            );
            const into = variant.shiny ? entry.shiny : entry;
            into[`form-${forme.slug}`] = strip.meta;

            const back = await buildStrip(BACK_SOURCES.map((path) => path(art, variant.shiny)));
            if (back) {
              await writeOut(
                join(assetDir, 'pokemon', String(id), `back-form-${forme.slug}${variant.suffix}.png`),
                back.png,
              );
              into[`back-form-${forme.slug}`] = back.meta;
            }
          }
        }

        manifest[id] = entry;
        done++;
        if (done % 100 === 0) log(`sprites ${done}/${limit}`);
      }),
    ),
  );

  await writeOut(join(dataDir, 'sprites.json'), JSON.stringify(manifest));

  const animated = Object.values(manifest).filter((entry) => entry.front?.frames > 1).length;
  const shiny = Object.values(manifest).filter((entry) => entry.shiny?.front).length;
  const shaped = Object.values(manifest).filter((entry) =>
    Object.keys(entry).some((key) => key.startsWith('form-')),
  ).length;
  log(`sprites ${Object.keys(manifest).length} (${animated} animated, ${shiny} with shiny art, ${shaped} with a battle forme)`);
  for (const [kind, ids] of Object.entries(missing)) {
    if (ids.length) log(`  missing ${kind}: ${ids.length} (${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''})`);
  }
  return manifest;
}

/**
 * The two palettes every Pokémon is drawn in, and where each one lands: the
 * ordinary art at `front.png` and the shiny at `front-shiny.png`, beside it.
 */
const VARIANTS = [
  { suffix: '', shiny: false },
  { suffix: '-shiny', shiny: true },
];

/** The shiny sets sit in a `shiny/` directory of their own at every source. */
const shinyPath = (base, shiny) => (shiny ? base.replace(/\/([^/]+)$/, '/shiny/$1') : base);

const FRONT_SOURCES = [
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/other/showdown/${id}.gif`, shiny),
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/versions/generation-v/black-white/animated/${id}.gif`, shiny),
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/other/home/${id}.png`, shiny),
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/${id}.png`, shiny),
];

const BACK_SOURCES = [
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/other/showdown/back/${id}.gif`, shiny),
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/versions/generation-v/black-white/animated/back/${id}.gif`, shiny),
  (id, shiny) => shinyPath(`${SPRITES}/pokemon/back/${id}.png`, shiny),
];

/**
 * The icon sets are published in one palette only, so these take no variant:
 * the shiny icon is derived rather than downloaded.
 */
const ICON_SOURCES = [
  (id) => `${SPRITES}/pokemon/versions/generation-viii/icons/${id}.png`,
  (id) => `${SPRITES}/pokemon/versions/generation-vii/icons/${id}.png`,
  (id) => `${SPRITES}/pokemon/${id}.png`,
];

/**
 * The box icon in the alternate palette.
 *
 * The two front sprites have to have come from the same source to be the same
 * drawing twice — a species animated in one set and still in another gives a
 * pair that do not line up, and no colour could be read off them — so a
 * mismatch simply yields no shiny icon, and that Pokémon walks the field in
 * its ordinary colours.
 *
 * @param {{png: Buffer, meta: any}} icon
 * @param {any} plain the ordinary front strip
 * @param {any} shiny the alternate front strip
 */
function shinyIcon(icon, plain, shiny) {
  if (!plain?.first || !shiny?.first) return null;
  if (shiny.source !== shinyPath(plain.source, true)) return null;

  const shift = paletteShift(plain.first, shiny.first);
  if (shift.size === 0) return null;

  const recoloured = recolour(decodePng(icon.png), shift);
  return {
    png: encodePng(recoloured.width, recoloured.height, recoloured.data),
    meta: icon.meta,
  };
}

/**
 * The box icon, trimmed to its opaque area.
 *
 * The published icons float inside a fixed 68x56 canvas, which is fine for a
 * grid cell and useless in the field, where the sprite has to stand on the
 * ground — the padding would hold it in the air. Trimmed, the bottom edge is
 * the Pokémon's feet, and the size is already in proportion to the 16px map
 * tiles, so this doubles as the overworld sprite.
 *
 * @param {string[]} urls
 * @returns {Promise<{png: Buffer, meta: {width: number, height: number}}|null>}
 */
async function buildIcon(urls) {
  for (const url of urls) {
    const buffer = await fetchBuffer(url, { allowMissing: true });
    if (!buffer) continue;

    const png = decodePng(buffer);
    const bounds = opaqueBounds(png);
    if (!bounds) continue;

    const trimmed = crop(png, bounds.x, bounds.y, bounds.width, bounds.height);
    return {
      png: encodePng(trimmed.width, trimmed.height, trimmed.data),
      meta: { width: trimmed.width, height: trimmed.height },
    };
  }
  return null;
}

/**
 * Decode the first source that answers, resample it to the frame cap the
 * renderer animates at, trim every frame to the animation's
 * shared bounding box, and lay the frames out side by side.
 *
 * @param {string[]} urls
 * @returns {Promise<{
 *   png: Buffer,
 *   source: string,
 *   first: {width: number, height: number, data: Uint8Array|Buffer},
 *   meta: {width: number, height: number, frames: number, delay: number},
 * }|null>}
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
      // Which source answered, and its first frame before any trimming: the
      // pair a shiny icon is read from has to be untrimmed to line up, since
      // two palettes need not leave the same transparent margin.
      source: url,
      first: { width: decoded.width, height: decoded.height, data: frames[0].data },
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
