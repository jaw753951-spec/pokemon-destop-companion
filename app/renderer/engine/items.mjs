/**
 * Using an item, wherever it is used from.
 *
 * The bag screen, the battle screen and the auto-use policy all end up doing
 * the same thing to the same Pokémon, so what an item does lives here rather
 * than in whichever screen happened to need it first.
 */
import { itemOf, moveOf, speciesOf } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { evolveInto, fullyHeal, maxHp, pendingEvolution } from './pokemon.mjs';

/**
 * Apply an item to the travelling Pokémon.
 *
 * A TM is not consumed: using it teaches the move permanently, which is what
 * TMs do from Gen 5 onward and what makes them worth finding here.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} slug
 * @returns {{used: boolean, ok: boolean, message: string}}
 */
export function useItem(session, slug) {
  const item = itemOf(slug);
  const pokemon = session.active;
  if (!item) return { used: false, ok: false, message: t('items.cannotUse') };

  const label = localized(item.name, slug);

  if (item.pocket === 'machines') {
    const move = item.move;
    if (!move || !moveOf(move)) return { used: false, ok: false, message: t('items.cannotUse') };
    const species = speciesOf(pokemon.speciesId);
    if (!species?.learnset.machine.includes(move)) {
      return { used: false, ok: false, message: t('items.cannotUse') };
    }
    if (!session.machines.includes(move)) session.machines.push(move);
    return { used: true, ok: true, message: t('items.taught', { move: localized(moveOf(move)?.name, move) }) };
  }

  if (item.pocket === 'medicine') {
    const healed = applyMedicine(pokemon, item, slug);
    if (!healed) return { used: false, ok: false, message: t('items.cannotUse') };
    session.removeItem(slug);
    return { used: true, ok: true, message: t('items.used', { name: label }) };
  }

  // An evolution stone, if this Pokémon is waiting on one.
  const evolution = pendingEvolution(pokemon, { item: slug });
  if (evolution) {
    session.removeItem(slug);
    const from = pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, '');
    evolveInto(pokemon, evolution.to);
    session.markCaught(evolution.to);
    return {
      used: true,
      ok: true,
      message: t('battle.evolving', {
        name: from,
        target: localized(speciesOf(pokemon.speciesId)?.name, ''),
      }),
    };
  }

  // Anything holdable becomes the held item.
  if (item.attributes.includes('holdable')) {
    if (pokemon.heldItem) session.addItem(pokemon.heldItem);
    session.removeItem(slug);
    pokemon.heldItem = slug;
    return { used: true, ok: true, message: t('items.used', { name: label }) };
  }

  return { used: false, ok: false, message: t('items.cannotUse') };
}

/**
 * Healing items, read from the item's own flavour text where it names an
 * amount, and otherwise treated as a full restore.
 *
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 * @param {any} item
 * @param {string} slug the item's own id, which is the same in every language
 * @returns {boolean} whether anything changed
 */
function applyMedicine(pokemon, item, slug) {
  const max = maxHp(pokemon);

  if (item.category === 'status-cures' || slug === 'full-heal') {
    if (!pokemon.status) return false;
    pokemon.status = null;
    pokemon.statusTurns = 0;
    return true;
  }

  if (item.category === 'revival') {
    if (pokemon.hp > 0) return false;
    pokemon.hp = Math.ceil(max / 2);
    return true;
  }

  if (slug === 'full-restore' || item.category === 'pp-recovery') {
    const before = { hp: pokemon.hp, status: pokemon.status };
    fullyHeal(pokemon);
    return before.hp !== pokemon.hp || before.status !== pokemon.status;
  }

  const amount = healingAmount(item);
  if (pokemon.hp >= max) return false;
  pokemon.hp = Math.min(max, pokemon.hp + (amount ?? max));
  return true;
}

/**
 * Which side of "HP" the amount sits on is a matter of grammar — "restore 20
 * HP" in English, "HP를 20만큼" in Korean — so both are accepted, and "HP",
 * which survives translation, is what anchors them.
 *
 * The number has to be close to that "HP" rather than merely somewhere in the
 * description: a Berry Juice is "a 100 percent pure juice" that restores 20,
 * and a Health Candy raises HP at "Lv. 30" without healing anything.
 */
