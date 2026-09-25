/**
 * Walking art for the Pokémon the Sprite Collab has not drawn, from the
 * follower sprites of the Pokémon Essentials resource packs.
 *
 * The collab leaves 55 species and a handful of formes without a walk: the
 * species walked in their box icon — or, past the last generation the icons
 * reach, in a model render twice the size of anything else on the road — and
 * the formes in their species' art, so a Therian Tornadus walked as an
 * Incarnate one. The Essentials packs draw a follower for nearly every one of
 * them: four rows of four frames, facing down, left, right and up.
 *
 * They are drawn for the handhelds' followers, about twice the collab's size,
 * so every sheet is brought down to half — one pixel kept of every two by two,
 * from whichever of the four positions keeps the most of the Pokémon — which
 * puts it at the collab's density. The row facing right is the walk, its
 * first frame the stand, and past the last box icon the row facing down is
 * the icon, the way the collab's own standing frame stands in there.
 */
import { join } from 'node:path';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, opaqueBounds } from '../lib/image.mjs';
import { ESSENTIALS } from '../sources.mjs';

/** The rows of a follower sheet. */
const FACING_DOWN = 0;
const FACING_RIGHT = 2;

/** How long each walking frame shows: ten of the handheld's sixtieths, as the collab's walks mostly run. */
const FRAME_MS = Math.round((10 * 1000) / 60);

/**
 * The packs' names for the species and formes whose name is not their slug
 * run together in capitals (`iron-crown` → `IRONCROWN`): a forme is its
 * species' name and the form's number there, and Mabosstiff is spelled with
 * one S.
 *
 * @type {Record<string, string>}
 */
const ESSENTIALS_NAMES = {
  mabosstiff: 'MABOSTIFF',
  'stunfisk-galar': 'STUNFISK_1',
  'tornadus-therian': 'TORNADUS_1',
  'thundurus-therian': 'THUNDURUS_1',
  'keldeo-resolute': 'KELDEO_1',
  'oricorio-sensu': 'ORICORIO_3',
  'necrozma-dusk': 'NECROZMA_1',
  'necrozma-dawn': 'NECROZMA_2',
  'calyrex-ice': 'CALYREX_1',
  'calyrex-shadow': 'CALYREX_2',
};

/** @param {string} slug */
export const essentialsName = (slug) => ESSENTIALS_NAMES[slug] ?? slug.toUpperCase().replace(/-/g, '');

/**
 * Give walking art to every species and forme the collab left without it.
 *
 * @param {{
 *   assetDir: string,
 *   species: Record<string, any>,
 *   manifest: Record<string, any>,
 *   ids: number[],
 *   lastBoxIcon: number,
 *   pool: <T>(task: () => Promise<T>) => Promise<T>,
 *   log: (message: string) => void,
 * }} context
 * @returns {Promise<{source: string, url: string, license: string, artists: string[]}|null>} the credit
 *   for the sheets used, or null when none were
 */
export async function buildFollowers({ assetDir, species, manifest, ids, lastBoxIcon, pool, log }) {
  /** @type {Array<{id: number, slug: string, key: string, icon: boolean}>} */
  const wanted = [];
  for (const id of ids) {
    const entry = manifest[id];
    if (!entry) continue;
    if (!entry.walk) {
      const dex = species[id]?.dex ?? id;
      wanted.push({ id, slug: species[id]?.slug ?? '', key: '', icon: dex > lastBoxIcon });
    }
    for (const forme of species[id]?.forms ?? []) {
      if (!entry[`walk-form-${forme.slug}`] && ESSENTIALS_NAMES[forme.slug]) {
        wanted.push({ id, slug: forme.slug, key: `-form-${forme.slug}`, icon: false });
      }
    }
  }

  const found = [];
  const missing = [];
  await Promise.all(
    wanted.map((want) =>
      pool(async () => {
        const name = essentialsName(want.slug);
        const entry = manifest[want.id];
        entry.shiny ??= {};
        let built = false;
        for (const variant of [
          { folder: 'Followers', suffix: '', into: entry },
          { folder: 'Followers shiny', suffix: '-shiny', into: entry.shiny },
        ]) {
          const source = await fetchBuffer(
            `${ESSENTIALS}/Graphics/Characters/${encodeURIComponent(variant.folder)}/${name}.png`,
            { allowMissing: true },
          );
          if (!source) continue;
          const sheet = halve(decodePng(source));
          const width = Math.floor(sheet.width / 4);
          const height = Math.floor(sheet.height / 4);
          const walk = strip(sheet, FACING_RIGHT, width, height, [0, 1, 2, 3]);
          const idle = strip(sheet, FACING_RIGHT, width, height, [0]);
          if (!walk || !idle) continue;
          for (const [pose, art] of /** @type {const} */ ([['walk', walk], ['idle', idle]])) {
            await writeOut(join(assetDir, 'pokemon', String(want.id), `${pose}${want.key}${variant.suffix}.png`), art.png);
            variant.into[`${pose}${want.key}`] = art.meta;
          }
          if (want.icon) {
            const icon = still(sheet, FACING_DOWN, width, height);
            if (icon) {
              await writeOut(join(assetDir, 'pokemon', String(want.id), `icon${variant.suffix}.png`), icon.png);
              variant.into.icon = icon.meta;
            }
          }
          if (!variant.suffix) built = true;
        }
        (built ? found : missing).push(want.slug);
      }),
    ),
  );

  log(`followers ${found.length} from Pokémon Essentials${missing.length ? `, not drawn there either: ${missing.join(', ')}` : ''}`);
  if (!found.length) return null;
  return {
    source: 'Pokémon Essentials Gen 8/9 resource packs',
    url: 'https://eeveeexpo.com/resources/1101/',
    license: 'free for fan projects, with credit',
    artists: await overworldArtists(),
  };
}

