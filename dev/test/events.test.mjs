import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../app/renderer/core/rng.mjs';
import { BASE_WEIGHT, EVENT_KINDS, EventScheduler } from '../../app/renderer/engine/events.mjs';

/** Weights are compared loosely: they are shares of 100, not exact integers. */
const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

test('every event starts equally likely', () => {
  const weights = new EventScheduler().weights();
  for (const kind of EVENT_KINDS) close(weights[kind], 20);
  close(sum(weights), 100);
});

test('a repeated event is damped 20 → 10 → 1 → 0', () => {
  const scheduler = new EventScheduler({ last: 'berry', streak: 1 });
  close(scheduler.weights().berry, 10);

  scheduler.streak = 2;
  close(scheduler.weights().berry, 1);

  scheduler.streak = 3;
  close(scheduler.weights().berry, 0);

  // A longer run stays at zero rather than going negative.
  scheduler.streak = 9;
  close(scheduler.weights().berry, 0);
});

test('the damped share is split equally among the others', () => {
  for (const streak of [1, 2, 3]) {
    const weights = new EventScheduler({ last: 'wild', streak }).weights();
    const others = EVENT_KINDS.filter((kind) => kind !== 'wild');
    const expected = BASE_WEIGHT + (BASE_WEIGHT - weights.wild) / others.length;
    for (const kind of others) close(weights[kind], expected);
    close(sum(weights), 100);
  }
});

test('firing a different event restores the previous one', () => {
  const scheduler = new EventScheduler({ last: 'heal', streak: 2 });
  close(scheduler.weights().heal, 1);

  // Simulate the roll landing on something else.
  scheduler.last = 'ball';
  scheduler.streak = 1;
  close(scheduler.weights().heal, BASE_WEIGHT + (BASE_WEIGHT - 10) / 4);
});

test('an event can never fire four times in a row', () => {
  const scheduler = new EventScheduler();
  const rng = new Rng(1234);
  let longestRun = 0;
  let run = 0;
  let previous = null;

  for (let i = 0; i < 200000; i++) {
    const kind = scheduler.roll(rng);
    run = kind === previous ? run + 1 : 1;
    previous = kind;
    longestRun = Math.max(longestRun, run);
  }

  assert.equal(longestRun, 3, 'three in a row is reachable, four is not');
});

test('the long-run distribution stays close to even', () => {
  const scheduler = new EventScheduler();
  const rng = new Rng(99);
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0]));

  const rolls = 200000;
  for (let i = 0; i < rolls; i++) counts[scheduler.roll(rng)]++;

  for (const kind of EVENT_KINDS) {
    const share = (counts[kind] / rolls) * 100;
    assert.ok(Math.abs(share - 20) < 1, `${kind} landed on ${share.toFixed(2)}%`);
  }
});

test('repeats are rarer than an even roll would make them', () => {
  const scheduler = new EventScheduler();
  const rng = new Rng(7);
  let repeats = 0;
  let previous = null;

  const rolls = 200000;
  for (let i = 0; i < rolls; i++) {
    const kind = scheduler.roll(rng);
    if (kind === previous) repeats++;
    previous = kind;
  }

  const share = repeats / rolls;
  // An even roll would repeat 20% of the time; damping should roughly halve it.
  assert.ok(share < 0.12, `repeat share was ${(share * 100).toFixed(2)}%`);
  assert.ok(share > 0.05, `repeats should still happen, got ${(share * 100).toFixed(2)}%`);
});

test('scheduler state round-trips through a save', () => {
  const scheduler = new EventScheduler();
  scheduler.roll(new Rng(3));
  const restored = new EventScheduler(scheduler.toJSON());
  assert.equal(restored.last, scheduler.last);
  assert.equal(restored.streak, scheduler.streak);
  assert.deepEqual(restored.weights(), scheduler.weights());
});

const sum = (weights) => Object.values(weights).reduce((total, value) => total + Number(value), 0);
