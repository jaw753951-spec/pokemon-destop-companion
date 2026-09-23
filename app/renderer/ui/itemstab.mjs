/**
 * The Items tab: one sub-tab per pocket, the bag on the left and whatever is
 * being inspected on the right, at roughly three to two.
 *
 * A last tab holds what the bag does by itself — which berry to hand over
 * after a battle, and when to throw a potion during one.
 */
import { url } from '../core/bridge.mjs';
import { itemOf, moveOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { AFTER_BATTLE_TARGETS, equipItem, itemActions, useItem } from '../engine/items.mjs';
import { moveSummary } from './movecard.mjs';
import { chooseAction, chooseFromList, confirm } from './dialog.mjs';

/** Pockets in the order the games show them, and the settings behind them. */
const POCKETS = ['medicine', 'misc', 'berries', 'pokeballs', 'machines'];
const OPTIONS = 'options';

/** When a potion is thrown without being asked for. */
const HEALING_CONDITIONS = ['never', 'hpTwoThirds', 'hpHalf', 'hpThird', 'hpQuarter'];

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{pocket?: string}} state carried between re-renders
 * @returns {HTMLElement}
 */
export function itemsTab(app, session, refresh, state) {
  const pocket = state.pocket && [...POCKETS, OPTIONS].includes(state.pocket) ? state.pocket : POCKETS[0];

  const tabs = el('div.pocket-tabs', {}, [...POCKETS, OPTIONS].map((name) =>
    el('button.chip', {
      type: 'button',
      text: name === OPTIONS ? t('items.options') : t(`items.pocket.${name}`),
      'aria-pressed': String(name === pocket),
      onClick: () => {
        app.audio.blip('select');
        state.pocket = name;
        refresh();
      },
    }),
  ));

  if (pocket === OPTIONS) {
    return el('div.tab-body.items-tab', {}, [tabs, optionsPane(app, session, refresh)]);
  }

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

  return el('div.tab-body.items-tab', {}, [tabs, el('div.items-split', {}, [list, inspector])]);
}

/**
 * What the bag does without being opened.
 *
 * Both settings are about the same thing — a fight the player is not watching
 * — so they sit together rather than one in the berry pocket and one in the
 * medicine pocket.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 */
function optionsPane(app, session, refresh) {
  const policy = session.itemPolicy;

  return el('div.item-options', {}, [
    el('div.section-title', { text: t('items.berryRestock') }),
    el('p.meta', { text: t('items.berryRestockNote') }),
    ...[0, 1, 2].map((index) => berryRow(app, session, policy, index, refresh)),

    el('div.section-title', { text: t('items.healingUse') }),
    el('p.meta', { text: t('items.healingUseNote') }),
    healingItemRow(app, session, policy, refresh),
    healingConditionRow(app, policy, refresh),

    el('div.section-title', { text: t('items.afterBattle') }),
    el('p.meta', { text: t('items.afterBattleNote') }),
    afterBattleRow(app, policy, refresh),
  ]);
}

/** How far a win tops the companion back up, fullest last. */
function afterBattleRow(app, policy, refresh) {
  const target = policy.afterBattle;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('items.afterBattleTarget') }),
    el('span.spacer'),
    el(`button.chip${target === 'never' ? '.off' : ''}`, {
      type: 'button',
      text: t(`items.afterBattle.${target}`),
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseFromList(app, t('items.afterBattleTarget'),
          Object.keys(AFTER_BATTLE_TARGETS).map((value) => ({
            value,
            label: t(`items.afterBattle.${value}`),
            detail: value === target ? t('auto.current') : '',
          })));
        if (chosen === null) return;
        policy.afterBattle = chosen;
        refresh();
      },
    }),
  ]);
}

/**
 * One rank of the restock order. Only berries the bag has ever held are
 * offered, plus the empty choice — a rank left unset is simply skipped.
 */
function berryRow(app, session, policy, index, refresh) {
  const slug = policy.berries[index] ?? null;
  const item = slug ? itemOf(slug) : null;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('items.priority', { rank: index + 1 }) }),
    el('span.spacer'),
    el(`button.chip${slug ? '' : '.off'}`, {
      type: 'button',
      text: item ? localized(item.name, slug) : t('items.unset'),
      onClick: async () => {
        app.audio.blip('select');
        const held = session.pocket('berries');
        const chosen = await chooseFromList(app, t('items.priority', { rank: index + 1 }), [
          { value: '', label: t('items.unset'), detail: '' },
          ...held.map((entry) => ({
            value: entry.slug,
            label: localized(entry.item.name, entry.slug),
            detail: t('items.count', { count: entry.count }),
          })),
        ]);
        if (chosen === null) return;
        policy.berries[index] = chosen || null;
        refresh();
      },
    }),
  ]);
}

