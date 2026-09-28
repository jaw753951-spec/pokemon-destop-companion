import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { itemOf } from '../../app/renderer/core/data.mjs';
import { EventScheduler } from '../../app/renderer/engine/events.mjs';
import { createPokemon, maxHp, maxPp } from '../../app/renderer/engine/pokemon.mjs';
import { answerShortages, callRestStop, lowOnPp, shortages } from '../../app/renderer/engine/rest.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };

test('a new shortage calls one rest stop, and only one while it lasts', () => {
  const scheduler = new EventScheduler();
  assert.deepEqual(answerShortages(scheduler, ['balls']), ['balls']);
  assert.equal(scheduler.forced, 'heal');
  scheduler.roll(new Rng(1));

  // Still out of balls a minute later: already answered.
  assert.deepEqual(answerShortages(scheduler, ['balls']), []);
  assert.equal(scheduler.forced, null);

  // A second, different shortage is new, and calls its own.
  assert.deepEqual(answerShortages(scheduler, ['balls', 'hp']), ['hp']);
  assert.equal(scheduler.forced, 'heal');
});

test('a shortage that clears and comes back calls again', () => {
  const scheduler = new EventScheduler();
  answerShortages(scheduler, ['potions']);
  scheduler.roll(new Rng(1));
  answerShortages(scheduler, []);
  assert.deepEqual(scheduler.shortages, []);
  assert.deepEqual(answerShortages(scheduler, ['potions']), ['potions']);
});

test('an event already decided on goes first, and the shortage waits its turn', () => {
  const scheduler = new EventScheduler();
  scheduler.force('wild');
  assert.deepEqual(answerShortages(scheduler, ['pp']), []);
  assert.equal(scheduler.forced, 'wild');
  scheduler.roll(new Rng(1));
  assert.deepEqual(answerShortages(scheduler, ['pp']), ['pp']);
});

/** @param {Record<string, number>} bag */
function fakeSession(bag, active) {
  return /** @type {any} */ ({
    active,
    events: new EventScheduler(),
    pocket: (pocket) =>
      Object.entries(bag)
        .filter(([slug, count]) => count > 0 && itemOf(slug)?.pocket === pocket)
        .map(([slug, count]) => ({ slug, count, item: itemOf(slug) })),
  });
}

test('health, PP, potions and balls are each a shortage of their own', withData, () => {
  const pokemon = createPokemon(new Rng(2), 6, 40, { ivFloor: 31 });
  const stocked = { potion: 2, 'poke-ball': 3 };

  assert.deepEqual(shortages(fakeSession(stocked, pokemon)), []);

  pokemon.hp = Math.floor(maxHp(pokemon) / 4);
  assert.deepEqual(shortages(fakeSession(stocked, pokemon)), ['hp']);
  pokemon.hp = maxHp(pokemon);

  // A status cure is not a potion.
  assert.deepEqual(shortages(fakeSession({ antidote: 1, 'poke-ball': 1 }, pokemon)), ['potions']);
  assert.deepEqual(shortages(fakeSession({ potion: 1 }, pokemon)), ['balls']);

  const session = fakeSession({}, pokemon);
  assert.deepEqual(callRestStop(session), ['potions', 'balls']);
  assert.equal(session.events.forced, 'heal');
});

test('PP runs short when the attacks are spent or a quarter is left', withData, () => {
  const pokemon = createPokemon(new Rng(3), 6, 40);
  assert.equal(lowOnPp(pokemon), false);
  for (const slot of pokemon.moves) slot.pp = Math.floor(maxPp(slot) / 5);
  assert.equal(lowOnPp(pokemon), true);
});
