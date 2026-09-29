import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, itemOf } from '../../app/renderer/core/data.mjs';
import { berryToHold, healAfterBattle, healingItemFor, healingItems } from '../../app/renderer/engine/items.mjs';
import { defaultItemPolicy, normalizeItemPolicy } from '../../app/renderer/engine/session.mjs';
import { createPokemon, maxHp, TRADE_ITEM } from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const withData = { skip: ready ? false : NEEDS_ASSETS };
import { assignRarityTiers } from '../tools/build/items.mjs';
import { BALL_TIERS } from '../tools/sources.mjs';
import { RETIRED_MOVES } from '../tools/build/dex.mjs';

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

// --------------------------------------------------------- stated effects

test('an item the engine reads states what it does', withData, () => {
  const items = gameData().items;

  // An evolution can name an item to hold as well as one to use, and a King's
  // Rock is filed under held items rather than under evolution.
  // The Linking Cord is what a trade evolution is given in its place.
  const evolutionItems = new Set([TRADE_ITEM]);
  for (const entry of Object.values(gameData().species)) {
    for (const evolution of entry.evolutions ?? []) {
      if (evolution.item) evolutionItems.add(evolution.item);
      if (evolution.heldItem) evolutionItems.add(evolution.heldItem);
      for (const held of evolution.heldItems ?? []) evolutionItems.add(held);
    }
  }

  // Everything marked as working has a rule the engine can follow — a use
  // effect, a held one, an evolution, or a pocket that is its own effect.
  for (const [slug, item] of Object.entries(items)) {
    if (!item.works) continue;
    const explained =
      item.use || item.held || item.capture || item.pocket === 'pokeballs' || item.pocket === 'machines' || evolutionItems.has(slug);
    assert.ok(explained, `${slug} claims to work with nothing behind it`);
  }

  // The four the game leans on, read off their own effect text rather than
  // guessed at from a description.
  assert.deepEqual(items['potion'].use, { hp: 20 });
  assert.deepEqual(items['max-potion'].use, { hp: 'full' });
  assert.deepEqual(items['ether'].use, { pp: { amount: 10, scope: 'one' } });
  assert.deepEqual(items['revive'].use, { revive: 0.5 });
});

test('only what this game will never have is dropped', withData, () => {
  const items = gameData().items;

  // Form changes, crafting, cooking, a story, a town — and the Exp. Share,
  // which splits experience between party members this game does not have.
  for (const slug of ['exp-share', 'venusaurite', 'red-apricorn', 'escape-rope', 'amulet-coin']) {
    assert.equal(items[slug], undefined, `${slug} should have been dropped`);
  }

  // Everything that acts on something the save carries stays, whether or not
  // the engine reads it yet.
  for (const slug of ['poke-ball', 'tm01', 'fire-stone', 'metal-coat', 'oran-berry', 'rare-candy',
    'leftovers', 'choice-band', 'charcoal', 'focus-sash', 'lucky-egg']) {
    assert.ok(items[slug]?.works, `${slug} should be working`);
  }

  // The ones that were kept against the day the engine could read them, and
  // now can be: a Mint's nature, a Capsule's ability, a PP Up's ceiling, a
  // Bottle Cap's genes, a type-resisting Berry, a Light Ball's one species.
  for (const slug of ['ability-capsule', 'adamant-mint', 'pp-up', 'occa-berry', 'bottle-cap', 'light-ball',
    'rocky-helmet', 'safety-goggles', 'toxic-orb', 'weakness-policy', 'heat-rock', 'everstone', 'smoke-ball',
    'golden-razz-berry', 'silver-razz-berry']) {
    assert.ok(items[slug]?.works, `${slug} should be working`);
  }

  // And the ones still waiting, which belong to systems this game does not
  // have: switching the companion out, prize money.
  for (const slug of ['shed-shell', 'pass-orb']) {
    assert.ok(items[slug], `${slug} should have been kept`);
    assert.equal(items[slug].works, false, `${slug} is not read by the engine yet`);
  }

  // One generation's copy of something the bag already has is not carried —
  // a Casteliacone is a Full Heal, a Health Mochi an HP Up — while the thing
  // it copies is.
  for (const slug of ['casteliacone', 'fresh-water', 'sacred-ash', 'health-mochi', 'health-wing', 'mighty-candy-xl',
    'dynamax-candy', 'sea-incense', 'blank-plate', 'fire-gem', 'enigma-berry', 'figy-berry', 'aguav-berry']) {
    assert.equal(items[slug], undefined, `${slug} should have been dropped`);
  }
  for (const slug of ['full-heal', 'super-potion', 'max-revive', 'hp-up', 'mystic-water', 'silk-scarf', 'sitrus-berry',
    'silver-razz-berry', 'golden-razz-berry', 'fresh-start-mochi', 'exp-candy-s']) {
    assert.ok(items[slug], `${slug} should still be carried`);
  }
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
    removeItem: (slug) => {
      bag[slug] -= 1;
      if (bag[slug] <= 0) delete bag[slug];
    },
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

test('a win tops the companion up to full, smallest potion first', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 5, 'super-potion': 2, 'max-potion': 1 });

  // Fifteen short: one Potion closes it, and nothing bigger is touched.
  pokemon.hp = maxHp(pokemon) - 15;
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'potion', count: 1 }]);
  assert.equal(pokemon.hp, maxHp(pokemon));
  assert.equal(session.bag['super-potion'], 2);

  // At full already, the bag is left alone.
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), []);
  assert.equal(session.bag.potion, 4);
});

