/**
 * The settings screen.
 *
 * Reachable from the title and, with "save and quit" added, from the field.
 */
import { appControl, settings as settingsApi } from '../core/bridge.mjs';
import { button, el } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';

/**
 * @param {{onClose: () => void, onSaveAndQuit?: () => Promise<void>|void}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function settingsScene({ onClose, onSaveAndQuit }) {
  return {
    keepBelow: true,

    mount(app) {
      const rows = el('div.settings-rows');

      const rebuild = () => {
        rows.replaceChildren(
          scaleRow(app),
          volumeRow(app, 'settings.music', 'musicVolume'),
          volumeRow(app, 'settings.effects', 'effectVolume'),
          languageRow(app, rebuild),
        );
      };
      rebuild();

      return el('div.screen', { style: { background: 'rgba(16, 21, 32, 0.9)' } }, [
        el('div.screen-header', {}, [
          el('span', { text: t('settings.title') }),
          el('span.spacer'),
          button(t('settings.close'), () => {
            app.audio.blip('cancel');
            onClose();
          }, { className: 'small' }),
        ]),
        el('div.screen-body', { style: { display: 'flex', flexDirection: 'column' } }, [
          rows,
          el('div.spacer', { style: { flex: '1' } }),
          onSaveAndQuit
            ? el('div', { style: { padding: '0 12px 12px' } }, [
                button(t('settings.saveAndQuit'), async () => {
                  app.audio.blip('confirm');
                  await onSaveAndQuit();
                }, { className: 'primary' }),
              ])
            : null,
        ]),
      ]);
    },
  };
}

/** @param {import('../core/app.mjs').App} app */
function scaleRow(app) {
  const options = el('div.options');

  const render = (steps) => {
    options.replaceChildren(
      ...steps.map((step) =>
        el('button.chip', {
          type: 'button',
          text: `${step}×`,
          'aria-pressed': String(app.settings.scale === step),
          onClick: async () => {
            app.audio.blip('select');
            await app.updateSettings({ scale: step });
            render(steps);
          },
        }),
      ),
    );
  };

  settingsApi.scaleSteps().then(render);
  return el('div.setting', {}, [el('span.label', { text: t('settings.scale') }), options]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {string} labelKey
 * @param {'musicVolume'|'effectVolume'} key
 */
function volumeRow(app, labelKey, key) {
  const value = el('span.value', { text: `${Math.round(app.settings[key] * 100)}%` });
  const slider = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '5',
    value: String(Math.round(app.settings[key] * 100)),
    onInput: (event) => {
      const percent = Number(/** @type {HTMLInputElement} */ (event.target).value);
      value.textContent = `${percent}%`;
      // Apply immediately so the user hears the change while dragging, and let
      // the persisted write happen on the same call.
      app.updateSettings({ [key]: percent / 100 });
    },
  });

  return el('div.setting', {}, [el('span.label', { text: t(labelKey) }), slider, value]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {() => void} rebuild
 */
function languageRow(app, rebuild) {
  const options = el(
    'div.options',
    {},
    /** @type {Array<'ko'|'en'>} */ (['ko', 'en']).map((code) =>
      el('button.chip', {
        type: 'button',
        text: t(`settings.language.${code}`),
        'aria-pressed': String(app.settings.language === code),
        onClick: async () => {
          if (app.settings.language === code) return;
          app.audio.blip('select');
          // Changing the language re-mounts every scene, this one included, so
          // there is nothing more to do here.
          await app.updateSettings({ language: code });
          rebuild();
        },
      }),
    ),
  );

  return el('div.setting', {}, [el('span.label', { text: t('settings.language') }), options]);
}

/**
 * Save the current run and close the app.
 * @param {import('../core/app.mjs').App} app
 */
export async function saveAndQuit(app) {
  const session = app.session;
  if (!session) {
    await appControl.quit();
    return;
  }
  await appControl.quit(session.slot, session.toSave());
}
