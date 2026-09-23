import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { moveOf, typeEffectiveness } from '../../app/renderer/core/data.mjs';
import {
  Battle,
  categoryOf,
  choosePolicyMove,
  effectiveStat,
  expectedDamage,
  STATUS,
} from '../../app/renderer/engine/battle.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle, normalizeAutoBattle } from '../../app/renderer/engine/session.mjs';
import { computeStat, experienceForLevel, levelForExperience, stageMultiplier } from '../../app/renderer/engine/stats.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** Charizard, Blastoise and Venusaur, for type matchups everybody knows. */
const CHARIZARD = 6;
const BLASTOISE = 9;
const VENUSAUR = 3;

/** A Pokémon with fixed, maximal IVs so a test's numbers are reproducible. */
function makeFixed(speciesId, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31 });
  pokemon.nature = 'hardy'; // neutral, so nature cannot skew a stat assertion
  pokemon.evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

test('stat formula matches a known main-series value', options, () => {
  // Bulbapedia's worked example: a level-78 Garchomp with 108 base HP, 24 IV
  // and 74 EV has 289 HP.
  assert.equal(computeStat(108, 24, 74, 78, 1, true), 289);

  // Its Attack, step by step: floor(195/4) = 48 EV points, so the inner term is
  // floor((2*130 + 12 + 48) * 78 / 100) = 249, then (249 + 5) * 1.1 = 279.4.
  assert.equal(computeStat(130, 12, 195, 78, 1.1, false), 279);
  // A hindering nature rounds the same way: 254 * 0.9 = 228.6.
  assert.equal(computeStat(130, 12, 195, 78, 0.9, false), 228);
  // And a neutral one is the inner term untouched.
  assert.equal(computeStat(130, 12, 195, 78, 1, false), 254);

  // A level-1 Pokémon still has the flat +10 on HP and +5 elsewhere.
  assert.equal(computeStat(45, 0, 0, 1, 1, true), 11);
  assert.equal(computeStat(49, 0, 0, 1, 1, false), 5);
});

test('stage multipliers follow the main-series table', options, () => {
  assert.equal(stageMultiplier(0), 1);
  assert.equal(stageMultiplier(1), 1.5);
  assert.equal(stageMultiplier(2), 2);
  assert.equal(stageMultiplier(6), 4);
  assert.equal(stageMultiplier(-1), 2 / 3);
  assert.equal(stageMultiplier(-6), 0.25);
  // Accuracy uses its own table.
  assert.equal(stageMultiplier(1, true), 4 / 3);
  assert.equal(stageMultiplier(-6, true), 1 / 3);
  // Out-of-range stages clamp rather than reading off the end of the table.
  assert.equal(stageMultiplier(99), 4);
  assert.equal(stageMultiplier(-99), 0.25);
});

test('experience curves round-trip through level lookup', options, () => {
  for (const rate of ['medium', 'fast', 'slow', 'medium-slow', 'slow-then-very-fast', 'fast-then-very-slow']) {
    for (const level of [1, 5, 17, 50, 99, 100]) {
      const total = experienceForLevel(rate, level);
      assert.equal(levelForExperience(rate, total), level, `${rate} at level ${level}`);
    }
  }
});

test('type chart reproduces the matchups it is famous for', options, () => {
  assert.equal(typeEffectiveness('water', ['fire']), 2);
  assert.equal(typeEffectiveness('electric', ['ground']), 0);
  assert.equal(typeEffectiveness('fighting', ['ghost']), 0);
  // Doubly effective against a dual type.
  assert.equal(typeEffectiveness('rock', ['fire', 'flying']), 4);
  // And doubly resisted.
  assert.equal(typeEffectiveness('grass', ['fire', 'flying']), 0.25);
});

test('a battle runs to a decisive end', options, () => {
  const battle = new Battle({
    rng: new Rng(42),
    player: makeFixed(CHARIZARD, 50, ['flamethrower']),
    foes: [makeFixed(VENUSAUR, 50, ['vine-whip'])],
    policy: null,
  });

  let turns = 0;
  while (battle.running && turns < 100) {
    battle.takeTurn();
    turns++;
  }

  assert.ok(!battle.running, 'the battle ended');
  assert.equal(battle.outcome, 'won', 'Fire beats Grass at equal level');
  assert.ok(battle.rewards.length > 0, 'experience was awarded');
  assert.ok(battle.rewards[0].experience > 0);
});

