/**
 * Check that a build produced everything the game will ask for.
 *
 * The pipeline tolerates individual sources going missing so a single dead URL
 * never fails the whole run — this step is where that tolerance is accounted
 * for, by cross-checking the manifests against what actually landed on disk.
 */
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { MAX_SPECIES } from '../sources.mjs';

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

  const [species, moves, items, machines, natures, types, areas, sprites, actors, bgm, tiers] = await Promise.all(
    [
      'species.json',
      'moves.json',
      'items.json',
      'machines.json',
      'natures.json',
      'types.json',
      'areas.json',
      'sprites.json',
      'actors.json',
      'bgm.json',
      'item-tiers.json',
    ].map(read),
  );

  note(Object.keys(species).length === MAX_SPECIES, `species: ${Object.keys(species).length} of ${MAX_SPECIES}`);
  note(Object.keys(types).length === 18, `types: ${Object.keys(types).length} of 18`);
  note(Object.keys(moves).length > 800, `moves: only ${Object.keys(moves).length}`);
  note(Object.keys(items).length > 1000, `items: only ${Object.keys(items).length}`);
  note(Object.keys(machines).length > 100, `machines: only ${Object.keys(machines).length}`);
  note(Object.keys(natures).length === 25, `natures: ${Object.keys(natures).length} of 25`);
  note(areas.length > 0, 'areas: none built');

  // Every species must be playable: a front sprite, an icon and a learnset.
  const noSprite = [];
  const noLearnset = [];
  const noKorean = [];
  for (const entry of Object.values(species)) {
    const sprite = sprites[entry.id];
    if (!sprite?.front || !sprite.icon) noSprite.push(entry.id);
    if (!entry.learnset?.level?.length) noLearnset.push(entry.id);
    if (!entry.name.ko || entry.name.ko === entry.name.en) noKorean.push(entry.id);
  }
  note(noSprite.length === 0, `species missing art: ${summarize(noSprite)}`);
  note(noLearnset.length === 0, `species missing a level-up learnset: ${summarize(noLearnset)}`);
  if (noKorean.length) log(`note: ${noKorean.length} species fall back to English names`);

  // Every move a learnset names must exist in moves.json.
  const unknownMoves = new Set();
  for (const entry of Object.values(species)) {
    for (const [, move] of entry.learnset.level) if (!moves[move]) unknownMoves.add(move);
    for (const move of entry.learnset.machine) if (!moves[move]) unknownMoves.add(move);
  }
  note(unknownMoves.size === 0, `learnsets reference unknown moves: ${summarize([...unknownMoves])}`);

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

  for (const [role, track] of Object.entries(bgm.cues)) {
    note(track && bgm.tracks[track], `cue ${role}: no track`);
  }

  for (const [tier, list] of Object.entries(tiers)) {
    note(list.length > 0, `item tier ${tier} is empty`);
    for (const name of list) {
      if (!items[name]) problems.push(`item tier ${tier}: unknown item ${name}`);
    }
  }

  note(Object.keys(actors.portraits).length > 50, `trainer portraits: only ${Object.keys(actors.portraits).length}`);
  note(Object.keys(actors.overworld).length > 50, `trainer field sprites: only ${Object.keys(actors.overworld).length}`);
  note(Object.keys(actors.props.berryTrees).length > 10, `berry trees: only ${Object.keys(actors.props.berryTrees).length}`);

  if (problems.length === 0) {
    log(`ok — ${Object.keys(species).length} species, ${areas.length} areas, ${Object.keys(bgm.tracks).length} tracks`);
    return true;
  }

  log(`${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 40)) log(`  - ${problem}`);
  if (problems.length > 40) log(`  … and ${problems.length - 40} more`);
  throw new Error(`Asset verification failed with ${problems.length} problem(s)`);
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
