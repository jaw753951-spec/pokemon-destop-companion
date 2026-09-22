/**
 * The battle sprite's poses and the stat-change arrows.
 *
 * The canvas is a recorder rather than a drawing surface: what matters here is
 * that the effect fires, that it travels the right way, and that it stays on
 * the sprite it belongs to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Battler, fitScale } from '../../app/renderer/render/battler.mjs';

/** A canvas context that remembers where the pen went. */
function recorder() {
  const points = [];
  let pen = null;
  return {
    points,
    canvas: { width: 240, height: 135 },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    rect() {},
    clip() {},
    fillRect() {},
    drawImage() {},
    beginPath() { pen = []; points.push(pen); },
    moveTo(x, y) { pen?.push([x, y]); },
    lineTo(x, y) { pen?.push([x, y]); },
    closePath() {},
    stroke() {},
    fill() {},
  };
}

/** A sprite stub: the size is all the arrows read off it. */
const sprite = { width: 40, height: 60, frameAt: () => 0, draw() {} };

/** How far past the sprite's own box an arrow's tip may reach. */
const ARM = Math.max(3, 40 * 0.12);

/** @param {number} direction */
function arrowsFor(direction) {
  const battler = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
  battler.showStatChange(/** @type {any} */ (direction));

  const frames = [];
  for (let step = 0; step < 10; step++) {
    const context = recorder();
    battler.draw(/** @type {any} */ (context));
    // The first point of each arrow is its tip, which is what travels.
    frames.push(context.points.map((line) => line[0]?.[1]).filter((y) => y !== undefined));
    battler.update(80);
  }
  return frames;
}

test('a stat change draws arrows and then stops on its own', () => {
  const frames = arrowsFor(1);
  assert.ok(frames[0].length > 0, 'the first frame should already show an arrow');
  // 640ms of animation at 80ms a step: over by the tenth frame.
  assert.deepEqual(frames[frames.length - 1], [], 'the effect should clear itself');
});

test('a raise climbs the sprite and a drop falls down it', () => {
  const up = arrowsFor(1).filter((frame) => frame.length);
  const down = arrowsFor(-1).filter((frame) => frame.length);

  const lead = (frames) => frames.map((frame) => frame[0]);
  const rising = lead(up);
  const falling = lead(down);

  assert.ok(rising[rising.length - 1] < rising[0], `arrows should rise, got ${rising.join(', ')}`);
  assert.ok(falling[falling.length - 1] > falling[0], `arrows should fall, got ${falling.join(', ')}`);
});

test('the arrows stay on the sprite they belong to', () => {
  // The sprite stands with its feet at y and its head 60 above; nothing should
  // be drawn off either end of it.
  for (const direction of [1, -1]) {
    for (const frame of arrowsFor(direction)) {
      for (const y of frame) {
        assert.ok(y >= 90 - 60 - ARM - 1 && y <= 90 + ARM + 1, `arrow at ${y} is off the sprite`);
      }
    }
  }
});

test('a battler too big for its corner is scaled to fit it', () => {
  assert.equal(fitScale(/** @type {any} */ ({ width: 40, height: 60 }), { width: 80, height: 120 }, 1), 1);
  assert.equal(fitScale(/** @type {any} */ ({ width: 40, height: 60 }), { width: 40, height: 30 }, 1), 0.5);
});

test('a fainting Pokémon sinks straight down and is cut off at its feet', () => {
  const battler = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
  battler.setPose('lose');

  const tops = [];
  const clips = [];
  for (let step = 0; step < 8; step++) {
    const context = recorder();
    // The clip rectangle is the one the draw puts up before the sprite.
    context.rect = (x, y, w, h) => clips.push([x, y, w, h]);
    battler.draw(/** @type {any} */ (context));
    tops.push(context.calls?.dy ?? battler.transform().dy);
    battler.update(100);
  }

  // Down, and only down — the games do not tip a fainted Pokémon over.
  assert.ok(tops[tops.length - 1] > tops[0], `expected a descent, saw ${tops.join(', ')}`);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] >= tops[i - 1], 'the slide should never reverse');
  assert.equal(battler.transform().rotate, 0);

  // And everything below the line it stood on is cut away as it goes.
  assert.ok(clips.length > 0, 'a fainting sprite should be clipped');
  for (const [, , , height] of clips) assert.equal(height, 90);
});

test('a fainted Pokémon stays down', () => {
  const battler = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
  battler.setPose('lose');
  for (let step = 0; step < 30; step++) battler.update(100);
  assert.equal(battler.pose, 'lose');
});
