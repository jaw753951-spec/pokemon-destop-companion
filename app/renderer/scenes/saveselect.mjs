/**
 * Save-slot selection, used both to start a new run and to continue one.
 */
import { saves, url } from '../core/bridge.mjs';
import { artPath, speciesOf } from '../core/data.mjs';
import { button, el, scrollable } from '../core/dom.mjs';
import { formatPlaytime, name as localized, t } from '../core/i18n.mjs';
import { levelForExperience } from '../engine/stats.mjs';
import { confirm } from '../ui/dialog.mjs';
import { starterScene } from './starter.mjs';
import { startRun } from './field.mjs';

/**
 * @param {{mode: 'new'|'continue', slots: Array<any>}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function slotScene({ mode, slots }) {
  return {
    mount(app) {
      const list = scrollable(el('div.slot-list'));

      const rebuild = async () => {
        const current = await saves.list();
        slots.splice(0, slots.length, ...current);
        list.replaceChildren(
          ...current.map((slot) => slotRow(app, slot, mode, rebuild)),
        );
      };

      list.replaceChildren(...slots.map((slot) => slotRow(app, slot, mode, rebuild)));

      return el('div.screen', {}, [
        el('div.screen-header', {}, [
          el('span', { text: t('slot.title') }),
          el('span.spacer'),
          button(t('common.back'), () => {
            app.audio.blip('cancel');
            app.pop();
          }, { className: 'small' }),
        ]),
        el('div.screen-body', {}, [list]),
      ]);
    },
  };
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {any} slot
 * @param {'new'|'continue'} mode
 * @param {() => Promise<void>} rebuild
 */
function slotRow(app, slot, mode, rebuild) {
  const usable = mode === 'new' ? true : !slot.empty;
  const species = slot.summary?.speciesId ? speciesOf(slot.summary.speciesId) : null;
  const active = species ? { speciesId: species.id, shiny: Boolean(slot.summary.shiny) } : null;

  const level = species ? levelForExperience(species.growthRate, slot.summary.experience ?? 0) : 1;
  const headline = slot.empty
    ? t('slot.empty')
    : `${slot.summary.nickname || localized(species?.name, '')} ${t('slot.level', { level })}`;

  const meta = slot.empty
    ? ''
    : [
        t('slot.badges', { count: slot.summary.badges }),
        t('slot.playtime', { time: formatPlaytime(slot.summary.playtime) }),
        slot.summary.champion ? t('slot.champion') : null,
      ]
        .filter(Boolean)
        .join('  ·  ');

  const row = el(
    `button.slot${slot.empty ? '.empty' : ''}`,
    {
      type: 'button',
      disabled: !usable,
      onClick: () => select(app, slot, mode, rebuild),
    },
    [
      el('img', {
        src: active
          ? url('assets', artPath(active) ?? '')
          : url('assets', 'props/item-ball.png'),
        alt: '',
      }),
      el('span.lines', {}, [
        el('span.headline', { text: `${slot.slot + 1}. ${headline}` }),
        meta ? el('span.meta', { text: meta }) : null,
      ]),
    ],
  );

  if (!slot.empty) {
    row.append(
      el('span.erase', {
        text: '×',
        title: t('slot.delete'),
        onClick: async (event) => {
          event.stopPropagation();
          if (!(await confirm(app, t('slot.delete'), { danger: true }))) return;
          await saves.remove(slot.slot);
          await rebuild();
        },
      }),
    );
  }

  return row;
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {any} slot
 * @param {'new'|'continue'} mode
 * @param {() => Promise<void>} rebuild
 */
async function select(app, slot, mode, rebuild) {
  app.audio.blip('confirm');

  if (mode === 'continue') {
    const save = await saves.read(slot.slot);
    if (!save) {
      app.toast(t('slot.empty'));
      await rebuild();
      return;
    }
    startRun(app, { slot: slot.slot, save });
    return;
  }

  if (!slot.empty && !(await confirm(app, t('slot.overwrite'), { danger: true }))) return;
  app.push(starterScene({ slot: slot.slot }));
}
