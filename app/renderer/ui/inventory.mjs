/**
 * The bag: the four tabs the brief calls for, opening on Pokémon.
 *
 * Each tab rebuilds itself from the session whenever something changes, which
 * keeps the screens stateless apart from the small amount of view state — the
 * open pocket, the Pokémon being moved — carried in `state`.
 */
import { button, el, setChildren } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';
import { boxTab } from './boxtab.mjs';
import { itemsTab } from './itemstab.mjs';
import { pokemonTab } from './pokemontab.mjs';
import { treasuresTab } from './treasurestab.mjs';

const TABS = ['pokemon', 'items', 'box', 'treasures'];

/**
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function inventoryScene({ session, onClose }) {
  /** View state that should survive a rebuild but not a reopen. */
  const state = {
    tab: 'pokemon',
    pocket: 'medicine',
    moving: /** @type {number|null} */ (null),
    /** Which move slot the Pokémon tab is showing the description for. */
    moveSlot: /** @type {number|null} */ (null),
  };

  return {
    keepBelow: true,
    // The companion keeps walking under this: a menu is the player
    // stopping to read, not the Pokémon stopping to wait.
    keepBelowRunning: true,

    mount(app) {
      const tabs = el('div.tab-strip');
      const body = el('div.screen-body.tabbed');

      /**
       * Rebuild the open tab.
       *
       * The body is replaced wholesale, which threw the reader back to the top
       * of the page every time anything was touched — reading a move's
       * description meant scrolling down to the slots, clicking, and being
       * carried back up above the sprite. So where each scroller stood is
       * carried across, except when the tab itself changes and the top is
       * where you want to be.
       *
       * @param {{keepScroll?: boolean}} [options]
       */
      const rebuild = (options = {}) => {
        const keep = options?.keepScroll === false ? [] : scrollOffsets(body);

        setChildren(tabs, [
          ...TABS.map((name) =>
            el('button.tab', {
              type: 'button',
              text: t(`inventory.${name}`),
              'aria-pressed': String(state.tab === name),
              onClick: () => {
                if (state.tab === name) return;
                app.audio.blip('select');
                state.tab = name;
                state.moving = null;
                state.moveSlot = null;
                rebuild({ keepScroll: false });
              },
            }),
          ),
        ]);

        body.replaceChildren(render(app, session, state, rebuild));
        restoreScroll(body, keep);
      };
      rebuild();

      return el('div.screen.inventory-screen', {}, [
        el('div.screen-header', {}, [
          tabs,
          el('span.spacer'),
          button(t('common.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        body,
      ]);
    },
  };
}

/**
 * Where every scroller inside a node stands, in the order they appear.
 * @param {HTMLElement} node
 * @returns {number[]}
 */
function scrollOffsets(node) {
  return [...node.querySelectorAll('.scroll')].map((element) => element.scrollTop);
}

/**
 * Put them back, as far as the rebuilt page allows.
 * @param {HTMLElement} node
 * @param {number[]} offsets
 */
function restoreScroll(node, offsets) {
  [...node.querySelectorAll('.scroll')].forEach((element, index) => {
    const wanted = offsets[index];
    if (typeof wanted === 'number') element.scrollTop = wanted;
  });
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} state
 * @param {() => void} rebuild
 */
function render(app, session, state, rebuild) {
  switch (state.tab) {
    case 'items':
      return itemsTab(app, session, rebuild, state);
    case 'box':
      return boxTab(app, session, rebuild, state);
    case 'treasures':
      return treasuresTab(session);
    case 'pokemon':
    default:
      return pokemonTab(app, session, rebuild, state);
  }
}
