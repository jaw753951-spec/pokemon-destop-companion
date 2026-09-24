/**
 * Moves that do something other than deal damage by the formula: the price a
 * move charges its own user, damage fixed in advance, the states a status move
 * leaves behind, the moves that hit more than once, and the ones that end a
 * wild battle outright.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { moveOf } from '../../app/renderer/core/data.mjs';
import { Battle, STATUS } from '../../app/renderer/engine/battle.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const MACHAMP = 68;
const GEODUDE = 74;
const SNORLAX = 143;
const BULBASAUR = 1;
const MAUSHOLD = 925;
const IRON_BOULDER = 1022;

/** A Pokémon with settled genes, so a number in a test means something. */
function fixed(speciesId, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), speciesId, level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  pokemon.ability = 'no-ability';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** A foe that can stand there all day and never hurt anything. */
const punchbag = (level = 70, speciesId = SNORLAX) => fixed(speciesId, level, ['defense-curl']);

function fight(player, foe, extra = {}) {
  return new Battle({ rng: new Rng(7), player, foes: [foe], policy: defaultAutoBattle(), ...extra });
}

/** How many times one move landed on the foe: a multi-hit move reports them in one entry. */
const hitsOf = (log) => log.find((entry) => entry.kind === 'damage' && entry.side === 'foe')?.data?.hits ?? 0;

test('Close Combat lowers its own user, not the target', options, () => {
  const battle = fight(fixed(MACHAMP, 60, ['close-combat']), punchbag());
  battle.takeTurn();
  assert.equal(battle.player.stages.def, -1);
  assert.equal(battle.player.stages.spd, -1);
  assert.equal(battle.foe.stages.def, 1); // its own Defense Curl, nothing more
  assert.equal(battle.foe.stages.spd, 0);
});

test('Seismic Toss deals damage equal to the level', options, () => {
  const battle = fight(fixed(MACHAMP, 42, ['seismic-toss']), punchbag());
  const before = battle.foe.pokemon.hp;
  battle.takeTurn();
  assert.equal(before - battle.foe.pokemon.hp, 42);
});

test('a Substitute costs a quarter and takes the next hit', options, () => {
  // The faster of the two puts it up before the Tackle comes.
  const player = fixed(MACHAMP, 60, ['substitute']);
  const foe = fixed(SNORLAX, 40, ['tackle']);
  const battle = fight(player, foe);
  const full = maxHp(player);
  battle.takeTurn();
  const cost = Math.floor(full / 4);
  // Whatever the Tackle did, it came out of the doll, not the Pokémon.
  assert.equal(player.hp, full - cost);
});

test('Leech Seed drains the target and feeds the user', options, () => {
  const player = fixed(BULBASAUR, 50, ['leech-seed']);
  player.hp = 10;
  const battle = fight(player, punchbag(50));
  battle.player.stages.acc = 6;
  battle.takeTurn();
  const foeMax = maxHp(battle.foe.pokemon);
  assert.equal(battle.foe.volatile.leechSeed, true);
  assert.equal(battle.foe.pokemon.hp, foeMax - Math.floor(foeMax / 8));
  assert.ok(player.hp > 10);

  // A Grass type cannot be seeded.
  const grassy = fight(fixed(BULBASAUR, 50, ['leech-seed']), punchbag(50, BULBASAUR));
  grassy.player.stages.acc = 6;
  grassy.takeTurn();
  assert.ok(!grassy.foe.volatile.leechSeed);
});

test('Toxic poisons badly, and the damage climbs each turn', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['toxic']), punchbag(60));
  battle.takeTurn();
  const foe = battle.foe.pokemon;
  assert.equal(foe.status, STATUS.POISON);
  assert.equal(foe.toxic, true);
  const max = maxHp(foe);
  const first = max - foe.hp;
  assert.equal(first, Math.floor(max / 16));
  const before = foe.hp;
  battle.takeTurn();
  assert.equal(before - foe.hp, Math.floor((max * 2) / 16));
});

test('Tachyon Cutter strikes twice and never misses', options, () => {
  assert.equal(moveOf('tachyon-cutter').accuracy, null);
  const player = fixed(IRON_BOULDER, 60, ['tachyon-cutter']);
  const battle = fight(player, punchbag(90));
  battle.foe.stages.eva = 6;
  const log = battle.takeTurn();
  assert.equal(hitsOf(log), 2);
});

