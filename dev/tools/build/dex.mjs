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
  const items = await buildItems(pool, log);
  const machines = await buildMachines(pool, log);
  const natures = await buildNatures(pool, log);
  const species = await buildSpecies(pool, log, limit);

  await writeOut(join(dataDir, 'machines.json'), JSON.stringify(machines));
  await writeOut(join(dataDir, 'natures.json'), JSON.stringify(natures));
  await writeOut(join(dataDir, 'types.json'), JSON.stringify(types));
  await writeOut(join(dataDir, 'moves.json'), JSON.stringify(moves));
  await writeOut(join(dataDir, 'items.json'), JSON.stringify(items));
  await writeOut(join(dataDir, 'species.json'), JSON.stringify(species));

  return { types, moves, items, machines, natures, species };
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
          sprite: Boolean(item.sprites?.default),
        };
      }),
    ),
  );

  log(`items ${Object.keys(out).length} across ${[...POCKETS].join('/')}`);
  return out;
}

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
          genus: {
            ko: species.genera.find((entry) => entry.language.name === 'ko')?.genus
              ?? species.genera.find((entry) => entry.language.name === 'en')?.genus
              ?? '',
            en: species.genera.find((entry) => entry.language.name === 'en')?.genus ?? '',
          },
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
