/**
 * Application entry point.
 *
 * A single always-on-top companion window; a second launch focuses the first
 * rather than opening another pet.
 */
import { app, BrowserWindow } from 'electron';

import { registerHandlers, registerProtocolHandler, registerProtocolScheme } from './ipc.mjs';
import { cleanTemporaryFiles } from './save.mjs';
import { loadSettings } from './settings.mjs';
import { createWindow, getWindow } from './window.mjs';

registerProtocolScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = getWindow();
    if (window) {
      window.show();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    registerProtocolHandler();
    registerHandlers();
    await cleanTemporaryFiles();
    createWindow(await loadSettings());

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(await loadSettings());
    });
  });

  // The companion is the whole app: closing its window ends the session on
  // every platform, macOS included.
  app.on('window-all-closed', () => app.quit());
}