test('type advantage decides an otherwise even matchup', options, () => {
  // Same level, same power move — only the matchup differs, so Water should
  // beat Fire far more often than not.
  let waterWins = 0;
  for (let seed = 0; seed < 30; seed++) {
    const battle = new Battle({
      rng: new Rng(seed + 1),
      player: makeFixed(BLASTOISE, 50, ['surf']),
      foes: [makeFixed(CHARIZARD, 50, ['flamethrower'])],
      policy: null,
    });
    while (battle.running) battle.takeTurn();
    if (battle.outcome === 'won') waterWins++;
  }
  assert.ok(waterWins >= 28, `water won ${waterWins}/30`);
});

test('a fainted Pokémon ends the battle and is reported once', options, () => {
  const battle = new Battle({
    rng: new Rng(7),
    player: makeFixed(CHARIZARD, 5, ['ember']),
    foes: [makeFixed(BLASTOISE, 60, ['surf'])],
    policy: null,
  });

  /** @type {import('../../app/renderer/engine/battle.mjs').LogEntry[]} */
  const log = [];
  while (battle.running) log.push(...battle.takeTurn());

  assert.equal(battle.outcome, 'lost');
  assert.equal(log.filter((entry) => entry.kind === 'end').length, 1);
  assert.equal(battle.player.pokemon.hp, 0);
});

test('a trainer sends out their next Pokémon', options, () => {
  const battle = new Battle({
    rng: new Rng(3),
    player: makeFixed(CHARIZARD, 60, ['flamethrower']),
    foes: [makeFixed(VENUSAUR, 20, ['tackle']), makeFixed(VENUSAUR, 20, ['tackle'])],
    policy: null,
    trainerBattle: true,
  });

  /** @type {any[]} */
  const log = [];
  while (battle.running) log.push(...battle.takeTurn());

  assert.equal(battle.outcome, 'won');
  assert.equal(log.filter((entry) => entry.kind === 'faint' && entry.side === 'foe').length, 2);
  assert.equal(log.filter((entry) => entry.kind === 'sendOut').length, 1);
  assert.equal(battle.rewards.length, 2, 'experience for each Pokémon defeated');
});

test('burn halves physical damage but not special', options, () => {
  const attacker = makeFixed(CHARIZARD, 50, ['slash']);
  const defender = makeFixed(VENUSAUR, 50, ['tackle']);

  const healthy = new Battle({ rng: new Rng(11), player: attacker, foes: [defender], policy: null });
  const physical = healthy.computeDamage(healthy.player, /** @type {any} */ (healthy.foe), {
    ...moveFixture('physical', 70, 'normal'),
  });

  healthy.player.pokemon.status = STATUS.BURN;
  const burned = new Battle({ rng: new Rng(11), player: healthy.player.pokemon, foes: [defender], policy: null });
  const burnedDamage = burned.computeDamage(burned.player, /** @type {any} */ (burned.foe), {
    ...moveFixture('physical', 70, 'normal'),
  });

  assert.ok(burnedDamage.damage < physical.damage, 'burn reduced the physical hit');
});