test('a top-up to full cures the condition too, with the narrowest cure', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ antidote: 1, 'full-heal': 1, 'full-restore': 1 });
  pokemon.status = 'psn';
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'antidote', count: 1 }]);
  assert.equal(pokemon.status, null);

  // A burn has no Antidote; the Full Heal goes before the Full Restore.
  pokemon.status = 'brn';
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'full-heal', count: 1 }]);

  // And only a full top-up does it.
  pokemon.status = 'par';
  pokemon.hp = maxHp(pokemon) - 1;
  healAfterBattle(session, pokemon, 'hpHalf');
  assert.equal(pokemon.status, 'par');
});

test('a top-up stops at the target the player set, and never is never', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const max = maxHp(pokemon);
  const session = fakeSession({ potion: 20 });

  pokemon.hp = 1;
  assert.deepEqual(healAfterBattle(session, pokemon, 'never'), []);
  assert.equal(pokemon.hp, 1);

  healAfterBattle(session, pokemon, 'hpHalf');
  assert.ok(pokemon.hp >= max / 2, `healed to ${pokemon.hp} of ${max}`);
  // A Potion at a time, so it lands within one Potion past the half.
  assert.ok(pokemon.hp < max / 2 + 20, `overshot to ${pokemon.hp} of ${max}`);
});

test('a top-up spends what the bag has when it cannot reach the target', withData, () => {
  const pokemon = createPokemon(new Rng(1), 6, 50, { ivFloor: 31 });
  const session = fakeSession({ potion: 2 });

  pokemon.hp = 1;
  assert.deepEqual(healAfterBattle(session, pokemon, 'full'), [{ slug: 'potion', count: 2 }]);
  assert.equal(pokemon.hp, 41);
  assert.equal(session.countOf('potion'), 0);
});

test('the after-battle top-up defaults to full, for new and old saves alike', () => {
  assert.equal(defaultItemPolicy().afterBattle, 'full');
  assert.equal(normalizeItemPolicy(null).afterBattle, 'full');
  // A save written before the setting existed.
  assert.equal(normalizeItemPolicy({ berries: [], healing: { item: null, condition: 'hpHalf' } }).afterBattle, 'full');
  assert.equal(normalizeItemPolicy({ afterBattle: 'hpHalf' }).afterBattle, 'hpHalf');
});

test('the three ranks and the automatic berry are kept side by side', () => {
  assert.equal(defaultItemPolicy().autoBerry, true);
  assert.deepEqual(defaultItemPolicy().berries, [null, null, null]);
  assert.equal(normalizeItemPolicy(null).autoBerry, true);
  // A save from before the switch keeps its order and takes the default.
  const old = normalizeItemPolicy({ berries: ['sitrus-berry'] });
  assert.deepEqual(old.berries, ['sitrus-berry', null, null]);
  assert.equal(old.autoBerry, true);
  assert.equal(normalizeItemPolicy({ autoBerry: false }).autoBerry, false);
});

test('an unset restock rank is skipped, and an empty order holds nothing', withData, () => {
  const session = fakeSession({ 'sitrus-berry': 1 });
  assert.equal(berryToHold(session, [null, 'oran-berry', 'sitrus-berry']), 'sitrus-berry');
  assert.equal(berryToHold(session, [null, null, null]), null);
  assert.equal(berryToHold(session, ['oran-berry']), null);
});

test('every item the bag can hold says what it is, in Korean as well as English', withData, () => {
  const blank = [];
  const borrowed = [];
  for (const [slug, entry] of Object.entries(gameData().items)) {
    // A machine is described by the move it teaches.
    if (entry.pocket === 'machines') continue;
    if (!entry.text?.ko || !entry.text?.en) blank.push(slug);
    else if (entry.text.ko === entry.text.en) borrowed.push(slug);
  }
  assert.deepEqual(blank, [], 'items with no description');
  assert.deepEqual(borrowed, [], 'items whose Korean description is the English one');
});

test('every move says what it does in Korean, not in English', withData, () => {
  const blank = [];
  const borrowed = [];
  for (const [slug, move] of Object.entries(gameData().moves)) {
    // Colosseum's Shadow moves and the Starmobiles' torques, which the dex
    // build leaves out.
    if (move.type === 'shadow' || RETIRED_MOVES.has(slug)) continue;
    if (!move.text?.ko) blank.push(slug);
    else if (move.text.ko === move.text.en || !/[가-힣]/.test(move.text.ko)) borrowed.push(slug);
  }
  assert.deepEqual(blank, [], 'moves with no Korean description');
  assert.deepEqual(borrowed, [], 'moves whose Korean description is the English one');
});
