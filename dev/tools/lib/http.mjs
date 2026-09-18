/**
 * Cached, rate-limited HTTP downloader for the asset pipeline.
 *
 * Every remote read in the pipeline goes through here so that re-runs are cheap
 * (disk cache), flaky networks recover (retry with backoff), and we never open
 * more sockets than the host tolerates (semaphore).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_DIR = process.env.PDC_CACHE_DIR || join(process.cwd(), '.cache', 'http');

/** Marker file contents for URLs that answered 404, so we don't re-ask every run. */
const MISSING = Buffer.from('\u0000PDC_MISSING\u0000');

/**
 * Bounded-concurrency task runner.
 * @param {number} limit
 */
export function createPool(limit) {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];

  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  return async function run(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(() => resolve()));
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** @param {string} url */
function cachePathFor(url) {
  const hash = createHash('sha256').update(url).digest('hex');
  return join(CACHE_DIR, hash.slice(0, 2), hash.slice(2));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download a URL, answering from the disk cache when possible.
 *
 * @param {string} url
 * @param {{retries?: number, allowMissing?: boolean, noCache?: boolean}} [options]
 * @returns {Promise<Buffer|null>} `null` when the server answered 404 and
 *   `allowMissing` is set.
 */
export async function fetchBuffer(url, options = {}) {
  const { retries = 4, allowMissing = false, noCache = false } = options;
  const cachePath = cachePathFor(url);

  if (!noCache) {
    try {
      const cached = await readFile(cachePath);
      if (cached.equals(MISSING)) {
        if (allowMissing) return null;
        throw new Error(`Cached 404 for ${url}`);
      }
      return cached;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code !== 'ENOENT') throw err;
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 16000));
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.status === 404) {
        await writeCache(cachePath, MISSING);
        if (allowMissing) return null;
        throw new Error(`404 Not Found: ${url}`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const body = Buffer.from(await response.arrayBuffer());
      await writeCache(cachePath, body);
      return body;
    } catch (err) {
      lastError = err;
      // A cached 404 or an explicit 404 is final — do not burn retries on it.
      if (err instanceof Error && err.message.startsWith('404')) throw err;
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${url}\n  ${lastError}`);
}

/**
 * @param {string} url
 * @param {{retries?: number, allowMissing?: boolean}} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const buffer = await fetchBuffer(url, options);
  if (buffer === null) return null;
  return JSON.parse(buffer.toString('utf8'));
}

/** @param {string} path @param {Buffer} body */
async function writeCache(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

/**
 * Write a file to disk, creating parent directories as needed.
 * @param {string} path
 * @param {Buffer|string} body
 */
export async function writeOut(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

/** @param {string} path */
export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
