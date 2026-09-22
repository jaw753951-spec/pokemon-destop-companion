#!/usr/bin/env electron
/**
 * One-shot check for the item ball lying on the path: renders it closed, part
 * way through being collected, and once it has gone.
 *
 * The icon is deliberately *not* square. The pipeline trims every item icon to
 * its opaque pixels, so almost none of them are, and one number read off the
 * image's height cannot stand for its width too — a stripe down the right-hand
 * edge of the test icon can only appear in the output if the whole width was
 * sampled.
 *
 * And a collected ball leaves nothing behind, as it does on the games' own
 * maps: past the fade there must be no ball on the ground at all.
 *
 *   xvfb-run -a npx electron --no-sandbox dev/tools/check-ball.mjs
 */
import { app } from 'electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 0, windowY: 0 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));
  await delay(1500);

  // One in-page script: the drawing, the reading back and the verdict all
  // happen where the module lives.
  const check = await window.webContents.executeJavaScript(`(async () => {
    try {
      const { BALL_FADE_MS, BALL_SIZE, drawBall } = await import('./scenes/fieldevents.mjs');
      const { groundY } = await import('./render/field.mjs');

      // A wide, short icon — the shape a trimmed item icon really is. Red lid
      // over a green base, with a blue stripe down the right-hand edge that
      // only a full-width sample can reach.
      const source = document.createElement('canvas');
      source.width = 32;
      source.height = 20;
      const paint = source.getContext('2d');
      paint.fillStyle = 'rgb(220, 60, 60)';
      paint.fillRect(0, 0, 32, 10);
      paint.fillStyle = 'rgb(60, 200, 90)';
      paint.fillRect(0, 10, 32, 10);
      paint.fillStyle = 'rgb(40, 80, 230)';
      paint.fillRect(26, 0, 6, 20);

      const image = new Image();
      image.src = source.toDataURL('image/png');
      await image.decode();

      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 110;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = false;
      const bg = [127, 176, 105];
      context.fillStyle = 'rgb(127, 176, 105)';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const closedX = 40;
      const openX = 110;
      drawBall(context, { sprite: { image }, frame: 'closed' }, closedX);
      // The frame it opens on: still there at full strength, still the whole
      // icon. Later frames are the same picture fading, so a sample of one of
      // those would be testing the alpha rather than the source rectangle.
      drawBall(context, { sprite: { image }, frame: 'open' }, openX, 0);

      const { width, height } = canvas;
      const data = context.getImageData(0, 0, width, height).data;
      const at = (x, y) => {
        const i = (y * width + x) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const near = (a, b) => Math.abs(a[0] - b[0]) < 24 && Math.abs(a[1] - b[1]) < 24 && Math.abs(a[2] - b[2]) < 24;
      const isBackground = (x, y) => near(at(x, y), bg);

      /** Is the stripe anywhere in this column band? */
      const hasStripe = (fromX, toX) => {
        for (let y = 0; y < height; y++) {
          for (let x = fromX; x < toX; x++) {
            if (near(at(x, y), [40, 80, 230])) return true;
          }
        }
        return false;
      };

      if (!hasStripe(closedX - 12, closedX + 12)) return { fail: 'the closed ball lost the right of its icon' };
      if (!hasStripe(openX - 12, openX + 16)) return { fail: 'the opened ball lost the right of its icon' };

      // A ball keeps to its own column, opened or not: nothing may appear in
      // the five columns either side of the width it is drawn at.
      const ground = groundY();
      const left = Math.round(openX - BALL_SIZE / 2);
      const right = left + BALL_SIZE;
      for (let y = 0; y < ground; y++) {
        for (let x = left - 5; x < left; x++) {
          if (!isBackground(x, y)) return { fail: \`stray left at \${x},\${y}\` };
        }
        for (let x = right; x < right + 5; x++) {
          if (!isBackground(x, y)) return { fail: \`stray right at \${x},\${y}\` };
        }
      }

      // And once the fade is over there is nothing left of it at all.
      const gone = document.createElement('canvas');
      gone.width = width;
      gone.height = height;
      const after = gone.getContext('2d');
      after.imageSmoothingEnabled = false;
      after.fillStyle = 'rgb(127, 176, 105)';
      after.fillRect(0, 0, width, height);
      drawBall(after, { sprite: { image }, frame: 'open' }, openX, BALL_FADE_MS + 1);
      const leftovers = after.getImageData(0, 0, width, height).data;
      for (let i = 0; i < leftovers.length; i += 4) {
        const pixel = [leftovers[i], leftovers[i + 1], leftovers[i + 2]];
        if (!near(pixel, bg)) return { fail: 'a collected ball was still on the ground' };
      }

      return { png: canvas.toDataURL('image/png') };
    } catch (error) {
      return { fail: String(error && error.stack ? error.stack : error) };
    }
  })()`);

  if (check.fail) return fail(check.fail);
  await mkdir('shots', { recursive: true });
  await writeFile('shots/check-ball.png', Buffer.from(check.png.replace(/^data:image\/png;base64,/, ''), 'base64'));

  console.log('PASS: the ball keeps its whole icon and stays inside its footprint (shots/check-ball.png)');
  app.exit(0);
}).catch((error) => {
  console.error('FAIL:', error);
  app.exit(1);
});