/** Which potion the automatic throw reaches for, or whatever fits. */
function healingItemRow(app, session, policy, refresh) {
  const slug = policy.healing.item;
  const item = slug ? itemOf(slug) : null;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('items.healingItem') }),
    el('span.spacer'),
    el('button.chip', {
      type: 'button',
      text: item ? localized(item.name, slug) : t('items.healingAuto'),
      onClick: async () => {
        app.audio.blip('select');
        const held = session.pocket('medicine').filter((entry) => entry.item.category !== 'status-cures');
        const chosen = await chooseFromList(app, t('items.healingItem'), [
          { value: '', label: t('items.healingAuto'), detail: t('items.healingAutoNote') },
          ...held.map((entry) => ({
            value: entry.slug,
            label: localized(entry.item.name, entry.slug),
            detail: t('items.count', { count: entry.count }),
          })),
        ]);
        if (chosen === null) return;
        policy.healing.item = chosen || null;
        refresh();
      },
    }),
  ]);
}

/** The health it is thrown at, in the same words the auto-battle screen uses. */
function healingConditionRow(app, policy, refresh) {
  const condition = policy.healing.condition;

  return el('div.setting.item-option', {}, [
    el('span.label', { text: t('auto.condition') }),
    el('span.spacer'),
    el(`button.chip${condition === 'never' ? '.off' : ''}`, {
      type: 'button',
      text: t(`auto.condition.${condition}`),
      onClick: async () => {
        app.audio.blip('select');
        const chosen = await chooseFromList(app, t('auto.condition'),
          HEALING_CONDITIONS.map((value) => ({
            value,
            label: t(`auto.condition.${value}`),
            detail: value === condition ? t('auto.current') : '',
          })));
        if (chosen === null) return;
        policy.healing.condition = chosen;
        refresh();
      },
    }),
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

  // What the item is for decides what it is offered for: a potion is used, a
  // Leftovers is carried, and a ball is neither — it is thrown at something
  // the companion has knocked down, from the capture screen.
  const actions = itemActions(session, slug);

  const choice = await chooseAction(app, localized(item.name, slug), [
    ...(actions.use ? [{ value: 'use', label: t('items.use') }] : []),
    ...(actions.equip ? [{ value: 'equip', label: t('items.equip') }] : []),
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

  if (choice === 'use' || choice === 'equip') {
    const result = choice === 'equip' ? equipItem(session, slug) : useItem(session, slug);
    app.toast(result.message ?? t('items.cannotUse'));
    // A refusal is worth a sound too: a TM the companion cannot learn says so
    // and nothing else happens, which used to be silent.
    app.audio.blip(result.ok ? 'confirm' : 'error');
    if (result.used) refresh();
  }
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

  const machineMove = item.pocket === 'machines' ? item.move : null;
  const move = machineMove ? moveOf(machineMove) : null;

  setChildren(inspector, [
    el('img.inspect-icon', { src: url('assets', `items/${slug}.png`), alt: '' }),
    el('span.inspect-name', { text: localized(item.name, slug) }),
    // A machine's own flavour text is a sentence about machines — the same one
    // on every TM in some generations, a description of the move in others.
    // What the player is choosing between is the move, so a machine shows the
    // move: its name, what it does, and its numbers, the same way every time.
    machineMove
      ? el('div.inspect-machine', {}, [
          el('span.inspect-move-name', {
            text: localized(move?.name, machineMove),
          }),
          el('span.meta', { text: moveSummary(machineMove) }),
          el('p.inspect-text', { text: localized(move?.text, '') }),
        ])
      : el('p.inspect-text', { text: localized(item.text, '') }),
    // The bag carries everything this game could one day act on, which is more
    // than it acts on today; an item says so itself rather than leaving the
    // player to find out by using it.
    item.works ? null : el('span.meta.inspect-inert', { text: t('items.noEffectYet') }),
  ]);
}
