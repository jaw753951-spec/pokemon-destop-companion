import test from 'node:test';
import assert from 'node:assert/strict';

import { drawWalker, STRIDE, walkFrame } from '../../app/renderer/render/field.mjs';
import { CENTER_STEPS, centerBeat, gatherBob } from '../../app/renderer/scenes/fieldevents.mjs';

test('the walk cycle is driven by distance, not by the clock', () => {
  // Standing on the same spot must not advance the legs, however long the
  // frame took — that is the difference between a walk and an idle animation.
  assert.deepEqual(walkFrame(0), walkFrame(0));
  assert.deepEqual(walkFrame(3), walkFrame(0));
  assert.notDeepEqual(walkFrame(STRIDE), walkFrame(0));
});

test('a step lands every stride, and the cycle has four beats', () => {
  const beats = [0, 1, 2, 3].map((step) => walkFrame(step * STRIDE));

  // Plant, step, plant, step: the feet are down on the even beats.
  assert.deepEqual(
    beats.map((beat) => beat.lift),
    [0, 1, 0, 1],
  );
  // The two steps lean opposite ways, so the body rocks rather than drifts.
  assert.deepEqual(
    beats.map((beat) => beat.lean),
    [0, 1, 0, -1],
  );
});

test('the cycle repeats forever and never leaves the walk', () => {
  for (const distance of [0, 8, 37, 1000, 123456.7]) {
    const frame = walkFrame(distance);
    assert.ok([0, 1].includes(frame.lift), `lift ${frame.lift}`);
    assert.ok([-1, 0, 1].includes(frame.lean), `lean ${frame.lean}`);
  }

  // Four strides on, the sprite is back where the cycle started.
  assert.deepEqual(walkFrame(4 * STRIDE), walkFrame(0));
  assert.deepEqual(walkFrame(400 * STRIDE), walkFrame(0));
});

test('a negative distance still resolves to a real beat', () => {
  // The offset only ever grows in play, but a rewound or restored save must
  // not put the renderer into an undefined frame.
  assert.deepEqual(walkFrame(-STRIDE), walkFrame(3 * STRIDE));
  assert.ok(walkFrame(-1));
});

// ------------------------------------------------- the rest stop's own script

test('the Center visit plays its door script, walks past, and then ends', () => {
  /** Drive the visit the way the runner does: one beat at a time. */
  const beats = [];
  let passing = false;
  for (let step = 0; step < 100; step++) {
    const next = centerBeat(step, passing);
    if (!next) break;
    passing = next.phase === 'passing';
    beats.push(next);
  }

  // Every door frame, then exactly one walk-past.
  assert.equal(beats.filter((beat) => beat.phase === 'visit').length, CENTER_STEPS.length);
  assert.equal(beats.filter((beat) => beat.phase === 'passing').length, 1);
  assert.equal(beats[beats.length - 1].phase, 'passing');

  // And the beat after the walk-past is nothing at all: an event that never
  // returns null leaves the runner busy for good, and no event — or area
  // change — can happen for the rest of the session.
  assert.equal(centerBeat(CENTER_STEPS.length, true), null);
  assert.equal(centerBeat(CENTER_STEPS.length + 5, true), null);
});

test('the companion is healed exactly once per visit', () => {
  const heals = CENTER_STEPS.filter((beat) => beat.heal);
  assert.equal(heals.length, 1);
  // Behind the closed door, which is the point of going in.
  assert.equal(heals[0].inside, true);
});

// ------------------------------------------------------ gathering on the spot

test('a companion bobs while it gathers and stands still otherwise', () => {
  // Nothing running, and phases that are not a gather, leave it on the ground.
  assert.equal(gatherBob(null), 0);
  assert.equal(gatherBob({ phase: 'approach', elapsed: 200 }), 0);
  assert.equal(gatherBob({ phase: 'show', elapsed: 200 }), 0);
  assert.equal(gatherBob({ phase: 'battle', elapsed: 200 }), 0);

  const heights = [];
  for (let elapsed = 0; elapsed <= 2000; elapsed += 40) {
    heights.push(gatherBob({ phase: 'gather', elapsed }));
  }

  // It leaves the ground and comes back to it, over and over, and never sinks
  // into the road.
  assert.ok(Math.max(...heights) > 0, 'the bob should lift the sprite');
  assert.ok(Math.min(...heights) >= 0, 'the bob should never go below the ground');
  assert.ok(heights.includes(0), 'the bob should come back down');
  // More than one rise across two seconds, so it reads as busy rather than as
  // one hop.
  const rises = heights.filter((height, index) => index > 0 && height > heights[index - 1]).length;
  assert.ok(rises > 3, `expected a repeating bob, saw ${rises} rises`);
});

test('a bobbing companion leaves its shadow on the ground', () => {
  /** A canvas that remembers the shadow ellipse and where the sprite landed. */
  const recorder = () => {
    const calls = { ellipse: [], image: [] };
    return {
      calls,
      globalAlpha: 1,
      fillStyle: '',
      save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, fill() {},
      ellipse(x, y) { calls.ellipse.push([x, y]); },
      drawImage(...args) { calls.image.push(args); },
    };
  };
  const sprite = { image: {}, width: 20, height: 24 };
  const walk = { x: 60, y: 100, distance: 0, moving: false, flip: false };

  const grounded = recorder();
  drawWalker(/** @type {any} */ (grounded), /** @type {any} */ (sprite), walk);
  const lifted = recorder();
  drawWalker(/** @type {any} */ (lifted), /** @type {any} */ (sprite), { ...walk, lift: 3 });

  // The shadow stays exactly where it was — that is what makes the bob read as
  // leaving the ground rather than the whole thing sliding up the screen.
  assert.deepEqual(lifted.calls.ellipse, grounded.calls.ellipse);

  // And the sprite is drawn three pixels higher. `drawImage` is called with
  // the nine-argument form, so the destination top is the seventh.
  const topOf = (recorded) => recorded.calls.image[0][6];
  assert.equal(topOf(grounded) - topOf(lifted), 3);
});
