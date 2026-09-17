import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../src/renderer/core/rng.mjs';
import { attemptCapture, captureChance, catchValue } from '../src/renderer/engine/capture.mjs';
import { createPokemon, maxHp } from '../src/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** Caterpie catches easily (rate 255); Dratini does not (rate 45). */
const CATERPIE = 10;
const DRATINI = 147;

function wild(speciesId, level, { hpRatio = 1, status = null } = {}) {
  const pokemon = createPokemon(new Rng(5), speciesId, level);
  pokemon.hp = Math.max(1, Math.round(maxHp(pokemon) * hpRatio));
  pokemon.status = status;
  return pokemon;
}

test('a Master Ball always catches', options, () => {
  const target = wild(DRATINI, 50);
  assert.equal(catchValue(target, 'master-ball'), Infinity);
  assert.equal(captureChance(target, 'master-ball'), 1);
  assert.deepEqual(attemptCapture(new Rng(1), target, 'master-ball'), { caught: true, shakes: 4 });
});

test('better balls give better odds', options, () => {
  const target = wild(DRATINI, 30, { hpRatio: 0.5 });
  const poke = captureChance(target, 'poke-ball');
  const great = captureChance(target, 'great-ball');
  const ultra = captureChance(target, 'ultra-ball');

  assert.ok(poke < great, `${poke} < ${great}`);
  assert.ok(great < ultra, `${great} < ${ultra}`);
  assert.ok(ultra < 1, 'an Ultra Ball is still not a sure thing here');
});

test('weakening and status both help', options, () => {
  const healthy = captureChance(wild(DRATINI, 30), 'poke-ball');
  const hurt = captureChance(wild(DRATINI, 30, { hpRatio: 0.1 }), 'poke-ball');
  const asleep = captureChance(wild(DRATINI, 30, { hpRatio: 0.1, status: 'slp' }), 'poke-ball');
  const paralysed = captureChance(wild(DRATINI, 30, { hpRatio: 0.1, status: 'par' }), 'poke-ball');

  assert.ok(hurt > healthy, 'a weakened target is easier');
  assert.ok(asleep > paralysed, 'sleep beats paralysis');
  assert.ok(paralysed > hurt, 'any status beats none');
});

test('an easy species at low HP is a near-certainty', options, () => {
  const chance = captureChance(wild(CATERPIE, 5, { hpRatio: 0.05 }), 'ultra-ball');
  assert.ok(chance > 0.99, `expected near-certain, got ${chance}`);
});

test('reported odds match how often a throw actually succeeds', options, () => {
  const rng = new Rng(20240917);
  const target = wild(DRATINI, 30, { hpRatio: 0.35 });
  const expected = captureChance(target, 'great-ball');

  let caught = 0;
  const throws = 40000;
  for (let i = 0; i < throws; i++) {
    if (attemptCapture(rng, target, 'great-ball').caught) caught++;
  }

  const observed = caught / throws;
  assert.ok(
    Math.abs(observed - expected) < 0.01,
    `observed ${observed.toFixed(4)} vs reported ${expected.toFixed(4)}`,
  );
});

test('a failed throw reports how far it got', options, () => {
  const rng = new Rng(3);
  const target = wild(DRATINI, 60);
  let sawPartial = false;

  for (let i = 0; i < 500 && !sawPartial; i++) {
    const result = attemptCapture(rng, target, 'poke-ball');
    if (!result.caught) {
      assert.ok(result.shakes >= 0 && result.shakes < 4, `shakes was ${result.shakes}`);
      if (result.shakes > 0) sawPartial = true;
    }
  }
  assert.ok(sawPartial, 'some throws should shake before breaking out');
});
