/**
 * The battle log as the screen reads it.
 *
 * These run against a fixture of two species and a handful of moves rather
 * than the generated data, so the rules about what an entry carries are
 * checked in a checkout that has never run the asset pipeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';

/** A species with nothing remarkable about it but its typing. */
const species = (id, slug, types, moves) => ({
  id,
  slug,
  name: { ko: slug, en: slug },
  types,
  stats: { hp: 60, atk: 60, def: 60, spa: 60, spd: 60, spe: 60 },
  abilities: [{ name: 'nothing', hidden: false }],
  growthRate: 'medium',
  baseExperience: 60,
  captureRate: 45,
  genderRate: 4,
  height: 10,
  weight: 100,
  effort: {},
  items: [],
  evolutions: [],
  learnset: { level: moves.map((move) => [1, move]), machine: [] },
  forms: [],
});

/** A move, with only the fields the engine actually reads off one. */
const move = (slug, extra = {}) => ({
  id: 1,
  name: { ko: slug, en: slug },
  type: 'normal',
  damageClass: 'physical',
  power: 40,
  accuracy: 100,
  pp: 35,
  priority: 0,
  target: 'selected-pokemon',
  text: { ko: '', en: '' },
  flags: [],
  meta: null,
  statChanges: [],
  ...extra,
});

setGameData(/** @type {any} */ ({
  species: {
    1: species(1, 'alpha', ['normal'], ['tackle']),
    2: species(2, 'beta', ['normal'], ['tackle']),
  },
  moves: {
    tackle: move('tackle'),
    'sand-attack': move('sand-attack', {
      damageClass: 'status',
      power: null,
      statChanges: [{ stat: 'accuracy', change: -1 }],
    }),
    'swords-dance': move('swords-dance', {
      damageClass: 'status',
      power: null,
      statChanges: [{ stat: 'atk', change: 2 }],
    }),
  },
  items: {},
  machines: {},
  natures: { hardy: { name: { ko: 'hardy', en: 'hardy' }, increased: null, decreased: null } },
  abilities: {},
  types: { normal: { name: { ko: 'normal', en: 'normal' }, effectiveness: {} } },
  areas: [],
  sprites: {},
  actors: { portraits: {}, overworld: {}, props: {} },
  bgm: { cues: {}, tracks: {} },
  itemTiers: {},
  leaders: [],
  leagues: [],
}));

const { Battle } = await import('../../app/renderer/engine/battle.mjs');
const { createPokemon, maxHp, setMove } = await import('../../app/renderer/engine/pokemon.mjs');

/** @param {number} id */
function makeOne(id, level = 20, moves = ['tackle']) {
  const pokemon = createPokemon(new Rng(7), id, level, { ivFloor: 31 });
  pokemon.nature = 'hardy';
  pokemon.moves = [];
  moves.forEach((slug, index) => setMove(pokemon, index, slug));
  pokemon.hp = maxHp(pokemon);
  return pokemon;
}

/** @param {any} options */
const makeBattle = (options = {}) =>
  new Battle({
    rng: new Rng(3),
    player: options.player ?? makeOne(1),
    foes: options.foes ?? [makeOne(2)],
    policy: { mode: 'repeatAll', order: [null, null, null, null], conditions: {} },
    items: { choose: () => null, throw: () => false },
    ...options,
  });

test('a faint entry carries the Pokémon that fell', () => {
  const foe = makeOne(2);
  const battle = makeBattle({ foes: [foe] });
  foe.hp = 1;

  /** @type {any[]} */
  let faints = [];
  for (let turn = 0; turn < 20 && battle.running; turn++) {
    faints = faints.concat(battle.takeTurn().filter((entry) => entry.kind === 'faint'));
  }

  const fallen = faints.find((entry) => entry.side === 'foe');
  assert.ok(fallen, 'the foe should have gone down');
  // The screen reads the log after the engine has finished the turn, and by
  // then the last foe to fall has been cleared off the battle — so the entry
  // has to carry it, or the message has no name in it and nothing can be
  // offered to the player to catch.
  assert.equal(battle.foe, null);
  assert.equal(fallen.data.pokemon, foe);
  assert.equal(fallen.data.speciesId, foe.speciesId);
});

test('a stage that cannot move says so instead of passing silently', () => {
  const battle = makeBattle();
  /** @type {any[]} */
  const log = [];

  assert.equal(battle.applyStage(battle.player, 'atk', 6, log), true);
  assert.equal(log.at(-1).kind, 'stat');

  // Already at the ceiling: nothing moves, and the games say as much.
  assert.equal(battle.applyStage(battle.player, 'atk', 1, log), false);
  assert.equal(log.at(-1).kind, 'statFailed');
  assert.equal(log.at(-1).data.stat, 'atk');
});

test('accuracy and evasion land on the stages the hit roll reads', () => {
  const battle = makeBattle();
  const log = [];

  // The move data spells these two out; every other stat is already short.
  battle.applyStage(battle.foe, 'accuracy', -1, log);
  battle.applyStage(battle.player, 'evasion', 1, log);

  assert.equal(battle.foe.stages.acc, -1);
  assert.equal(battle.player.stages.eva, 1);
  assert.equal(battle.foe.stages.accuracy, undefined);
  assert.equal(battle.player.stages.evasion, undefined);
  // And the entry names the stage the rest of the game knows it by.
  assert.deepEqual(log.map((entry) => entry.data.stat), ['acc', 'eva']);
});

test('a stage an item could not move is not announced', () => {
  const battle = makeBattle();
  const log = [];
  battle.applyStage(battle.player, 'atk', 6, log);
  log.length = 0;

  // A berry that finds its stat already maxed stays in the hand, so there is
  // nothing to say about it.
  assert.equal(battle.applyStage(battle.player, 'atk', 1, log, { quiet: true }), false);
  assert.deepEqual(log, []);
});
