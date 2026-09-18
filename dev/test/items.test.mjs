import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { itemOf } from '../../app/renderer/core/data.mjs';
import { berryToHold, healingAmount, healingItemFor, healingItems } from '../../app/renderer/engine/items.mjs';
import { createPokemon, maxHp } from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };
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

// ------------------------------------------------------- healing amounts

/** @param {Record<string, string>} text */
const withText = (text) => ({ text });

test('the amount is read from either side of HP', () => {
  // Both descriptions are the official ones PokeAPI carries for a Potion.
  assert.equal(
    healingAmount(withText({ en: 'A spray-type medicine for treating wounds. It can be used to restore 20 HP to a single Pokémon.' })),
    20,
  );
  assert.equal(
    healingAmount(withText({ ko: '스프레이식의 상처약. 포켓몬 1마리의 HP를 20만큼 회복한다.' })),
    20,
  );
});

test('three-digit amounts are read whole', () => {
  assert.equal(healingAmount(withText({ en: 'It can be used to restore 120 HP to a single Pokémon.' })), 120);
  assert.equal(healingAmount(withText({ ko: '포켓몬 1마리의 HP를 120만큼 회복한다.' })), 120);
});

test('a number the description mentions for another reason is not the amount', () => {
  // A Berry Juice is "100 percent pure" and restores 20 — the older reading
  // took whichever number came first and healed five times too much.
  const berryJuice = withText({
    en: 'A 100 percent pure juice made of Berries. It can be used to restore 20 HP to a single Pokémon.',
    ko: '나무열매 100% 쥬스. 포켓몬 1마리의 HP를 20만큼 회복한다.',
  });
  assert.equal(healingAmount(berryJuice), 20);

  // A Health Candy names a level, not an amount, and heals nothing.
  const healthCandy = withText({
    en: "A big candy. When given to a Pokémon at Lv. 30 or higher, it will increase that Pokémon's base HP.",
    ko: '에너지가 가득한 큰 사탕. 레벨 30 이상인 포켓몬의 HP를 올린다.',
  });
  assert.equal(healthCandy && healingAmount(healthCandy), null);
});

test('a description that names no amount promises a full restore', () => {
  assert.equal(
    healingAmount(withText({ en: 'It can be used to completely restore the max HP of a single Pokémon.' })),
    null,
  );
  assert.equal(healingAmount(withText({ ko: '포켓몬 1마리의 HP를 모두 회복한다.' })), null);
  assert.equal(healingAmount({}), null);
});

test('PP is not HP', () => {
  // An Ether restores 10 PP; reading that as 10 HP is the mistake anchoring on
  // "HP" rather than on any number at all avoids.
  assert.equal(
    healingAmount(withText({
      en: 'This medicine can be used to restore 10 PP to a single selected move that has been learned by a Pokémon.',
      ko: '포켓몬이 기억하고 있는 기술 중 1개의 PP를 10만큼 회복한다.',
    })),
    null,
  );
});

test('a language the game has never shipped reads the same way', () => {
  // Nothing about the reading is Korean or English: "HP" is what it looks for.
  assert.equal(healingAmount(withText({ ja: 'ポケモン1匹のHPを20かいふくする。' })), 20);
  assert.equal(healingAmount(withText({ de: 'Stellt 20 HP eines Pokémon wieder her.' })), 20);
});

/**
 * Just enough of a session for the bag helpers: a pocket to read and a count
 * to check. The helpers touch nothing else.
 *
 * @param {Record<string, number>} bag
 */
function fakeSession(bag) {
  return /** @type {any} */ ({
    bag,
    countOf: (slug) => bag[slug] ?? 0,
    pocket: (pocket) =>
      Object.entries(bag)
        .filter(([slug]) => itemOf(slug)?.pocket === pocket)
        .map(([slug, count]) => ({ slug, count, item: itemOf(slug) })),
  });
}

test('healing items are offered weakest first, and only while they would help', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 3, 'super-potion': 2, 'max-potion': 1, antidote: 1 });

  pokemon.hp = maxHp(pokemon);
  assert.deepEqual(healingItems(session, pokemon), [], 'nothing to heal');

  pokemon.hp = 1;
  const offered = healingItems(session, pokemon).map((entry) => entry.slug);
  // A Potion restores 20 and a Super Potion 60, so they sort that way; the
  // Antidote cures a status and is not a healing item at all.
  assert.deepEqual(offered, ['potion', 'super-potion', 'max-potion']);
});

test('the automatic throw takes the smallest potion that covers the damage', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 3, 'super-potion': 2, 'max-potion': 1 });

  pokemon.hp = maxHp(pokemon) - 15;
  assert.equal(healingItemFor(session, pokemon, null), 'potion');

  pokemon.hp = maxHp(pokemon) - 50;
  assert.equal(healingItemFor(session, pokemon, null), 'super-potion');

  // Hurt worse than anything on hand covers: the biggest heal is the answer.
  pokemon.hp = 1;
  assert.equal(healingItemFor(session, pokemon, null), 'max-potion');

  // A named item is used whether or not it covers the damage, and only if the
  // bag still has one.
  assert.equal(healingItemFor(session, pokemon, 'potion'), 'potion');
  assert.equal(healingItemFor(session, pokemon, 'full-restore'), null);
});

test('an unset restock rank is skipped, and an empty order holds nothing', withData, () => {
  const session = fakeSession({ 'sitrus-berry': 1 });
  assert.equal(berryToHold(session, [null, 'oran-berry', 'sitrus-berry']), 'sitrus-berry');
  assert.equal(berryToHold(session, [null, null, null]), null);
  assert.equal(berryToHold(session, ['oran-berry']), null);
});
