/**
 * Moving on from one area to the next: mostly within the region the road is
 * in, and now and then across to the other one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { REGION_CROSSING_CHANCE, Session } from '../../app/renderer/engine/session.mjs';

setGameData(
  /** @type {any} */ ({
    areas: [
      { id: 'route101', region: 'hoenn' },
      { id: 'route102', region: 'hoenn' },
      { id: 'route103', region: 'hoenn' },
      { id: 'kanto-route-1', region: 'kanto' },
      { id: 'kanto-route-2', region: 'kanto' },
    ],
    species: {},
    items: {},
  }),
);

test('the road mostly stays in its region, and sometimes crosses', () => {
  const session = /** @type {any} */ (Object.create(Session.prototype));
  let seed = 1;
  session.rng = { chance: (p) => ((seed = (seed * 16807) % 2147483647) / 2147483647) < p, pick: (list) => list[seed % list.length] };

  let crossings = 0;
  const moves = 2000;
  for (let move = 0; move < moves; move++) {
    const from = session.area?.region;
    session.area = session.area ?? { id: 'route101', region: 'hoenn' };
    const before = session.area.region;
    session.rotateArea();
    if (from && session.area.region !== before) crossings++;
  }
  const share = crossings / moves;
  assert.ok(share > REGION_CROSSING_CHANCE / 2 && share < REGION_CROSSING_CHANCE * 2, `crossed ${share}`);
});

test('an area is never followed by itself', () => {
  const session = /** @type {any} */ (Object.create(Session.prototype));
  session.rng = { chance: () => false, pick: (list) => list[0] };
  session.area = { id: 'route101', region: 'hoenn' };
  for (let move = 0; move < 10; move++) {
    const before = session.area.id;
    session.rotateArea();
    assert.notEqual(session.area.id, before);
  }
});