test('Population Bomb keeps going', options, () => {
  const battle = fight(fixed(MAUSHOLD, 60, ['population-bomb']), punchbag(90));
  battle.player.stages.acc = 6;
  const log = battle.takeTurn();
  // Every hit rolls its own accuracy; at +6 none of them misses.
  assert.equal(hitsOf(log), 10);
});

test('Roar sends a wild Pokémon away, and the battle ends there', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['roar']), punchbag());
  // Roar is never picked automatically; call it the way a choice would.
  const log = [];
  battle.forceOut(battle.player, battle.foe, log);
  assert.equal(battle.outcome, 'fled');
  assert.ok(log.some((entry) => entry.kind === 'end'));
});

test('Teleport lets a wild Pokémon leave', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['defense-curl']), fixed(GEODUDE, 20, ['teleport']));
  battle.takeTurn();
  assert.equal(battle.outcome, 'fled');
});

test('a Mimic copies for the battle, and a Sketch for good', options, () => {
  const player = fixed(SNORLAX, 60, ['mimic', 'tackle']);
  const battle = fight(player, fixed(MACHAMP, 40, ['karate-chop']));
  battle.foe.lastMove = 'karate-chop';
  const orig = battle.chooseMove.bind(battle);
  battle.chooseMove = (a, d) => (a === battle.player ? 'mimic' : orig(a, d));
  battle.takeTurn();
  assert.ok(battle.movesOf(battle.player).some((slot) => slot.move === 'karate-chop'));
  assert.equal(player.moves[0].move, 'mimic', 'the save keeps the Mimic');

  const smeargle = fixed(235, 60, ['sketch']);
  const sketching = fight(smeargle, fixed(MACHAMP, 40, ['karate-chop']));
  sketching.foe.lastMove = 'karate-chop';
  sketching.takeTurn();
  assert.equal(smeargle.moves[0].move, 'karate-chop');
});

/** Make the player use `move` this turn, whatever the automatic battler thinks of it. */
function force(battle, move) {
  const own = battle.chooseMove.bind(battle);
  battle.chooseMove = (attacker, defender) => (attacker === battle.player ? move : own(attacker, defender));
}

test('a Power Trick swaps Attack and Defense until it is used again', options, () => {
  const battle = fight(fixed(MACHAMP, 60, ['power-trick']), punchbag());
  const atk = battle.rawStat(battle.player, 'atk');
  const def = battle.rawStat(battle.player, 'def');
  battle.takeTurn();
  assert.equal(battle.rawStat(battle.player, 'atk'), def);
  assert.equal(battle.rawStat(battle.player, 'def'), atk);
});

test('a Lucky Chant keeps critical hits off its side', options, () => {
  const battle = fight(fixed(SNORLAX, 60, ['lucky-chant']), punchbag());
  battle.takeTurn();
  assert.equal(battle.field.sides.player.luckyChant > 0, true);
  battle.foe.stages.crit = 6;
  battle.foe.volatile.laserFocus = 1;
  assert.equal(battle.rollCritical(battle.foe, battle.player, moveOf('tackle')), false);
});

test('a Corrosive Gas melts the item across, and a Bestow hands one over', options, () => {
  const foe = punchbag();
  foe.heldItem = 'leftovers';
  const gassed = fight(fixed(SNORLAX, 60, ['corrosive-gas']), foe);
  gassed.takeTurn();
  assert.equal(foe.heldItem, null);

  const giver = fixed(SNORLAX, 60, ['bestow']);
  giver.heldItem = 'sitrus-berry';
  const gifted = fight(giver, punchbag());
  force(gifted, 'bestow');
  gifted.takeTurn();
  assert.equal(giver.heldItem, null);
  assert.equal(gifted.foe.pokemon.heldItem, 'sitrus-berry');
});

test('a Fire move under Powder blows up on its user', options, () => {
  const foe = fixed(MACHAMP, 20, ['fire-punch']);
  const battle = fight(fixed(SNORLAX, 60, ['powder']), foe);
  battle.player.stages.acc = 6;
  // Powder has priority, so it lands before the Fire Punch goes off.
  const log = battle.takeTurn();
  assert.ok(log.some((entry) => entry.kind === 'message' && entry.data?.key === 'move.powder.exploded'));
  assert.equal(maxHp(foe) - foe.hp, Math.floor(maxHp(foe) / 4));
});
