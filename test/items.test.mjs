import test from 'node:test';
import assert from 'node:assert/strict';

import { assignRarityTiers } from '../tools/build/items.mjs';
import { BALL_TIERS } from '../tools/sources.mjs';

/** @param {Partial<any>} overrides */
function item(overrides = {}) {
  return {
    name: { ko: '테스트', en: 'Test' },
    pocket: 'medicine',
    category: 'healing',
    cost: 100,
    attributes: [],
    sprite: true,
    ...overrides,
  };
}

/** Build `count` items in one pocket with increasing cost. */
function pocketOf(prefix, pocket, count) {
  /** @type {Record<string, any>} */
  const items = {};
  for (let index = 0; index < count; index++) {
    items[`${prefix}${index}`] = item({ pocket, cost: (index + 1) * 100 });
  }
  return items;
}

test('every tier gets items, cheapest first', () => {
  const tiers = assignRarityTiers(pocketOf('m', 'medicine', 100));
  for (const tier of BALL_TIERS) {
    assert.ok(tiers[tier.ball].length > 0, `${tier.ball} should not be empty`);
  }
  // 60 / 25 / 12 / 3 split of a hundred items.
  assert.equal(tiers['poke-ball'].length, 60);
  assert.equal(tiers['great-ball'].length, 25);
  assert.equal(tiers['ultra-ball'].length, 12);
  assert.equal(tiers['master-ball'].length, 3);

  assert.ok(tiers['poke-ball'].includes('m0'), 'the cheapest item is common');
  assert.ok(tiers['master-ball'].includes('m99'), 'the priciest item is the rarest');
});

test('each pocket is split independently so no tier is monopolised', () => {
  const tiers = assignRarityTiers({
    ...pocketOf('m', 'medicine', 100),
    ...pocketOf('b', 'berries', 20),
  });
  const rarest = tiers['master-ball'];
  assert.ok(rarest.some((name) => name.startsWith('m')), 'medicine reaches the rarest tier');
  assert.ok(rarest.some((name) => name.startsWith('b')), 'berries reach the rarest tier');
});

test('a one-item pocket still lands somewhere', () => {
  const tiers = assignRarityTiers({ only: item({ pocket: 'misc' }) });
  const placements = BALL_TIERS.filter((tier) => tiers[tier.ball].includes('only'));
  assert.equal(placements.length, 1, 'the item appears in exactly one tier');
});

test('undroppable items are excluded', () => {
  const tiers = assignRarityTiers({
    keyItem: item({ pocket: 'key' }),
    artless: item({ sprite: false }),
    englishOnly: item({ name: { ko: 'Test', en: 'Test' } }),
    plate: item({ category: 'plates' }),
    fine: item({ pocket: 'misc' }),
  });
  const all = Object.values(tiers).flat();
  assert.deepEqual(all, ['fine']);
});

test('TMs are ranked by the move they teach', () => {
  const moves = {
    tackle: { damageClass: 'physical', power: 40, accuracy: 100 },
    'hyper-beam': { damageClass: 'special', power: 150, accuracy: 90 },
    'swords-dance': { damageClass: 'status', power: null, accuracy: null },
  };
  /** @type {Record<string, any>} */
  const items = {};
  for (const move of Object.keys(moves)) {
    items[`tm-${move}`] = item({ pocket: 'machines', category: 'all-machines', cost: 0, move });
  }

  const tiers = assignRarityTiers(items, moves);
  const tierOf = (name) => BALL_TIERS.findIndex((tier) => tiers[tier.ball].includes(name));
  assert.ok(
    tierOf('tm-hyper-beam') > tierOf('tm-tackle'),
    'a stronger move makes for a rarer TM',
  );
  assert.ok(tierOf('tm-swords-dance') >= 0, 'status TMs are still droppable');
});
