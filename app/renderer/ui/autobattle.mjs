/**
 * Auto-battle settings.
 *
 * Three things decide what the companion does on its turn, in this order: the
 * move order laid out by hand, the mode that takes over once that order runs
 * out, and per-category weights with a condition each. Everything here edits
 * the policy the battle engine reads, so the effect of a change is immediate.
 */
import { moveOf } from '../core/data.mjs';
import { button, el, scrollable, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { categoryOf } from '../engine/battle.mjs';
import { chooseFromList } from './dialog.mjs';

/** Exactly one of these is active, as the brief requires. */
const MODES = ['repeatAll', 'repeatLast', 'damageFirst'];

/** The weightable move categories, in the order they are shown. */
const CATEGORIES = ['damage', 'status', 'stat', 'field', 'heal'];

/** Conditions a category can be gated on. */
const CONDITIONS = ['always', 'noField', 'noStatus', 'lowHp', 'firstTurn'];

/**
 * @param {{session: import('../engine/session.mjs').Session, onClose: () => void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function autoBattleScene({ session, onClose }) {
  return {
    keepBelow: true,

    mount(app) {
      const body = scrollable(el('div.auto-body'));

      const rebuild = () => {
        setChildren(body, [
          el('div.section-title', { text: t('auto.order') }),
          orderRow(app, session, rebuild),
          modeRow(app, session, rebuild),
          el('div.section-title', { text: t('auto.weights') }),
          ...CATEGORIES.map((category) => weightRow(app, session, category, rebuild)),
        ]);
      };
      rebuild();

      return el('div.screen', { style: { background: 'rgba(16, 21, 32, 0.92)' } }, [
        el('div.screen-header', {}, [
          el('span', { text: t('auto.title') }),
          el('span.spacer'),
          button(t('common.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        el('div.screen-body', {}, [body]),
      ]);
    },
  };
}

/**
 * Four boxes, fired left to right. Only moves the Pokémon currently holds can
 * go in them, so the order can never name something it cannot use.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} rebuild
 */
function orderRow(app, session, rebuild) {
  const policy = session.autoBattle;
  const equipped = session.active.moves.map((slot) => slot.move);

  return el('div.auto-order', {}, [0, 1, 2, 3].map((index) => {
    const move = policy.order?.[index] ?? null;
    const known = move && equipped.includes(move) ? move : null;
    const record = known ? moveOf(known) : null;

    return el(`button.auto-slot${known ? '' : '.empty'}`, {
      type: 'button',
      text: record ? localized(record.name, known) : t('auto.empty'),
      onClick: async () => {
        app.audio.blip('select');
        const choices = [
          { value: '', label: t('auto.empty'), detail: '' },
          ...equipped.map((slug) => ({
            value: slug,
            label: localized(moveOf(slug)?.name, slug),
            detail: t(`auto.weight.${categoryOf(moveOf(slug) ?? {})}`),
          })),
        ];
        const chosen = await chooseFromList(app, t('auto.order'), choices);
        if (chosen === null) return;
        policy.order = [...(policy.order ?? [null, null, null, null])];
        policy.order[index] = chosen || null;
        rebuild();
      },
    });
  }));
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} rebuild
 */
function modeRow(app, session, rebuild) {
  const policy = session.autoBattle;
  return el('div.setting', {}, [
    el('span.label', { text: '' }),
    el('div.options', {}, MODES.map((mode) =>
      el('button.chip', {
        type: 'button',
        text: t(`auto.${mode}`),
        'aria-pressed': String(policy.mode === mode),
        onClick: () => {
          app.audio.blip('select');
          // Only one may be active, so selecting replaces rather than toggles.
          policy.mode = mode;
          rebuild();
        },
      }),
    )),
  ]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} category
 * @param {() => void} rebuild
 */
function weightRow(app, session, category, rebuild) {
  const policy = session.autoBattle;
  policy.weights = policy.weights ?? {};
  policy.conditions = policy.conditions ?? {};

  const weight = policy.weights[category] ?? 0;
  const value = el('span.value', { text: String(weight) });

  const slider = el('input', {
    type: 'range',
    min: '0',
    max: '20',
    step: '1',
    value: String(weight),
    onInput: (event) => {
      const next = Number(/** @type {HTMLInputElement} */ (event.target).value);
      policy.weights[category] = next;
      value.textContent = String(next);
    },
  });

  const condition = policy.conditions[category] ?? 'always';
  const conditionButton = el('button.chip', {
    type: 'button',
    text: t(`auto.condition.${condition}`),
    title: t('auto.condition'),
    onClick: () => {
      app.audio.blip('select');
      const next = CONDITIONS[(CONDITIONS.indexOf(condition) + 1) % CONDITIONS.length];
      policy.conditions[category] = next;
      rebuild();
    },
  });

  return el('div.setting.auto-weight', {}, [
    el('span.label', { text: t(`auto.weight.${category}`) }),
    slider,
    value,
    conditionButton,
  ]);
}
