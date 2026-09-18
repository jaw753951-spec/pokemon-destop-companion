/**
 * The generated game data, loaded once at start-up.
 *
 * Everything here is read-only reference data — species, moves, items, areas,
 * the type chart — as opposed to the save, which holds the player's state.
 */
import { loadJson } from './bridge.mjs';

/**
 * @typedef {Object} GameData
 * @property {Record<string, any>} species keyed by Pokédex number
 * @property {Record<string, any>} moves keyed by move slug
 * @property {Record<string, any>} items keyed by item slug
 * @property {Record<string, string>} machines TM slug to move slug
 * @property {Record<string, any>} natures keyed by nature slug
 * @property {Record<string, any>} types keyed by type slug
 * @property {Array<any>} areas
 * @property {Record<string, any>} sprites keyed by Pokédex number
 * @property {Record<string, any>} actors
 * @property {{cues: Record<string, string>, tracks: Record<string, any>}} bgm
 * @property {Record<string, string[]>} itemTiers
 * @property {{backdrops: Record<string, any>, rooms: Record<string, any>, tags: Record<string, string>, badges: string[]}} battle
 * @property {Array<any>} trainerClasses
 * @property {Array<any>} leaders
 * @property {Array<any>} leagues
 */

/** @type {GameData|null} */
let data = null;

/** @returns {Promise<GameData>} */
export async function loadGameData() {
  if (data) return data;

  const [species, moves, items, machines, natures, types, areas, sprites, actors, bgm, itemTiers, battle] = await Promise.all([
    loadJson('data', 'species.json'),
    loadJson('data', 'moves.json'),
    loadJson('data', 'items.json'),
    loadJson('data', 'machines.json'),
    loadJson('data', 'natures.json'),
    loadJson('data', 'types.json'),
    loadJson('data', 'areas.json'),
    loadJson('data', 'sprites.json'),
    loadJson('data', 'actors.json'),
    loadJson('data', 'bgm.json'),
    loadJson('data', 'item-tiers.json'),
    loadJson('data', 'battle.json'),
  ]);

  // Authored data is optional: a checkout without it still runs, just without
  // trainers or the league.
  const [trainerClasses, leaders, leagues] = await Promise.all([
    loadJson('authored', 'trainer-classes.json').then((file) => file.classes ?? []).catch(() => []),
    loadJson('authored', 'leaders.json').then((file) => file.leaders ?? []).catch(() => []),
    loadJson('authored', 'leagues.json').then((file) => file.leagues ?? []).catch(() => []),
  ]);

  data = {
    species, moves, items, machines, natures, types, areas, sprites, actors, bgm, itemTiers, battle,
    trainerClasses, leaders, leagues,
  };
  return data;
}

/**
 * Install a data set directly, bypassing the loader.
 *
 * The engine modules are pure functions over this data, and the unit tests
 * exercise them against the real generated JSON read from disk — which they can
 * only do if the data can be supplied without going through the preload bridge.
 *
 * @param {GameData|null} next
 */
export function setGameData(next) {
  data = next;
  slugIndex = null;
}

/** @returns {GameData} */
export function gameData() {
  if (!data) throw new Error('Game data has not been loaded yet');
  return data;
}

/** @param {number|string} id */
export const speciesOf = (id) => gameData().species[String(id)] ?? null;

/** @param {string} slug */
export const moveOf = (slug) => gameData().moves[slug] ?? null;

/** @param {string} slug */
export const itemOf = (slug) => gameData().items[slug] ?? null;

/**
 * Damage multiplier of one attacking type against a defender's types.
 * @param {string} attacking
 * @param {string[]} defending
 * @returns {number}
 */
export function typeEffectiveness(attacking, defending) {
  const chart = gameData().types[attacking];
  if (!chart) return 1;
  return defending.reduce((total, type) => total * (chart.effectiveness[type] ?? 1), 1);
}

/** Species slug to Pokédex number, built on first use. */
let slugIndex = null;

/** @param {string} slug */
export function speciesIdBySlug(slug) {
  if (!slugIndex) {
    slugIndex = new Map(Object.values(gameData().species).map((entry) => [entry.slug, entry.id]));
  }
  return slugIndex.get(slug) ?? null;
}
