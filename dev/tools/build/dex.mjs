/**
 * Build the rule data the game runs on: species, moves, items and the type
 * chart, all with official Korean names and text.
 *
 * Rules follow the newest generation a thing exists in — Gen 9 for almost
 * everything, falling back through `VERSION_GROUP_PRIORITY` for species and
 * moves that Scarlet/Violet dropped.
 */
import { join } from 'node:path';

import { fetchJson, writeOut } from '../lib/http.mjs';
import {
  flavorBundle,
  genusBundle,
  idFromUrl,
  nameBundle,
  newestVersionGroupFor,
  STAT_KEYS,
} from '../lib/poke.mjs';
import { MAX_SPECIES, POKEAPI, VERSION_GROUP_PRIORITY } from '../sources.mjs';

/**
 * @param {{dataDir: string, sample: boolean, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildDex({ dataDir, sample, log, pool }) {
  const limit = sample ? 40 : MAX_SPECIES;

  const types = await buildTypes(pool, log);
  const moves = await buildMoves(pool, log);
  const everyItem = await buildItems(pool, log);
  const machines = await buildMachines(pool, log);
  const natures = await buildNatures(pool, log);
  const species = await buildSpecies(pool, log, limit);

  // The bag only carries what the game can act on, which is decided here
  // rather than in the screens: an item nobody can do anything with is an item
  // the player should never have been handed.
  const items = usefulItems(everyItem, { machines, moves, species, log });

  await writeOut(join(dataDir, 'machines.json'), JSON.stringify(machines));
  await writeOut(join(dataDir, 'natures.json'), JSON.stringify(natures));
  await writeOut(join(dataDir, 'types.json'), JSON.stringify(types));
  await writeOut(join(dataDir, 'moves.json'), JSON.stringify(moves));
  await writeOut(join(dataDir, 'items.json'), JSON.stringify(items));
  await writeOut(join(dataDir, 'species.json'), JSON.stringify(species));

  return { types, moves, items, machines, natures, species };
}

/**
 * The items the game is able to do something with.
 *
 * Everything PokeAPI knows about is fetched, because what an item does is
 * decided by its own effect text rather than by a list kept here — and then
 * everything the game cannot act on is dropped. That is most of them: an Exp.
 * Share splits experience between party members and this game walks one
 * Pokémon; a Mega Stone, a Z-Crystal, a sandwich ingredient and a TM material
 * have nothing to act on at all. Keeping them would fill the bag, the item
 * balls on the path and the rarity tiers with things whose only effect is to
 * be carried.
 *
 * What stays: every ball, every machine that teaches a move the game shipped,
 * anything with a parsed use or held effect, and anything an evolution asks
 * for — a Fire Stone, or the Metal Coat something evolves while holding.
 *
 * @param {Record<string, any>} items
 * @param {{machines: Record<string, string>, moves: Record<string, any>, species: Record<string, any>, log: (message: string) => void}} context
 */
function usefulItems(items, { machines, moves, species, log }) {
  /** Items some species' evolution names, held or used. */
  const evolutionItems = new Set();
  for (const entry of Object.values(species)) {
    for (const evolution of entry.evolutions ?? []) {
      if (evolution.item) evolutionItems.add(evolution.item);
      if (evolution.heldItem) evolutionItems.add(evolution.heldItem);
    }
  }

  /** @type {Record<string, any>} */
  const out = {};
  const dropped = { pockets: /** @type {Record<string, number>} */ ({}), total: 0 };

  for (const [slug, item] of Object.entries(items)) {
    const keep =
      item.pocket === 'pokeballs' ||
      (item.pocket === 'machines' && moves[machines[slug]]) ||
      Boolean(item.use) ||
      Boolean(item.held) ||
      evolutionItems.has(slug);

    if (keep) {
      out[slug] = item;
      continue;
    }
    dropped.total += 1;
    dropped.pockets[item.pocket] = (dropped.pockets[item.pocket] ?? 0) + 1;
  }

  const summary = Object.entries(dropped.pockets)
    .sort((a, b) => b[1] - a[1])
    .map(([pocket, count]) => `${pocket} ${count}`)
    .join(', ');
  log(`items ${Object.keys(out).length} kept, ${dropped.total} with no effect dropped (${summary})`);
  return out;
}

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
 * Items, restricted to the pockets the companion actually uses. Categories are
 * read first so we only fetch the items we keep.
 */
async function buildItems(pool, log) {
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
  if (!text.startsWith('Held:') && !/^Raises the holder's/i.test(text)) return null;

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

  // "Consumed when paralyzed to cure paralysis." and its siblings.
  const cure = /Consumed when (paralyzed|asleep|poisoned|burned|frozen) to cure/i.exec(text);
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

  return null;
}

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
  const text = effect?.short_effect ?? '';
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

  if (/[Cc]ures any status ailment/.test(text)) use.status = 'any';
  const cure = /Cures (poison|paralysis|sleep|burns?|freezing|infatuation|confusion)\b/i.exec(text);
  if (cure && !use.status) {
    const status = CURE_NAMES[cure[1].toLowerCase().replace(/s$/, '')];
    if (status) use.status = status;
  }

  // "Raises Attack effort and happiness." and the berries that undo it.
  const raise = /Raises ([A-Za-z ]+?)(?: effort)? and happiness/i.exec(text);
  if (raise) {
    const stat = STAT_NAMES[raise[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: EFFORT_STEP };
  }
  const drop = /Drops ([A-Za-z ]+?) Effort Values by (\d+)/i.exec(text);
  if (drop) {
    const stat = STAT_NAMES[drop[1].trim().toLowerCase()];
    if (stat && stat !== 'random') use.effort = { stat, amount: -Number(drop[2]) };
  }

  if (/Causes a level-up/i.test(text)) use.level = 1;

  return Object.keys(use).length > 0 ? use : null;
}

/** How much effort a vitamin adds, as the games have always given. */
const EFFORT_STEP = 10;

/** The conditions a medicine can cure, as its effect text names them. */
const CURE_NAMES = { poison: 'psn', paralysis: 'par', sleep: 'slp', burn: 'brn', freezing: 'frz' };

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
const STATUS_NAMES = { paralyzed: 'par', asleep: 'slp', poisoned: 'psn', burned: 'brn', frozen: 'frz' };

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
          eggGroups: species.egg_groups.map((group) => group.name),
          habitat: species.habitat?.name ?? null,
          isLegendary: species.is_legendary,
          isMythical: species.is_mythical,
          isBaby: species.is_baby,
          evolvesFrom: species.evolves_from_species ? idFromUrl(species.evolves_from_species.url) : null,
          text: flavorBundle(species.flavor_text_entries),
          learnset: extractLearnset(pokemon.moves),
          evolutionChain: idFromUrl(species.evolution_chain.url),
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
  return out;
}

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
