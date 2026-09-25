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
 * They are drawn for the handhelds' followers, most of them about twice the
 * collab's size, so a sheet is brought down to half — shrunk as pixel art,
 * its outline kept whole — wherever that lands nearer the size the collab would have drawn
 * it, and kept whole where it does not: a Rapid Strike Urshifu beside the
 * collab's Single Strike one, a small Pokémon the packs draw small. The row facing right is the walk, its
 * first frame the stand, and past the last box icon the row facing down is
 * the icon, the way the collab's own standing frame stands in there.
 */
import { join } from 'node:path';

import { writeOut } from '../lib/http.mjs';
import { vendored } from '../lib/vendor.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { concatX, crop, doubledPixels, opaqueBounds, shrinkPixelArt, undouble } from '../lib/image.mjs';

/** The rows of a follower sheet. */
const FACING_DOWN = 0;
const FACING_RIGHT = 2;

/** How much of a sheet has to be two-by-two blocks for it to count as blown up to twice its size. */
const DOUBLED = 0.95;

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
  'urshifu-rapid-strike': 'URSHIFU_1',
  'oinkologne-female': 'OINKOLOGNE_1',
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
 *   drawnShinies?: Set<string>,
 * }} context
 * @returns {Promise<{source: string, url: string, license: string, artists: string[]}|null>} the credit
 *   for the sheets used, or null when none were
 */
export async function buildFollowers({ assetDir, species, manifest, ids, lastBoxIcon, pool, log, drawnShinies }) {
  /** @type {Array<{id: number, slug: string, key: string, icon: boolean, female?: boolean}>} */
  const wanted = [];
  for (const id of ids) {
    const entry = manifest[id];
    if (!entry) continue;
    if (!entry.walk) {
      const dex = species[id]?.dex ?? id;
      wanted.push({ id, slug: species[id]?.slug ?? '', key: '', icon: dex > lastBoxIcon });
      // And her, where the packs draw the female apart (`PYROAR_female`).
      if (!species[id]?.regional) wanted.push({ id, slug: species[id]?.slug ?? '', key: '-female', icon: false, female: true });
    }
    for (const forme of species[id]?.forms ?? []) {
      if (!entry[`walk-form-${forme.slug}`] && ESSENTIALS_NAMES[forme.slug]) {
        wanted.push({ id, slug: forme.slug, key: `-form-${forme.slug}`, icon: false });
      }
    }
  }

  const expected = expectedHeights(species, manifest);
  const found = [];
  const missing = [];
  const females = [];
  const whole = [];
  const shrunk = [];
  await Promise.all(
    wanted.map((want) =>
      pool(async () => {
        const name = `${essentialsName(want.slug)}${want.female ? '_female' : ''}`;
        const entry = manifest[want.id];
        entry.shiny ??= {};
        let built = false;
        /** Whether this sheet is drawn at half its size, decided on the ordinary one. @type {boolean|null} */
        let half = null;
        for (const variant of [
          { folder: 'Followers', suffix: '', into: entry },
          { folder: 'Followers shiny', suffix: '-shiny', into: entry.shiny },
        ]) {
          const source = await vendored('essentials', `Graphics/Characters/${variant.folder}/${name}.png`);
          if (!source) continue;
          const full = decodePng(source);
          // Most of the packs' sheets are pixel art blown up to twice its
          // size, and come back to their own pixels at half, losing nothing
          // — which is what every one of them is drawn at, whatever size that
          // makes it, so each pixel is the size of every other Pokémon's. A
          // sheet drawn at its own pixels is drawn whole, or shrunk as pixel
          // art where whole is far off the size the collab would have drawn.
          // Read frame by frame off the row this game draws: a sheet can be
          // blown up in one direction's row and drawn afresh in another's,
          // and the blocks of one frame need not sit on the next one's parity.
          const doubled = rowDoubled(full, FACING_RIGHT);
          if (half === null) {
            if (doubled) {
              half = true;
            } else {
              const tall = strip(full, FACING_RIGHT, Math.floor(full.width / 4), Math.floor(full.height / 4), [0, 1, 2, 3])?.meta.height;
              const aim = expected(want);
              half = !tall || !aim || Math.abs(Math.log(tall / 2 / aim)) <= Math.abs(Math.log(tall / aim));
              (half ? shrunk : whole).push(`${want.slug}${want.female ? ' (female)' : ''}`);
            }
          }
          const sheet = !half ? full : doubled ? undoubleSheet(full) : halve(full);
          const width = Math.floor(sheet.width / 4);
          const height = Math.floor(sheet.height / 4);
          const walk = strip(sheet, FACING_RIGHT, width, height, [0, 1, 2, 3]);
          const idle = strip(sheet, FACING_RIGHT, width, height, [0]);
          if (!walk || !idle) continue;
          for (const [pose, art] of /** @type {const} */ ([['walk', walk], ['idle', idle]])) {
            await writeOut(join(assetDir, 'pokemon', String(want.id), `${pose}${want.key}${variant.suffix}.png`), art.png);
            variant.into[`${pose}${want.key}`] = art.meta;
            // The packs draw every shiny as a shiny.
            if (variant.suffix) drawnShinies?.add(`${want.id}:${pose}${want.key}`);
          }
          if (want.icon) {
            const icon = still(sheet, FACING_DOWN, width, height);
            if (icon) {
              await writeOut(join(assetDir, 'pokemon', String(want.id), `icon${variant.suffix}.png`), icon.png);
              variant.into.icon = icon.meta;
              entry.iconFrom = 'followers';
            }
          }
          if (!variant.suffix) built = true;
        }
        // A species drawn the same for both sexes has no female sheet, which
        // is no miss.
        if (!want.female) (built ? found : missing).push(want.slug);
        else if (built) females.push(want.slug);
      }),
    ),
  );

  log(`followers ${found.length} from Pokémon Essentials (${females.length} with a female of their own; drawn at their own pixels whole: ${whole.join(', ') || 'none'}; shrunk: ${shrunk.join(', ') || 'none'})${missing.length ? `, not drawn there either: ${missing.join(', ')}` : ''}`);
  if (!found.length) return null;
  return {
    source: 'Pokémon Essentials Gen 8/9 resource packs',
    url: 'https://eeveeexpo.com/resources/1101/',
    license: 'free for fan projects, with credit',
    artists: await overworldArtists(),
  };
}

