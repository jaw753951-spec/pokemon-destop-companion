/**
 * Files from other people's repositories that the build keeps a copy of here,
 * so a sprite does not vanish from the game the day its source does.
 *
 * Each source has a directory under `data/vendor/` holding the files the
 * build has used, at the paths they had there, and an `index.json` naming
 * them — and naming the paths the source was asked for and did not have, so
 * a build without the network answers those too. A path the index does not
 * know yet is fetched from the source, pinned to the commit the index
 * names, and filed here for the next commit; the build says which.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchBuffer } from './http.mjs';

/** Where the copies live. */
export const VENDOR_DIR = fileURLToPath(new URL('../../../data/vendor/', import.meta.url));

/**
 * @typedef {{source: string, commit: string, base: string, present: string[], absent: string[]}} VendorIndex
 */

/** Read once per source, however many files are asked for at once. @type {Map<string, Promise<VendorIndex>>} */
const indexes = new Map();
/** @type {Map<string, string[]>} paths filed this run, by source */
const filed = new Map();

/**
 * @param {string} source a directory under `data/vendor/`
 * @returns {Promise<VendorIndex>}
 */
function indexOf(source) {
  let index = indexes.get(source);
  if (!index) {
    index = readFile(join(VENDOR_DIR, source, 'index.json'), 'utf8').then((text) => JSON.parse(text));
    indexes.set(source, index);
  }
  return index;
}

/**
 * A file of a vendored source: the copy here, or — for a path this copy has
 * never been asked for — the source's own at the pinned commit, filed here.
 *
 * @param {string} source
 * @param {string} path the file's path in the source repository
 * @returns {Promise<Buffer|null>} null when the source does not have it, or
 *   could not be reached for a path never asked for before
 */
export async function vendored(source, path) {
  const index = await indexOf(source);
  if (index.present.includes(path)) return readFile(join(VENDOR_DIR, source, path));
  if (index.absent.includes(path)) return null;
  const url = `${index.base}/${index.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
  let body;
  try {
    body = await fetchBuffer(url, { allowMissing: true });
  } catch {
    // Unreachable is not absent: nothing is recorded, and the next build asks again.
    return null;
  }
  if (body) {
    await mkdir(dirname(join(VENDOR_DIR, source, path)), { recursive: true });
    await writeFile(join(VENDOR_DIR, source, path), body);
    index.present.push(path);
  } else {
    index.absent.push(path);
  }
  filed.set(source, [...(filed.get(source) ?? []), path]);
  return body;
}

/**
 * Write back what this run added to the indexes, and say what to commit.
 *
 * @param {(message: string) => void} log
 */
export async function saveVendored(log) {
  for (const [source, paths] of filed) {
    const index = await indexOf(source);
    index.present = [...new Set(index.present)].sort();
    index.absent = [...new Set(index.absent)].sort();
    await writeFile(join(VENDOR_DIR, source, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    log(`vendored ${source}: ${paths.length} path(s) new to data/vendor/${source} — commit them (${paths.slice(0, 6).join(', ')}${paths.length > 6 ? ', …' : ''})`);
  }
  filed.clear();
}
