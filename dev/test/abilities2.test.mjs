/**
 * The abilities added once every species was checked for one that did
 * nothing: the Paradox boosts, the forme switches, copying, and the rest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { moveOf, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { ABILITIES, afterBattle, auraMultiplier } from '../../app/renderer/engine/abilities.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { TERRAIN, WEATHER } from '../../app/renderer/engine/field.mjs';
import { heldPassive } from '../../app/renderer/engine/items.mjs';
import { createPokemon, maxHp, setMove, statsOf } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} level @param {string[]} moves @param {string} [ability] */
function make(slug, level, moves = [], ability) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  if (ability) pokemon.ability = ability;
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} player @param {any} foe @param {Record<string, any>} [extra] */
const fight = (player, foe, extra = {}) =>
  new Battle({ rng: new Rng(3), player, foes: [foe], policy: defaultAutoBattle(), ...extra });

test('Protosynthesis lifts the highest stat in the sun, or on a Booster Energy it spends', options, () => {
  const tusk = make('great-tusk', 50, ['tackle']);
  const plain = fight(tusk, make('chansey', 50, ['splash']));
  const atk = plain.stat(plain.player, 'atk');

  const sunny = fight(make('great-tusk', 50, ['tackle']), make('chansey', 50, ['splash']), { weather: WEATHER.SUN });
  assert.equal(sunny.stat(sunny.player, 'atk'), Math.floor(atk * 1.3));

  const charged = make('great-tusk', 50, ['tackle']);
  charged.heldItem = 'booster-energy';
  const boosted = fight(charged, make('chansey', 50, ['splash']));
  assert.equal(boosted.stat(boosted.player, 'atk'), Math.floor(atk * 1.3));
  assert.equal(charged.heldItem, null, 'the Booster Energy is spent');
});

test('Quark Drive works on Electric Terrain, and a Speed boost is half again', options, () => {
  const bundle = make('iron-bundle', 50, ['tackle']);
  const battle = fight(bundle, make('chansey', 50, ['splash']));
  const before = battle.stat(battle.player, 'spe');
  battle.field.setTerrain(TERRAIN.ELECTRIC, 5);
  assert.equal(battle.stat(battle.player, 'spe'), Math.floor(before * 1.5));
});

test('Stance Change draws the blade to strike', options, () => {
  const aegislash = make('aegislash', 50, ['iron-head'], 'stance-change');
  const battle = fight(aegislash, make('chansey', 80, ['splash']));
  assert.equal(battle.player.marks.forme ?? null, null, 'it walks in guarding');
  const guarding = battle.stat(battle.player, 'atk');
  battle.takeTurn();
  assert.equal(battle.player.marks.forme, 'aegislash-blade');
  assert.ok(battle.stat(battle.player, 'atk') > guarding * 2);
});

test('Hunger Switch turns Morpeko every turn, and its Aura Wheel with it', options, () => {
  const morpeko = make('morpeko', 50, ['aura-wheel'], 'hunger-switch');
  const battle = fight(morpeko, make('chansey', 80, ['splash']));
  battle.takeTurn();
  assert.equal(battle.player.marks.forme, 'morpeko-hangry');
  assert.equal(battle.effectiveMove(battle.player, battle.foe, moveOf('aura-wheel')).type, 'dark');
  battle.takeTurn();
  assert.equal(battle.player.marks.forme ?? null, null);
  assert.equal(battle.effectiveMove(battle.player, battle.foe, moveOf('aura-wheel')).type, 'electric');
});

test('Imposter walks in as whatever it faces', options, () => {
  const ditto = make('ditto', 50, ['transform'], 'imposter');
  const foe = make('charizard', 50, ['flamethrower', 'air-slash']);
  const battle = fight(ditto, foe);
  assert.deepEqual(battle.typesOf(battle.player), ['fire', 'flying']);
  assert.deepEqual(battle.movesOf(battle.player).map((slot) => slot.move), ['flamethrower', 'air-slash']);
  assert.ok(battle.movesOf(battle.player).every((slot) => slot.pp <= 5));
  assert.equal(battle.stat(battle.player, 'spa'), battle.stat(battle.foe, 'spa'));
  assert.equal(battle.player.pokemon.moves[0].move, 'transform', 'its own moves are untouched');

  // And a Ditto without it can use Transform itself.
  const plainDitto = make('ditto', 50, ['transform'], 'limber');
  const manual = fight(plainDitto, make('charizard', 50, ['splash']));
  manual.takeTurn();
  assert.deepEqual(manual.typesOf(manual.player), ['fire', 'flying']);
});

test('a Mummy passes itself on at a touch', options, () => {
  const cofagrigus = make('cofagrigus', 60, ['splash'], 'mummy');
  const attacker = make('machamp', 30, ['bite'], 'guts');
  const battle = new Battle({ rng: new Rng(3), player: attacker, foes: [cofagrigus], policy: defaultAutoBattle() });
  battle.takeTurn();
  assert.equal(battle.abilitySlugOf(battle.player), 'mummy');
  assert.equal(attacker.ability, 'guts', 'only for the battle');
});

test('Neutralizing Gas quiets the ability across from it', options, () => {
  const weezing = make('weezing', 50, ['splash'], 'neutralizing-gas');
  const gyarados = make('gyarados', 50, ['splash'], 'intimidate');
  const battle = fight(weezing, gyarados);
  assert.equal(battle.player.stages.atk ?? 0, 0, 'no Intimidate');
  assert.equal(battle.abilityOf(battle.foe), null);
});

test('the auras lift a type for everyone, and Aura Break turns them round', options, () => {
  assert.equal(auraMultiplier([ABILITIES['fairy-aura'], null], { type: 'fairy' }), 4 / 3);
  assert.equal(auraMultiplier([ABILITIES['fairy-aura'], null], { type: 'dark' }), 1);
  assert.equal(auraMultiplier([ABILITIES['dark-aura'], ABILITIES['aura-break']], { type: 'dark' }), 0.75);
});

test('a Klutz carries its item for nothing', options, () => {
  const lopunny = make('lopunny', 50, [], 'klutz');
  lopunny.heldItem = 'life-orb';
  assert.equal(heldPassive(lopunny, 'damage'), null);
  lopunny.ability = 'cute-charm';
  assert.ok(heldPassive(lopunny, 'damage'));
});

test('Natural Cure and Regenerator do their work as the battle ends', options, () => {
  const chansey = make('chansey', 50, [], 'natural-cure');
  chansey.status = 'psn';
  assert.equal(afterBattle(chansey, maxHp(chansey)), 'cured');
  assert.equal(chansey.status, null);

  const slowbro = make('slowbro', 50, [], 'regenerator');
  slowbro.hp = 1;
  afterBattle(slowbro, maxHp(slowbro));
  assert.equal(slowbro.hp, 1 + Math.floor(maxHp(slowbro) / 3));
  assert.ok(statsOf(slowbro).hp > 0);
});
