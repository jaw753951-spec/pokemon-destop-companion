/**
 * Build the rule data the game runs on: species, moves, items and the type
 * chart, all with official Korean names and text.
 *
 * Rules follow the newest generation a thing exists in — Gen 9 for almost
 * everything, falling back through `VERSION_GROUP_PRIORITY` for species and
 * moves that Scarlet/Violet dropped.
 */
import { join } from 'node:path';

import { fetchBuffer, fetchJson, writeOut } from '../lib/http.mjs';
import {
  flavorBundle,
  genusBundle,
  idFromUrl,
  nameBundle,
  newestVersionGroupFor,
  STAT_KEYS,
} from '../lib/poke.mjs';
import { MAX_SPECIES, MOVE_FLAG_SET, POKEAPI, SHOWDOWN, VERSION_GROUP_PRIORITY } from '../sources.mjs';

/**
 * @param {{dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildDex({ dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;

  const types = await buildTypes(pool, log);
  const moves = await buildMoves(pool, log);
  const natures = await buildNatures(pool, log);
  const everyItem = await buildItems(pool, log, natures);
  const machines = await buildMachines(pool, log);
  const abilities = await buildAbilities(pool, log);
  const species = await buildSpecies(pool, log, limit);

  await attachMoveFlags(moves, log);

  // Which items the game ships is decided here rather than in the screens.
  const items = shippedItems(everyItem, { machines, moves, species, log });
  pruneHeldItems(species, items, log);

  await writeOut(join(dataDir, 'machines.json'), JSON.stringify(machines));
  await writeOut(join(dataDir, 'natures.json'), JSON.stringify(natures));
  await writeOut(join(dataDir, 'abilities.json'), JSON.stringify(abilities));
  await writeOut(join(dataDir, 'types.json'), JSON.stringify(types));
  await writeOut(join(dataDir, 'moves.json'), JSON.stringify(moves));
  await writeOut(join(dataDir, 'items.json'), JSON.stringify(items));
  await writeOut(join(dataDir, 'species.json'), JSON.stringify(species));

  return { types, moves, items, machines, natures, abilities, species };
}

/**
 * The items the game ships, which is everything but the ones it can never have
 * a use for.
 *
 * The line is not "does this work yet". A Mint changes a nature, an Ability
 * Capsule swaps an ability, a PP Up raises a move's PP, a vitamin raises
 * effort, a type-protection Berry softens a hit of one type — the save already
 * carries a nature, an ability, PP, effort and types, so each of those acts on
 * something this game has, whether or not the engine reads it today. Keeping
 * them means the bag is the bag of a Pokémon game, and implementing one later
 * is a change to the engine rather than to the data.
 *
 * What goes is what belongs to a system this game will not have: Mega Stones,
 * Z-Crystals, Dynamax Crystals and Tera Shards change forms; apricorns and TM
 * materials are crafting; curry, sandwiches and Pokéblock berries are cooking;
 * a bicycle and a Rod belong to a world with towns in it. And a handful named
 * one by one, of which the Exp. Share is the clearest: it splits experience
 * between party members, and this game walks a single Pokémon.
 *
 * Each kept item is marked with whether the engine reads it yet, so a screen
 * can say "no effect in this game yet" rather than leaving a player to find
 * out by using one.
 *
 * @param {Record<string, any>} items
 * @param {{machines: Record<string, string>, moves: Record<string, any>, species: Record<string, any>, log: (message: string) => void}} context
 */
function shippedItems(items, { machines, moves, species, log }) {
  /** Items some species evolves by, held or used. */
  const evolutionItems = new Set();
  for (const entry of Object.values(species)) {
    for (const evolution of entry.evolutions ?? []) {
      if (evolution.item) evolutionItems.add(evolution.item);
      if (evolution.heldItem) evolutionItems.add(evolution.heldItem);
    }
  }

  /** @type {Record<string, any>} */
  const out = {};
  /** @type {Record<string, number>} */
  const dropped = {};

  for (const [slug, item] of Object.entries(items)) {
    // A machine is only worth carrying if the move it teaches was shipped.
    if (item.pocket === 'machines' && !moves[machines[slug]]) {
      dropped['unknown move'] = (dropped['unknown move'] ?? 0) + 1;
      continue;
    }

    const reason = KEPT_ITEMS[slug] ? null : RETIRED_ITEMS[slug] ?? RETIRED_CATEGORIES[item.category];
    if (reason) {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
      continue;
    }

    out[slug] = {
      ...item,
      works:
        Boolean(item.use) ||
        Boolean(item.held) ||
        item.pocket === 'pokeballs' ||
        item.pocket === 'machines' ||
        evolutionItems.has(slug),
    };
  }

  const inert = Object.values(out).filter((item) => !item.works).length;
  log(`items ${Object.keys(out).length - inert} of them read by the engine, ${inert} waiting on one`);

  const summary = Object.entries(dropped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  log(`items ${Object.keys(out).length} kept, ${Object.values(dropped).reduce((a, b) => a + b, 0)} dropped (${summary})`);
  return out;
}

/**
 * Item categories that belong to systems this game does not have, and the
 * reason each one goes — which is also what would have to change for it to
 * come back.
 *
 * @type {Record<string, string>}
 */
const RETIRED_CATEGORIES = {
  'mega-stones': 'form changes',
  'dynamax-crystals': 'form changes',
  'z-crystals': 'form changes',
  'tera-shard': 'form changes',
  'species-candies': 'form changes',
  'tm-materials': 'crafting',
  'apricorn-box': 'crafting',
  'curry-ingredients': 'cooking',
  'sandwich-ingredients': 'cooking',
  picnic: 'cooking',
  'baking-only': 'cooking',
  mulch: 'berry growing',
  scarves: 'contests',
  spelunking: 'a world with towns in it',
  gameplay: 'a world with towns in it',
  'plot-advancement': 'a story',
  'event-items': 'a story',
  'data-cards': 'a story',
  'dex-completion': 'a story',
  collectibles: 'selling',
  loot: 'selling',
  unused: 'unused in the games too',
};

/**
 * The few that stay on their own account, because the category they were
 * filed under says nothing about what they are for. A Bottle Cap is listed as
 * loot and is really how a Pokémon's genes are maxed out.
 *
 * @type {Record<string, true>}
 */
const KEPT_ITEMS = {
  'bottle-cap': true,
  'gold-bottle-cap': true,
};

/**
 * The few that go on their own account rather than by category.
 *
 * @type {Record<string, string>}
 */
const RETIRED_ITEMS = {
  'exp-share': 'nothing to share with',
  'exp-share-gen6': 'nothing to share with',
  'amulet-coin': 'selling',
  'luck-incense': 'selling',
  // Story and event items PokeAPI files among the ordinary ones: the Origin
  // Ball and the Legend Plate are handed over by the plot of Legends: Arceus,
  // a Park Ball only exists inside Pal Park's transfer, a Cherish Ball only
  // around an event Pokémon, and a Strange Ball only around one HOME moved.
  'laorigin-ball': 'a story',
  'legend-plate': 'a story',
  'park-ball': 'a story',
  'cherish-ball': 'a story',
  'lastrange-ball': 'a story',
  // Hisui's own balls and berry. Three of the balls share their names with
  // the ordinary Poké, Great and Ultra Balls — the bag listed each twice —
  // and the rest are about throwing distance and being unnoticed, neither of
  // which a companion's battle has. The Hopo Berry is fed from the satchel
  // and has never been held.
  'lapoke-ball': 'Hisui only',
  'lagreat-ball': 'Hisui only',
  'laultra-ball': 'Hisui only',
  'laheavy-ball': 'Hisui only',
  'laleaden-ball': 'Hisui only',
  'lagigaton-ball': 'Hisui only',
  'lafeather-ball': 'Hisui only',
  'lawing-ball': 'Hisui only',
  'lajet-ball': 'Hisui only',
  'hopo-berry': 'Hisui only',
};

/** The 18 battle types with their Korean names and full damage relations. */
async function buildTypes(pool, log) {
  const index = await fetchJson(`${POKEAPI}/type/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const type = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
        if (type.name === 'unknown' || type.name === 'shadow' || type.name === 'stellar') return;
        const relations = type.damage_relations;
        /** @type {Record<string, number>} */
        const effectiveness = {};
        for (const other of relations.double_damage_to) effectiveness[other.name] = 2;
        for (const other of relations.half_damage_to) effectiveness[other.name] = 0.5;
        for (const other of relations.no_damage_to) effectiveness[other.name] = 0;
        out[type.name] = { name: nameBundle(type.names, type.name), effectiveness };
      }),
    ),
  );

  log(`types ${Object.keys(out).length}`);
  return out;
}

async function buildMoves(pool, log) {
  const index = await fetchJson(`${POKEAPI}/move/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const move = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        if (!move || !move.type) return;
        out[move.name] = {
          id: move.id,
          name: nameBundle(move.names, move.name),
          type: move.type.name,
          damageClass: move.damage_class?.name ?? 'status',
          power: move.power,
          accuracy: move.accuracy,
          pp: move.pp ?? 5,
          priority: move.priority ?? 0,
          target: move.target?.name ?? 'selected-pokemon',
          text: flavorBundle(move.flavor_text_entries),
          meta: move.meta
            ? {
                ailment: move.meta.ailment?.name ?? 'none',
                ailmentChance: move.meta.ailment_chance ?? 0,
                category: move.meta.category?.name ?? 'damage',
                critRate: move.meta.crit_rate ?? 0,
                drain: move.meta.drain ?? 0,
                healing: move.meta.healing ?? 0,
                flinchChance: move.meta.flinch_chance ?? 0,
                statChance: move.meta.stat_chance ?? 0,
                minHits: move.meta.min_hits,
                maxHits: move.meta.max_hits,
                minTurns: move.meta.min_turns,
                maxTurns: move.meta.max_turns,
              }
            : null,
          statChanges: (move.stat_changes ?? []).map((change) => ({
            stat: STAT_KEYS[change.stat.name] ?? change.stat.name,
            change: change.change,
          })),
        };
      }),
    ),
  );

  log(`moves ${Object.keys(out).length}`);
  return out;
}

