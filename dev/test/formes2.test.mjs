/**
 * The holes a second look at the formes found: shapes that changed without
 * anyone seeing it, a weather a Forecast did not read, a young Wishiwashi
 * that schooled, items the bag would not offer, and moves a fusion forgot to
 * trade.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { artOf, gameData, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { WEATHER } from '../../app/renderer/engine/field.mjs';
import { HELD_FORMES, SCHOOLING_LEVEL, settleForme, standingTypes } from '../../app/renderer/engine/forms.mjs';
import { itemActions, useItem } from '../../app/renderer/engine/items.mjs';
import { availableMoves, createPokemon, evolveInto, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';
import { battlerArt } from '../../app/renderer/render/battler.mjs';
import { walkerArt } from '../../app/renderer/render/field.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

/** @param {string} slug @param {number} [level] @param {string[]} [moves] */
function make(slug, level = 60, moves = []) {
  const pokemon = createPokemon(new Rng(1), /** @type {number} */ (speciesIdBySlug(slug)), level, { ivFloor: 31 });
  pokemon.heldItem = null;
  settleForme(pokemon);
  if (moves.length) {
    pokemon.moves = [];
    moves.forEach((move, index) => setMove(pokemon, index, move));
  }
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} player @param {any} [foe] */
function fight(player, foe = make('geodude', 20, ['defense-curl'])) {
  return new Battle({ rng: new Rng(3), player, foes: [foe], policy: defaultAutoBattle() });
}

