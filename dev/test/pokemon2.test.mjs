/**
 * What a Pokémon is and can learn: the female variants the dex files apart,
 * the moves evolving teaches, and the ones a tutor or a forme brings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, moveOf, speciesIdBySlug, speciesOf } from '../../app/renderer/core/data.mjs';
import {
  availableMoves,
  createPokemon,
  evolveInto,
  genderedSpecies,
  learnOnEvolution,
  setMove,
} from '../../app/renderer/engine/pokemon.mjs';

const ready = await useRealGameData();
const options = { skip: ready ? false : NEEDS_ASSETS };

const id = (slug) => /** @type {number} */ (speciesIdBySlug(slug));

test('a female Indeedee is the female entry, and a male one is not', options, () => {
  const female = createPokemon(new Rng(1), id('indeedee'), 30, { gender: 'female' });
  assert.equal(speciesOf(female.speciesId).slug, 'indeedee-female');
  assert.ok(speciesOf(female.speciesId).abilities.some((entry) => entry.name === female.ability));

  const male = createPokemon(new Rng(1), id('indeedee'), 30, { gender: 'male' });
  assert.equal(speciesOf(male.speciesId).slug, 'indeedee');
  assert.equal(genderedSpecies(id('indeedee-female'), 'male'), id('indeedee'));
});

test('a female Lechonk grows into the female Oinkologne, and either can be met', options, () => {
  assert.equal(speciesOf(id('oinkologne')).genderRate, 4);
  const lechonk = createPokemon(new Rng(1), id('lechonk'), 20, { gender: 'female' });
  evolveInto(lechonk, id('oinkologne'));
  assert.equal(speciesOf(lechonk.speciesId).slug, 'oinkologne-female');
});

test('evolving teaches the evolution move, into a free slot', options, () => {
  const charmeleon = createPokemon(new Rng(1), id('charmeleon'), 36, {});
  charmeleon.moves = charmeleon.moves.slice(0, 2);
  evolveInto(charmeleon, id('charizard'));
  const taught = learnOnEvolution(charmeleon);
  assert.ok(taught.learned.includes('air-slash'));
  assert.ok(charmeleon.moves.some((slot) => slot.move === 'air-slash'));

  // With four moves already, the move waits in the list.
  const full = createPokemon(new Rng(1), id('charmeleon'), 36, {});
  ['scratch', 'ember', 'growl', 'smokescreen'].forEach((move, index) => setMove(full, index, move));
  evolveInto(full, id('charizard'));
  assert.deepEqual(learnOnEvolution(full).waiting, ['air-slash']);
});

test('a tutor move is there to learn at any level', options, () => {
  // Any species whose tutor list names a move the game ships.
  const species = Object.values(gameData().species).find((entry) =>
    (entry.learnset.tutor ?? []).some((move) => moveOf(move)),
  );
  assert.ok(species, 'some species learns something from a tutor');
  const pokemon = createPokemon(new Rng(1), species.id, 1, {});
  const move = species.learnset.tutor.find((slug) => moveOf(slug));
  assert.ok(availableMoves(pokemon).includes(move), move);
});

test('a Calyrex riding its steed can learn the steed’s moves', options, () => {
  const calyrex = createPokemon(new Rng(1), id('calyrex'), 80, {});
  const before = availableMoves(calyrex);
  assert.ok(!before.includes('glacial-lance'));
  calyrex.forme = 'calyrex-ice';
  assert.ok(availableMoves(calyrex).includes('glacial-lance'));
});
