#!/usr/bin/env electron
/**
 * One-shot check for the drag fix: boot the real game at a given scale, grab
 * the drag strip the way a pointer does, move it, and confirm the window
 * followed — including the case a real pointer creates and a synthetic one
 * does not, where the window moving under a still pointer changes every
 * client coordinate with it.
 *
 *   xvfb-run -a npx electron --no-sandbox dev/tools/check-drag.mjs [scale]
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

  // Electron keeps its own switches in argv, so the scale is whichever
  // trailing argument reads as a number.
  const scale = Number(process.argv[process.argv.length - 1]) || 2;
  const window = createWindow({ ...(await loadSettings()), scale, windowX: 100, windowY: 100 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));

  await delay(2000);

  const before = window.getPosition();
  // Screen coordinates, because that is what the handler reads: they are
  // where the pointer is on the desk, and they do not change when the window
  // moves out from under it.
  const dragged = await window.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('dragbar');
    if (!bar) return { error: 'no dragbar' };
    const at = (x, y) => ({
      bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0,
      screenX: x, screenY: y, clientX: 300, clientY: 5,
    });
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

  // The shake, reproduced honestly: a pointer that is not moving at all, whose
  // client coordinates nevertheless change every event because the window is
  // being moved out from under it. Each event is built from where the window
  // actually is at that moment, which is what a real pointer would report.
  const send = (type, screenAt) => {
    const [wx, wy] = window.getPosition();
    return window.webContents.executeJavaScript(`(() => {
      const bar = document.getElementById('dragbar');
      bar.dispatchEvent(new PointerEvent('${type}', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0,
        screenX: ${screenAt.x}, screenY: ${screenAt.y},
        clientX: ${screenAt.x - wx}, clientY: ${screenAt.y - wy},
      }));
      return true;
    })()`);
  };

  const held = { x: 500, y: 200 };
  await send('pointerdown', held);
  const settled = window.getPosition();
  for (let i = 0; i < 12; i++) {
    await send('pointermove', held);
    await delay(20);
  }
  await send('pointerup', held);
  await delay(300);
  const still = window.getPosition();
  if (still[0] !== settled[0] || still[1] !== settled[1]) {
    return fail(`a still pointer moved the window: ${settled.join(',')} -> ${still.join(',')}`);
  }

  console.log(`PASS: the drag strip moves the window, and holds it still, at scale ${scale}`);
  app.exit(0);

  function fail(message) {
    console.error(`FAIL: ${message}`);
    app.exit(1);
  }
}).catch((error) => {
  console.error('FAIL:', error);
  app.exit(1);
});