const HEALING_AMOUNT = /(?<!\d)(\d{2,3})(?!\d)[^\d]{0,6}HP|HP[^\d]{0,6}(?<!\d)(\d{2,3})(?!\d)/i;

/**
 * The number of hit points an item's description promises, when it names one.
 * A description that names none, as a Max Potion's does not, is a full restore.
 *
 * Exported for the tests; the screens reach it through `useItem`.
 */
export function healingAmount(item) {
  // Every localization is searched, not just the chosen one: the description
  // the player is reading may be the one that leaves the number out.
  for (const text of Object.values(item.text ?? {})) {
    const match = HEALING_AMOUNT.exec(String(text));
    if (match) return Number(match[1] ?? match[2]);
  }
  return null;
}

/**
 * The medicine in the bag that would do this Pokémon some good right now,
 * weakest first — a Potion is the right answer to a scratch, and hoarding the
 * Full Restore for when it is needed is what a player does by hand.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * `power` is what the item is worth — the amount it promises, or a full bar
 * where it promises none — and `restores` what that comes to on this Pokémon
 * right now, which is what there is any point showing.
 *
 * @returns {Array<{slug: string, count: number, item: any, power: number, restores: number}>}
 */
export function healingItems(session, pokemon) {
  const max = maxHp(pokemon);
  const missing = max - pokemon.hp;

  return session
    .pocket('medicine')
    .filter(({ item }) => item.category !== 'revival' && item.category !== 'status-cures')
    .map(({ slug, count, item }) => {
      // A description that names no amount is a full restore.
      const power = healingAmount(item) ?? max;
      return { slug, count, item, power, restores: Math.min(missing, power) };
    })
    .filter((entry) => entry.restores > 0)
    .sort((a, b) => a.power - b.power || a.slug.localeCompare(b.slug));
}

/**
 * The item an automatic throw should use: the one the player named, or the
 * smallest that covers the damage taken.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string|null} preferred a slug, or null for "whatever fits"
 */
export function healingItemFor(session, pokemon, preferred) {
  const available = healingItems(session, pokemon);
  if (available.length === 0) return null;

  if (preferred) {
    const named = available.find((entry) => entry.slug === preferred);
    return named ? named.slug : null;
  }

  const missing = maxHp(pokemon) - pokemon.hp;
  const covers = available.find((entry) => entry.power >= missing);
  // Nothing covers it: the largest heal on hand is the next best thing.
  return (covers ?? available[available.length - 1]).slug;
}

/**
 * Take one healing item from the bag and apply it, wherever it was thrown
 * from.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {boolean} whether it was used
 */
export function throwItem(session, slug, pokemon) {
  const item = itemOf(slug);
  if (!item || session.countOf(slug) <= 0) return false;
  if (!applyMedicine(pokemon, item, slug)) return false;
  session.removeItem(slug);
  return true;
}

/**
 * The berry to put in a Pokémon's hand: the first of the player's choices that
 * is actually in the bag.
 *
 * @param {import('./session.mjs').Session} session
 * @param {Array<string|null>} priorities
 */
export function berryToHold(session, priorities) {
  for (const slug of priorities) {
    if (slug && session.countOf(slug) > 0 && itemOf(slug)) return slug;
  }
  return null;
}

/**
 * Hand the companion a berry if it is holding nothing, which is what the
 * restock setting is for. Returns the berry handed over, if any.
 *
 * @param {import('./session.mjs').Session} session
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function restockBerry(session, pokemon) {
  if (pokemon.heldItem) return null;
  const berry = berryToHold(session, session.itemPolicy?.berries ?? []);
  if (!berry) return null;

  session.removeItem(berry);
  pokemon.heldItem = berry;
  return berry;
}

/**
 * A held berry a Pokémon would eat in a pinch: one with a healing amount on
 * it, which is what a Sitrus or an Oran is.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function edibleBerry(pokemon) {
  if (!pokemon.heldItem) return null;
  const item = itemOf(pokemon.heldItem);
  if (!item || item.pocket !== 'berries') return null;
  return healingAmount(item) ? pokemon.heldItem : null;
}
