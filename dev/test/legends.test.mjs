/**
 * The legendaries' shapes: the ones a held item gives, the ones a battle
 * opens in, and the ones a key item from the bag steps through.
 */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { NEEDS_ASSETS, useRealGameData } from './helpers/data.mjs';
import { Rng } from '../../app/renderer/core/rng.mjs';
import { gameData, moveOf, speciesIdBySlug } from '../../app/renderer/core/data.mjs';
import { abilityName } from '../../app/renderer/engine/abilities.mjs';
import { Battle } from '../../app/renderer/engine/battle.mjs';
import { WEATHER } from '../../app/renderer/engine/field.mjs';
import {
  settleForme,
  signatureItems,
  standingForme,
  standingTypes,
  useFormeItem,
} from '../../app/renderer/engine/forms.mjs';
import { itemActions, signatureFind, SIGNATURE_FIND_CHANCE, useItem } from '../../app/renderer/engine/items.mjs';
import { createPokemon, maxHp, setMove } from '../../app/renderer/engine/pokemon.mjs';
import { defaultAutoBattle } from '../../app/renderer/engine/session.mjs';

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

/** @param {any} player @param {Record<string, any>} [extra] */
function fight(player, extra = {}) {
  return new Battle({
    rng: new Rng(3),
    player,
    foes: [make('geodude', 20, ['defense-curl'])],
    policy: defaultAutoBattle(),
    ...extra,
  });
}

/** @param {Record<string, number>} bag @param {any} active */
function fakeSession(bag, active) {
  return /** @type {any} */ ({
    bag,
    active,
    box: [],
    rng: { chance: () => true, pick: (list) => list[0], int: (min) => min },
    countOf: (slug) => bag[slug] ?? 0,
    removeItem: (slug) => {
      bag[slug] -= 1;
    },
  });
}

test('Terapagos Terastallizes by Tera Shift, and into its Stellar Form on the Tera Orb', options, () => {
  const plain = make('terapagos', 60, ['tera-starstorm']);
  const shifted = fight(plain);
  assert.equal(shifted.player.marks.forme, 'terapagos-terastal');
  assert.equal(abilityName(plain), 'tera-shell');
  assert.equal(
    shifted.effectiveMove(shifted.player, shifted.foe, moveOf('tera-starstorm')).type,
    'normal',
    'only the Stellar Form makes it Stellar',
  );

  const orbed = make('terapagos', 60, ['tera-starstorm']);
  orbed.heldItem = 'tera-orb';
  const stellar = fight(orbed, { weather: WEATHER.RAIN });
  assert.equal(stellar.player.marks.forme, 'terapagos-stellar');
  assert.equal(abilityName(orbed), 'teraform-zero');
  assert.equal(stellar.field.weather, null, 'Teraform Zero clears the sky on the way in');
  assert.ok(orbed.hp > maxHp(make('terapagos')), 'the Stellar Form is far sturdier');
  const starstorm = stellar.effectiveMove(stellar.player, stellar.foe, moveOf('tera-starstorm'));
  assert.equal(starstorm.type, 'stellar');

  // The battle over, it is itself again, and no healthier than it can be.
  settleForme(orbed);
  assert.equal(orbed.forme, undefined);
  assert.ok(orbed.hp <= maxHp(orbed));
});

test('Tera Shell turns every hit to not very effective at full health', options, () => {
  const terapagos = make('terapagos');
  const battle = fight(terapagos);
  const taken = (hp) => {
    terapagos.hp = hp;
    return battle.computeDamage(battle.foe, battle.player, moveOf('close-combat'));
  };
  const full = taken(maxHp(terapagos)).damage;
  // The Rng is reseeded so the two rolls match.
  battle.rng = new Rng(5);
  const shellOn = battle.computeDamage(battle.foe, battle.player, moveOf('close-combat')).damage;
  terapagos.hp = maxHp(terapagos) - 1;
  battle.rng = new Rng(5);
  const shellOff = battle.computeDamage(battle.foe, battle.player, moveOf('close-combat')).damage;
  assert.ok(full > 0);
  assert.ok(shellOn * 3 < shellOff, `a super-effective hit at full health is quartered: ${shellOn} vs ${shellOff}`);
});

test('a Primal orb, a rusted sword, a Z crystal take hold only in battle', options, () => {
  const kyogre = make('kyogre');
  kyogre.heldItem = 'blue-orb';
  settleForme(kyogre);
  assert.equal(standingForme(kyogre), null, 'not Primal on the road');
  const battle = fight(kyogre);
  assert.equal(battle.player.marks.forme, 'kyogre-primal');
  assert.equal(battle.field.weather, WEATHER.RAIN, 'Primordial Sea');
  settleForme(kyogre);
  assert.equal(kyogre.forme, undefined);

  const zacian = make('zacian');
  zacian.heldItem = 'rusted-sword';
  assert.equal(fight(zacian).player.marks.forme, 'zacian-crowned');

  // Ultra Burst needs a fused Necrozma first.
  const necrozma = make('necrozma');
  necrozma.heldItem = 'ultranecrozium-z--held';
  assert.notEqual(fight(necrozma).player.marks.forme, 'necrozma-ultra');
  settleForme(necrozma);
  assert.equal(useFormeItem(necrozma, 'n-solarizer--merge'), 'necrozma-dusk');
  assert.equal(fight(necrozma).player.marks.forme, 'necrozma-ultra');
  settleForme(necrozma);
  assert.equal(necrozma.forme, 'necrozma-dusk', 'and fused still, once the battle lets go');
});

