import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { gameData } from '../../app/renderer/core/data.mjs';
import { pocketOrder } from '../../app/renderer/engine/bagorder.mjs';
import { EVOLUTION_PRICE, machinePrice, priceOf } from '../../app/renderer/engine/shop.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };

/** Every item of a pocket, in the order the bag lists it. */
const listed = (pocket) => Object.entries(gameData().items)
  .filter(([, item]) => item.pocket === pocket)
  .map(([slug, item]) => ({ slug, item }))
  .sort(pocketOrder(pocket))
  .map((entry) => entry.slug);

test('machines are listed by kind and number, not as text', withData, () => {
  const order = listed('machines');
  const at = (slug) => order.indexOf(slug);
  assert.ok(at('tm09') < at('tm10') && at('tm22') < at('tm23') && at('tm99') < at('tm100'));
  assert.ok(at('tm100') > at('tm23'), 'TM100 comes after TM23, not between TM10 and TM11');
  assert.ok(at('tm229') < at('hm01') && at('hm08') < at('tr00'));
});

test('the misc pocket puts anyone’s items first, one Pokémon’s together, evolution last', withData, () => {
  const order = listed('misc');
  const at = (slug) => order.indexOf(slug);
  // Anyone's, then one Pokémon's, then evolving only.
  assert.ok(at('leftovers') < at('light-ball'));
  assert.ok(at('light-ball') < at('thunder-stone'));
  assert.ok(at('linking-cord') > at('leftovers'), 'the Linking Cord goes with the evolution items');
  // A King's Rock is held for its flinch, and stays among the held items.
  assert.ok(at('kings-rock') < at('light-ball'));
  // Items for one Pokémon sit side by side.
  const together = (slugs) => {
    const places = slugs.map(at).sort((a, b) => a - b);
    assert.equal(places[places.length - 1] - places[0], slugs.length - 1, `${slugs.join(', ')} should be adjacent`);
  };
  together(['adamant-orb', 'adamant-crystal']);
  together(['red-nectar', 'yellow-nectar', 'pink-nectar', 'purple-nectar']);
  together(['strawberry-sweet', 'love-sweet', 'berry-sweet', 'clover-sweet', 'flower-sweet', 'star-sweet', 'ribbon-sweet']);
  together(['cracked-pot', 'chipped-pot']);
});

test('TMs cost more the harder their move hits, and evolution items at least a vitamin', withData, () => {
  assert.equal(machinePrice('swords-dance'), 20000);
  assert.equal(machinePrice('thunderbolt'), 40000);
  assert.equal(machinePrice('hyper-beam'), 50000);
  assert.equal(priceOf('thunder-stone'), EVOLUTION_PRICE);
  assert.ok((priceOf('metal-coat') ?? 0) >= EVOLUTION_PRICE);
  assert.equal(priceOf('safari-ball'), null, 'the Safari Ball is not carried');
});
