/**
 * Using an item, wherever it is used from.
 *
 * The bag screen, the battle screen and the auto-use policy all end up doing
 * the same thing to the same Pokémon, so what an item does lives here rather
 * than in whichever screen happened to need it first.
 */
import { gameData, itemOf, moveOf, speciesOf } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { abilitySlot, evolveInto, levelOf, maxHp, maxPp, pendingEvolution } from './pokemon.mjs';
import { addEffort, experienceForLevel, STATS } from './stats.mjs';

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

  // Anything with an effect of its own — a potion, an Ether, a vitamin, a
  // Rare Candy — does it here, whichever pocket it sits in.
  if (item.use) {
    if (!applyUse(pokemon, item)) return { used: false, ok: false, message: t('items.cannotUse') };
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
 * Apply an item's use effect: what its own effect text says it does.
 *
 * The amounts are read off the item during the build — "Restores 20 HP",
 * "Restores 10 PP for one move", "Raises Attack effort" — so nothing here has
 * to guess at a number or match on a name. An item the build could make no
 * sense of never reaches the bag, so anything arriving here has an effect;
 * what it can still fail at is being pointless right now, which is what a
 * false return means.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {any} item
 * @returns {boolean} whether anything changed
 */
function applyUse(pokemon, item) {
  const use = item.use;
  if (!use) return false;

  const max = maxHp(pokemon);

  // A revival is the one effect that wants its target fainted.
  if (use.revive !== undefined) {
    if (pokemon.hp > 0) return false;
    pokemon.hp = Math.max(1, Math.round(max * use.revive));
    pokemon.status = null;
    pokemon.statusTurns = 0;
    return true;
  }

  // Everything else is for a Pokémon still standing.
  if (pokemon.hp <= 0) return false;
  let changed = false;

  if (use.hp !== undefined && pokemon.hp < max) {
    pokemon.hp = Math.min(max, pokemon.hp + (use.hp === 'full' ? max : use.hp));
    changed = true;
  }

  if (use.status && pokemon.status && (use.status === 'any' || use.status === pokemon.status)) {
    pokemon.status = null;
    pokemon.statusTurns = 0;
    changed = true;
  }

  if (use.pp) changed = restorePp(pokemon, use.pp) || changed;
  if (use.effort) changed = changeEffort(pokemon, use.effort) || changed;

  if (use.level) {
    const level = levelOf(pokemon);
    if (level < MAX_LEVEL) {
      pokemon.experience = experienceForLevel(speciesOf(pokemon.speciesId).growthRate, level + use.level);
      changed = true;
    }
  }

  // An Exp. Candy is experience handed over directly rather than a level.
  if (use.experience) {
    if (levelOf(pokemon) < MAX_LEVEL) {
      pokemon.experience += use.experience;
      changed = true;
    }
  }

  // A Mint rewrites which stats the nature favours, keeping the name of the
  // one it was born with — which is what the games do, and why a screen shows
  // the mint's nature rather than the original.
  if (use.nature && gameData().natures[use.nature] && pokemon.nature !== use.nature) {
    pokemon.nature = use.nature;
    changed = true;
  }

  // A Bottle Cap maxes the genes: one stat, or all of them.
  if (use.genes) changed = maximizeGenes(pokemon, use.genes) || changed;

  // An Ability Capsule swaps the two ordinary abilities; an Ability Patch
  // hands over the hidden one, and hands it back if it is already out.
  if (use.ability) changed = switchAbility(pokemon, use.ability) || changed;

  // A PP Up raises a move's ceiling rather than filling it.
  if (use.ppUp) changed = raiseMaxPp(pokemon, use.ppUp) || changed;

  return changed;
}

/**
 * The stat a Bottle Cap should be spent on: the lowest one, which is where a
 * player would spend it and what makes "one" a choice worth making at all.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {'one'|'all'} scope
 */
function maximizeGenes(pokemon, scope) {
  const weakest = [...STATS].sort((a, b) => (pokemon.ivs[a] ?? 0) - (pokemon.ivs[b] ?? 0))[0];
  const stats = scope === 'all' ? [...STATS] : [weakest];
  let changed = false;
  for (const stat of stats) {
    if ((pokemon.ivs[stat] ?? 0) >= MAX_IV) continue;
    pokemon.ivs = { ...pokemon.ivs, [stat]: MAX_IV };
    changed = true;
  }
  return changed;
}

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {'swap'|'hidden'} how
 */
function switchAbility(pokemon, how) {
  const abilities = speciesOf(pokemon.speciesId)?.abilities ?? [];
  if (abilities.length === 0) return false;

  if (how === 'hidden') {
    const hidden = abilities.find((entry) => entry.hidden);
    if (!hidden) return false;
    // A Patch used on a Pokémon that already has the hidden ability puts the
    // ordinary one back, as it does in the games.
    const next = pokemon.ability === hidden.name ? abilities.find((entry) => !entry.hidden) : hidden;
    if (!next || next.name === pokemon.ability) return false;
    pokemon.ability = next.name;
    return true;
  }

  const ordinary = abilities.filter((entry) => !entry.hidden);
  if (ordinary.length < 2) return false;
  const slot = abilitySlot(pokemon);
  // The Capsule has nothing to swap a hidden ability with.
  if (slot < 0 || abilities[slot]?.hidden) return false;
  const next = ordinary[(ordinary.findIndex((entry) => entry.name === pokemon.ability) + 1) % ordinary.length];
  if (!next || next.name === pokemon.ability) return false;
  pokemon.ability = next.name;
  return true;
}

/**
 * Raise a move's ceiling, and fill what was just added.
 *
 * The raise is kept per slot rather than on the move, because two Pokémon can
 * know the same move with different amounts spent on it. A slot at the cap
 * takes nothing, which is what makes a PP Max worth holding on to.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{fraction: number, max: number}} ppUp
 */
function raiseMaxPp(pokemon, ppUp) {
  const slot = pokemon.moves.find((entry) => (entry.ppUp ?? 0) < ppUp.max - 1e-9 && moveOf(entry.move));
  if (!slot) return false;

  const before = maxPp(slot);
  slot.ppUp = Math.min(ppUp.max, (slot.ppUp ?? 0) + ppUp.fraction);
  slot.pp += maxPp(slot) - before;
  return true;
}

/** The highest a gene goes. */
const MAX_IV = 31;

/**
 * Put PP back: into the first move that has lost any, or into all of them.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{amount: number|'full', scope: 'one'|'all'}} pp
 */
function restorePp(pokemon, pp) {
  const spent = pokemon.moves.filter((slot) => slot.pp < maxPp(slot));
  const targets = pp.scope === 'all' ? spent : spent.slice(0, 1);
  if (targets.length === 0) return false;

  for (const slot of targets) {
    const full = maxPp(slot);
    slot.pp = pp.amount === 'full' ? full : Math.min(full, slot.pp + pp.amount);
  }
  return true;
}

/**
 * Move a stat's effort, up for a vitamin and down for the berries that undo
 * one. Raising goes through the shared cap so the per-stat and total limits
 * hold however the effort was earned.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {{stat: string, amount: number}} effort
 */
function changeEffort(pokemon, effort) {
  const before = pokemon.evs[effort.stat] ?? 0;
  if (effort.amount >= 0) {
    pokemon.evs = addEffort(pokemon.evs, { [effort.stat]: effort.amount });
  } else {
    pokemon.evs = { ...pokemon.evs, [effort.stat]: Math.max(0, before + effort.amount) };
  }
  return (pokemon.evs[effort.stat] ?? 0) !== before;
}

/** The level nothing grows past. */
const MAX_LEVEL = 100;

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
    // What a battle can throw: the ones that put hit points back. A status
    // cure and a revival both have their moment, and neither is this one.
    .filter(({ item }) => item.use?.hp !== undefined)
    .map(({ slug, count, item }) => {
      const power = item.use.hp === 'full' ? max : item.use.hp;
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
  if (!applyUse(pokemon, item)) return false;
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
 * What the held item does simply by being held, if anything.
 *
 * The consumable rules — a berry waiting for half a bar or for a paralysis —
 * are read by `heldTrigger`; this is the other half: the Leftovers that heal
 * every turn, the Choice Band that trades moves for power, the Charcoal that
 * makes a fire move hit harder. Both come off the same parsed effect, told
 * apart by what the effect is keyed on.
 *
 * @param {import('./pokemon.mjs').Pokemon|null|undefined} pokemon
 * @param {string} kind the effect to ask for
 * @returns {any|null}
 */
export function heldPassive(pokemon, kind) {
  const held = pokemon?.heldItem ? itemOf(pokemon.heldItem)?.held : null;
  return held && held.on === kind ? held : null;
}

/**
 * What a held item keeps off its holder.
 *
 * A pair of Safety Goggles refuses powder and the weather, Protective Pads
 * refuse whatever touching would have cost, a Clear Amulet refuses a stat
 * drop and a Covert Cloak refuses a move's side effects. All four are the same
 * shape — a shield with a list of what it stops — so they are asked the same
 * question.
 *
 * @param {import('./pokemon.mjs').Pokemon|null|undefined} pokemon
 * @param {string} against the kind of harm
 * @returns {any} the shield's value for it, or null
 */
export function heldShield(pokemon, against) {
  const shield = heldPassive(pokemon, 'shield');
  return shield?.[against] ?? null;
}

/**
 * Whether a held item's effect applies to this Pokémon at all.
 *
 * Most do not care who is holding them. A Thick Club cares a great deal — it
 * doubles the Attack of a Cubone and does nothing for anything else — so the
 * ones that name a species are checked against the one holding them. Names are
 * compared without their punctuation, because a Farfetch'd is filed as
 * `farfetchd` and written with an apostrophe.
 *
 * @param {any} held the parsed held effect
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
export function itemSuits(held, pokemon) {
  if (!held?.species?.length) return true;
  const slug = (speciesOf(pokemon.speciesId)?.slug ?? '').replace(/[^a-z0-9]/g, '');
  return held.species.includes(slug);
}

/**
 * Whether the held item's moment has come.
 *
 * Every berry that does something while held carries the rule it does it by —
 * the pipeline reads it off the item's own effect text — so this is only a
 * matter of asking whether the rule is satisfied now. An Oran waits for half
 * health, a Liechi for a quarter, a Cheri for the paralysis it cures, a Leppa
 * for a move that has run dry.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @returns {{slug: string, held: any}|null}
 */
export function heldTrigger(pokemon) {
  const slug = pokemon.heldItem;
  const held = slug ? itemOf(slug)?.held : null;
  if (!slug || !held || pokemon.hp <= 0) return null;

  switch (held.on) {
    case 'hp':
      return pokemon.hp <= maxHp(pokemon) * held.at ? { slug, held } : null;
    case 'status':
      return pokemon.status && (held.status === 'any' || held.status === pokemon.status) ? { slug, held } : null;
    case 'pp':
      return emptyMove(pokemon) ? { slug, held } : null;
    default:
      return null;
  }
}

/**
 * Do what the held item promises, as far as the Pokémon itself is concerned.
 *
 * A berry that raises a stat is the battle's business rather than the
 * Pokémon's — stages live on the combatant, not on the save — so that one is
 * left to the caller and reported as unhandled here.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {any} held
 * @returns {boolean} whether anything changed
 */
export function applyHeldEffect(pokemon, held) {
  if (held.on === 'hp' && held.heal) {
    const max = maxHp(pokemon);
    const amount = held.heal.amount ?? Math.max(1, Math.floor(max * held.heal.fraction));
    if (pokemon.hp >= max) return false;
    pokemon.hp = Math.min(max, pokemon.hp + amount);
    return true;
  }

  if (held.on === 'status') {
    if (!pokemon.status) return false;
    pokemon.status = null;
    pokemon.statusTurns = 0;
    return true;
  }

  if (held.on === 'pp') {
    const slot = emptyMove(pokemon);
    if (!slot) return false;
    slot.pp = Math.min(maxPp(slot), slot.pp + held.amount);
    return true;
  }

  return false;
}

/**
 * The first move that has run out of PP, which is what a Leppa Berry is
 * waiting for.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 */
function emptyMove(pokemon) {
  return pokemon.moves.find((slot) => slot.pp <= 0 && moveOf(slot.move)) ?? null;
}