test('a held crystal, plate, memory or drive is a shape worn everywhere', options, () => {
  const dialga = make('dialga');
  dialga.heldItem = 'adamant-crystal';
  settleForme(dialga);
  assert.equal(dialga.forme, 'dialga-origin');

  const arceus = make('arceus', 60, ['judgment']);
  arceus.heldItem = 'flame-plate';
  settleForme(arceus);
  assert.deepEqual(standingTypes(arceus), ['fire']);
  const battle = fight(arceus);
  assert.deepEqual(battle.typesOf(battle.player), ['fire']);
  assert.equal(battle.effectiveMove(battle.player, battle.foe, moveOf('judgment')).type, 'fire');

  const silvally = make('silvally', 60, ['multi-attack']);
  silvally.heldItem = 'water-memory';
  settleForme(silvally);
  assert.deepEqual(standingTypes(silvally), ['water']);

  const genesect = make('genesect', 60, ['techno-blast']);
  genesect.heldItem = 'chill-drive';
  settleForme(genesect);
  const drive = fight(genesect);
  assert.equal(drive.effectiveMove(drive.player, drive.foe, moveOf('techno-blast')).type, 'ice');
  assert.deepEqual(drive.typesOf(drive.player), ['bug', 'steel'], 'a drive changes the move, not the Pokémon');
});

test('a key item steps its legendary through its shapes and is kept', options, () => {
  const kyurem = make('kyurem');
  const session = fakeSession({ 'dna-splicers': 1 }, kyurem);
  assert.equal(itemActions(session, 'dna-splicers').use, true);
  assert.ok(useItem(session, 'dna-splicers').ok);
  assert.equal(kyurem.forme, 'kyurem-black');
  useItem(session, 'dna-splicers');
  assert.equal(kyurem.forme, 'kyurem-white');
  useItem(session, 'dna-splicers');
  assert.equal(kyurem.forme, undefined);
  assert.equal(session.bag['dna-splicers'], 1, 'the splicers are a tool, not a potion');

  const deoxys = make('deoxys');
  const seen = [];
  for (let use = 0; use < 4; use++) seen.push(useFormeItem(deoxys, 'meteorite'));
  assert.deepEqual(seen, ['deoxys-attack', 'deoxys-defense', 'deoxys-speed', null]);

  // Somebody else's item does nothing, and the bag does not offer it.
  const pikachu = make('pikachu');
  assert.equal(useFormeItem(pikachu, 'gracidea'), false);
  assert.equal(itemActions(fakeSession({ gracidea: 1 }, pikachu), 'gracidea').use, false);

  // A Zygarde going down to 10% keeps within its smaller bar.
  const zygarde = make('zygarde');
  useFormeItem(zygarde, 'zygarde-cube');
  assert.equal(zygarde.forme, 'zygarde-10');
  assert.equal(zygarde.hp, maxHp(zygarde));
});

test('a Relic Song turns Meloetta, and the next turns it back', options, () => {
  const meloetta = make('meloetta', 60, ['relic-song']);
  const battle = new Battle({
    rng: new Rng(4),
    player: meloetta,
    foes: [make('chansey', 100, ['splash'])],
    policy: defaultAutoBattle(),
  });
  battle.takeTurn();
  assert.equal(battle.player.marks.forme, 'meloetta-pirouette');
  battle.takeTurn();
  assert.notEqual(battle.player.marks.forme, 'meloetta-pirouette');
});

test("a legendary's own item is found only while it is the one travelling", options, () => {
  assert.ok(SIGNATURE_FIND_CHANCE > 0 && SIGNATURE_FIND_CHANCE < 0.5);
  const kyogre = make('kyogre');
  assert.equal(signatureFind(fakeSession({}, kyogre))?.item, 'blue-orb');
  assert.equal(signatureFind(fakeSession({ 'blue-orb': 1 }, kyogre)), null, 'not twice');
  assert.equal(signatureFind(fakeSession({}, make('tauros'))), null, 'nothing for a Tauros');

  // None of them is in the ordinary finds.
  const tiers = new Set(
    Object.values(JSON.parse(readFileSync(new URL('../../data/generated/item-tiers.json', import.meta.url), 'utf8'))).flat(),
  );
  assert.ok(tiers.size > 100);
  for (const item of signatureItems().keys()) assert.ok(!tiers.has(item), `${item} is in the ordinary finds`);
});

test('every forme a battle or a bag can reach is named in Korean', options, () => {
  const unnamed = [];
  for (const species of Object.values(gameData().species)) {
    for (const form of species.forms ?? []) if (!/[가-힣]/.test(form.name?.ko ?? '')) unnamed.push(form.slug);
  }
  assert.deepEqual(unnamed, []);
});
