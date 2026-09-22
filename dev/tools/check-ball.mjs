#!/usr/bin/env electron
/**
 * One-shot check for the opened item ball: renders the closed and opened
 * shapes with the real `drawBall` and a real item-ball icon, and verifies the
 * opened lid stays inside the ball's own footprint — the "broken image" look
 * was the rotated halves overhanging it.
 *
 *   xvfb-run -a npx electron --no-sandbox dev/tools/check-ball.mjs
 */
import { app } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.setPath('userData', await mkdtemp(join(tmpdir(), 'pdc-ball-')));

const { registerHandlers, registerProtocolHandler, registerProtocolScheme } = await import('../../app/main/ipc.mjs');
const { loadSettings } = await import('../../app/main/settings.mjs');
const { createWindow } = await import('../../app/main/window.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.commandLine.appendSwitch('disable-gpu');
registerProtocolScheme();

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  app.exit(1);
};

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();

  // The real renderer page: it can import the game's own modules, as the
  // other check harnesses do.
  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 0, windowY: 0 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));
  await delay(1500);

  // One in-page script, so the drawn canvas never has to cross the IPC
  // boundary — a pdc:// image taints it, and a tainted canvas cannot export.
  const check = await window.webContents.executeJavaScript(`(async () => {
    try {
      const { drawBall } = await import('./scenes/fieldevents.mjs');

      // crossOrigin before src: the pdc:// protocol answers with the CORS
      // header, and without the attribute the image taints the canvas and
      // the pixels cannot be read back. (The game's own draws never read
      // pixels, which is why loadImage can skip the attribute.)
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = 'pdc://assets/items/poke-ball.png';
      await image.decode();
      const size = 24;
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 110;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = false;

      const bg = [127, 176, 105];
      context.fillStyle = 'rgb(127, 176, 105)';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const openX = 96;
      drawBall(context, { sprite: { image }, frame: 'closed' }, 24, size);
      drawBall(context, { sprite: { image }, frame: 'open' }, openX, size);

      await image.decode();
      const { width, height } = canvas;
      const data = context.getImageData(0, 0, width, height).data;
      const isBackground = (x, y) => {
        const i = (y * width + x) * 4;
        return Math.abs(data[i] - bg[0]) < 12 && Math.abs(data[i + 1] - bg[1]) < 12 && Math.abs(data[i + 2] - bg[2]) < 12;
      };

      // The opened ball's footprint is the square the closed one occupies.
      // Nothing opaque may appear in the four columns either side of it —
      // that overhang was the bug. Only rows the ball can reach are scanned:
      // the ball sits on the ground line it is drawn against (y = 90 down).
      const left = Math.round(openX - size / 2);
      const right = Math.round(openX + size / 2);
      const top = 90 - size;
      for (let y = top; y < 90; y++) {
        for (let x = left - 4; x < left; x++) {
          if (!isBackground(x, y)) return { fail: \`overhang at \${x},\${y}\` };
        }
        for (let x = right; x < right + 4; x++) {
          if (!isBackground(x, y)) return { fail: \`overhang at \${x},\${y}\` };
        }
      }

      return { png: canvas.toDataURL('image/png') };
    } catch (error) {
      return { fail: String(error && error.stack ? error.stack : error) };
    }
  })()`);

  if (check.fail) return fail(check.fail);
  await writeFile('shots/check-ball.png', Buffer.from(check.png.replace(/^data:image\/png;base64,/, ''), 'base64'));

  console.log('PASS: the opened ball stays inside its own footprint (shots/check-ball.png)');
  app.exit(0);
}).catch((error) => {
  console.error('FAIL:', error);
  app.exit(1);
});
