/**
 * Renderer entry point: load everything the game needs, then hand control to
 * the title screen.
 */
import { App, fitStage, runLoop, trackWindowPosition } from './core/app.mjs';
import { AudioEngine } from './core/audio.mjs';
import { saves, settings as settingsApi, windowControl } from './core/bridge.mjs';
import { loadGameData } from './core/data.mjs';
import { el } from './core/dom.mjs';
import { setLanguage, t } from './core/i18n.mjs';
import { titleScene } from './scenes/title.mjs';

async function boot() {
  const overlay = /** @type {HTMLElement} */ (document.getElementById('overlay'));
  const splash = el('div#boot', { text: 'Loading…' });
  overlay.append(splash);

  fitStage();
  window.addEventListener('resize', fitStage);
  document.getElementById('minimize')?.addEventListener('click', () => windowControl.minimize());
  trackWindowPosition();

  const settings = await settingsApi.get();
  await setLanguage(settings.language);
  splash.textContent = t('app.loading');

  const [, slots] = await Promise.all([loadGameData(), saves.list()]);

  const audio = new AudioEngine();
  audio.setVolumes(settings);

  const app = new App({ settings, audio });
  // The screenshot harness in tools/ drives the game through this; nothing in
  // the app itself reads it.
  /** @type {any} */ (globalThis).__pdcApp = app;
  splash.remove();
  app.setScene(titleScene({ slots }));
  runLoop(app);
}

boot().catch((error) => {
  console.error(error);
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.replaceChildren(el('div#boot', { text: `${t('app.loadFailed')}\n\n${error.message ?? error}` }));
  }
});
