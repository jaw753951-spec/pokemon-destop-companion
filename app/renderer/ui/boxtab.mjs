/**
 * The Box tab: every Pokémon caught so far, in the grid the main series uses.
 *
 * Selecting one offers the same four actions the games do — take it along,
 * move it to another space, release it, or back out — and a fifth: marking it
 * a favourite, which keeps it in the top rows under a yellow star.
 *
 * The box has no limit: it grows a row at a time as it fills.
 */
import { url } from '../core/bridge.mjs';
import { artPath, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, shinyMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { levelOf } from '../engine/pokemon.mjs';
import { championIcon } from './badges.mjs';
import { chooseAction, confirm } from './dialog.mjs';

/** Spaces to a row, as the grid lays them out, and the rows always shown. */
const ROW = 10;
const MIN_ROWS = 5;

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{moving?: number|null}} state
 * @returns {HTMLElement}
 */
export function boxTab(app, session, refresh, state) {
  // Every space in use and at least one free one, in whole rows.
  const spaces = Math.max(MIN_ROWS, Math.ceil((session.box.length + 1) / ROW)) * ROW;
  const grid = el('div.box-grid');

  for (let index = 0; index < spaces; index++) {
    grid.append(space(app, session, index, refresh, state));
  }

  const moving = state.moving !== null && state.moving !== undefined;
  return el('div.tab-body.box-tab', {}, [
    el('div.box-head', {}, [
      moving
        ? el('div.box-hint', { text: t('box.moveTarget') })
        : el('div.box-hint', { text: t('box.count', { count: session.box.filter(Boolean).length }) }),
      moving ? null : button(t('box.sort'), () => sortMenu(app, session, refresh), { className: 'small' }),
    ]),
    scrollable(grid),
  ]);
}

/**
 * Ask which order to put the box in, and put it in that order. Favourites
 * stay at the top whichever it is.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 */
async function sortMenu(app, session, refresh) {
  const order = await chooseAction(app, t('box.sort'), [
    { value: /** @type {const} */ ('dex'), label: t('box.sortDex') },
    { value: /** @type {const} */ ('dexReverse'), label: t('box.sortDexReverse') },
    { value: /** @type {const} */ ('clear'), label: t('box.sortClear') },
    { value: /** @type {const} */ ('clearReverse'), label: t('box.sortClearReverse') },
    { value: /** @type {const} */ ('shiny'), label: t('box.sortShiny') },
  ]);
  if (!order) return;
  session.sortBox(order);
  app.audio.blip('confirm');
  refresh();
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} index
 * @param {() => void} refresh
 * @param {{moving?: number|null}} state
 */
function space(app, session, index, refresh, state) {
  const pokemon = session.box[index] ?? null;
  const moving = state.moving ?? null;

  if (!pokemon) {
    return el(`button.box-space.empty${moving === null ? '' : '.target'}`, {
      type: 'button',
      onClick: () => {
        if (moving === null) return;
        moveTo(session, moving, index);
        state.moving = null;
        app.audio.blip('confirm');
        refresh();
      },
    });
  }

  const species = speciesOf(pokemon.speciesId);
  return el(`button.box-space${moving === index ? '.moving' : ''}`, {
    type: 'button',
    title: `${pokemon.nickname || localized(species?.name, '')} ${t('slot.level', { level: levelOf(pokemon) })}`,
    onClick: () => {
      if (moving !== null) {
        moveTo(session, moving, index);
        state.moving = null;
        app.audio.blip('confirm');
        refresh();
        return;
      }
      openMenu(app, session, index, refresh, state);
    },
  }, [
    el('img', { src: url('assets', artPath(pokemon) ?? ''), alt: '' }),
    shinyMark(pokemon, t('pokemon.shiny')),
    pokemon.favorite ? el('i.favorite-mark', { title: t('box.favorite') }) : null,
    // The crown of a Pokémon that has beaten the League.
    pokemon.champion ? el('i.champion-pin', {}, [championIcon()]) : null,
  ]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} index
 * @param {() => void} refresh
 * @param {{moving?: number|null}} state
 */
async function openMenu(app, session, index, refresh, state) {
  const pokemon = session.box[index];
  if (!pokemon) return;
  const label = pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, '');

  const choice = await chooseAction(app, label, [
    { value: 'switch', label: t('box.switch') },
    { value: 'move', label: t('box.move') },
    { value: 'favorite', label: pokemon.favorite ? t('box.unfavorite') : t('box.makeFavorite') },
    { value: 'release', label: t('box.release'), danger: true },
  ]);

  if (choice === 'favorite') {
    app.audio.blip('confirm');
    session.toggleFavorite(index);
    refresh();
    return;
  }

  if (choice === 'switch') {
    session.switchActive(index);
    app.toast(t('box.switched', { name: label }));
    app.audio.playCry(session.active.speciesId);
    refresh();
    return;
  }

  if (choice === 'move') {
    state.moving = index;
    refresh();
    return;
  }

  if (choice === 'release') {
    if (!(await confirm(app, t('box.releaseConfirm'), { danger: true }))) return;
    session.box[index] = null;
    app.toast(t('box.released', { name: label }));
    refresh();
  }
}

/**
 * Swap two spaces. Moving onto an empty space leaves the original empty, which
 * is how the games' box cursor behaves.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} from
 * @param {number} to
 */
function moveTo(session, from, to) {
  if (from === to) return;
  while (session.box.length <= Math.max(from, to)) session.box.push(null);
  const moved = session.box[from];
  session.box[from] = session.box[to] ?? null;
  session.box[to] = moved;
}
