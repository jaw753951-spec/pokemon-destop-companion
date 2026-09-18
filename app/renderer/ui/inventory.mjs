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
  const state = { tab: 'pokemon', pocket: 'medicine', moving: /** @type {number|null} */ (null) };

  return {
    keepBelow: true,

    mount(app) {
      const tabs = el('div.tab-strip');
      const body = el('div.screen-body.tabbed');

      const rebuild = () => {
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
                rebuild();
              },
            }),
          ),
        ]);

        body.replaceChildren(render(app, session, state, rebuild));
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
      return pokemonTab(app, session, rebuild);
  }
}