/** @param {Record<string, number>} contents @param {any} pokemon */
function bag(contents, pokemon) {
  return /** @type {any} */ ({
    bag: { ...contents },
    active: pokemon,
    machines: [],
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

test('every forme looks like itself: its own walking art, or its battle sprite where there is none', options, () => {
  const sprites = gameData().sprites;
  for (const species of Object.values(gameData().species)) {
    for (const form of species.forms ?? []) {
      const pokemon = { speciesId: species.id, forme: form.slug };
      const plain = { speciesId: species.id };
      const fought = battlerArt(pokemon);
      assert.ok(fought, `${form.slug} has nothing to fight in`);
      assert.notEqual(fought.path, battlerArt(plain)?.path, `${form.slug} fights in its species' art`);
      if (sprites[species.id]?.[`walk-form-${form.slug}`]) {
        assert.match(walkerArt(pokemon, 'walk')?.path ?? '', new RegExp(`walk-form-${form.slug}\\.png$`));
      }
    }
  }
  // A Rotom in the washer walks in the washer, and a shiny one in the shiny
  // washer where the collab drew one.
  const wash = { speciesId: /** @type {number} */ (speciesIdBySlug('rotom')), forme: 'rotom-wash' };
  assert.match(walkerArt(wash, 'idle')?.path ?? '', /idle-form-rotom-wash\.png$/);
  assert.match(artOf({ ...wash, shiny: true }, 'walk')?.path ?? '', /walk-form-rotom-wash(-shiny)?\.png$/);
  // A forme the collab never drew still walks the road in its species' art.
  const rider = { speciesId: /** @type {number} */ (speciesIdBySlug('calyrex')), forme: 'calyrex-ice' };
  assert.match(walkerArt(rider, 'walk')?.path ?? '', /\/walk\.png$/);
  assert.equal(battlerArt(rider)?.meta.facing, 'left');
});

test('a Castform in hail is snowy, as it is in snow', options, () => {
  const castform = make('castform', 50);
  castform.ability = 'forecast';
  const battle = fight(castform);
  battle.field.setWeather(WEATHER.HAIL, 5);
  battle.evaluateFormes([]);
  assert.equal(battle.player.marks.forme, 'castform-snowy');
  assert.deepEqual(battle.typesOf(battle.player), ['ice']);
});

test('a Wishiwashi schools only from level 20', options, () => {
  const young = make('wishiwashi', SCHOOLING_LEVEL - 1);
  young.ability = 'schooling';
  assert.equal(fight(young).player.marks.forme ?? null, null, 'too young to call a school');

  const grown = make('wishiwashi', SCHOOLING_LEVEL);
  grown.ability = 'schooling';
  assert.equal(fight(grown).player.marks.forme, 'wishiwashi-school');
});

test('only an Ogerpon is met holding the item that shapes it', options, () => {
  for (const slug of HELD_FORMES.keys()) {
    const id = /** @type {number} */ (speciesIdBySlug(slug));
    const held = new Set();
    for (let seed = 1; seed <= 40; seed++) held.add(createPokemon(new Rng(seed), id, 60).heldItem ?? null);
    if (slug === 'ogerpon') assert.ok(held.size > 1, 'an Ogerpon comes in its masks');
    else assert.deepEqual([...held], [null], `a ${slug} came holding ${[...held].join(', ')}`);
  }
});

test('the bag offers a nectar to an Oricorio, and to nothing else', options, () => {
  const oricorio = make('oricorio', 30);
  assert.equal(itemActions(bag({ 'pink-nectar': 1 }, oricorio), 'pink-nectar').use, true);
  assert.equal(itemActions(bag({ 'pink-nectar': 1 }, make('pikachu', 30)), 'pink-nectar').use, false);
});

test('a Ditto that copied a Disguise has no disguise to break', options, () => {
  const mimikyu = make('mimikyu', 50, ['shadow-sneak']);
  mimikyu.ability = 'disguise';
  const ditto = make('ditto', 50, ['transform']);
  ditto.ability = 'imposter';
  const battle = fight(mimikyu, ditto);
  assert.ok(battle.foe.transform, 'the Imposter took the Mimikyu’s shape');
  assert.equal(battle.abilitySlugOf(battle.foe), 'disguise');
  const tackle = { damageClass: 'physical' };
  assert.equal(battle.bustForme(battle.player, battle.foe, tackle), false);
  assert.equal(battle.bustForme(battle.foe, battle.player, tackle), true);
});

test('a Type: Null holding a memory evolves straight into that type', options, () => {
  const typeNull = make('type-null', 60);
  typeNull.heldItem = 'fire-memory';
  evolveInto(typeNull, /** @type {number} */ (speciesIdBySlug('silvally')));
  assert.equal(typeNull.forme, 'silvally-fire');
  assert.deepEqual(standingTypes(typeNull), ['fire']);
});

test('a fusion trades its moves, and parting forgets what the fusion brought', options, () => {
  const kyurem = make('kyurem', 70, ['scary-face', 'glaciate', 'dragon-pulse']);
  const splicers = bag({ 'dna-splicers': 1 }, kyurem);
  useItem(splicers, 'dna-splicers');
  assert.equal(kyurem.forme, 'kyurem-black');
  assert.deepEqual(kyurem.moves.map((slot) => slot.move), ['fusion-bolt', 'freeze-shock', 'dragon-pulse']);
  useItem(splicers, 'dna-splicers');
  assert.deepEqual(kyurem.moves.map((slot) => slot.move), ['fusion-flare', 'ice-burn', 'dragon-pulse']);
  useItem(splicers, 'dna-splicers');
  assert.equal(kyurem.forme ?? null, null);
  assert.deepEqual(kyurem.moves.map((slot) => slot.move), ['scary-face', 'glaciate', 'dragon-pulse']);

  const calyrex = make('calyrex', 70, ['psychic', 'giga-drain']);
  const reins = bag({ 'reins-of-unity': 1 }, calyrex);
  useItem(reins, 'reins-of-unity');
  assert.deepEqual(calyrex.moves.map((slot) => slot.move), ['psychic', 'giga-drain', 'glacial-lance']);
  useItem(reins, 'reins-of-unity');
  assert.deepEqual(calyrex.moves.map((slot) => slot.move), ['psychic', 'giga-drain', 'astral-barrage']);
  useItem(reins, 'reins-of-unity');
  assert.deepEqual(calyrex.moves.map((slot) => slot.move), ['psychic', 'giga-drain']);

  // One that knew nothing but the fusion's move remembers a Confusion.
  const lone = make('calyrex', 70, ['psychic']);
  const lonely = bag({ 'reins-of-unity': 1 }, lone);
  useItem(lonely, 'reins-of-unity');
  lone.moves = [{ move: 'glacial-lance', pp: 5, ppUp: 0 }];
  useItem(lonely, 'reins-of-unity');
  useItem(lonely, 'reins-of-unity');
  assert.deepEqual(lone.moves.map((slot) => slot.move), ['confusion']);

  // A Necrozma's Sunsteel Strike is in no learnset; the fusion is where it
  // comes from, and the move list offers it while the fusion lasts.
  const necrozma = make('necrozma', 70, ['psychic', 'x-scissor', 'rock-slide', 'swords-dance']);
  useItem(bag({ 'n-solarizer--merge': 1 }, necrozma), 'n-solarizer--merge');
  assert.equal(necrozma.forme, 'necrozma-dusk');
  assert.ok(availableMoves(necrozma).includes('sunsteel-strike'));
});