/**
 * A sheet at half its size: of every two by two pixels, the one at whichever
 * of the four positions keeps the most of the drawing across the sheet, so a
 * one-pixel outline or a thin tail is not dropped for falling on the wrong
 * parity.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 */
export function halve(sheet) {
  const width = Math.floor(sheet.width / 2);
  const height = Math.floor(sheet.height / 2);
  let best = { dx: 0, dy: 0, kept: -1 };
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    let kept = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) if (sheet.data[((y * 2 + dy) * sheet.width + x * 2 + dx) * 4 + 3]) kept++;
    }
    if (kept > best.kept) best = { dx, dy, kept };
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((y * 2 + best.dy) * sheet.width + x * 2 + best.dx) * 4;
      data.set(sheet.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/**
 * Frames of one row, cut to one box shared by all of them — down to the
 * lowest foot and as wide either side of the frame's centre as the widest
 * reach — so the Pokémon does not slide about between frames.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {number} row
 * @param {number} width
 * @param {number} height
 * @param {number[]} columns
 */
function strip(sheet, row, width, height, columns) {
  const frames = columns.map((column) => crop(sheet, column * width, row * height, width, height));
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const frame of frames) {
    const bounds = opaqueBounds(frame);
    if (!bounds) continue;
    left = Math.min(left, bounds.x);
    right = Math.max(right, bounds.x + bounds.width);
    top = Math.min(top, bounds.y);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  if (!Number.isFinite(left)) return null;
  const centre = width / 2;
  const reach = Math.ceil(Math.max(centre - left, right - centre));
  const x = Math.max(0, Math.floor(centre - reach));
  const box = { x, y: top, width: Math.min(width, Math.ceil(centre + reach)) - x, height: bottom - top };
  const out = concatX(frames.map((frame) => crop(frame, box.x, box.y, box.width, box.height)));
  const durations = frames.map(() => (frames.length > 1 ? FRAME_MS : 1000));
  return {
    png: encodePng(out.width, out.height, out.data),
    meta: { width: box.width, height: box.height, frames: frames.length, durations, delay: durations[0] },
  };
}

/**
 * The first frame of a row, trimmed to the Pokémon: a box icon.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 * @param {number} row
 * @param {number} width
 * @param {number} height
 */
function still(sheet, row, width, height) {
  const frame = crop(sheet, 0, row * height, width, height);
  const bounds = opaqueBounds(frame);
  if (!bounds) return null;
  const icon = crop(frame, bounds.x, bounds.y, bounds.width, bounds.height);
  return { png: encodePng(icon.width, icon.height, icon.data), meta: { width: icon.width, height: icon.height } };
}

/**
 * Everyone the packs credit for their Pokémon overworlds, read from the
 * credits file shipped beside the sprites.
 *
 * @returns {Promise<string[]>}
 */
async function overworldArtists() {
  const text = (await fetchBuffer(`${ESSENTIALS}/gen9_credits.txt`, { allowMissing: true }))?.toString('utf8') ?? '';
  return parseOverworldArtists(text);
}

/**
 * The names on the credits file's "Pokemon Overworlds" lines.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseOverworldArtists(text) {
  // The file names some artists twice, once with a space ("Larry Turbo",
  // "LarryTurbo"); the first spelling is kept.
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^-.*Pokemon Overworlds\s*-\s*(.+)$/);
    if (!match) continue;
    for (const raw of match[1].split(',')) {
      const name = raw.trim();
      const key = name.replace(/\s+/g, '').toLowerCase();
      if (name && !names.has(key)) names.set(key, name);
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}
