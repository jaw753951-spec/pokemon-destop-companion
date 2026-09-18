/**
 * The Items tab: one sub-tab per pocket, the bag on the left and whatever is
 * being inspected on the right, at roughly three to two.
 */
import { url } from '../core/bridge.mjs';
import { itemOf, moveOf, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { fullyHeal, maxHp, pendingEvolution, evolveInto } from '../engine/pokemon.mjs';
import { chooseAction, confirm } from './dialog.mjs';

/** Pockets in the order the games show them. */
const POCKETS = ['medicine', 'misc', 'berries', 'pokeballs', 'machines'];

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{pocket?: string}} state carried between re-renders
 * @returns {HTMLElement}
 */
export function itemsTab(app, session, refresh, state) {
  const pocket = state.pocket && POCKETS.includes(state.pocket) ? state.pocket : POCKETS[0];
  const inspector = el('div.item-inspector');
  showInspector(inspector, null);

  const list = scrollable(el('div.item-list'));
  const entries = session.pocket(pocket);

  if (entries.length === 0) {
    list.append(el('div.empty', { text: t('items.empty') }));
  } else {
    list.append(
      ...entries
        .sort((a, b) => localized(a.item.name, a.slug).localeCompare(localized(b.item.name, b.slug)))
        .map(({ slug, count, item }) =>
          el('button.item-row', {
            type: 'button',
            onClick: () => openMenu(app, session, slug, inspector, refresh),
          }, [
            el('img', { src: url('assets', `items/${slug}.png`), alt: '' }),
            el('span.item-name', { text: localized(item.name, slug) }),
            el('span.item-count', { text: t('items.count', { count }) }),
          ]),
        ),
    );
  }

  return el('div.tab-body.items-tab', {}, [
    el('div.pocket-tabs', {}, POCKETS.map((name) =>
      el('button.chip', {
        type: 'button',
        text: t(`items.pocket.${name}`),
        'aria-pressed': String(name === pocket),
        onClick: () => {
          app.audio.blip('select');
          state.pocket = name;
          refresh();
        },
      }),
    )),
    el('div.items-split', {}, [list, inspector]),
  ]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} slug
 * @param {HTMLElement} inspector
 * @param {() => void} refresh
 */
async function openMenu(app, session, slug, inspector, refresh) {
  const item = itemOf(slug);
  if (!item) return;

  const choice = await chooseAction(app, localized(item.name, slug), [
    { value: 'use', label: t('items.use') },
    { value: 'inspect', label: t('items.inspect') },
    { value: 'toss', label: t('items.toss'), danger: true },
  ]);

  if (choice === 'inspect') {
    showInspector(inspector, slug);
    return;
  }

  if (choice === 'toss') {
    if (!(await confirm(app, t('items.tossConfirm'), { danger: true }))) return;
    session.removeItem(slug);
    app.toast(t('items.tossed', { name: localized(item.name, slug) }));
    refresh();
    return;
  }

  if (choice === 'use') {
    const result = useItem(session, slug);
    app.toast(result.message ?? t('items.cannotUse'));
    if (result.used) {
      app.audio.blip(result.ok ? 'confirm' : 'error');
      refresh();
    }
  }
}

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
    const healed = applyMedicine(pokemon, item);
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
 * @returns {boolean} whether anything changed
 */
function applyMedicine(pokemon, item) {
  const max = maxHp(pokemon);

  if (item.category === 'status-cures' || item.name.en === 'Full Heal') {
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

  if (item.name.en === 'Full Restore' || item.category === 'pp-recovery') {
    const before = { hp: pokemon.hp, status: pokemon.status };
    fullyHeal(pokemon);
    return before.hp !== pokemon.hp || before.status !== pokemon.status;
  }

  const amount = healingAmount(item);
  if (pokemon.hp >= max) return false;
  pokemon.hp = Math.min(max, pokemon.hp + (amount ?? max));
  return true;
}

/** The number of hit points an item's description promises, when it names one. */
function healingAmount(item) {
  const text = `${item.text?.en ?? ''} ${item.text?.ko ?? ''}`;
  const match = /(\d{2,3})\s*(?:HP|만큼)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * @param {HTMLElement} inspector
 * @param {string|null} slug
 */
function showInspector(inspector, slug) {
  if (!slug) {
    inspector.replaceChildren(el('span.meta', { text: t('items.inspect') }));
    return;
  }
  const item = itemOf(slug);
  if (!item) return;

  setChildren(inspector, [
    el('img.inspect-icon', { src: url('assets', `items/${slug}.png`), alt: '' }),
    el('span.inspect-name', { text: localized(item.name, slug) }),
    el('p.inspect-text', { text: localized(item.text, '') }),
    item.pocket === 'machines' && item.move
      ? el('span.meta', { text: localized(moveOf(item.move)?.name, item.move) })
      : null,
  ]);
}