test('status immunities are respected', options, () => {
  const battle = new Battle({
    rng: new Rng(5),
    player: makeFixed(CHARIZARD, 50, ['ember']),
    foes: [makeFixed(CHARIZARD, 50, ['ember'])],
    policy: null,
  });

  // A Fire type cannot be burned, so this must be refused.
  const applied = battle.inflictStatus(/** @type {any} */ (battle.foe), 'burn', []);
  assert.equal(applied, false);
  assert.equal(battle.foe?.pokemon.status, null);

  // A Grass type can be.
  const grassBattle = new Battle({
    rng: new Rng(5),
    player: makeFixed(CHARIZARD, 50, ['ember']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: null,
  });
  assert.equal(grassBattle.inflictStatus(/** @type {any} */ (grassBattle.foe), 'burn', []), true);
  assert.equal(grassBattle.foe?.pokemon.status, STATUS.BURN);
});

test('moves are sorted into auto-battle categories', options, () => {
  assert.equal(categoryOf(moveFixture('physical', 40, 'normal')), 'damage');
  assert.equal(categoryOf({ damageClass: 'status', meta: { healing: 50 }, statChanges: [] }), 'heal');
  assert.equal(
    categoryOf({ damageClass: 'status', meta: { ailment: 'sleep', healing: 0 }, statChanges: [] }),
    'status',
  );
  assert.equal(
    categoryOf({ damageClass: 'status', meta: { ailment: 'none', healing: 0 }, statChanges: [{ stat: 'atk', change: 2 }] }),
    'stat',
  );
  assert.equal(categoryOf({ damageClass: 'status', meta: { ailment: 'none', healing: 0 }, statChanges: [] }), 'field');
});

test('an explicit move order is followed in sequence and then repeated', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'slash', 'growl', 'smokescreen']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 90, ['tackle'])],
    policy: { mode: 'repeatAll', order: ['slash', 'ember'], conditions: {} },
  });

  const usable = player.moves;
  const picks = [];
  for (let turn = 0; turn < 4; turn++) {
    picks.push(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), usable));
    battle.player.turnsTaken++;
  }
  assert.deepEqual(picks, ['slash', 'ember', 'slash', 'ember']);
});

test('repeatLast holds on the final move of the order', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'slash']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 90, ['tackle'])],
    policy: { mode: 'repeatLast', order: ['slash', 'ember'], conditions: {} },
  });

  const picks = [];
  for (let turn = 0; turn < 4; turn++) {
    picks.push(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves));
    battle.player.turnsTaken++;
  }
  assert.deepEqual(picks, ['slash', 'ember', 'ember', 'ember']);
});

test('damageFirst ignores the conditions and picks the strongest attack', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'flamethrower', 'growl']);
  const battle = new Battle({
    rng: new Rng(2),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    // Attacks are switched off and stat moves left on, and damageFirst must
    // still pick the strongest attack.
    policy: { mode: 'damageFirst', order: [], conditions: { damage: 'never', stat: 'always' } },
  });

  const pick = choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);
  assert.equal(pick, 'flamethrower');
});

test('a kind set to never takes a category out of the running', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['ember', 'growl']);
  const battle = new Battle({
    rng: new Rng(4),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { mode: 'repeatAll', order: [], conditions: { damage: 'always', stat: 'never' } },
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves), 'ember');
  }
});

test('with no order, several attacks come down to the hardest-hitting one', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle', 'ember', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(7),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    // The shipped defaults, which name no order at all.
    policy: defaultAutoBattle(),
  });

  // Attacks never compete with each other, so this holds on every roll.
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves), 'flamethrower');
  }
});

test('a healing move waits for the health its condition names', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['recover', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(3),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { mode: 'repeatAll', order: [], conditions: { damage: 'never', heal: 'hpThird' } },
  });

  const pick = () => choosePolicyMove(battle, battle.player, /** @type {any} */ (battle.foe), player.moves);

  // Above a third, healing is out and nothing else is allowed, so the fallback
  // attack is all that is left.
  player.hp = Math.ceil(maxHp(player) * 0.5);
  assert.equal(pick(), 'flamethrower');

  player.hp = Math.floor(maxHp(player) / 3);
  assert.equal(pick(), 'recover');
});

test('a stored policy from either older shape becomes conditions', options, () => {
  // Weights, where zero meant "never".
  const weighted = normalizeAutoBattle({
    mode: 'repeatAll',
    order: [],
    weights: { damage: 10, stat: 0 },
    conditions: { damage: 'always', stat: 'firstTurn' },
  });
  assert.equal(weighted.conditions.damage, 'always');
  assert.equal(weighted.conditions.stat, 'never');
  assert.equal(weighted.weights, undefined);

  // Tick boxes, where an unticked kind meant the same.
  const ticked = normalizeAutoBattle({ mode: 'repeatAll', order: [], use: { heal: false } });
  assert.equal(ticked.conditions.heal, 'never');
  assert.equal(ticked.use, undefined);

  // And half health, which used to have a name of its own.
  assert.equal(normalizeAutoBattle(null).conditions.heal, 'hpHalf');
});

