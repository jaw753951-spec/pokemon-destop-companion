import test from 'node:test';
import assert from 'node:assert/strict';

import { STRIDE, walkFrame } from '../../app/renderer/render/field.mjs';
import { CENTER_STEPS, centerBeat } from '../../app/renderer/scenes/fieldevents.mjs';

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
