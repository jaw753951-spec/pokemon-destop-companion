#!/usr/bin/env electron
/**
 * One-shot check for the item ball lying on the path: renders the closed and
 * opened shapes with the real `drawBall` and verifies two things the drawing
 * got wrong.
 *
 * The icon is deliberately *not* square. The pipeline trims every item icon to
 * its opaque pixels, so almost none of them are, and the opened ball was
 * reading one number off the image's height and using it as the source
 * rectangle's width too — which sampled a tall slice of a wide picture and
 * stretched it across the whole ball. That is what "the image breaks" looked
 * like. A stripe down the right-hand edge of the test icon can only appear in
 * the output if the whole width was sampled.
 *
 * The second check is the older one: the opened lid has to stay inside the
 * ball's own footprint rather than overhanging it.
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
      const { BALL_LID_TIP, BALL_SIZE, drawBall } = await import('./scenes/fieldevents.mjs');
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
      drawBall(context, { sprite: { image }, frame: 'open' }, openX);

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

      // The opened ball may not stray outside the room the drawing gives it:
      // its own width, plus the distance the lid is meant to tip forward on
      // the right. Overhanging beyond that was the older bug.
      const ground = groundY();
      const left = Math.round(openX - BALL_SIZE / 2);
      const right = Math.ceil(left + BALL_SIZE * (1 + BALL_LID_TIP)) + 1;
      for (let y = Math.max(0, ground - 24); y < ground; y++) {
        for (let x = left - 5; x < left; x++) {
          if (!isBackground(x, y)) return { fail: \`overhang left at \${x},\${y}\` };
        }
        for (let x = right; x < right + 5; x++) {
          if (!isBackground(x, y)) return { fail: \`overhang right at \${x},\${y}\` };
        }
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