/**
 * Hang each move's classification off it: contact, punch, sound, powder and
 * the rest of the flags the abilities and held items are written against.
 *
 * Showdown's table is a TypeScript module rather than JSON, but the shape it
 * needs to be read at is shallow — one block per move, each with a `num` that
 * is the move's national number and a `flags` object — so a reader for exactly
 * that shape is smaller and steadier than pulling in a parser. Anything whose
 * number is missing or zero is a Showdown invention (the CAP moves, the Z-move
 * variants) and has no move here to belong to.
 *
 * @param {Record<string, any>} moves
 * @param {(message: string) => void} log
 */
async function attachMoveFlags(moves, log) {
  const source = await fetchBuffer(`${SHOWDOWN}/moves.ts`, { allowMissing: true });

  /** @type {Map<number, string[]>} */
  const byNumber = new Map();
  if (source) {
    for (const block of source.toString('utf8').split(/\n\t(?:"[^"]+"|\w+): \{\n/).slice(1)) {
      const number = /^\t\tnum: (\d+),$/m.exec(block);
      const flags = /^\t\tflags: \{([^}]*)\},$/m.exec(block);
      if (!number || !flags || Number(number[1]) === 0) continue;

      const kept = [...flags[1].matchAll(/(\w+): 1/g)]
        .map((match) => match[1])
        .filter((flag) => MOVE_FLAG_SET.has(flag));
      if (kept.length) byNumber.set(Number(number[1]), kept);
    }
  }

  let flagged = 0;
  for (const move of Object.values(moves)) {
    move.flags = byNumber.get(move.id) ?? [];
    if (move.flags.length) flagged++;
  }

  if (!source) log('moves flags unavailable — the classification source could not be read');
  else log(`moves ${flagged} classified (contact, punch, sound, powder and the rest)`);
}

/**
 * The abilities, with their official names and the sentence that states what
 * each one does.
 *
 * Both texts are kept for the same reason the items keep theirs: the flavour
 * line is what a player is shown, and the effect line is the exact rule, which
 * is what lets the Pokémon screen say what an ability actually does rather
 * than repeating the cartridge's hint at it. Which of them the engine has
 * written is the engine's own business — `app/renderer/engine/abilities.mjs`
 * holds that list — so nothing here marks one as working or not.
 */
async function buildAbilities(pool, log) {
  const index = await fetchJson(`${POKEAPI}/ability/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const ability = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        // The main series is the only one this game draws from; the side-game
        // abilities share the namespace and would never be rolled.
        if (!ability || ability.is_main_series === false) return;

        const effect = (ability.effect_entries ?? []).find((item) => item.language?.name === 'en');
        // A few abilities belong to mechanics this game will not have, so
        // keeping them would be keeping a rule that can never fire. The
        // Primal weathers belong to Primordial Groudon and Kyogre, which are
        // not forms this game can reach; Battle Bond's and Power Construct's
        // formes were removed from the games that would carry them here; and
        // the Mega-exclusive abilities hang off Mega Stones, which the item
        // filter below already retires.
        if (FORM_ONLY_ABILITIES.has(ability.name)) return;
        out[ability.name] = {
          id: ability.id,
          name: nameBundle(ability.names, ability.name),
          text: flavorBundle(ability.flavor_text_entries, 'flavor_text'),
          effect: effect?.short_effect ?? '',
        };
      }),
    ),
  );

  log(`abilities ${Object.keys(out).length}`);
  return out;
}

/**
 * The abilities that belong to a forme this game cannot reach, dropped at the
 * source so no species ever rolls one and no screen ever shows one.
 *
 * Each is a mechanic rather than a rule: the Primal weathers ride on the two
 * Primal reversions (which would need Red Orb and Blue Orb to be form-change
 * items, a system the bag has no pocket for), and the two Bond abilities ride
 * on Ash-Greninja and Complete Zygarde — formes the games themselves retired
 * from general play and this companion has no cutscene to earn. Zero to Hero
 * is the one that cannot follow the same road: it is Palafin's only ability,
 * so dropping it would leave the species pointing at nothing, and a Pokémon
 * carrying no ability at all is a worse lie than one carrying a rule the
 * battle never gets to use — a switch-out the game never calls for. It stays
 * as built data the screen shows as inert.
 *
 * @type {Set<string>}
 */
const FORM_ONLY_ABILITIES = new Set([
  'desolate-land',
  'primordial-sea',
  'delta-stream',
  'battle-bond',
  'power-construct',
]);
async function buildItems(pool, log, natures) {
  const categoryIndex = await fetchJson(`${POKEAPI}/item-category/index.json`);
  /** @type {Map<string, {url: string, pocket: string, category: string}>} */
  const wanted = new Map();

  await Promise.all(
    categoryIndex.results.map((entry) =>
      pool(async () => {
        const category = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
        const pocket = category.pocket?.name;
        if (!POCKETS.has(pocket)) return;
        for (const item of category.items) {
          wanted.set(item.name, { url: item.url, pocket, category: category.name });
        }
      }),
    ),
  );

  /** @type {Record<string, any>} */
  const out = {};
  await Promise.all(
    [...wanted.entries()].map(([name, meta]) =>
      pool(async () => {
        const item = await fetchJson(`${POKEAPI}${meta.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        if (!item) return;
        out[name] = {
          id: item.id,
          name: nameBundle(item.names, item.name),
          pocket: meta.pocket,
          category: meta.category,
          cost: item.cost ?? 0,
          flingPower: item.fling_power,
          attributes: (item.attributes ?? []).map((attribute) => attribute.name),
          text: flavorBundle(item.flavor_text_entries, 'text'),
          held: heldEffect(item),
          use: useEffect(item),
          sprite: Boolean(item.sprites?.default),
        };
        unwritten(out[name], name, natures);
      }),
    ),
  );

  log(`items ${Object.keys(out).length} across ${[...POCKETS].join('/')}`);
  return out;
}