/**
 * How tall the collab would have drawn a Pokémon it has not drawn.
 *
 * A variety, a female or a forme of a species the collab draws is its
 * species' walking height. Anything else is read off the collab's own habit:
 * across every species it draws, the height of the walk against the
 * Pokédex height, fitted as a power — a Wailord is not drawn forty times a
 * Diglett's height, and the fit knows by how much it is not.
 *
 * @param {Record<string, any>} species
 * @param {Record<string, any>} manifest as the collab left it
 * @returns {(want: {id: number}) => number|null}
 */
function expectedHeights(species, manifest) {
  const points = Object.values(species)
    .filter((entry) => !entry.regional && entry.height > 0 && manifest[entry.id]?.walk?.height)
    .map((entry) => [Math.log(entry.height), Math.log(manifest[entry.id].walk.height)]);
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / (points.length || 1);
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / (points.length || 1);
  let covariance = 0;
  let variance = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  }
  const slope = variance ? covariance / variance : 0;
  return (want) => {
    const entry = species[want.id];
    const own = manifest[entry?.dex ?? want.id]?.walk?.height;
    if (own) return own;
    if (!entry?.height || !points.length) return null;
    return Math.exp(meanY + slope * (Math.log(entry.height) - meanX));
  };
}

/**
 * Whether every frame of a sheet's row is pixel art blown up to twice its
 * size.
 *
 * @param {import('../lib/image.mjs').Raster} sheet four frames by four rows
 * @param {number} row
 */
function rowDoubled(sheet, row) {
  const width = Math.floor(sheet.width / 4);
  const height = Math.floor(sheet.height / 4);
  return [0, 1, 2, 3].every((column) => doubledPixels(crop(sheet, column * width, row * height, width, height)).share >= DOUBLED);
}

/**
 * A sheet blown up to twice its size, back at its own pixels frame by frame,
 * each on the parity its own blocks sit on; a frame that is not blown up is
 * shrunk as pixel art.
 *
 * @param {import('../lib/image.mjs').Raster} sheet four frames by four rows
 */
function undoubleSheet(sheet) {
  const width = Math.floor(sheet.width / 4);
  const height = Math.floor(sheet.height / 4);
  const half = { width: Math.floor(width / 2), height: Math.floor(height / 2) };
  const out = { width: half.width * 4, height: half.height * 4, data: new Uint8Array(half.width * 4 * half.height * 4 * 4) };
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const cell = crop(sheet, column * width, row * height, width, height);
      const parity = doubledPixels(cell);
      const small = parity.share >= DOUBLED ? undouble(cell, parity) : shrinkPixelArt(cell);
      for (let y = 0; y < Math.min(small.height, half.height); y++) {
        for (let x = 0; x < Math.min(small.width, half.width); x++) {
          const from = (y * small.width + x) * 4;
          out.data.set(small.data.subarray(from, from + 4), ((row * half.height + y) * out.width + column * half.width + x) * 4);
        }
      }
    }
  }
  return out;
}

/**
 * A sheet at half its size, shrunk as pixel art (see `shrinkPixelArt`): the
 * outline kept whole and each shape in its own colour, rather than a pixel
 * of every two by two from a fixed corner.
 *
 * @param {import('../lib/image.mjs').Raster} sheet
 */
export const halve = (sheet) => shrinkPixelArt(sheet);

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
  const text = (await vendored('essentials', 'gen9_credits.txt'))?.toString('utf8') ?? '';
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
