#!/usr/bin/env electron
/**
 * One-shot check for the drag fix: boot the real game at scale 2, grab the
 * drag strip the way a pointer does, move it, and confirm the window itself
 * moved through the `window:moveBy` channel.
 *
 *   xvfb-run -a npx electron --no-sandbox dev/tools/check-drag.mjs
 */
import { app } from 'electron';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.setPath('userData', await mkdtemp(join(tmpdir(), 'pdc-drag-')));

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../app/main/ipc.mjs');
const { loadSettings } = await import('../../app/main/settings.mjs');
const { createWindow } = await import('../../app/main/window.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.commandLine.appendSwitch('disable-gpu');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();

  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 100, windowY: 100 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));

  await delay(2000);

  const before = window.getPosition();
  const dragged = await window.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('dragbar');
    if (!bar) return { error: 'no dragbar' };
    const at = (x, y) => ({ bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y });
    bar.dispatchEvent(new PointerEvent('pointerdown', at(300, 5)));
    for (let i = 1; i <= 10; i++) bar.dispatchEvent(new PointerEvent('pointermove', at(300 + i * 5, 5 + i * 3)));
    bar.dispatchEvent(new PointerEvent('pointerup', at(350, 35)));
    return { moved: true };
  })()`);
  await delay(300);
  const after = window.getPosition();

  console.log('drag result:', JSON.stringify(dragged));
  console.log(`position: ${before.join(',')} -> ${after.join(',')}`);
  const [x0, y0] = before;
  const [x1, y1] = after;
  if (!dragged.moved) return fail(`drag did not run: ${JSON.stringify(dragged)}`);
  if (Math.abs(x1 - x0 - 50) > 6 || Math.abs(y1 - y0 - 30) > 6) {
    return fail(`window did not follow the pointer (expected +50,+30, saw ${x1 - x0},${y1 - y0})`);
  }

  console.log('PASS: the drag strip moves the window through window:moveBy');
  app.exit(0);

  function fail(message) {
    console.error(`FAIL: ${message}`);
    app.exit(1);
  }
}).catch((error) => {
  console.error('FAIL:', error);
  app.exit(1);
});
