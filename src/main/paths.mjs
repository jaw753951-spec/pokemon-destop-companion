/**
 * Where the app's files live, in development and inside a packaged build.
 *
 * `npm run assets` writes into the repository, while `electron-builder` copies
 * the same directories into `process.resourcesPath` via `extraResources`, so
 * every lookup checks the packaged location first and falls back to the repo.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this module rather than `app.getAppPath()`, which points at
// whichever entry file Electron was handed — not the project root when a tool
// such as the screenshot harness boots the app itself.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** @param {string} name a top-level directory such as `assets` or `data` */
function resolve(name) {
  const packaged = join(process.resourcesPath ?? '', name);
  if (existsSync(packaged)) return packaged;
  return join(REPO_ROOT, name);
}

export const ASSET_DIR = resolve('assets');
export const DATA_DIR = join(resolve('data'), 'generated');
export const AUTHORED_DIR = join(resolve('data'), 'authored');
export const RENDERER_DIR = join(REPO_ROOT, 'src', 'renderer');

/** Per-user state: settings and save slots. Never inside the app bundle. */
export const USER_DIR = app.getPath('userData');
export const SAVE_DIR = join(USER_DIR, 'saves');
export const SETTINGS_FILE = join(USER_DIR, 'settings.json');
