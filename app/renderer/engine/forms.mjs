/**
 * The formes a battle can change, and the moment each one changes in.
 *
 * A species' `forms` array in the dex names every alternate forme whose
 * trigger the battle itself can supply — weather a Forecast reads, health a
 * Zen Mode waits on, a hit that breaks a Disguise, a move that catches
 * something. This is the table that says which ability keys each species off
 * and which way round the two shapes go.
 *
 * The forme itself lives on the combatant (`marks.forme`), the way a Protean's
 * type does: the save never carries one, because a battle is where forme
 * changes happen and where they end.
 *
 * @typedef {Object} SpeciesForm
 * @property {string} slug the variety slug the dex files it under
 * @property {string} trigger the moment it changes in
 * @property {string[]} types its types
 * @property {Record<string, number>} stats its base stats
 * @property {boolean} sprite whether the pipeline carried a picture for it
 */

import { speciesOf } from '../core/data.mjs';

/** The ability each forme-changing species keys off. */
export const FORM_ABILITY = new Map([
  ['castform', 'forecast'],
  ['darmanitan', 'zen-mode'],
  ['wishiwashi', 'schooling'],
  ['minior', 'shields-down'],
  ['mimikyu', 'disguise'],
  ['eiscue', 'ice-face'],
  ['cramorant', 'gulp-missile'],
]);

/**
 * The formes a held item decides, by species and then by item: the forme it
 * takes, and the type its signature move becomes.
 *
 * Ogerpon wears whichever mask it is holding — Water, Fire or Rock on top of
 * its Grass, with the forme's own ability — and its Ivy Cudgel turns the
 * mask's type. Without a mask it is the Teal Mask, the species' own shape.
 *
 * @type {Map<string, Map<string, {forme: string, type: string}>>}
 */
export const HELD_FORMES = new Map([
  [
    'ogerpon',
    new Map([
      ['wellspring-mask', { forme: 'ogerpon-wellspring-mask', type: 'water' }],
      ['hearthflame-mask', { forme: 'ogerpon-hearthflame-mask', type: 'fire' }],
      ['cornerstone-mask', { forme: 'ogerpon-cornerstone-mask', type: 'rock' }],
    ]),
  ],
]);

/**
 * The forme a Pokémon's held item puts it in, if its species has one and the
 * dex carries it.
 *
 * @param {{speciesId: number, heldItem?: string|null}|null|undefined} pokemon
 * @returns {{forme: string, type: string}|null}
 */
export function heldForme(pokemon) {
  const species = speciesOf(pokemon?.speciesId);
  const byItem = HELD_FORMES.get(species?.slug ?? '');
  const entry = byItem?.get(pokemon?.heldItem ?? '');
  if (!entry || !(species.forms ?? []).some((form) => form.slug === entry.forme)) return null;
  return entry;
}

/**
 * Put a Pokémon into the shape its held item calls for, outside a battle.
 *
 * A mask is not a battle trick: an Ogerpon holding one wears it on the road
 * and in the menus too, so handing one over or taking it back changes the
 * Pokémon there and then. Any other species is left as it is.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function settleHeldForme(pokemon) {
  if (!HELD_FORMES.has(speciesOf(pokemon?.speciesId)?.slug ?? '')) return;
  const entry = heldForme(pokemon);
  if (entry) pokemon.forme = entry.forme;
  else delete pokemon.forme;
}

/**
 * The ability a forme puts in place of the species' own, if it has one.
 *
 * @param {{speciesId?: number, forme?: string|null}|null|undefined} pokemon
 * @returns {string|null}
 */
export function formeAbility(pokemon) {
  if (!pokemon?.forme) return null;
  const form = (speciesOf(pokemon.speciesId)?.forms ?? []).find((entry) => entry.slug === pokemon.forme);
  return form?.trigger === 'item' ? form.ability ?? null : null;
}

/**
 * The types a Pokémon has outside a battle: its forme's, when it is wearing
 * one that has its own, and its species' otherwise.
 *
 * @param {{speciesId: number, forme?: string|null}|null|undefined} pokemon
 * @returns {string[]}
 */
export function standingTypes(pokemon) {
  const species = speciesOf(pokemon?.speciesId);
  const form = pokemon?.forme ? (species?.forms ?? []).find((entry) => entry.slug === pokemon.forme) : null;
  return form?.types ?? species?.types ?? [];
}

/** Weather a Forecast turns into, and the forme that weather means. */
const FORECAST_FORMS = new Map([
  ['sun', 'castform-sunny'],
  ['rain', 'castform-rainy'],
  ['snow', 'castform-snowy'],
]);

/**
 * Which forme a species should be in right now, given the battle around it.
 *
 * Returns `null` when the species does not change, or when it should be back
 * in its ordinary shape — which is the answer most of the time, and why every
 * caller checks this once a turn rather than the engine wiring a hook per
 * species.
 *
 * The forme the combatant is already wearing is passed in as well: whether the
 * next check lands on a forme or on the default depends on where it is now,
 * and a forme that can only be entered but never left would stick for the
 * rest of the battle.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{
 *   current: string|null,
 *   weather: string|null,
 *   weatherTurns: number,
 *   overhp: number,
 *   maxhp: number,
 *   broken: boolean,
 *   usedMove: string|null,
 * }} state
 * @returns {string|null} the forme slug to take, or null to keep the current one
 */
export function formeFor(pokemon, state) {
  const species = speciesOf(pokemon?.speciesId);
  const speciesSlug = species?.slug;
  if (!speciesSlug) return null;
  const forms = species.forms ?? [];
  if (!forms.length) return null;

  // A mask is on or it is not; nothing in the battle moves it.
  if (HELD_FORMES.has(speciesSlug)) {
    const entry = heldForme(pokemon);
    if (entry) return entry.forme;
    return state.current ? speciesSlug : null;
  }

  const ability = FORM_ABILITY.get(speciesSlug);
  if (pokemon.ability !== ability) return null;

  // The slug the species' ordinary shape answers to — what the dex filed the
  // species itself under. A forme steps back into it by name, which is why
  // the returned slugs name it explicitly rather than meaning "any".
  const plain = speciesSlug;
  const find = (slug) => (forms.some((form) => form.slug === slug) ? slug : null);
  const half = state.overhp * 2 <= state.maxhp;
  const quarter = state.overhp * 4 <= state.maxhp;

  switch (ability) {
    // One forme per weather, and none when there is no weather to read.
    case 'forecast': {
      const forme = FORECAST_FORMS.get(state.weather ?? '');
      return forme ? find(forme) : plain;
    }

    // Below half the fire takes hold; above it, back to normal.
    case 'zen-mode':
      return half ? find('darmanitan-zen') : plain;

    // Together above a quarter, scattered below it.
    case 'schooling':
      return quarter ? plain : find('wishiwashi-school');

    // The core is out below half; above it, the rock it starts as. The
    // species' own slug is the meteor — the dex files Minior under its
    // default variety, and the seven coloured cores hang off Shields Down.
    case 'shields-down':
      return half ? find('minior-red') : plain;

    // A Disguise is broken by one hit, and stays broken.
    case 'disguise':
      return state.broken ? find('mimikyu-busted') : plain;

    // The ice face is knocked off by one hit, and stays off.
    case 'ice-face':
      return state.broken ? find('eiscue-noice') : plain;

    // Whatever Surf or Dive caught, it keeps — until the throw is made.
    case 'gulp-missile':
      return state.usedMove === 'surf' ? find('cramorant-gulping')
        : state.usedMove === 'dive' ? find('cramorant-gorging')
        : plain;

    default:
      return null;
  }
}
