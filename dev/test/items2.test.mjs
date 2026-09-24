/**
 * The items the audit found doing nothing, or doing the wrong thing: the balls
 * that were all a Poké Ball, the Power items' missing effort, the key items
 * with no forme to give, and the held items nobody read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { ballBonus, catchValue } from '../../app/renderer/engine/capture.mjs';
import { EventScheduler } from '../../app/renderer/engine/events.mjs';
import { canHold, eventModifiers, heldPassive, itemNeedsChoice, itemSuits, useItem } from '../../app/renderer/engine/items.mjs';
import { createPokemon, gainFromDefeat, maxHp, maxPp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';
import { VOLATILE } from '../../app/renderer/engine/volatile.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} level @param {string[]} [moves] */
function make(slug, level, moves = []) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31, shiny: false });
  pokemon.nature = 'hardy';
  pokemon.heldItem = null;
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** A session with just a bag and a companion, which is all an item needs. */
function bag(contents, pokemon) {
  return /** @type {any} */ ({
    bag: { ...contents },
    active: pokemon,
    machines: [],
    events: new EventScheduler(),
    countOf(slug) {
      return this.bag[slug] ?? 0;
    },
    addItem(slug, count = 1) {
      this.bag[slug] = (this.bag[slug] ?? 0) + count;
    },
    removeItem(slug, count = 1) {
      const held = this.bag[slug] ?? 0;
      if (held < count) return false;
      if (held === count) delete this.bag[slug];
      else this.bag[slug] = held - count;
      return true;
    },
  });
}

test('each ball earns its bonus only where it should', options, () => {
  const magikarp = make('magikarp', 5);
  const onix = make('onix', 40);
  assert.equal(ballBonus('net-ball', magikarp), 3.5);
  assert.equal(ballBonus('net-ball', onix), 1);
  assert.equal(ballBonus('quick-ball', onix, { throws: 0 }), 5);
  assert.equal(ballBonus('quick-ball', onix, { throws: 1 }), 1);
  assert.equal(ballBonus('dusk-ball', onix, { time: 'night' }), 3);
  assert.equal(ballBonus('dusk-ball', onix, { time: 'day', areaTags: ['cave'] }), 3);
  assert.equal(ballBonus('dusk-ball', onix, { time: 'day' }), 1);
  assert.equal(ballBonus('nest-ball', magikarp), 3.6);
  assert.equal(ballBonus('repeat-ball', onix, { caught: new Set([onix.speciesId]) }), 3.5);
  assert.equal(ballBonus('level-ball', magikarp, { active: make('pikachu', 25) }), 8);
  assert.equal(ballBonus('moon-ball', make('clefairy', 20)), 4);
  assert.equal(ballBonus('fast-ball', make('jolteon', 30)), 4);
  assert.equal(ballBonus('beast-ball', onix), 0.1);
  assert.equal(ballBonus('beast-ball', make('nihilego', 50)), 5);
  assert.equal(ballBonus('ultra-ball', make('nihilego', 50)), 0.1);
  // A Heavy Ball moves the rate itself: Onix is 210 kg.
  assert.ok(catchValue(onix, 'heavy-ball') > catchValue(onix, 'poke-ball'));
  assert.ok(catchValue(magikarp, 'heavy-ball') < catchValue(magikarp, 'poke-ball'));
});

test('a Power item adds its eight effort points', options, () => {
  const pokemon = make('pikachu', 20);
  pokemon.evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  pokemon.heldItem = 'power-bracer';
  const held = heldPassive(pokemon, 'effort');
  // A Magikarp yields one Speed point.
  gainFromDefeat(pokemon, { baseStats: { hp: 20, atk: 10, def: 55, spa: 15, spd: 20, spe: 80 }, baseExp: 40, level: 5 }, {
    effortMultiplier: held?.multiplier ?? 1,
    effortBonus: held?.bonus,
  });
  assert.equal(pokemon.evs.atk, 8);
  assert.equal(pokemon.evs.spe, 1);
});

test('a Lucky Egg’s share is in the experience reported', options, () => {
  const plain = make('pikachu', 20);
  const egged = make('pikachu', 20);
  const defeated = { baseStats: { hp: 20, atk: 10, def: 55, spa: 15, spd: 20, spe: 80 }, baseExp: 40, level: 20 };
  const base = gainFromDefeat(plain, defeated).experience;
  assert.equal(gainFromDefeat(egged, defeated, { experienceMultiplier: 1.5 }).experience, Math.round(base * 1.5));
});

test('a Destiny Knot ties the one who infatuated its holder', options, () => {
  const holder = make('pikachu', 30);
  holder.gender = 'female';
  holder.heldItem = 'destiny-knot';
  const suitor = make('pikachu', 30);
  suitor.gender = 'male';
  const battle = new Battle({ rng: new Rng(3), player: holder, foes: [suitor], policy: defaultAutoBattle() });
  assert.ok(battle.infatuate(battle.foe, battle.player, []));
  assert.ok(battle.foe.volatile[VOLATILE.INFATUATION]);
});

