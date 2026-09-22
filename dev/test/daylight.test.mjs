/**
 * The light of the hour, on the things the pipeline could not grade.
 *
 * Area backgrounds are rendered five times over and graded at build time.
 * Everything standing on them is one picture shared by every hour, so it is
 * washed at draw time instead — and the wash has to land where the grade
 * would have, or a building at midnight sits in a different night from the
 * road under it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DAYLIGHT } from '../../app/renderer/render/daylight.mjs';
import { TIME_GRADES, TIME_KEYS } from '../../dev/tools/lib/image.mjs';

/** What the pipeline would make of a channel. */
const graded = (value, multiply, add) => Math.max(0, Math.min(255, value * multiply + add));

/** What the wash makes of it: a `source-atop` fill over the pixel. */
const washed = (value, strength, tint) =>
  Math.max(0, Math.min(255, (1 - strength) * value + strength * tint));

/** `rgb(r, g, b)` back into numbers. */
const channels = (colour) => colour.match(/\d+/g).map(Number);

test('every band the pipeline grades has a wash to match it', () => {
  for (const key of TIME_KEYS) {
    assert.ok(key in DAYLIGHT, `no wash for ${key}`);
  }
  // Daytime is the unmodified palette, so there is nothing to lay over it.
  assert.equal(DAYLIGHT.day, null);
});

test('the wash lands where the grade would, across the whole range', () => {
  for (const key of TIME_KEYS) {
    const light = DAYLIGHT[key];
    if (!light) continue;
    const { multiply, add } = TIME_GRADES[key];
    const tint = channels(light.colour);

    let squared = 0;
    let samples = 0;
    let worst = 0;
    for (let value = 0; value <= 255; value += 5) {
      for (let channel = 0; channel < 3; channel++) {
        const want = graded(value, multiply[channel], add[channel]);
        const got = washed(value, light.strength, tint[channel]);
        squared += (got - want) ** 2;
        worst = Math.max(worst, Math.abs(got - want));
        samples++;
      }
    }
    const rms = Math.sqrt(squared / samples);
    // A single fill cannot reproduce a per-channel multiply exactly; what it
    // has to do is stay close enough that the eye reads one light.
    assert.ok(rms < 14, `${key}: ${rms.toFixed(1)} off the pipeline's grade`);
    assert.ok(worst < 40, `${key}: one channel ${worst.toFixed(0)} out`);
  }
});

test('night is the heaviest wash and dawn the lightest', () => {
  const strength = (key) => DAYLIGHT[key]?.strength ?? 0;
  assert.ok(strength('night') > strength('dusk'));
  assert.ok(strength('dusk') > strength('afternoon'));
  assert.ok(strength('afternoon') > strength('dawn'));
  assert.ok(strength('dawn') > 0);
});
