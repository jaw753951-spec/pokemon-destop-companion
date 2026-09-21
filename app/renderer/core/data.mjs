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
 * @property {Record<string, any>} abilities keyed by ability slug
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

  const [species, moves, items, machines, natures, abilities, types, areas, sprites, actors, bgm, itemTiers, battle] = await Promise.all([
    loadJson('data', 'species.json'),
    loadJson('data', 'moves.json'),
    loadJson('data', 'items.json'),
    loadJson('data', 'machines.json'),
    loadJson('data', 'natures.json'),
    loadJson('data', 'abilities.json'),
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
    species, moves, items, machines, natures, abilities, types, areas, sprites, actors, bgm, itemTiers, battle,
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

/** @param {string|null|undefined} slug */
export const abilityOf = (slug) => (slug ? gameData().abilities?.[slug] ?? null : null);

/**
 * Whether a move belongs to one of the classes the game acts on.
 *
 * Reading it through here rather than off `move.flags` keeps every caller
 * working against a save and a data file written before the classes existed,
 * where the field is simply absent.
 *
 * @param {any} move
 * @param {string} flag
 */
export const moveHasFlag = (move, flag) => Boolean(move?.flags?.includes(flag));

/**
 * Where a Pokémon's art lives, and how big it is.
 *
 * A shiny Pokémon has art of its own rather than a filter over the ordinary
 * art, so the path and the measurements both move — the two palettes are
 * trimmed separately and need not leave the same margin. A species whose
 * alternate palette never built falls back to the ordinary one, which is worth
 * doing silently: a missing picture is worse than a missing sparkle.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null}|null|undefined} pokemon
 * @param {'front'|'back'|'icon'} kind
 * @returns {{path: string, meta: any}|null}
 */
export function artOf(pokemon, kind) {
  if (!pokemon) return null;
  const entry = gameData().sprites[pokemon.speciesId];
  if (!entry) return null;

  // An alternate forme is a picture of its own beside the default's, which is
  // why the forme is part of the path rather than a filter over it. There is
  // no back or box icon published for the formes, so those fall back to the
  // default's — a Mimikyu that lost its disguise still walks on the same
  // feet, and the player's own busted Mimikyu is drawn mirrored as ever.
  const forme = pokemon.forme;
  if (forme && kind === 'front') {
    const formMeta = entry[`form-${forme}`];
    if (formMeta) {
      const formShiny = pokemon.shiny ? entry.shiny?.[`form-${forme}`] : null;
      const form = formShiny ?? formMeta;
      return {
        path: `pokemon/${pokemon.speciesId}/front-form-${forme}${form === formShiny ? '-shiny' : ''}.png`,
        meta: form,
      };
    }
  }

  const shiny = pokemon.shiny ? entry.shiny?.[kind] : null;
  const meta = shiny ?? entry[kind];
  if (!meta) return null;

  const suffix = shiny ? '-shiny' : '';
  return { path: `pokemon/${pokemon.speciesId}/${kind}${suffix}.png`, meta };
}

/**
 * A key that changes whenever the picture would: the species, which of its
 * two palettes, and which of its shapes it is wearing.
 *
 * Screens that cache a decoded sprite keyed on the species alone would keep
 * showing the ordinary art after a swap to a shiny of the same species, which
 * is exactly the moment a player is looking for the difference — and the same
 * trap again the moment a Castform walks out of the rain.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null}|null|undefined} pokemon
 */
export const spriteKey = (pokemon) =>
  pokemon
    ? `${pokemon.speciesId}${pokemon.shiny ? ':shiny' : ''}${pokemon.forme ? `:${pokemon.forme}` : ''}`
    : '';

/**
 * The `pdc://` URL of a Pokémon's art, for the screens that set an `img` or a
 * CSS background rather than decoding a sprite strip.
 *
 * @param {{speciesId: number, shiny?: boolean, forme?: string|null}|null|undefined} pokemon
 * @param {'front'|'back'|'icon'} kind
 */
export const artPath = (pokemon, kind) => artOf(pokemon, kind)?.path ?? null;

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