test('a Cleanse Tag keeps a third of the wild Pokémon away, and Honey calls one', options, () => {
  const pokemon = make('pikachu', 20);
  pokemon.heldItem = 'cleanse-tag';
  const session = bag({ honey: 1 }, pokemon);
  assert.deepEqual(eventModifiers(session), { wild: 2 / 3 });
  pokemon.heldItem = null;
  assert.deepEqual(eventModifiers(session), {});

  assert.equal(useItem(session, 'honey').ok, true);
  assert.equal(session.events.roll(new Rng(1)), 'wild');
});

test('a nectar sets an Oricorio’s style and is drunk; a catalog turns Rotom and swaps its move', options, () => {
  const oricorio = make('oricorio', 30);
  const session = bag({ 'yellow-nectar': 1, 'rotom-catalog': 1 }, oricorio);
  assert.equal(useItem(session, 'yellow-nectar').ok, true);
  assert.equal(oricorio.forme, 'oricorio-pom-pom');
  assert.equal(session.bag['yellow-nectar'], undefined);

  const rotom = make('rotom', 30, ['thunder-shock', 'thunderbolt']);
  session.active = rotom;
  assert.equal(useItem(session, 'rotom-catalog').ok, true);
  assert.equal(rotom.forme, 'rotom-heat');
  assert.equal(rotom.moves[0].move, 'overheat');
  assert.equal(session.bag['rotom-catalog'], 1);
});

test('a Keldeo that learns Secret Sword stands Resolute', options, () => {
  const keldeo = make('keldeo', 60, ['surf']);
  assert.equal(keldeo.forme ?? null, null);
  setMove(keldeo, 1, 'secret-sword');
  assert.equal(keldeo.forme, 'keldeo-resolute');
  setMove(keldeo, 1, 'aqua-jet');
  assert.equal(keldeo.forme ?? null, null);
});

test('a regional form swings its species’ item', options, () => {
  const alolan = make('marowak-alola', 40);
  alolan.heldItem = 'thick-club';
  assert.ok(itemSuits(heldPassive(alolan, 'stat'), alolan));
  const galarian = make('farfetchd-galar', 40);
  galarian.heldItem = 'stick';
  assert.ok(itemSuits(heldPassive(galarian, 'crit'), galarian));
});

test('an Ether and a Bottle Cap go where the player points them', options, () => {
  assert.equal(itemNeedsChoice('ether'), 'move');
  assert.equal(itemNeedsChoice('pp-up'), 'move');
  assert.equal(itemNeedsChoice('bottle-cap'), 'stat');
  assert.equal(itemNeedsChoice('elixir'), null);

  const pokemon = make('pikachu', 30, ['thunderbolt', 'quick-attack']);
  pokemon.moves[0].pp = 1;
  pokemon.moves[1].pp = 1;
  const session = bag({ ether: 1, 'bottle-cap': 1 }, pokemon);
  assert.equal(useItem(session, 'ether', { move: 1 }).ok, true);
  assert.equal(pokemon.moves[0].pp, 1);
  assert.equal(pokemon.moves[1].pp, Math.min(maxPp(pokemon.moves[1]), 11));

  pokemon.ivs = { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 };
  assert.equal(useItem(session, 'bottle-cap', { stat: 'spe' }).ok, true);
  assert.equal(pokemon.ivs.spe, 31);
  assert.equal(pokemon.ivs.hp, 1);
});

test('a Fresh-Start Mochi takes the effort back', options, () => {
  const pokemon = make('pikachu', 30);
  pokemon.evs = { hp: 10, atk: 20, def: 0, spa: 0, spd: 0, spe: 252 };
  const session = bag({ 'fresh-start-mochi': 1 }, pokemon);
  assert.equal(useItem(session, 'fresh-start-mochi').ok, true);
  assert.deepEqual(Object.values(pokemon.evs), [0, 0, 0, 0, 0, 0]);
});

test('a Life Orb still costs a Rock Head, and not a Magic Guard', options, () => {
  const run = (ability) => {
    const attacker = make('aerodactyl', 50, ['wing-attack']);
    attacker.ability = ability;
    attacker.heldItem = 'life-orb';
    const battle = new Battle({ rng: new Rng(3), player: attacker, foes: [make('snorlax', 80, ['defense-curl'])], policy: defaultAutoBattle() });
    battle.player.stages.acc = 6;
    battle.takeTurn();
    return maxHp(attacker) - attacker.hp;
  };
  assert.ok(run('rock-head') > 0);
  assert.equal(run('magic-guard'), 0);
});

test('a Razz Berry makes the catch easier, and a catching berry is not held', options, () => {
  const onix = make('onix', 40);
  assert.ok(catchValue(onix, 'poke-ball', { berry: 'golden-razz-berry' }) > catchValue(onix, 'poke-ball', { berry: 'silver-razz-berry' }));
  assert.ok(catchValue(onix, 'poke-ball', { berry: 'silver-razz-berry' }) > catchValue(onix, 'poke-ball'));
  // A Nanab or a Pinap does nothing to the odds.
  assert.equal(catchValue(onix, 'poke-ball', { berry: 'golden-nanab-berry' }), catchValue(onix, 'poke-ball'));
  assert.equal(canHold('golden-razz-berry'), false);
  assert.equal(canHold('sitrus-berry'), true);
});