/**
 * What an item does while a Pokémon is holding it, read from the one place
 * that states it exactly.
 *
 * The flavour text a player sees is deliberately vague — a Sitrus Berry
 * "restores a little HP" — but PokeAPI's short effect for the same item spells
 * the rule out: "Held: Consumed at 1/2 max HP to recover 1/4 max HP." Parsing
 * that leaves the berries behaving as they do in the games without a table of
 * numbers typed out here, which would be one more thing to keep in step with
 * the data.
 *
 * Anything whose effect is not one of these shapes — the type-resisting
 * berries, the ones that only matter when cooking — comes back null and is
 * simply carried.
 *
 * @param {any} item
 * @returns {any}
 */
function heldEffect(item) {
  const effect = (item.effect_entries ?? []).find((entry) => entry.language?.name === 'en');
  const text = (effect?.short_effect ?? '').replace(/[’']/g, "'");
  // Most held effects announce themselves; the ones that boost a named
  // species — a Thick Club, a Light Ball — simply say what they do, so the
  // opening words they use are allowed through too.
  if (!/^(?:Held:|Raises\b|Doubles\b|Increases\b|Boosts\b|When the holder\b)/i.test(text)) return null;

  const at = (match) => (match ? 1 / Number(match) : null);

  // ---- The berries, which are consumed when their moment comes.

  // "Consumed at 1/2 max HP to recover 1/4 max HP."
  const fraction = /Consumed at 1\/(\d) max HP to (?:recover|restore) 1\/(\d) (?:of its )?max HP/i.exec(text);
  if (fraction) return { on: 'hp', at: at(fraction[1]), heal: { fraction: 1 / Number(fraction[2]) } };

  // "Consumed at 1/2 max HP to recover 10 HP."
  const fixed = /Consumed at 1\/(\d) max HP to (?:recover|restore) (\d+) HP/i.exec(text);
  if (fixed) return { on: 'hp', at: at(fixed[1]), heal: { amount: Number(fixed[2]) } };

  // "Consumed at 1/4 max HP to boost Attack." — and one that rolls a stat.
  const boost = /Consumed at 1\/(\d) max HP to (?:sharply )?boost (?:its )?([A-Za-z ]+?)(?: by two stages)?\./i.exec(text);
  if (boost) {
    const stat = STAT_NAMES[boost[2].trim().toLowerCase()];
    const stages = /two stages/i.test(text) ? 2 : 1;
    if (stat) return { on: 'hp', at: at(boost[1]), stat, stages };
  }

  // The three pinch berries that buy something other than a stat: a Lansat's
  // critical hit ratio, a Micle's accuracy, a Custap's turn.
  const pinchCrit = /Consumed at 1\/(\d) max HP to boost critical hit ratio by (one|two) stages?/i.exec(text);
  if (pinchCrit) return { on: 'hp', at: at(pinchCrit[1]), crit: pinchCrit[2].toLowerCase() === 'two' ? 2 : 1 };

  const pinchAccuracy = /Consumed at 1\/(\d) max HP to boost accuracy of next move by (\d+)%/i.exec(text);
  if (pinchAccuracy) {
    return { on: 'hp', at: at(pinchAccuracy[1]), accuracy: 1 + Number(pinchAccuracy[2]) / 100 };
  }

  if (/Consumed at 1\/(\d) max HP when using a move to go first/i.test(text)) {
    const first = /Consumed at 1\/(\d) max HP/i.exec(text);
    return { on: 'hp', at: at(first?.[1]), first: true };
  }

  // "Consumed when paralyzed to cure paralysis." and its siblings.
  const cure = /Consumed when (paralyzed|asleep|poisoned|burned|frozen|confused) to cure/i.exec(text);
  if (cure) return { on: 'status', status: STATUS_NAMES[cure[1].toLowerCase()] };
  if (/Consumed to cure any status condition/i.test(text)) return { on: 'status', status: 'any' };

  // "Consumed when a move runs out of PP to restore its PP by 10."
  const pp = /Consumed when a move runs out of PP to restore its PP by (\d+)/i.exec(text);
  if (pp) return { on: 'pp', amount: Number(pp[1]) };

  // ---- The things that simply work while they are held.

  // "Poison-type holder recovers 1/16 max HP each turn. Non-Poison-Types take
  // 1/8 max HP damage." — the conditional one is read before the plain one.
  const sludge = /([A-Za-z]+)-type holder recovers 1\/(\d+).*?max HP each turn\..*?take 1\/(\d+).*?max HP damage/i.exec(text);
  if (sludge) {
    return {
      on: 'turn',
      type: sludge[1].toLowerCase(),
      heal: { fraction: 1 / Number(sludge[2]) },
      harm: { fraction: 1 / Number(sludge[3]) },
    };
  }
  const turn = /Restores 1\/(\d+).*?max HP at the end of each turn/i.exec(text);
  if (turn) return { on: 'turn', heal: { fraction: 1 / Number(turn[1]) } };

  // "Fire-Type moves from holder do 20% more damage."
  const typed = /([A-Za-z]+)-Type moves from holder do (\d+)% more damage/i.exec(text);
  if (typed) return { on: 'damage', moveType: typed[1].toLowerCase(), multiplier: 1 + Number(typed[2]) / 100 };

  // "Boosts the damage of physical moves used by the holder by 10%."
  const classed = /Boosts the damage of (physical|special) moves used by the holder by (?:1\/\d+ \()?(\d+)%/i.exec(text);
  if (classed) {
    return { on: 'damage', damageClass: classed[1].toLowerCase(), multiplier: 1 + Number(classed[2]) / 100 };
  }

  // "Holder's Super Effective moves do 20% extra damage."
  const superEffective = /Super Effective moves do (\d+)% extra damage/i.exec(text);
  if (superEffective) {
    return { on: 'damage', superEffective: true, multiplier: 1 + Number(superEffective[1]) / 100 };
  }

  // "Holder's moves inflict 30% extra damage, but cost 10% max HP."
  const orb = /moves inflict (\d+)% extra damage, but cost (\d+)% max HP/i.exec(text);
  if (orb) return { on: 'damage', multiplier: 1 + Number(orb[1]) / 100, cost: Number(orb[2]) / 100 };

  // "Increases Attack by 50%, but restricts the holder to only one move."
  const choice = /Increases ([A-Za-z ]+?) by (\d+)%, but restricts the holder to only one move/i.exec(text);
  if (choice) {
    const stat = STAT_NAMES[choice[1].trim().toLowerCase()];
    if (stat) return { on: 'stat', stats: [stat], multiplier: 1 + Number(choice[2]) / 100, lock: true };
  }

  // "Raises the holder's Special Defense to 1.5×. Prevents the holder from
  // selecting a status move."
  const vest = /Raises the holder's ([A-Za-z ]+?) to ([\d.]+)×/i.exec(text);
  if (vest) {
    const stat = STAT_NAMES[vest[1].trim().toLowerCase()];
    const noStatus = /Prevents the holder from selecting a status move/i.test(text);
    if (stat) return { on: 'stat', stats: [stat], multiplier: Number(vest[2]), noStatus };
  }

  // "Holder has 1.5× Defense and Special Defense, as long as it's not fully
  // evolved."
  const eviolite = /Holder has ([\d.]+)× Defense and Special Defense, as long as it's not fully evolved/i.exec(text);
  if (eviolite) return { on: 'stat', stats: ['def', 'spd'], multiplier: Number(eviolite[1]), unevolvedOnly: true };

  // "Raises the holder's critical hit ratio by one stage."
  if (/Raises the holder's critical hit ratio by one stage/i.test(text)) return { on: 'crit', stages: 1 };

  // "Holder survives any single-hit attack at 1 HP if at max HP."
  if (/survives any single-hit attack at 1 HP if at max HP/i.test(text)) {
    return { on: 'survive', fromFull: true, consumed: true };
  }
  const band = /Holder has (\d+)% chance to survive attacks.*?at 1 HP/i.exec(text);
  if (band) return { on: 'survive', chance: Number(band[1]) / 100 };

  // "Holder receives 1/8 of the damage it deals when attacking."
  const shell = /Holder receives 1\/(\d+) of the damage it deals when attacking/i.exec(text);
  if (shell) return { on: 'drain', fraction: 1 / Number(shell[1]) };

  // "Increases EXP earned in battle by 50%."
  const experience = /Increases EXP earned in battle by (\d+)%/i.exec(text);
  if (experience) return { on: 'experience', multiplier: 1 + Number(experience[1]) / 100 };

  // "Holder has a 3/16 (18.75%) chance to move first."
  const first = /chance to move first/i.test(text) ? /(\d+)\/(\d+)/.exec(text) : null;
  if (first) return { on: 'first', chance: Number(first[1]) / Number(first[2]) };

  // "Holder gains double effort values from battles, but has halved Speed."
  if (/gains double effort values from battles/i.test(text)) {
    return { on: 'effort', multiplier: 2, stats: ['spe'], speed: 0.5 };
  }

  // "Holder gains 4 Special Attack effort values, but has halved Speed in
  // battle." — the six weights, which pay in one stat rather than all of them.
  const weight = /Holder gains (\d+) ([A-Za-z ]+?) effort values, but has halved Speed/i.exec(text);
  if (weight) {
    const stat = STAT_NAMES[weight[2].trim().toLowerCase()];
    if (stat && stat !== 'random') {
      return { on: 'effort', bonus: { stat, amount: Number(weight[1]) }, stats: ['spe'], speed: 0.5 };
    }
  }

  // ---- What a held item says about being hit.

  // "Consumed when struck by a super-effective Fire-type attack to halve the
  // damage." — and the Chilan Berry, which does not wait for it to be super
  // effective because nothing is weak to Normal.
  const resist = /Consumed when struck by a (super-effective )?([A-Za-z]+)-type attack to halve the damage/i.exec(text);
  if (resist) {
    return {
      on: 'resist',
      moveType: resist[2].toLowerCase(),
      superEffectiveOnly: Boolean(resist[1]),
      multiplier: 0.5,
    };
  }

  // "Consumed when struck by a super-effective attack to restore 1/4 max HP."
  const enigma = /Consumed when struck by a super-effective attack to restore 1\/(\d+) max HP/i.exec(text);
  if (enigma) return { on: 'hurt', superEffective: true, heal: { fraction: 1 / Number(enigma[1]) }, consumed: true };

  // "When the holder is hit by a super effective move, its Attack and Special
  // Attack raise by two stages."
  const policy = /When the holder is hit by a super effective move, its ([A-Za-z ]+?) raise by (one|two) stages?/i.exec(text);
  if (policy) {
    const stats = statList(policy[1]);
    if (stats.length) {
      return { on: 'hurt', superEffective: true, stats, stages: policy[2].toLowerCase() === 'two' ? 2 : 1, consumed: true };
    }
  }

  // "Raises the holder's Special Attack by one stage when it takes Water-type
  // damage." and "If the holder is hit by a damaging Ice move, raises its
  // Attack by one stage." — the same rule, written two ways.
  const absorbed =
    /Raises the holder's ([A-Za-z ]+?) by (one|two) stages? when it takes ([A-Za-z]+)-type damage/i.exec(text) ??
    /If the holder is hit by a damaging ([A-Za-z]+) move, raises its ([A-Za-z ]+?) by (one|two) stages?/i.exec(text);
  if (absorbed) {
    // Which of the two sentences matched decides which group is which.
    const typed = /takes/i.test(absorbed[0]);
    const stats = statList(typed ? absorbed[1] : absorbed[2]);
    const stages = (typed ? absorbed[2] : absorbed[3]).toLowerCase() === 'two' ? 2 : 1;
    const moveType = (typed ? absorbed[3] : absorbed[1]).toLowerCase();
    if (stats.length) return { on: 'hurt', moveType, stats, stages, consumed: true };
  }

  // "When the holder is hit by a physical move, increases its Defense by one
  // stage." — the Kee and Maranga Berries.
  const guarded = /When the holder is hit by a (physical|special) move, increases its ([A-Za-z ]+?) by (one|two) stages?/i.exec(text);
  if (guarded) {
    const stats = statList(guarded[2]);
    const stages = guarded[3].toLowerCase() === 'two' ? 2 : 1;
    if (stats.length) return { on: 'hurt', damageClass: guarded[1].toLowerCase(), stats, stages, consumed: true };
  }

  // "Consumed to deal 1/8 attacker's max HP when holder is struck by a
  // physical attack." — the Jaboca and Rowap Berries.
  const thorn = /Consumed to deal 1\/(\d+) attacker's max HP when holder is struck by a (physical|special) attack/i.exec(text);
  if (thorn) {
    return { on: 'hurt', damageClass: thorn[2].toLowerCase(), recoil: { fraction: 1 / Number(thorn[1]) }, consumed: true };
  }

  // "When the holder is hit by a contact move, the attacking Pokémon takes 1/6
  // its max HP in damage."
  const helmet = /When the holder is hit by a contact move, the attacking Pok.mon takes 1\/(\d+) its max HP in damage/i.exec(text);
  if (helmet) return { on: 'contact', recoil: { fraction: 1 / Number(helmet[1]) } };

  // ---- What a held item keeps off its holder.

  // "Prevents damage from powder moves and the damage from Hail and Sandstorm."
  if (/Prevents damage from powder moves/i.test(text)) return { on: 'shield', flags: ['powder'], weather: true };

  // "Prevents side effects of contact moves used on the holder."
  if (/Prevents side effects of contact moves used on the holder/i.test(text)) {
    return { on: 'shield', contactEffects: true };
  }

  // "Grants immunity to Ground-type moves, Spikes, and Toxic Spikes. Consumed
  // when the holder takes damage from a move."
  const balloon = /Grants immunity to ([A-Za-z]+)-type moves/i.exec(text);
  if (balloon) return { on: 'immune', moveType: balloon[1].toLowerCase(), popped: true };

  // ---- What a held item does between turns, or to a turn.

  // "Resets all lowered stats to normal at end of turn. Consumed after use."
  if (/Resets all lowered stats to normal/i.test(text)) return { on: 'restore', consumed: true };

  // "Consumed to cure infatuation. Gen V: Also removes Taunt, Encore, Torment,
  // Disable, and Cursed Body." — everything a Mental Herb undoes is something
  // that took a move away, so it is read as one effect rather than five.
  if (/Consumed to cure infatuation/i.test(text)) return { on: 'free', consumed: true };

  // "Both turns of a two-turn charge move happen at once."
  if (/Both turns of a two-turn charge move happen at once/i.test(text)) return { on: 'charge', consumed: true };

  // "Inflicts Toxic on the holder at the end of the turn."
  const orbStatus = /Inflicts (Toxic|Burn|Poison|Paralysis|Sleep) on the holder at the end of the turn/i.exec(text);
  if (orbStatus) {
    const status = SELF_STATUS_NAMES[orbStatus[1].toLowerCase()];
    if (status) return { on: 'selfStatus', status };
  }

  // "Consumed on Electric Terrain and raises the holder's Defense by one stage."
  const seed = /Consumed on ([A-Za-z]+) Terrain and raises the holder's ([A-Za-z ]+?) by (one|two) stages?/i.exec(text);
  if (seed) {
    const stats = statList(seed[2]);
    if (stats.length) {
      return { on: 'terrain', terrain: seed[1].toLowerCase(), stats, stages: seed[3].toLowerCase() === 'two' ? 2 : 1, consumed: true };
    }
  }

  // "Damaging moves gain a 10% chance to make their target flinch."
  const flinch = /Damaging moves gain a (\d+)% chance to make their target flinch/i.exec(text);
  if (flinch) return { on: 'flinch', chance: Number(flinch[1]) / 100 };

  // "Holder moves last in its priority bracket."
  if (/Holder moves last in its priority bracket/i.test(text)) return { on: 'last' };

  // "Prevents level-based evolution from occuring." — the typo is upstream's.
  if (/Prevents level-based evolution/i.test(text)) return { on: 'noEvolve' };

  // ---- Accuracy, both directions.

  // "Provides a 1/5 (20%) boost in accuracy if the holder moves after the
  // target." — a Wide Lens says the same without the condition.
  const lens = /Provides a 1\/\d+ \((\d+)%\) boost in accuracy(?: if the holder moves after the target)?/i.exec(text);
  if (lens) {
    return { on: 'accuracy', multiplier: 1 + Number(lens[1]) / 100, movingLast: /moves after the target/i.test(text) };
  }

  // "Increases the holder's evasion by 1/9 (11 1/9%)." — evasion raised by a
  // ninth is what an attacker sees as nine tenths the accuracy.
  const evasion = /Increases the holder's evasion by 1\/(\d+)/i.exec(text);
  if (evasion) return { on: 'evasion', multiplier: 1 / (1 + 1 / Number(evasion[1])) };
  const evasionPercent = /Holder's evasion is increased by (\d+)%/i.exec(text);
  if (evasionPercent) return { on: 'evasion', multiplier: 1 / (1 + Number(evasionPercent[1]) / 100) };

  // ---- How long a field effect the holder set lasts.

  // "Sunny Day by the holder lasts 8 rounds instead of 5.", "Light Screen and
  // Reflect used by the holder last 8 rounds instead of 5.", and the Terrain
  // Extender, which says it a third way.
  const rock = /(Sunny Day|Rain Dance|Sandstorm|Hail|Snowscape|Light Screen and Reflect) (?:by|used by) the holder lasts? (\d+) rounds/i.exec(text);
  if (rock) {
    const what = /Screen/i.test(rock[1]) ? 'screen' : 'weather';
    return { on: 'extend', what, turns: Number(rock[2]) };
  }
  const extender = /Extends the holder's Terrain effects to (\d+) turns/i.exec(text);
  if (extender) return { on: 'extend', what: 'terrain', turns: Number(extender[1]) };

  // ---- The ones that only work for one Pokémon.

  // "Doubles Pikachu's Attack and Special Attack.", "Raises Ditto's Defense
  // and Special Defense by 50%."
  const speciesStat =
    /^(?:Held: )?(Doubles|Raises) ([A-Za-z'. ]+?)'s ((?:Attack|Defense|Speed|Special Attack|Special Defense|HP)(?: and (?:Attack|Defense|Speed|Special Attack|Special Defense|HP))?)(?: by (\d+)%)?(?: when held)?[.,]/i.exec(text);
  if (speciesStat) {
    const stats = statList(speciesStat[3]);
    const multiplier = speciesStat[4] ? 1 + Number(speciesStat[4]) / 100 : 2;
    const species = speciesList(speciesStat[2]);
    if (stats.length && species.length) return { on: 'stat', species, stats, multiplier };
  }

  // "Boosts the damage from Dialga's Dragon-type and Steel-type moves by 20%."
  const legendaryOrb = /Boosts the damage from ([A-Za-z'. ]+?)'s ([A-Za-z]+)-type and ([A-Za-z]+)-type moves by (\d+)%/i.exec(text);
  if (legendaryOrb) {
    return {
      on: 'damage',
      species: speciesList(legendaryOrb[1]),
      moveTypes: [legendaryOrb[2].toLowerCase(), legendaryOrb[3].toLowerCase()],
      multiplier: 1 + Number(legendaryOrb[4]) / 100,
    };
  }

  // "Raises Farfetch'd's critical hit ratio by two stages." — and the Scope
  // Lens, which says "the holder" where this says a name.
  const critRatio = /Raises ([A-Za-z'. ]+?)'s critical hit ratio by (one|two) stages?/i.exec(text);
  if (critRatio) {
    const stages = critRatio[2].toLowerCase() === 'two' ? 2 : 1;
    const holder = /^the holder$/i.test(critRatio[1].trim());
    return holder ? { on: 'crit', stages } : { on: 'crit', stages, species: speciesList(critRatio[1]) };
  }

  // "Holder's Speed is halved. Negates all Ground-type immunities" — an Iron
  // Ball costs Speed and drags its holder down to the ground.
  if (/Holder's Speed is halved\./i.test(text) && /Negates all Ground-type immunities/i.test(text)) {
    return { on: 'stat', stats: ['spe'], multiplier: 0.5, grounds: true };
  }

  // "Consectutive uses of the same attack have a cumulative damage boost of
  // 10%. Maximum 100% boost." — the typo is upstream's.
  const metronome = /uses of the same attack have a cumulative damage boost of (\d+)%\.\s*Maximum (\d+)% boost/i.exec(text);
  if (metronome) {
    return { on: 'damage', consecutive: Number(metronome[1]) / 100, max: 1 + Number(metronome[2]) / 100 };
  }

  return null;
}

/**
 * The stats an effect sentence names, in the engine's own keys.
 * @param {string} phrase for example "Attack and Special Attack"
 * @returns {string[]}
 */
function statList(phrase) {
  return phrase
    .split(/\s+and\s+/i)
    .map((part) => STAT_NAMES[part.trim().toLowerCase()])
    .filter((stat) => stat && stat !== 'random');
}

/**
 * The species an effect sentence names, as the slugs the dex files them under.
 *
 * "Cubone or Marowak" and "Latias and Latios" are both two Pokémon, and a
 * Farfetch'd is filed without its apostrophe, so the punctuation goes.
 *
 * @param {string} phrase
 * @returns {string[]}
 */
function speciesList(phrase) {
  return phrase
    .split(/\s+(?:or|and)\s+/i)
    .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

/** The conditions an orb gives its own holder, as its effect text names them. */
const SELF_STATUS_NAMES = { toxic: 'psn', poison: 'psn', burn: 'brn', paralysis: 'par', sleep: 'slp' };

/**
 * What an item does when it is used on a Pokémon, from the same sentence the
 * held effects are read from.
 *
 * "Restores 20 HP." is a Potion; "Restores 10 PP for one move." is an Ether;
 * "Raises Attack effort and happiness." is a Protein. An item whose effect is
 * not one of these — a Mega Stone, a sandwich ingredient, an Exp. Share — comes
 * back null, and the build then leaves it out of the game altogether.
 *
 * @param {any} item
 * @returns {any}
 */
function useEffect(item) {
  const effect = (item.effect_entries ?? []).find((entry) => entry.language?.name === 'en');
  const text = (effect?.short_effect ?? '').replace(/[’']/g, "'");
  if (!text || text.startsWith('Held:')) return null;

  /** @type {any} */
  const use = {};

  // "Revives with half HP." — checked first, since a revival also restores HP
  // and would otherwise read as an ordinary potion.
  const revive = /Revives(?: [^.]+?)? with (half|full) HP/i.exec(text);
  if (revive) return { revive: revive[1].toLowerCase() === 'full' ? 1 : 0.5 };

  if (/Restores HP to full/i.test(text)) use.hp = 'full';
  const hp = /Restores (\d+) HP/i.exec(text);
  if (hp) use.hp = Number(hp[1]);

  // "Restores 10 PP for one move." and "Restores PP to full for each move."
  const pp = /Restores (?:(\d+) PP|PP to full) (?:for|of) (one|each|a single|all) move/i.exec(text);
  if (pp) use.pp = { amount: pp[1] ? Number(pp[1]) : 'full', scope: /each|all/i.test(pp[2]) ? 'all' : 'one' };

  // "Cures any status ailment.", "Cures all major status ailments and
  // confusion." — a Full Heal and a Big Malasada are the same medicine.
  if (/[Cc]ures (?:any|all)? ?(?:major )?status ailments?/.test(text)) use.status = 'any';
  const cure = /Cures (?:a |an )?(poison|paralysis|sleep|burn|freezing|frozen|infatuation|confusion)\b/i.exec(text);
  if (cure && !use.status) {
    const status = CURE_NAMES[cure[1].toLowerCase()];
    if (status) use.status = status;
  }

  // "Raises Attack effort and happiness." and the berries that undo it.
  const raise = /Raises ([A-Za-z ]+?)(?: effort)? and happiness/i.exec(text);
  if (raise) {
    const stat = STAT_NAMES[raise[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: EFFORT_STEP };
  }

  // "Increases HP effort by 1." — the six wings, which are a vitamin paid out
  // a point at a time.
  const wing = /Increases ([A-Za-z ]+?) effort by (\d+)/i.exec(text);
  if (wing && !use.effort) {
    const stat = STAT_NAMES[wing[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: Number(wing[2]) };
  }

  // "Raises a move's max PP by 20%." — a PP Up, and a PP Max, which says 60%
  // because it is the three of them at once.
  const ppUp = /Raises a move's max PP by (\d+)%/i.exec(text);
  if (ppUp) use.ppUp = { fraction: Number(ppUp[1]) / 100, max: PP_UP_LIMIT };

  // "Switches a Pokémon between its two possible (non-Hidden) Abilities."
  if (/Switches a Pok.mon between its two possible \(non-Hidden\) Abilities/i.test(text)) use.ability = 'swap';

  // "Trade to Mr. Hyper to maximize one of a Pokémon's genes." — there is no
  // Mr. Hyper here, so the Bottle Cap simply does what he would have.
  const caps = /maximize (one|all) of a Pok.mon's genes/i.exec(text);
  if (caps) use.genes = caps[1].toLowerCase() === 'all' ? 'all' : 'one';
  const drop = /Drops ([A-Za-z ]+?) Effort Values by (\d+)/i.exec(text);
  if (drop) {
    const stat = STAT_NAMES[drop[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: -Number(drop[2]) };
  }

  if (/Causes a level-up/i.test(text)) use.level = 1;

  return Object.keys(use).length > 0 ? use : null;
}

/**
 * The effects PokeAPI has no sentence for.
 *
 * Every other item in the bag states its own rule and is read from it, which
 * is the point of doing it that way — the numbers stay in the data. These are
 * the ones whose `short_effect` upstream is simply empty, so there is nothing
 * to read and the rule has to be written. Each is a family rather than a name:
 * a mint carries its nature in its slug, a candy its size, a mochi its stat,
 * so one rule covers the twenty-one mints rather than twenty-one lines.
 *
 * Anything not covered here keeps its empty effect and the bag says so.
 *
 * @param {any} item the record being built, modified in place
 * @param {string} slug
 * @param {Record<string, any>} natures
 */
function unwritten(item, slug, natures) {
  if (item.use || item.held) return;

  // A Mint is named for the nature it hands over.
  const mint = /^([a-z]+)-mint$/.exec(slug);
  if (mint && natures[mint[1]]) {
    item.use = { nature: mint[1] };
    return;
  }

  // An Exp. Candy is named for its size, and each size is worth what the
  // games pay for it.
  const candy = /^exp-candy-(xs|s|m|l|xl)$/.exec(slug);
  if (candy) {
    item.use = { experience: EXP_CANDY[candy[1]] };
    return;
  }

  // The Let's Go candies and the Scarlet/Violet mochi both raise one stat's
  // training; the candy says how much in its suffix, and a mochi is a vitamin
  // by another name.
  const training = /^(health|mighty|tough|smart|courage|quick)-candy(?:-(l|xl))?$/.exec(slug);
  if (training) {
    item.use = { effort: { stat: CANDY_STATS[training[1]], amount: CANDY_STEP[training[2] ?? 's'] } };
    return;
  }
  const mochi = /^(health|muscle|resist|genius|clever|swift)-mochi$/.exec(slug);
  if (mochi) {
    item.use = { effort: { stat: MOCHI_STATS[mochi[1]], amount: EFFORT_STEP } };
    return;
  }

  const written = UNWRITTEN[slug];
  if (written) Object.assign(item, written);
}

/** What each size of Exp. Candy is worth, as the games pay it. */
const EXP_CANDY = { xs: 100, s: 800, m: 3000, l: 10000, xl: 30000 };

/** Which stat each Let's Go candy trains, from the name it is sold under. */
const CANDY_STATS = { health: 'hp', mighty: 'atk', tough: 'def', smart: 'spa', courage: 'spd', quick: 'spe' };

/** And how much of it, by the size on the wrapper. */
const CANDY_STEP = { s: 1, l: 3, xl: 10 };

/** Which stat each mochi trains. */
const MOCHI_STATS = { health: 'hp', muscle: 'atk', resist: 'def', genius: 'spa', clever: 'spd', swift: 'spe' };

/**
 * The handful that are neither a family nor documented — one line each, in the
 * same shape the parsers produce.
 *
 * @type {Record<string, {use?: any, held?: any}>}
 */
const UNWRITTEN = {
  // The Fairy type-protection berry, which the other seventeen describe and
  // this one does not.
  'roseli-berry': { held: { on: 'resist', moveType: 'fairy', superEffectiveOnly: true, multiplier: 0.5 } },
  // Hisui's Leppa Berry.
  'hopo-berry': { held: { on: 'pp', amount: 10 } },
  'max-honey': { use: { revive: 1 } },
  // "Raises Special Attack when the holder uses a sound move."
  'throat-spray': { held: { on: 'used', flags: ['sound'], stats: ['spa'], stages: 1, consumed: true } },
  // "Punching moves do 10% more damage and stop counting as contact."
  'punching-glove': { held: { on: 'damage', flags: ['punch'], multiplier: 1.1, dropsContact: true } },
  // "A multi-hit move always hits four or five times."
  'loaded-dice': { held: { on: 'multiHit', min: 4 } },
  'clear-amulet': { held: { on: 'shield', statDrops: true } },
  // "Steps over everything laid on the ground."
  'heavy-duty-boots': { held: { on: 'shield', hazards: true } },
  // The Fairy type booster, which the other seventeen document and this
  // newcomer does not.
  'fairy-feather': { held: { on: 'damage', moveType: 'fairy', multiplier: 1.2 } },
  // The Ability Capsule's opposite number: it hands over the hidden ability
  // rather than swapping the two ordinary ones.
  'ability-patch': { use: { ability: 'hidden' } },
  'covert-cloak': { held: { on: 'shield', secondary: true } },
  'utility-umbrella': { held: { on: 'shield', weatherEffects: true } },
  // "Raises Speed by two stages when one of the holder's moves misses."
  'blunder-policy': { held: { on: 'miss', stats: ['spe'], stages: 2, consumed: true } },
};

/** How much effort a vitamin adds, as the games have always given. */
const EFFORT_STEP = 10;

/** The most a move's PP can be raised above its base, as the games cap it. */
const PP_UP_LIMIT = 0.6;

/** The conditions a medicine can cure, as its effect text names them. */
const CURE_NAMES = {
  poison: 'psn',
  paralysis: 'par',
  sleep: 'slp',
  burn: 'brn',
  freezing: 'frz',
  frozen: 'frz',
  confusion: 'cnf',
};

/** The stats a berry can raise, as the effect text names them. */
const STAT_NAMES = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  'special attack': 'spa',
  'special defense': 'spd',
  speed: 'spe',
  'a random stat': 'random',
};

/** The conditions a berry can cure, as the effect text names them. */
const STATUS_NAMES = {
  paralyzed: 'par',
  asleep: 'slp',
  poisoned: 'psn',
  burned: 'brn',
  frozen: 'frz',
  // Confusion ends with the battle rather than going into the save, so the
  // berry that cures it is read by the battle rather than by the bag.
  confused: 'cnf',
};

/**
 * Which move each TM/HM teaches. An item is reused across generations with
 * different moves, so the newest version group wins.
 * @returns {Promise<Record<string, string>>}
 */
async function buildMachines(pool, log) {
  const index = await fetchJson(`${POKEAPI}/machine/index.json`);
  /** @type {Map<string, {move: string, rank: number}>} */
  const best = new Map();

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const machine = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`, {
          allowMissing: true,
        });
        if (!machine?.item || !machine.move) return;
        const rank = VERSION_GROUP_PRIORITY.indexOf(machine.version_group.name);
        const groupRank = rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
        const previous = best.get(machine.item.name);
        if (!previous || groupRank < previous.rank) {
          best.set(machine.item.name, { move: machine.move.name, rank: groupRank });
        }
      }),
    ),
  );

  /** @type {Record<string, string>} */
  const out = {};
  for (const [item, value] of best) out[item] = value.move;
  log(`machines ${Object.keys(out).length}`);
  return out;
}

/**
 * The 25 natures, with the stat each one raises and lowers.
 * @returns {Promise<Record<string, any>>}
 */
async function buildNatures(pool, log) {
  const index = await fetchJson(`${POKEAPI}/nature/index.json`);
  /** @type {Record<string, any>} */
  const out = {};

  await Promise.all(
    index.results.map((entry) =>
      pool(async () => {
        const nature = await fetchJson(`${POKEAPI}${entry.url.replace('/api/v2', '')}index.json`);
        out[nature.name] = {
          name: nameBundle(nature.names, nature.name),
          increased: nature.increased_stat ? STAT_KEYS[nature.increased_stat.name] ?? null : null,
          decreased: nature.decreased_stat ? STAT_KEYS[nature.decreased_stat.name] ?? null : null,
        };
      }),
    ),
  );

  log(`natures ${Object.keys(out).length}`);
  return out;
}

/** Pockets the game surfaces in its inventory tabs. */
const POCKETS = new Set(['medicine', 'pokeballs', 'machines', 'berries', 'misc', 'key']);

async function buildSpecies(pool, log, limit) {
  const chains = new Map();
  /** @type {Record<string, any>} */
  const out = {};
  let done = 0;

  await Promise.all(
    Array.from({ length: limit }, (_, index) => index + 1).map((id) =>
      pool(async () => {
        const species = await fetchJson(`${POKEAPI}/pokemon-species/${id}/index.json`, { allowMissing: true });
        if (!species) return;

        const variety = species.varieties.find((entry) => entry.is_default) ?? species.varieties[0];
        const pokemon = await fetchJson(
          `${POKEAPI}${variety.pokemon.url.replace('/api/v2', '')}index.json`,
        );

        /** @type {Record<string, number>} */
        const stats = {};
        for (const stat of pokemon.stats) stats[STAT_KEYS[stat.stat.name] ?? stat.stat.name] = stat.base_stat;

        // The other varieties, with the rule each one changes its shape by —
        // weather, health, a held item, a turn spent below half. Only the
        // ones the battle can actually trigger are worth carrying; the rest
        // (regional forms, Mega, Gigantamax) would need a system this game
        // does not have, so they are not fetched at all.
        const forms = await buildForms(species, pool);

        out[id] = {
          id,
          slug: species.name,
          name: nameBundle(species.names, species.name),
          genus: genusBundle(species.genera),
          types: pokemon.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
          stats,
          abilities: pokemon.abilities.map((entry) => ({
            name: entry.ability.name,
            hidden: entry.is_hidden,
          })),
          height: pokemon.height,
          weight: pokemon.weight,
          baseExp: pokemon.base_experience ?? 100,
          growthRate: species.growth_rate?.name ?? 'medium',
          captureRate: species.capture_rate ?? 45,
          genderRate: species.gender_rate,
          heldItems: wildHeldItems(pokemon.held_items),
          eggGroups: species.egg_groups.map((group) => group.name),
          habitat: species.habitat?.name ?? null,
          isLegendary: species.is_legendary,
          isMythical: species.is_mythical,
          isBaby: species.is_baby,
          evolvesFrom: species.evolves_from_species ? idFromUrl(species.evolves_from_species.url) : null,
          text: flavorBundle(species.flavor_text_entries),
          learnset: extractLearnset(pokemon.moves),
          evolutionChain: idFromUrl(species.evolution_chain.url),
          forms,
        };

        const chainId = out[id].evolutionChain;
        if (chainId && !chains.has(chainId)) chains.set(chainId, null);
        done++;
        if (done % 200 === 0) log(`species ${done}/${limit}`);
      }),
    ),
  );

  await attachEvolutions(out, chains, pool);
  log(`species ${Object.keys(out).length}`);
  const formSpecies = Object.values(out).filter((entry) => entry.forms.length).length;
  const formCount = Object.values(out).reduce((total, entry) => total + entry.forms.length, 0);
  log(`species forms ${formCount} across ${formSpecies} species the battle can change`);
  return out;
}

/**
 * Which varieties of a species the battle itself can change between, and what
 * each one looks like.
 *
 * Every non-default variety is fetched for its stats, types and sprite, but
 * only those whose forme hangs off a condition a battle provides are kept —
 * a weather Forecast, a Zen Mode below half, a Disguise broken by a hit, an
 * item a wild Pokémon can be rolled holding. The rest (regional forms, Mega,
 * Gigantamax, Origin, Crowned) would need a trainer to choose them or an item
 * this game retires, so they stay out of the data rather than in it dead.
 *
 * @param {any} species the `pokemon-species` record
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 * @returns {Promise<Array<any>>}
 */
async function buildForms(species, pool) {
  const trigger = FORM_TRIGGER.get(species.name);
  if (!trigger) return [];

  // Only the one alternate forme the engine knows is kept, by the slug
  // `forms.mjs` names for it — a species like Minior publishes a forme per
  // colour, all of which share the one behaviour, and keeping all of them
  // would be thirteen entries the battle can never tell apart.
  const formeSlug = FORM_FORME.get(species.name);
  const wanted = species.varieties.filter(
    (variety) => !variety.is_default && idFromUrl(variety.pokemon.url) !== null,
  );
  const chosen = formeSlug
    ? wanted.filter((variety) => variety.pokemon.name === formeSlug)
    : wanted;
  if (!chosen.length) return [];

  return Promise.all(
    chosen.map((variety) =>
      pool(async () => {
        const pokemon = await fetchJson(
          `${POKEAPI}${variety.pokemon.url.replace('/api/v2', '')}index.json`,
        );
        return {
          slug: pokemon.name,
          name: nameBundle(pokemon.names, pokemon.name),
          // The variety's numeric id, which is where the sprite step finds the
          // forme's picture — most alternate formes live under ids above
          // 10000 rather than beside the default one.
          id: idFromUrl(variety.pokemon.url),
          trigger,
          types: pokemon.types.sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
          stats: pokemon.stats.reduce((record, stat) => {
            record[STAT_KEYS[stat.stat.name] ?? stat.stat.name] = stat.base_stat;
            return record;
          }, {}),
          sprite: Boolean(pokemon.sprites?.other?.showdown?.front_default || pokemon.sprites?.front_default),
        };
      }),
    ),
  );
}

/**
 * The forme each battle-triggered species changes into, by the species that
 * owns it.
 *
 * PokeAPI publishes every published variety — Minior in seven colours and
 * Mimikyu as a totem twice over, and a Darmanitan whose Galar cousin shares
 * the species record — while the battle can only ever reach the one, which
 * this names. The forecast formes and the gulp-missile catches are the
 * exception: those wear a different shape per weather or per catch, and all
 * of them are reachable.
 *
 * @type {Map<string, string|null>}
 */
const FORM_FORME = new Map([
  ['castform', null],
  ['darmanitan', 'darmanitan-zen'],
  ['wishiwashi', 'wishiwashi-school'],
  ['minior', 'minior-red'],
  ['mimikyu', 'mimikyu-busted'],
  ['eiscue', 'eiscue-noice'],
  ['cramorant', null],
]);

/**
 * The battle-triggered forme changes, by the species that owns them.
 *
 * Each trigger names the hook the engine runs it on: `enter` (weather on the
 * way in), `weather` (the sky moving over it), `turn` (end-of-turn health
 * checks), `hit` (a Disguise broken), `move` (a move the holder uses), and
 * `revert` (the condition that undid it has gone). `back` names the forme to
 * fall back to when the condition stops holding, when that differs from the
 * default one.
 *
 * @type {Map<string, string>}
 */
const FORM_TRIGGER = new Map([
  // Weather reads the sky the moment the Pokémon walks in.
  ['castform', 'weather'],
  // Health: Zen Mode below half, Schooling above a quarter, Shields Down the
  // other way round — the meteor up, the core down.
  ['darmanitan', 'turn'],
  ['wishiwashi', 'turn'],
  ['minior', 'turn'],
  // One hit to break, and the battle keeps it broken.
  ['mimikyu', 'hit'],
  ['eiscue', 'hit'],
  // A Surf or a Dive catches something, and it stays caught.
  ['cramorant', 'move'],
]);

/**
 * Forget any held-item slot naming something the game does not ship.
 *
 * A wild Nosepass carries a Star Piece in the cartridge, and a Star Piece is
 * one of the things dropped here because selling is not a system this game
 * has. A slot pointing at an item the bag could never hold would put a
 * Pokémon on the field holding nothing under a name, so it is emptied.
 *
 * @param {Record<string, any>} species
 * @param {Record<string, any>} items
 * @param {(message: string) => void} log
 */
function pruneHeldItems(species, items, log) {
  const dropped = new Set();
  for (const entry of Object.values(species)) {
    for (const slot of /** @type {const} */ (['common', 'rare'])) {
      const slug = entry.heldItems?.[slot];
      if (!slug || items[slug]) continue;
      dropped.add(slug);
      entry.heldItems[slot] = null;
    }
  }

  const carrying = Object.values(species).filter(
    (entry) => entry.heldItems?.common || entry.heldItems?.rare,
  ).length;
  log(`held items ${carrying} species carry one${dropped.size ? `, ${dropped.size} slots dropped with their item` : ''}`);
}

/**
 * The two held-item slots a wild Pokémon rolls from.
 *
 * The cartridges give a species two of them — a common one and a rare one —
 * and roll which, if either, the Pokémon out in the grass turns out to be
 * carrying. PokeAPI publishes the same table as a rarity per version, 50 for
 * the common slot and 5 for the rare one, so the two slots are read back out
 * of it. The newest version that lists anything wins, as everything else here
 * follows the newest generation.
 *
 * A rarity of 100 is a species that always carries the thing, which the
 * cartridges express by putting the same item in both slots — so that is what
 * it comes back as.
 *
 * @param {Array<any>} held
 * @returns {{common: string|null, rare: string|null}}
 */
function wildHeldItems(held) {
  /** @type {{common: string|null, rare: string|null}} */
  const slots = { common: null, rare: null };
  let bestRank = Number.MAX_SAFE_INTEGER;

  for (const entry of held ?? []) {
    for (const detail of entry.version_details ?? []) {
      const rank = VERSION_PRIORITY.indexOf(detail.version.name);
      if (rank < 0 || rank > bestRank) continue;
      // A newer version than anything seen so far replaces the lot: the two
      // slots belong to one generation's table, not to a mixture.
      if (rank < bestRank) {
        bestRank = rank;
        slots.common = null;
        slots.rare = null;
      }
      if (detail.rarity >= 100) {
        slots.common = entry.item.name;
        slots.rare = entry.item.name;
      } else if (detail.rarity >= 50) {
        slots.common = entry.item.name;
      } else if (detail.rarity > 0) {
        slots.rare = entry.item.name;
      }
    }
  }
  return slots;
}

/**
 * The versions a held-item table may be read from, newest first.
 *
 * `VERSION_GROUP_PRIORITY` names version groups; a held-item entry names a
 * version inside one, so the groups are spread back out into the versions
 * they contain.
 */
const VERSION_PRIORITY = [
  'scarlet', 'violet',
  'sword', 'shield',
  'brilliant-diamond', 'shining-pearl',
  'lets-go-pikachu', 'lets-go-eevee',
  'ultra-sun', 'ultra-moon',
  'sun', 'moon',
  'omega-ruby', 'alpha-sapphire',
  'x', 'y',
  'black-2', 'white-2',
  'black', 'white',
  'heartgold', 'soulsilver',
  'platinum',
  'diamond', 'pearl',
  'emerald',
  'firered', 'leafgreen',
  'ruby', 'sapphire',
  'crystal',
  'gold', 'silver',
  'yellow',
  'red', 'blue',
];

/**
 * Level-up and TM learnsets from the newest generation the Pokémon appears in.
 * @param {Array<any>} moves
 */
function extractLearnset(moves) {
  const levelGroup = newestVersionGroupFor(moves, 'level-up');
  const machineGroup = newestVersionGroupFor(moves, 'machine');

  /** @type {Array<[number, string]>} */
  const level = [];
  /** @type {Set<string>} */
  const machine = new Set();
  /** @type {Set<string>} */
  const tutor = new Set();

  for (const entry of moves) {
    for (const detail of entry.version_group_details) {
      const method = detail.move_learn_method.name;
      const group = detail.version_group.name;
      if (method === 'level-up' && group === levelGroup) level.push([detail.level_learned_at, entry.move.name]);
      else if (method === 'machine' && group === machineGroup) machine.add(entry.move.name);
      else if (method === 'tutor' && group === machineGroup) tutor.add(entry.move.name);
    }
  }

  level.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return { level, machine: [...machine].sort(), tutor: [...tutor].sort() };
}

/**
 * Walk each evolution chain once and hang the outgoing edges off every species.
 * @param {Record<string, any>} species
 * @param {Map<number, unknown>} chains
 * @param {<T>(task: () => Promise<T>) => Promise<T>} pool
 */
async function attachEvolutions(species, chains, pool) {
  await Promise.all(
    [...chains.keys()].map((chainId) =>
      pool(async () => {
        const chain = await fetchJson(`${POKEAPI}/evolution-chain/${chainId}/index.json`, {
          allowMissing: true,
        });
        if (!chain) return;
        walkChain(chain.chain, species);
      }),
    ),
  );
}

/** @param {any} node @param {Record<string, any>} species */
function walkChain(node, species) {
  const fromId = idFromUrl(node.species.url);
  const entry = fromId ? species[fromId] : null;
  if (entry) {
    entry.evolutions = node.evolves_to.map((child) => {
      const detail = child.evolution_details[0] ?? {};
      return {
        to: idFromUrl(child.species.url),
        trigger: detail.trigger?.name ?? 'level-up',
        minLevel: detail.min_level ?? null,
        item: detail.item?.name ?? null,
        heldItem: detail.held_item?.name ?? null,
        happiness: detail.min_happiness ?? null,
        timeOfDay: detail.time_of_day || null,
        knownMove: detail.known_move?.name ?? null,
        location: detail.location?.name ?? null,
        gender: detail.gender ?? null,
      };
    });
  }
  for (const child of node.evolves_to) walkChain(child, species);
}
