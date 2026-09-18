/**
 * Modal prompts: the yes/no confirmations and small pickers the game leans on.
 *
 * Each returns a promise that settles when the user chooses, so callers can
 * `await` them inline rather than threading callbacks through the UI.
 */
import { button, el, scrollable } from '../core/dom.mjs';
import { t } from '../core/i18n.mjs';

/**
 * @param {import('../core/app.mjs').App} app
 * @param {string} message
 * @param {{confirmLabel?: string, cancelLabel?: string, danger?: boolean, align?: 'center'|'bottom'}} [options]
 * @returns {Promise<boolean>}
 */
export function confirm(app, message, options = {}) {
  return new Promise((resolve) => {
    const close = mountModal(app, (dismiss) =>
      el('div.panel', {}, [
        el('p', { text: message }),
        el('div.actions', {}, [
          button(options.confirmLabel ?? t('common.yes'), () => {
            app.audio.blip('confirm');
            dismiss();
            resolve(true);
          }, { className: options.danger ? 'primary' : '' }),
          button(options.cancelLabel ?? t('common.no'), () => {
            app.audio.blip('cancel');
            dismiss();
            resolve(false);
          }),
        ]),
      ]),
      { align: options.align },
    );
    void close;
  });
}

/**
 * A short list of labelled actions, as used by the box and item screens.
 *
 * @template T
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {Array<{value: T, label: string, danger?: boolean}>} choices
 * @returns {Promise<T|null>} null when dismissed
 */
export function chooseAction(app, title, choices) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) =>
      el('div.panel', {}, [
        title ? el('p', { text: title }) : null,
        el(
          'div.actions',
          { style: { flexWrap: 'wrap' } },
          choices.map((choice) =>
            button(choice.label, () => {
              app.audio.blip(choice.danger ? 'cancel' : 'confirm');
              dismiss();
              resolve(choice.value);
            }, { className: choice.danger ? 'ghost' : '' }),
          ),
        ),
        button(t('common.cancel'), () => {
          app.audio.blip('cancel');
          dismiss();
          resolve(null);
        }, { className: 'small' }),
      ]),
    );
  });
}

/**
 * A single line of text, for naming a caught Pokémon.
 *
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {{placeholder?: string, initial?: string, maxLength?: number}} [options]
 * @returns {Promise<string|null>} null when skipped
 */
export function prompt(app, title, options = {}) {
  return new Promise((resolve) => {
    /** @type {HTMLInputElement} */
    const input = /** @type {any} */ (
      el('input', {
        type: 'text',
        value: options.initial ?? '',
        placeholder: options.placeholder ?? '',
        maxlength: options.maxLength ?? 12,
        style: {
          '-webkit-app-region': 'no-drag',
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 6px',
          border: '2px solid var(--frame)',
          borderRadius: '4px',
          textAlign: 'center',
        },
      })
    );

    const dismiss = mountModal(app, (close) => {
      const accept = () => {
        app.audio.blip('confirm');
        close();
        resolve(input.value.trim() || null);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') accept();
      });
      return el('div.panel', {}, [
        el('p', { text: title }),
        input,
        el('div.actions', {}, [
          button(t('common.ok'), accept, { className: 'primary' }),
          button(t('common.no'), () => {
            app.audio.blip('cancel');
            close();
            resolve(null);
          }),
        ]),
      ]);
    });
    void dismiss;
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * A scrollable list picker.
 *
 * @template T
 * @param {import('../core/app.mjs').App} app
 * @param {string} title
 * @param {Array<{value: T, label: string, detail?: string}>} entries
 * @param {{empty?: string}} [options] what to say when there is nothing to choose
 * @returns {Promise<T|null>}
 */
export function chooseFromList(app, title, entries, options = {}) {
  return new Promise((resolve) => {
    mountModal(app, (dismiss) => {
      const list = scrollable(
        el(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '150px' } },
          entries.length
            ? entries.map((entry) =>
                el(
                  'button.slot',
                  {
                    type: 'button',
                    style: { padding: '3px 6px' },
                    onClick: () => {
                      app.audio.blip('confirm');
                      dismiss();
                      resolve(entry.value);
                    },
                  },
                  [
                    el('span.lines', {}, [
                      el('span.headline', { text: entry.label }),
                      entry.detail ? el('span.meta', { text: entry.detail }) : null,
                    ]),
                  ],
                ),
              )
            : [el('p.meta', { text: options.empty ?? t('pokemon.noReplacement') })],
        ),
      );

      return el('div.panel', { style: { width: '280px' } }, [
        el('p', { text: title }),
        list,
        button(t('common.cancel'), () => {
          app.audio.blip('cancel');
          dismiss();
          resolve(null);
        }, { className: 'small' }),
      ]);
    });
  });
}

/**
 * Mount a modal layer and hand the builder a function that removes it.
 * @param {import('../core/app.mjs').App} app
 * @param {(dismiss: () => void) => HTMLElement} build
 * @returns {() => void}
 */
function mountModal(app, build, options = {}) {
  // A modal normally sits in the middle of the screen, over whatever asked the
  // question. `bottom` moves it out of the way for a screen whose question is
  // about something the player has to be able to see while answering.
  const layer = el(`div.modal${options.align === 'bottom' ? '.bottom' : ''}`);
  const dismiss = () => layer.remove();
  layer.append(build(dismiss));
  app.overlay.append(layer);
  return dismiss;
}
