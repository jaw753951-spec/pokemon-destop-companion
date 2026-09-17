/**
 * The Box tab: every Pokémon caught so far, in the grid the main series uses.
 *
 * Selecting one offers the same four actions the games do — take it along,
 * move it to another space, release it, or back out.
 */
import { url } from '../core/bridge.mjs';
import { speciesOf } from '../core/data.mjs';
import { el, scrollable } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { levelOf } from '../engine/pokemon.mjs';
import { chooseAction, confirm } from './dialog.mjs';

/** Spaces shown even when empty, so the grid keeps its shape. */
const MIN_SPACES = 30;

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @param {{moving?: number|null}} state
 * @returns {HTMLElement}
 */
export function boxTab(app, session, refresh, state) {
  const spaces = Math.max(MIN_SPACES, session.box.length + 1);
  const grid = el('div.box-grid');

  for (let index = 0; index < spaces; index++) {
    grid.append(space(app, session, index, refresh, state));
  }

  return el('div.tab-body.box-tab', {}, [
    state.moving !== null && state.moving !== undefined
      ? el('div.box-hint', { text: t('box.moveTarget') })
      : null,
    scrollable(grid),
  ]);
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
    el('img', { src: url('assets', `pokemon/${pokemon.speciesId}/icon.png`), alt: '' }),
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
    { value: 'release', label: t('box.release'), danger: true },
  ]);

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
