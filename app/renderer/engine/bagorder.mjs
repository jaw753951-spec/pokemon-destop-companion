/**
 * The order a pocket is listed in, in the bag and in the shop alike.
 *
 * Most pockets read best alphabetically. Two do not:
 *
 * - **Machines** go by kind and number — TMs, then HMs, then TRs, each from
 *   01 up. Sorting their names as text put TM100–199 between TM10 and TM11,
 *   which pushed TM23–99 to the bottom of the list.
 * - **The misc pocket** puts what any Pokémon can use first; then what one
 *   Pokémon uses — a Dialga's orb and crystal, an Arceus's plates, an
 *   Oricorio's nectars — kept together and in the order of the Pokédex; and
 *   last the items that only evolve something, the stones any number of
 *   families use first and then each family's own, the seven Sweets side by
 *   side.
 */
import { gameData, speciesIdBySlug } from '../core/data.mjs';
import { name as localized } from '../core/i18n.mjs';
import { signatureItems } from './forms.mjs';

/** @typedef {{slug: string, item: any}} Entry */

/**
 * @param {string} pocket
 * @returns {(a: Entry, b: Entry) => number}
 */
export function pocketOrder(pocket) {
  if (pocket === 'machines') return byMachine;
  if (pocket === 'misc') return byUse;
  return byName;
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** @param {Entry} a @param {Entry} b */
function byName(a, b) {
  return collator.compare(localized(a.item?.name, a.slug), localized(b.item?.name, b.slug)) || a.slug.localeCompare(b.slug);
}

/** TMs, then HMs, then TRs. */
const MACHINE_KINDS = ['tm', 'hm', 'tr'];

/** @param {Entry} a @param {Entry} b */
function byMachine(a, b) {
  const kind = (/** @type {string} */ slug) => {
    const index = MACHINE_KINDS.indexOf(slug.replace(/\d+$/, ''));
    return index < 0 ? MACHINE_KINDS.length : index;
  };
  const number = (/** @type {string} */ slug) => Number(/\d+$/.exec(slug)?.[0] ?? 0);
  return kind(a.slug) - kind(b.slug) || number(a.slug) - number(b.slug) || byName(a, b);
}

/** @param {Entry} a @param {Entry} b */
function byUse(a, b) {
  const left = placeOf(a);
  const right = placeOf(b);
  return left.group - right.group || left.family - right.family || byName(a, b);
}

/**
 * Where a misc item goes: its group — 0 for anyone, 1 for one Pokémon, 2 for
 * evolving only — and, within the group, the family it belongs to by the
 * Pokédex number of the family's first stage (0 for no one family).
 *
 * @param {Entry} entry
 * @returns {{group: number, family: number}}
 */
function placeOf({ slug, item }) {
  const { owners, evolves } = index();
  const owner = owners.get(slug);
  if (owner !== undefined) return { group: 1, family: owner };
  const families = evolves.get(slug);
  // An item with an effect of its own — a King's Rock, a Metal Coat — is held
  // for that, and belongs with the rest of what anyone can hold. The Linking
  // Cord stands in for a trade, which no evolution names an item for, so the
  // data's own word for an evolution item counts as well.
  if ((families || item?.category === 'evolution') && !item?.held && !item?.use) {
    return { group: 2, family: families?.size === 1 ? [...families][0] : 0 };
  }
  return { group: 0, family: 0 };
}

/**
 * Whether some Pokémon evolves by this item, held or used.
 *
 * @param {string} slug
 */
export function evolvesSomething(slug) {
  return index().evolves.has(slug);
}

/**
 * Built once from the data: which Pokémon each item belongs to, and which
 * families each item evolves.
 *
 * @type {{owners: Map<string, number>, evolves: Map<string, Set<number>>}|null}
 */
let cached = null;
let cachedFor = /** @type {any} */ (null);

function index() {
  const data = gameData();
  if (cached && cachedFor === data) return cached;

  const species = Object.values(data.species ?? {});
  /** The species each one evolves from, to walk a family back to its first stage. */
  const from = new Map();
  for (const entry of species) {
    for (const evolution of entry.evolutions ?? []) from.set(evolution.to, entry.id);
  }
  const root = (/** @type {number} */ id) => {
    let current = id;
    for (let step = 0; step < 4 && from.has(current); step++) current = from.get(current);
    // A regional form is filed after its species, by the national number.
    const record = data.species[current];
    return Number(record?.dex ?? record?.id ?? current);
  };
  const rootOf = (/** @type {string} */ slug) => {
    const id = speciesIdBySlug(slug);
    return id === null ? null : root(id);
  };

  /** @type {Map<string, number>} */
  const owners = new Map();
  for (const [item, holders] of signatureItems()) {
    const family = rootOf(holders[0]);
    if (family !== null) owners.set(item, family);
  }
  for (const [slug, item] of Object.entries(data.items ?? {})) {
    const holders = item?.held?.species;
    if (owners.has(slug) || !holders?.length) continue;
    const family = rootOf(holders[0]);
    if (family !== null) owners.set(slug, family);
  }

  /** @type {Map<string, Set<number>>} */
  const evolves = new Map();
  for (const entry of species) {
    for (const evolution of entry.evolutions ?? []) {
      for (const item of [evolution.item, evolution.heldItem, ...(evolution.heldItems ?? [])]) {
        if (!item) continue;
        if (!evolves.has(item)) evolves.set(item, new Set());
        evolves.get(item)?.add(root(entry.id));
      }
    }
  }

  cached = { owners, evolves };
  cachedFor = data;
  return cached;
}
