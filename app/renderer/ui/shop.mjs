/**
 * The shop: open from the road at any time, a Poké Mart without the walk to
 * one.
 *
 * It is laid out as the bag's item tabs are — the pockets along the top, the
 * stock on the left and what is being looked at on the right — so the shop
 * reads as the other side of the bag rather than a screen of its own to
 * learn. What is being bought comes with its price, how many the bag already
 * has, and a count to buy; a kept item — a Leftovers, a TM — comes one at a
 * time and not at all once had.
 */
import { url } from '../core/bridge.mjs';
import { moveOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { pocketOrder } from '../engine/bagorder.mjs';
import { alreadyOwned, buy, formatMoney, isConsumable, shopStock } from '../engine/shop.mjs';
import { moveSummary } from './movecard.mjs';

/** The pockets in the order the bag shows them. */
const POCKETS = ['medicine', 'misc', 'berries', 'pokeballs', 'machines'];

/** The most bought in one go. */
const MAX_COUNT = 99;

/**
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function shopScene({ session, onClose }) {
  const state = { pocket: POCKETS[0], selected: /** @type {string|null} */ (null), count: 1 };
  const stock = shopStock();

  return {
    keepBelow: true,
    keepBelowRunning: true,

    mount(app) {
      const purse = el('span.shop-money');
      // Laid out as the bag's own tab body is — a column whose split takes the
      // height left under the pockets — so the stock list has a height to
      // overflow and the wheel scrolls it. As a plain block the list simply
      // grew past the bottom of the window and was cut off there, and nothing
      // scrolled at all.
      const body = el('div.screen-body.tabbed.shop-body');

      const rebuild = () => {
        const keep = body.querySelector('.item-list')?.scrollTop ?? 0;
        purse.textContent = t('money.label', { amount: formatMoney(session.money) });
        const list = scrollable(el('div.item-list'));
        // Medicine, berries and balls cheapest first; the machines by number
        // and the misc pocket by who it is for, as the bag lists them.
        const entries = stock.filter((entry) => entry.item.pocket === state.pocket);
        if (state.pocket === 'machines' || state.pocket === 'misc') entries.sort(pocketOrder(state.pocket));
        if (state.selected && !entries.some((entry) => entry.slug === state.selected)) state.selected = null;

        list.append(...entries.map(({ slug, item, price }) =>
          el(`button.item-row${alreadyOwned(session, slug) ? '.unlearnable' : ''}`, {
            type: 'button',
            'aria-pressed': String(slug === state.selected),
            onClick: () => {
              app.audio.blip('select');
              state.selected = slug;
              state.count = 1;
              rebuild();
            },
          }, [
            el('img', { src: url('assets', `items/${slug}.png`), alt: '' }),
            el('span.item-name', { text: localized(item.name, slug) }),
            el('span.item-count', { text: t('money.label', { amount: formatMoney(price) }) }),
          ])));

        setChildren(body, [el('div.tab-body.items-tab', {}, [
          el('div.pocket-tabs', {}, POCKETS.map((pocket) =>
            el('button.chip', {
              type: 'button',
              text: t(`items.pocket.${pocket}`),
              'aria-pressed': String(pocket === state.pocket),
              onClick: () => {
                app.audio.blip('select');
                state.pocket = pocket;
                state.selected = null;
                rebuild();
              },
            }))),
          el('div.items-split', {}, [list, inspector(app, session, state, stock, rebuild)]),
        ])]);
        list.scrollTop = keep;
      };
      rebuild();

      return el('div.screen.inventory-screen', {}, [
        el('div.screen-header', {}, [
          el('span', { text: t('shop.title') }),
          el('span.spacer'),
          purse,
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
 * What is being looked at: what it does, what it costs, and the way to buy it.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {{selected: string|null, count: number}} state
 * @param {Array<{slug: string, item: any, price: number}>} stock
 * @param {() => void} rebuild
 */
function inspector(app, session, state, stock, rebuild) {
  // A machine's move text runs long; the panel scrolls rather than pushing
  // the buy button off the bottom.
  const panel = scrollable(el('div.item-inspector'));
  const entry = stock.find((candidate) => candidate.slug === state.selected);
  if (!entry) {
    panel.append(el('span.meta.inspect-hint', { text: t('shop.hint') }));
    return panel;
  }
  const { slug, item, price } = entry;
  const move = item.pocket === 'machines' ? moveOf(item.move) : null;
  const owned = alreadyOwned(session, slug);
  const many = isConsumable(slug);
  const total = price * state.count;

  const setCount = (count) => {
    state.count = Math.max(1, Math.min(MAX_COUNT, count));
    app.audio.blip('select');
    rebuild();
  };

  setChildren(panel, [
    el('img.inspect-icon', { src: url('assets', `items/${slug}.png`), alt: '' }),
    el('span.inspect-name', { text: localized(item.name, slug) }),
    move
      ? el('div.inspect-machine', {}, [
          el('span.inspect-move-name', { text: localized(move.name, item.move) }),
          el('span.meta', { text: moveSummary(item.move) }),
          el('p.inspect-text', { text: localized(move.text, '') }),
        ])
      : el('p.inspect-text', { text: localized(item.text, '') }),
    el('span.meta', { text: t('shop.inBag', { count: session.countOf(slug) }) }),
    owned
      ? el('span.meta.inspect-inert', { text: t('shop.owned') })
      : el('div.shop-buy', {}, [
          many ? button('−', () => setCount(state.count - 1), { className: 'small' }) : null,
          many ? el('span.shop-count', { text: `×${state.count}` }) : null,
          many ? button('+', () => setCount(state.count + 1), { className: 'small' }) : null,
          many ? button('×10', () => setCount(state.count + 10), { className: 'small' }) : null,
          button(t('shop.buy', { amount: formatMoney(total) }), () => {
            const result = buy(session, slug, state.count);
            if (result === 'bought') {
              app.audio.blip('confirm');
              app.toast(t('shop.bought', { item: localized(item.name, slug), count: many ? state.count : 1 }));
              state.count = 1;
            } else {
              app.audio.blip('error');
              app.toast(t(result === 'poor' ? 'shop.poor' : 'shop.owned'));
            }
            rebuild();
          }, { className: 'small primary', disabled: session.money < total }),
        ]),
  ]);
  return panel;
}