test('an item takes the companion\'s turn instead of a move', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower']);
  player.hp = 20;

  const thrown = [];
  const battle = new Battle({
    rng: new Rng(11),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
    items: {
      choose: () => null,
      throw: (slug, pokemon) => {
        thrown.push(slug);
        pokemon.hp += 60;
        return true;
      },
    },
  });

  battle.queueItem('super-potion');
  const log = battle.takeTurn();

  assert.deepEqual(thrown, ['super-potion']);
  const item = log.find((entry) => entry.kind === 'item');
  assert.ok(item && item.data.used);
  // The turn went on the item, so no move of the companion's was used.
  assert.equal(player.moves[0].pp, 15);
  assert.ok(log.some((entry) => entry.kind === 'move' && entry.side === 'foe'));
  assert.ok(!log.some((entry) => entry.kind === 'move' && entry.side === 'player'));
  // And only once: the next turn is fought normally.
  assert.equal(battle.pendingItem, null);
});

test('an item is used in the companion\'s place in the order, not ahead of everything', options, () => {
  // A slow companion against a fast foe: the foe moves first, and the item
  // is used when the companion's turn comes round.
  const player = makeFixed(VENUSAUR, 50, ['tackle']);
  const battle = new Battle({
    rng: new Rng(3),
    player,
    foes: [makeFixed(CHARIZARD, 60, ['tackle'])],
    policy: defaultAutoBattle(),
    items: { choose: () => null, throw: () => true },
  });

  battle.queueItem('potion');
  const log = battle.takeTurn();
  const item = log.findIndex((entry) => entry.kind === 'item');
  const foeMove = log.findIndex((entry) => entry.kind === 'move' && entry.side === 'foe');
  assert.ok(item >= 0 && foeMove >= 0);
  assert.ok(foeMove < item, 'the faster foe acts before the item is used');
});

