/**
 * The renderer's whole view of the system.
 *
 * Everything the game needs from Node — settings, save slots, window control —
 * goes through these channels, so the renderer itself stays plain DOM, Canvas
 * and WebAudio. Game data and assets are served over the `pdc://` protocol
 * instead, so the renderer can `fetch` them like any web app.
 */
import { app, ipcMain, net, protocol } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ASSET_DIR, AUTHORED_DIR, DATA_DIR } from './paths.mjs';
import { deleteSlot, listSlots, readSlot, writeSlot } from './save.mjs';
import { loadSettings, saveSettings, SCALE_STEPS } from './settings.mjs';
import { applyScale, getWindow } from './window.mjs';

/** Roots the `pdc://` protocol will serve, by host name. */
const ROOTS = { assets: ASSET_DIR, data: DATA_DIR, authored: AUTHORED_DIR };

/** Must run before `app.ready`. */
export function registerProtocolScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'pdc',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // The renderer is a file:// page, so every pdc:// read is cross-origin.
        corsEnabled: true,
      },
    },
  ]);
}

export function registerProtocolHandler() {
  protocol.handle('pdc', async (request) => {
    const url = new URL(request.url);
    const root = ROOTS[url.hostname];
    if (!root) return new Response('Unknown asset root', { status: 404 });

    // Reject anything that escapes its root, however it was encoded.
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (relative.split(sep).includes('..')) return new Response('Forbidden', { status: 403 });

    const response = await net.fetch(pathToFileURL(join(root, relative)).toString());
    if (!response.ok) return response;

    // Re-issue with the CORS header the file:// renderer needs to read it.
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(response.body, { status: response.status, headers });
  });
}

export function registerHandlers() {
  handle('settings:get', () => loadSettings());

  handle('settings:set', async (patch) => {
    const before = await loadSettings();
    const settings = await saveSettings(patch);
    if (settings.scale !== before.scale) applyScale(settings.scale);
    return settings;
  });

  handle('settings:scaleSteps', () => SCALE_STEPS);

  handle('saves:list', () => listSlots());
  handle('saves:read', (slot) => readSlot(slot));
  handle('saves:write', ({ slot, save }) => writeSlot(slot, save));
  handle('saves:delete', (slot) => deleteSlot(slot));

  handle('window:position', async () => {
    const window = getWindow();
    if (!window) return null;
    const [x, y] = window.getPosition();
    await saveSettings({ windowX: x, windowY: y });
    return { x, y };
  });

  handle('window:minimize', () => {
    getWindow()?.minimize();
    return true;
  });

  handle('app:quit', async ({ slot, save } = {}) => {
    // "Save and quit" must not lose the run if the write fails.
    if (Number.isInteger(slot) && save) await writeSlot(slot, save);
    app.quit();
    return true;
  });
}

/**
 * Wrap a handler so a thrown error reaches the renderer as a rejected promise
 * with a readable message rather than Electron's opaque serialization error.
 * @param {string} channel
 * @param {(payload: any) => any} fn
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return await fn(payload);
    } catch (error) {
      throw new Error(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
