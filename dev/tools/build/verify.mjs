/**
 * Check that a build produced everything the game will ask for.
 *
 * The pipeline tolerates individual sources going missing so a single dead URL
 * never fails the whole run — this step is where that tolerance is accounted
 * for, by cross-checking the manifests against what actually landed on disk.
 */
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { defaultLanguage } from '../../../app/shared/languages.mjs';
import { LANGUAGES } from '../languages.mjs';
import { MAX_SPECIES, MOVE_FLAG_SET } from '../sources.mjs';

/**
 * @param {{assetDir: string, dataDir: string, log: (message: string) => void}} context
 */
export async function verifyAssets({ assetDir, dataDir, log }) {
  /** @type {string[]} */
  const problems = [];
  const note = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const read = async (name) => JSON.parse(await readFile(join(dataDir, name), 'utf8'));
  const readAuthored = async (name) =>
    JSON.parse(await readFile(join(dataDir, '..', 'authored', name), 'utf8'));

  const [species, moves, items, machines, natures, abilities, types, areas, sprites, actors, bgm, tiers, battle] =
    await Promise.all(
      [
        'species.json',
        'moves.json',
        'items.json',
        'machines.json',
        'natures.json',
        'abilities.json',
        'types.json',
        'areas.json',
        'sprites.json',
        'actors.json',
        'bgm.json',
        'item-tiers.json',
        'battle.json',
      ].map(read),
    );

  note(Object.keys(species).length === MAX_SPECIES, `species: ${Object.keys(species).length} of ${MAX_SPECIES}`);
  note(Object.keys(types).length === 18, `types: ${Object.keys(types).length} of 18`);
  note(Object.keys(moves).length > 800, `moves: only ${Object.keys(moves).length}`);
  // The build drops what belongs to a system this game will not have, and
  // keeps everything that acts on something it does — whether or not the
  // engine reads it yet.
  note(Object.keys(items).length > 600, `items: only ${Object.keys(items).length}`);
  const retired = Object.entries(items).filter(([, item]) =>
    ['mega-stones', 'z-crystals', 'dynamax-crystals', 'tera-shard', 'curry-ingredients', 'tm-materials'].includes(
      item.category,
    ),
  );
  note(retired.length === 0, `items from a retired system kept: ${summarize(retired.map(([slug]) => slug))}`);
  note(items['exp-share'] === undefined, 'the Exp. Share has nothing to share with');
  // Anything the engine does read must say what it does.
  const silent = Object.entries(items).filter(
    ([slug, item]) => item.works && !item.use && !item.held && item.pocket !== 'pokeballs' && item.pocket !== 'machines'
      && !evolutionItem(species, slug),
  );
  note(silent.length === 0, `items marked as working with no effect: ${summarize(silent.map(([slug]) => slug))}`);
  note(Object.keys(machines).length > 100, `machines: only ${Object.keys(machines).length}`);
  note(Object.keys(natures).length === 25, `natures: ${Object.keys(natures).length} of 25`);
  note(Object.keys(abilities).length > 250, `abilities: only ${Object.keys(abilities).length}`);
  note(areas.length > 0, 'areas: none built');

  // A move without its classification would quietly take every ability and
  // held item that keys off one out of the game, so the count is checked
  // rather than the field's presence.
  const unclassified = Object.values(moves).filter((move) => !Array.isArray(move.flags));
  note(unclassified.length === 0, `moves with no classification field: ${unclassified.length}`);
  const classified = Object.values(moves).filter((move) => move.flags?.length).length;
  note(classified > 300, `moves classified: only ${classified}`);
  const strayFlags = new Set();
  for (const move of Object.values(moves)) {
    for (const flag of move.flags ?? []) if (!MOVE_FLAG_SET.has(flag)) strayFlags.add(flag);
  }
  note(strayFlags.size === 0, `moves carry classifications the game does not ship: ${summarize([...strayFlags])}`);

  // Every species must be playable: a front sprite, an icon and a learnset.
  const noSprite = [];
  const noShiny = [];
  const noShinyIcon = [];
  const noLearnset = [];
  const unknownAbilities = new Set();
  /** How many species each language shows another language's name for. */
  const borrowed = new Map(LANGUAGES.map((language) => [language.code, 0]));
  for (const entry of Object.values(species)) {
    const sprite = sprites[entry.id];
    if (!sprite?.front || !sprite.icon) noSprite.push(entry.id);
    if (!sprite?.shiny?.front) noShiny.push(entry.id);
    // The shiny box icon is derived from the two front sprites rather than
    // downloaded, and that needs both of them to have come from the same
    // source — so a gap here is a Pokémon that walks the field in its
    // ordinary colours, not a broken build.
    if (sprite?.shiny?.front && !sprite?.shiny?.icon) noShinyIcon.push(entry.id);
    if (!entry.learnset?.level?.length) noLearnset.push(entry.id);
    for (const ability of entry.abilities ?? []) {
      if (!abilities[ability.name]) unknownAbilities.add(ability.name);
    }
    for (const language of LANGUAGES) {
      if (!untranslated(entry.name, language)) continue;
      borrowed.set(language.code, (borrowed.get(language.code) ?? 0) + 1);
    }
  }
  note(noSprite.length === 0, `species missing art: ${summarize(noSprite)}`);
  note(noShiny.length === 0, `species missing alternate-palette art: ${summarize(noShiny)}`);
  if (noShinyIcon.length) {
    log(`note: ${noShinyIcon.length} species have no shiny box icon and walk the field in their ordinary colours`);
  }
  note(unknownAbilities.size === 0, `species name abilities that were not built: ${summarize([...unknownAbilities])}`);
  note(noLearnset.length === 0, `species missing a level-up learnset: ${summarize(noLearnset)}`);
  for (const [code, count] of borrowed) {
    if (count) log(`note: ${count} species have no official "${code}" name and fall back`);
  }

  // Every move a learnset names must exist in moves.json.
  const unknownMoves = new Set();
  for (const entry of Object.values(species)) {
    for (const [, move] of entry.learnset.level) if (!moves[move]) unknownMoves.add(move);
    for (const move of entry.learnset.machine) if (!moves[move]) unknownMoves.add(move);
  }
  note(unknownMoves.size === 0, `learnsets reference unknown moves: ${summarize([...unknownMoves])}`);

  // The alternate palettes are files of their own, so the manifest measuring
  // one is not proof that it landed.
  const sampleIds = Object.keys(sprites).slice(0, 12);
  for (const id of sampleIds) {
    for (const [kind, meta] of Object.entries(sprites[id].shiny ?? {})) {
      if (!meta) continue;
      // eslint-disable-next-line no-await-in-loop
      note(await fileExists(join(assetDir, 'pokemon', id, `${kind}-shiny.png`)), `species ${id}: no shiny ${kind}`);
    }
  }

  // Every area needs its five backgrounds and a loadable track.
  for (const area of areas) {
    for (const time of ['dawn', 'day', 'afternoon', 'dusk', 'night']) {
      // eslint-disable-next-line no-await-in-loop
      note(await fileExists(join(assetDir, 'areas', area.id, `${time}.png`)), `area ${area.id}: no ${time} background`);
    }
    note(!area.music || Boolean(bgm.tracks[area.music]), `area ${area.id}: music ${area.music} was not built`);
    note(area.encounters.length > 0, `area ${area.id}: no wild encounters`);
  }

  // Every encounter must name a species we actually shipped.
  const slugs = new Map(Object.values(species).map((entry) => [entry.slug, entry.id]));
  const unknownEncounters = new Set();
  for (const area of areas) {
    for (const encounter of area.encounters) if (!slugs.has(encounter.species)) unknownEncounters.add(encounter.species);
  }
  if (unknownEncounters.size) log(`note: ${unknownEncounters.size} encounter species not matched by slug (${summarize([...unknownEncounters])})`);

  // Every backdrop the manifest names, every backdrop an area's tags can ask
  // for, and every badge must be on disk.
  for (const id of Object.keys(battle.backdrops)) {
    // eslint-disable-next-line no-await-in-loop
    note(await fileExists(join(assetDir, 'battle', `${id}.png`)), `battle backdrop ${id}: not built`);
  }
  for (const [tag, backdrop] of Object.entries(battle.tags)) {
    note(Boolean(battle.backdrops[backdrop]), `tag ${tag}: names unbuilt backdrop ${backdrop}`);
  }
  for (const id of Object.keys(battle.rooms)) {
    // eslint-disable-next-line no-await-in-loop
    note(await fileExists(join(assetDir, 'rooms', `${id}.png`)), `league room ${id}: not built`);
    note(Boolean(battle.backdrops[id]), `league room ${id}: no backdrop of the same name`);
  }
  for (const type of battle.badges) {
    // eslint-disable-next-line no-await-in-loop
    note(await fileExists(join(assetDir, 'badges', `${type}.png`)), `badge ${type}: not built`);
    note(Boolean(types[type]), `badge ${type}: not a type`);
  }
  for (const area of areas) {
    note(
      area.tags.some((tag) => battle.tags[tag]),
      `area ${area.id}: no tag maps to a battle backdrop`,
    );
  }

  for (const [role, track] of Object.entries(bgm.cues)) {
    note(track && bgm.tracks[track], `cue ${role}: no track`);
  }

  for (const [tier, list] of Object.entries(tiers)) {
    note(list.length > 0, `item tier ${tier} is empty`);
    for (const name of list) {
      if (!items[name]) problems.push(`item tier ${tier}: unknown item ${name}`);
    }
  }

  await verifyAuthored({ readAuthored, species, types, actors, note, log });

  note(Object.keys(actors.portraits).length > 50, `trainer portraits: only ${Object.keys(actors.portraits).length}`);
  note(Object.keys(actors.overworld).length > 50, `trainer field sprites: only ${Object.keys(actors.overworld).length}`);
  note(Object.keys(actors.props.berryTrees).length > 10, `berry trees: only ${Object.keys(actors.props.berryTrees).length}`);
  note(Boolean(actors.props.center?.door), 'the Pokémon Center was not cut out of its town');
  note(await fileExists(join(assetDir, 'props', 'poke-center.png')), 'Pokémon Center: no building');
  note(await fileExists(join(assetDir, 'props', 'poke-center-door.png')), 'Pokémon Center: no door animation');

  if (problems.length === 0) {
    log(`ok — ${Object.keys(species).length} species, ${areas.length} areas, ${Object.keys(bgm.tracks).length} tracks`);
    return true;
  }

  log(`${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 40)) log(`  - ${problem}`);
  if (problems.length > 40) log(`  … and ${problems.length - 40} more`);
  throw new Error(`Asset verification failed with ${problems.length} problem(s)`);
}

/**
 * The hand-written data: trainer classes, gym leaders and the leagues.
 *
 * These are the only files in the project typed out by hand rather than
 * derived, so every species id, type and portrait they name is checked against
 * what the pipeline actually produced.
 */
async function verifyAuthored({ readAuthored, species, types, actors, note, log }) {
  const [classes, leaders, leagues] = await Promise.all([
    readAuthored('trainer-classes.json').then((file) => file.classes).catch(() => null),
    readAuthored('leaders.json').then((file) => file.leaders).catch(() => null),
    readAuthored('leagues.json').then((file) => file.leagues).catch(() => null),
  ]);

  if (!classes || !leaders || !leagues) {
    log('note: authored data is missing, so trainers and the league are unavailable');
    return;
  }

  for (const entry of classes) {
    note(Boolean(actors.overworld[entry.field]), `trainer class ${entry.id}: no field sprite ${entry.field}`);
    note(Boolean(actors.portraits[entry.portrait]), `trainer class ${entry.id}: no portrait ${entry.portrait}`);
    for (const type of entry.types) note(Boolean(types[type]), `trainer class ${entry.id}: unknown type ${type}`);
  }

  const coveredTypes = new Set(leaders.map((leader) => leader.type));
  note(coveredTypes.size === 18, `gym leaders cover ${coveredTypes.size} of 18 types`);
  const base = defaultLanguage(LANGUAGES);
  for (const leader of leaders) {
    note(Boolean(types[leader.type]), `leader ${leader.id}: unknown type ${leader.type}`);
    note(Boolean(leader.name?.[base.code]), `leader ${leader.id}: no ${base.code} name`);
    if (leader.portrait) {
      note(Boolean(actors.portraits[leader.portrait]), `leader ${leader.id}: no portrait ${leader.portrait}`);
    }
  }
  // Names for the other languages are authored by hand, so a gap is worth
  // reporting but never worth failing a build over.
  for (const language of LANGUAGES) {
    if (language.code === base.code) continue;
    const missing = leaders.filter((leader) => !leader.name?.[language.code]);
    if (!missing.length) continue;
    const listed = missing.map((leader) => leader.name?.[base.code] ?? leader.id).join(', ');
    log(`note: ${missing.length} leader(s) have no "${language.code}" name (${listed})`);
  }

  for (const league of leagues) {
    const members = [...league.eliteFour, league.champion];
    note(league.eliteFour.length >= 4, `league ${league.region}: only ${league.eliteFour.length} Elite Four`);
    for (const member of members) {
      note(Boolean(member.name?.[base.code]), `league ${league.region}/${member.id}: no ${base.code} name`);
      note((member.party ?? []).length > 0, `league ${league.region}/${member.id}: no party`);
      for (const id of member.party ?? []) {
        note(Boolean(species[id]), `league ${league.region}/${member.id}: unknown species ${id}`);
      }
      if (member.type) note(Boolean(types[member.type]), `league ${league.region}/${member.id}: unknown type ${member.type}`);
      if (member.portrait) {
        note(Boolean(actors.portraits[member.portrait]), `league ${league.region}/${member.id}: no portrait ${member.portrait}`);
      }
    }
  }

  log(`authored: ${classes.length} trainer classes, ${leaders.length} gym leaders, ${leagues.length} leagues`);
}

const summarize = (list) => `${list.length} (${list.slice(0, 6).join(', ')}${list.length > 6 ? ', …' : ''})`;

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a record shows another language's text under this language's code,
 * which is what the bundles do when a source carries no name for it.
 *
 * @param {Record<string, string>} bundle
 * @param {import('../../../app/shared/languages.mjs').Language} language
 */
function untranslated(bundle, language) {
  const text = bundle?.[language.code];
  if (!text) return true;
  return Boolean(language.fallback) && text === bundle[/** @type {string} */ (language.fallback)];
}

/**
 * Whether some species evolves by this item, held or used — the one thing an
 * item with no effect of its own can still be kept for.
 *
 * @param {Record<string, any>} species
 * @param {string} slug
 */
function evolutionItem(species, slug) {
  return Object.values(species).some((entry) =>
    (entry.evolutions ?? []).some((evolution) => evolution.item === slug || evolution.heldItem === slug),
  );
}
