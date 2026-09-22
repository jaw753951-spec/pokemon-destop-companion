/**
 * The rules that decide how big things are drawn and how hard they are hit.
 *
 * These run against a hand-written dex rather than the generated one: they are
 * about the arithmetic, and a fixture states the cases — a half-metre Pokémon
 * drawn from a large icon, a whale drawn from a small one — far more plainly
 * than hunting for a species that happens to have them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setGameData } from '../../app/renderer/core/data.mjs';
import { ACTOR_HEIGHT, actorHeight, actorScale } from '../../app/renderer/render/field.mjs';
import { companionArmour } from '../../app/renderer/engine/battle.mjs';
import { treeFor } from '../../app/renderer/scenes/fieldevents.mjs';
import { COMPANION_DAMAGE_TAKEN, COMPANION_WEAKNESS_TAKEN } from '../../app/shared/constants.mjs';

/** Heights in decimetres, as PokeAPI files them. */
setGameData(
  /** @type {any} */ ({
    species: {
      10: { id: 10, height: 3 }, // Caterpie, 0.3 m
      143: { id: 143, height: 21 }, // Snorlax, 2.1 m
      302: { id: 302, height: 5 }, // Sableye, 0.5 m
      321: { id: 321, height: 145 }, // Wailord, 14.5 m
    },
  }),
);

/** A sprite is only ever measured, so its own art need not exist. */
const sprite = (width, height) => ({ width, height });

test('a Pokémon is drawn to its own height, not to its icon', () => {
  // The icons: Sableye's is 31x30 and Caterpie's is 14x16, which is why a flat
  // multiplier had the half-metre Sableye towering over the road.
  const sableye = actorHeight(sprite(31, 30), { speciesId: 302 });
  const caterpie = actorHeight(sprite(14, 16), { speciesId: 10 });

  assert.ok(sableye < 26, `Sableye came out ${sableye}px tall`);
  // Both are small Pokémon, so both land near the common height.
  for (const height of [sableye, caterpie]) {
    assert.ok(Math.abs(height - ACTOR_HEIGHT) <= 8, `${height}px is a long way off ${ACTOR_HEIGHT}px`);
  }
});

test('but a bigger Pokémon is still bigger', () => {
  const caterpie = actorHeight(sprite(14, 16), { speciesId: 10 });
  const snorlax = actorHeight(sprite(38, 40), { speciesId: 143 });
  const wailord = actorHeight(sprite(44, 26), { speciesId: 321 });

  assert.ok(snorlax > caterpie, `Snorlax ${snorlax} should top Caterpie ${caterpie}`);
  assert.ok(wailord > snorlax, `Wailord ${wailord} should top Snorlax ${snorlax}`);
  // And the whole roster fits in the window, which is the point of the band.
  assert.ok(wailord <= 44, `Wailord came out ${wailord}px tall`);
});

test('no sprite is blown up or shrunk past what its art can take', () => {
  /** @type {Array<{speciesId: number, art: {width: number, height: number}}>} */
  const cases = [
    { speciesId: 10, art: sprite(14, 16) },
    { speciesId: 302, art: sprite(31, 30) },
    { speciesId: 321, art: sprite(44, 26) },
  ];
  for (const { speciesId, art } of cases) {
    const scale = actorScale(art, { speciesId });
    assert.ok(scale >= 0.6 && scale <= 2, `scale ${scale} for species ${speciesId}`);
  }
});

test('a species the dex has no figure for still gets a size', () => {
  const scale = actorScale(sprite(20, 20), { speciesId: 999 });
  assert.ok(Number.isFinite(scale) && scale > 0, `scale was ${scale}`);
  assert.equal(actorScale(null, { speciesId: 10 }), 1.5, 'no sprite falls back to the prop scale');
});

test('the companion takes less of everything, and more of what beats it', () => {
  const player = /** @type {any} */ ({ side: 'player' });
  const foe = /** @type {any} */ ({ side: 'foe' });

  assert.equal(companionArmour(player, 1), COMPANION_DAMAGE_TAKEN);
  assert.equal(companionArmour(player, 0.5), COMPANION_DAMAGE_TAKEN);
  assert.equal(companionArmour(player, 2), COMPANION_DAMAGE_TAKEN * COMPANION_WEAKNESS_TAKEN);
  assert.equal(companionArmour(player, 4), COMPANION_DAMAGE_TAKEN * COMPANION_WEAKNESS_TAKEN);

  // What the companion deals is untouched, whoever it is hitting.
  assert.equal(companionArmour(foe, 1), 1);
  assert.equal(companionArmour(foe, 2), 1);
  assert.equal(companionArmour(null, 2), 1);
});

test('every berry grows on a tree, and always the same one', () => {
  const trees = { cheri: {}, oran: {}, pecha: {}, sitrus: {} };

  // A berry Emerald drew a tree for grows on its own.
  assert.equal(treeFor('oran-berry', trees), 'oran');
  assert.equal(treeFor('cheri-berry', trees), 'cheri');

  // One it never drew is given one of them — the same one every time, and not
  // the same one as every other berry.
  const roseli = treeFor('roseli-berry', trees);
  assert.ok(Object.keys(trees).includes(roseli), `roseli landed on ${roseli}`);
  assert.equal(treeFor('roseli-berry', trees), roseli, 'the same berry keeps the same tree');

  const spread = new Set(
    ['roseli', 'babiri', 'occa', 'passho', 'wacan', 'rindo', 'yache', 'chople']
      .map((name) => treeFor(`${name}-berry`, trees)),
  );
  assert.ok(spread.size > 1, `eight berries all landed on ${[...spread]}`);

  // And a build with no berry trees at all says so rather than throwing.
  assert.equal(treeFor('oran-berry', {}), null);
});