test('a Sitrus Berry is eaten at half health, for a quarter of the bar', options, () => {
  // Two Tackles rather than anything decisive: the berry is the point, and a
  // battle that ends on turn one has no turn two to eat it in.
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'sitrus-berry';

  const battle = new Battle({
    rng: new Rng(12),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  // Above half, nothing happens.
  player.hp = maxHp(player);
  battle.takeTurn();
  assert.equal(player.heldItem, 'sitrus-berry');

  const half = Math.floor(maxHp(player) / 2) - 1;
  player.hp = half;
  const log = battle.takeTurn();

  assert.ok(log.some((entry) => entry.kind === 'berry'));
  assert.equal(player.heldItem, null, 'the berry is gone once eaten');
  // A quarter of the bar, on top of whatever the turn did to it.
  assert.ok(player.hp >= half - 40 + Math.floor(maxHp(player) / 4));
});

test('a Cheri Berry waits for the paralysis it cures', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'cheri-berry';

  const battle = new Battle({
    rng: new Rng(13),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  battle.takeTurn();
  assert.equal(player.heldItem, 'cheri-berry', 'nothing to cure yet');

  player.status = STATUS.PARALYSIS;
  battle.takeTurn();
  assert.equal(player.status, null);
  assert.equal(player.heldItem, null);
});

test('a Liechi Berry waits for a quarter, and raises a stage', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'liechi-berry';

  const battle = new Battle({
    rng: new Rng(14),
    player,
    foes: [makeFixed(BLASTOISE, 60, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  // Half health is not a pinch as far as this berry is concerned.
  player.hp = Math.floor(maxHp(player) / 2);
  battle.takeTurn();
  assert.equal(player.heldItem, 'liechi-berry');

  player.hp = Math.floor(maxHp(player) / 4);
  battle.takeTurn();
  assert.equal(player.heldItem, null);
  assert.equal(battle.player.stages.atk, 1);
});

test('Leftovers pays a sixteenth at the end of each turn', options, () => {
  // Both sides have to last the turn out: the upkeep is paid at the end of
  // one, and a battle that ends first never reaches it.
  const player = makeFixed(CHARIZARD, 50, ['tackle']);
  player.heldItem = 'leftovers';
  player.hp = maxHp(player) - 40;

  const battle = new Battle({
    rng: new Rng(21),
    player,
    foes: [makeFixed(BLASTOISE, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const log = battle.takeTurn();
  const healed = log.find((entry) => entry.kind === 'heal' && entry.side === 'player');

  assert.ok(healed, 'nothing was restored');
  assert.equal(healed.data.amount, Math.floor(maxHp(player) / 16));
  assert.equal(healed.data.item, 'leftovers');
});

test('a Choice Band lifts Attack and holds the move it picked', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['tackle', 'flamethrower']);
  const battle = new Battle({
    rng: new Rng(22),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const plain = effectiveStat(battle.player, 'atk');
  player.heldItem = 'choice-band';
  assert.equal(effectiveStat(battle.player, 'atk'), Math.floor(plain * 1.5));

  // The first choice sticks, even though the policy would otherwise reconsider
  // once the better move is the only sensible answer.
  const first = battle.chooseMove(battle.player, /** @type {any} */ (battle.foe));
  battle.player.lockedMove = first;
  for (let turn = 0; turn < 5; turn++) {
    assert.equal(battle.chooseMove(battle.player, /** @type {any} */ (battle.foe)), first);
  }
});

test('a Charcoal lifts fire moves and leaves the rest alone', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['flamethrower', 'slash']);
  const battle = new Battle({
    rng: new Rng(23),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const fire = expectedDamage(battle.player, /** @type {any} */ (battle.foe), moveOf('flamethrower'));
  player.heldItem = 'charcoal';

  // `expectedDamage` is the planner's view and does not read held items, so
  // the real roll is what this compares: twenty per cent more, every time.
  const roll = (seed) => {
    const fight = new Battle({
      rng: new Rng(seed),
      player,
      foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
      policy: defaultAutoBattle(),
    });
    return fight.computeDamage(fight.player, /** @type {any} */ (fight.foe), moveOf('flamethrower')).damage;
  };
  const withCharcoal = roll(5);
  player.heldItem = null;
  const without = roll(5);

  assert.ok(fire > 0);
  assert.ok(withCharcoal > without, `${withCharcoal} should beat ${without}`);
  assert.equal(withCharcoal, Math.max(1, Math.floor(without * 1.2)));
});

test('a Focus Sash leaves one hit point, once', options, () => {
  const player = makeFixed(CHARIZARD, 5, ['tackle']);
  player.heldItem = 'focus-sash';
  player.hp = maxHp(player);

  const battle = new Battle({
    rng: new Rng(24),
    player,
    // A Blastoise fifty levels up would end this in one hit.
    foes: [makeFixed(BLASTOISE, 60, ['surf'])],
    policy: defaultAutoBattle(),
  });

  battle.takeTurn();
  assert.equal(player.hp, 1, 'the sash should have held');
  assert.equal(player.heldItem, null, 'and been used up');
});

test('expected damage ranks a super-effective move above a resisted one', options, () => {
  const battle = new Battle({
    rng: new Rng(1),
    player: makeFixed(CHARIZARD, 50, ['flamethrower', 'surf']),
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: null,
  });

  const fire = expectedDamage(battle.player, /** @type {any} */ (battle.foe), moveFixture('special', 90, 'fire'));
  const water = expectedDamage(battle.player, /** @type {any} */ (battle.foe), moveFixture('special', 90, 'water'));
  assert.ok(fire > water, 'Fire beats Water into a Grass type');
});

/** A minimal move record, for damage maths that does not need real data. */
function moveFixture(damageClass, power, type) {
  return {
    damageClass,
    power,
    type,
    accuracy: 100,
    priority: 0,
    statChanges: [],
    meta: { ailment: 'none', ailmentChance: 0, critRate: 0, drain: 0, healing: 0, flinchChance: 0, statChance: 0 },
  };
}

test('a Fake Out works on the first turn out and fails after it', options, () => {
  // Nothing else to use, so the second turn has to try it and find it fails.
  const player = makeFixed(CHARIZARD, 50, ['fake-out']);
  const battle = new Battle({
    rng: new Rng(5),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });

  const first = battle.takeTurn();
  assert.ok(first.some((entry) => entry.kind === 'damage' && entry.side === 'foe'), 'the first one lands');
  assert.ok(!first.some((entry) => entry.kind === 'failed' && entry.side === 'player'));

  const second = battle.takeTurn();
  assert.ok(second.some((entry) => entry.kind === 'failed' && entry.side === 'player'), 'the second one fails');
  assert.ok(!second.some((entry) => entry.kind === 'damage' && entry.side === 'foe'));
});

test('after the first turn out, a Fake Out is not reached for when there is anything else', options, () => {
  const player = makeFixed(CHARIZARD, 50, ['fake-out', 'tackle']);
  const battle = new Battle({
    rng: new Rng(5),
    player,
    foes: [makeFixed(VENUSAUR, 50, ['tackle'])],
    policy: { ...defaultAutoBattle(), order: ['fake-out', 'fake-out'], mode: 'repeatAll' },
  });

  battle.takeTurn();
  const moves = battle.takeTurn().filter((entry) => entry.kind === 'move' && entry.side === 'player');
  assert.deepEqual(moves.map((entry) => entry.data.move), ['tackle']);
});

test('inside a Trick Room the slower side moves first, and a second one takes it down', options, () => {
  // Venusaur is slower than Charizard at the same level.
  const battle = new Battle({
    rng: new Rng(2),
    player: makeFixed(VENUSAUR, 50, ['tackle']),
    foes: [makeFixed(CHARIZARD, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  assert.equal(battle.orderOfPlay()[0], battle.foe, 'the faster foe first, normally');

  assert.equal(battle.field.toggleTrickRoom(), 'started');
  assert.equal(battle.orderOfPlay()[0], battle.player, 'the slower companion first, in the room');
  assert.ok(!battle.field.quiet, 'a room standing is something going on');

  assert.equal(battle.field.toggleTrickRoom(), 'ended');
  assert.equal(battle.orderOfPlay()[0], battle.foe);
});

test('a Trick Room runs out after five turns', options, () => {
  const battle = new Battle({
    rng: new Rng(2),
    player: makeFixed(VENUSAUR, 50, ['tackle']),
    foes: [makeFixed(CHARIZARD, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  battle.field.toggleTrickRoom();
  const ended = [];
  for (let turn = 0; turn < 5; turn++) ended.push(...battle.field.tick());
  assert.deepEqual(ended.map((entry) => entry.kind), ['trickRoom']);
  assert.equal(battle.field.trickRoom, 0);
});

test('a Tailwind doubles the Speed of the side it blows behind, for four turns', options, () => {
  const battle = new Battle({
    rng: new Rng(2),
    player: makeFixed(VENUSAUR, 50, ['tackle']),
    foes: [makeFixed(CHARIZARD, 50, ['tackle'])],
    policy: defaultAutoBattle(),
  });
  const before = battle.speedOf(battle.player);
  assert.ok(battle.field.setTailwind('player'));
  assert.equal(battle.speedOf(battle.player), before * 2);
  assert.ok(!battle.field.setTailwind('player'), 'one already blowing is not restarted');
  // Twice as fast is faster than the Charizard.
  assert.equal(battle.orderOfPlay()[0], battle.player);

  const ended = [];
  for (let turn = 0; turn < 4; turn++) ended.push(...battle.field.tick());
  assert.deepEqual(ended.map((entry) => [entry.kind, entry.side]), [['tailwind', 'player']]);
  assert.equal(battle.speedOf(battle.player), before);
});

test('using Trick Room and Tailwind puts them up', options, () => {
  const player = makeFixed(VENUSAUR, 50, ['trick-room']);
  const battle = new Battle({
    rng: new Rng(4),
    player,
    foes: [makeFixed(CHARIZARD, 50, ['tailwind'])],
    policy: { ...defaultAutoBattle(), order: ['trick-room'], mode: 'repeatAll' },
  });
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'trickRoom' && entry.data.state === 'started'));
  assert.ok(battle.field.trickRoom > 0);
});
