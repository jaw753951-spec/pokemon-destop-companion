/**
 * The battle sprite's poses and the stat-change arrows.
 *
 * The canvas is a recorder rather than a drawing surface: what matters here is
 * that the effect fires, that it travels the right way, and that it stays on
 * the sprite it belongs to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Battler } from '../../app/renderer/render/battler.mjs';
import { idleBob } from '../../app/renderer/render/field.mjs';

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

test('a Pokémon off on a Fly or a Dig is not drawn at all until it comes back', () => {
  for (const place of ['sky', 'ground', 'water', 'vanished']) {
    const battler = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
    /** How many times the sprite itself was drawn in one frame. */
    const drawn = () => {
      let count = 0;
      const stub = { ...sprite, draw() { count++; } };
      battler.sprite = /** @type {any} */ (stub);
      battler.draw(/** @type {any} */ (recorder()));
      return count;
    };
    battler.goAway(place);
    battler.showStatus('brn');
    for (let step = 0; step < 10; step++) battler.update(60);
    assert.ok(battler.gone, `${place}: should have left`);
    // Nothing of it: no sprite, and no burn flickering over the empty spot.
    const context = recorder();
    battler.draw(/** @type {any} */ (context));
    assert.equal(context.points.length, 0, `${place}: an effect was drawn over an empty spot`);
    assert.equal(drawn(), 0, `${place}: the sprite was drawn while away`);
    // A hit it takes there — an Earthquake on a Dig — still shows nothing.
    battler.setPose('hit');
    assert.equal(drawn(), 0, `${place}: a hit brought it back into view`);

    battler.comeBack();
    for (let step = 0; step < 10; step++) battler.update(60);
    assert.equal(battler.gone, false);
    assert.equal(drawn(), 1, `${place}: should be back on its spot`);
    assert.equal(battler.travel().dy, 0);
  }
});

test('a Fly leaves up off the screen, a Dig down through the ground', () => {
  const fly = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
  const dig = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
  fly.goAway('sky');
  dig.goAway('ground');
  fly.update(300);
  dig.update(300);
  assert.ok(fly.travel().dy < 0 && !fly.travel().clip);
  assert.ok(dig.travel().dy > 0 && dig.travel().clip);
});

test('a battler bobs while it waits', () => {
  const battler = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1, scale: 1.5 });

  const lifts = new Set();
  for (let step = 0; step < 24; step++) {
    const { dx, dy, scale } = battler.transform();
    // Up only, and by whole art pixels at the scale it is drawn.
    assert.ok(dy <= 0, `a bob should never sink into the ground, saw ${dy}`);
    assert.ok(Number.isInteger(-dy / 1.5), `a bob should move by whole art pixels, saw ${dy}`);
    assert.equal(dx, 0);
    assert.equal(scale, 1);
    lifts.add(dy);
    battler.update(40);
  }
  assert.ok(lifts.size > 1, 'it should rise and fall');
  assert.equal(Math.min(...[...lifts]), -2 * 1.5);
  assert.equal(idleBob(0), 0);
});

test('an attack is one push forward and a hit one push back, level and at its own size', () => {
  /** @param {'attack'|'hit'} pose @param {1|-1} facing */
  const track = (pose, facing) => {
    const battler = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing, scale: 2 });
    battler.setPose(pose);
    const moves = [];
    while (!battler.poseDone) {
      const transform = battler.transform();
      assert.equal(transform.dy, 0, 'a push stays on the ground');
      assert.equal(transform.scale, 1, 'a push does not resize the picture');
      assert.equal(transform.rotate, 0);
      assert.ok(Number.isInteger(transform.dx), 'by whole field pixels');
      moves.push(transform.dx);
      battler.update(20);
    }
    assert.equal(battler.pose, 'idle', 'and it settles back to waiting');
    return moves;
  };

  for (const facing of /** @type {const} */ ([1, -1])) {
    const attack = track('attack', facing);
    const hit = track('hit', facing);
    // Forward (towards the side it faces, which `draw` multiplies in) and back.
    assert.ok(attack.every((dx) => dx >= 0) && Math.max(...attack) > 8, `attack ${attack.join(',')}`);
    assert.ok(hit.every((dx) => dx <= 0) && Math.min(...hit) < -8, `hit ${hit.join(',')}`);
    // Once: out to the far end, then back, never out again.
    const turn = attack.indexOf(Math.max(...attack));
    for (let i = 1; i <= turn; i++) assert.ok(attack[i] >= attack[i - 1]);
    for (let i = turn + 1; i < attack.length; i++) assert.ok(attack[i] <= attack[i - 1]);
  }

  // The hit is washed red, fading as it settles.
  const hit = new Battler({ sprite: /** @type {any} */ (sprite), x: 100, y: 90, facing: 1 });
  hit.setPose('hit');
  const first = hit.transform().flash;
  hit.update(200);
  assert.ok(first > hit.transform().flash && hit.transform().flash > 0);
});

test('the far platform moves down the backdrop and the bands close up behind it', async () => {
  const { lowerFoePlatform } = await import('../tools/build/battle.mjs');
  // Two bands of one colour a row, and a "platform" of another on the right.
  const width = 160;
  const height = 60;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(y % 2 ? [10, 10, 10, 255] : [20, 20, 20, 255], (y * width + x) * 4);
  }
  for (let y = 10; y < 14; y++) for (let x = 120; x < 150; x++) data.set([200, 0, 0, 255], (y * width + x) * 4);
  const moved = lowerFoePlatform({ width, height, data }, 5);
  const at = (x, y) => [...moved.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
  assert.deepEqual(at(130, 15), [200, 0, 0]);
  assert.deepEqual(at(130, 18), [200, 0, 0]);
  // Where it stood is its rows' own bands again.
  assert.deepEqual(at(130, 10), [20, 20, 20]);
  assert.deepEqual(at(130, 11), [10, 10, 10]);
  // And nothing on the left moves.
  assert.deepEqual(at(50, 12), [20, 20, 20]);
});
