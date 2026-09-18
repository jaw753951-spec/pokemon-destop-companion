/**
 * The application shell: services every screen shares, and the scene stack.
 *
 * A scene owns one screen. It may put DOM into the overlay, draw on the canvas,
 * or both — the title screen is pure DOM, the field is mostly canvas. Scenes
 * are pushed and popped rather than swapped so a menu can return to whatever
 * was underneath it.
 */
import { VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { clear } from './dom.mjs';
import { settings as settingsApi, windowControl } from './bridge.mjs';
import { setLanguage } from './i18n.mjs';

/**
 * A screen. Every hook is optional: a DOM-only scene needs just `mount`.
 * @typedef {Object} Scene
 * @property {(app: App) => (HTMLElement|null|void)} [mount]
 * @property {(app: App) => void} [unmount]
 * @property {(deltaMs: number, app: App) => void} [update]
 * @property {(context: CanvasRenderingContext2D, app: App) => void} [render]
 * @property {boolean} [keepBelow] draw the scene beneath this one as well
 * @property {(paused: boolean) => void} [setPaused] halt the scene's own motion
 *   while something else, such as a field event, plays out over it
 * @property {number} [offset] the field scene's world scroll, so events can
 *   spawn props just beyond the right edge of the view
 */

export class App {
  /**
   * @param {{settings: any, audio: import('./audio.mjs').AudioEngine}} services
   */
  constructor({ settings, audio }) {
    this.settings = settings;
    this.audio = audio;

    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('scene'));
    this.context = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    this.context.imageSmoothingEnabled = false;
    this.overlay = /** @type {HTMLElement} */ (document.getElementById('overlay'));
    this.toastNode = /** @type {HTMLElement} */ (document.getElementById('toast'));

    /** @type {Array<{scene: Scene, node: HTMLElement|null}>} */
    this.stack = [];
    /** @type {any} */
    this.session = null;

    this.lastFrame = 0;
    this.toastTimer = 0;
  }

  /** The scene currently on top, or null before the first one is pushed. */
  get scene() {
    return this.stack.length ? this.stack[this.stack.length - 1].scene : null;
  }

  /**
   * Replace the whole stack with one scene.
   * @param {Scene} scene
   */
  setScene(scene) {
    while (this.stack.length) this.pop();
    this.push(scene);
  }

  /**
   * Put a scene on top of the current one.
   * @param {Scene} scene
   */
  push(scene) {
    const container = document.createElement('div');
    container.className = 'screen';
    this.overlay.append(container);

    const node = scene.mount?.(this) ?? null;
    if (node instanceof HTMLElement) container.append(node);

    this.stack.push({ scene, node: container });
    this.syncVisibility();
    return scene;
  }

  /** Remove the top scene and return to the one below it. */
  pop() {
    const top = this.stack.pop();
    if (!top) return;
    top.scene.unmount?.(this);
    top.node?.remove();
    this.syncVisibility();
  }

  /**
   * Only the top scene's controls are usable, so only its DOM is shown. A
   * scene beneath may still be drawn on the canvas — that is what `keepBelow`
   * is for — but its buttons and panels would otherwise sit over the screen on
   * top of it.
   */
  syncVisibility() {
    this.stack.forEach((entry, index) => {
      if (entry.node) entry.node.hidden = index !== this.stack.length - 1;
    });
  }

  /**
   * @param {number} deltaMs
   */
  tick(deltaMs) {
    // Only the top scene updates; ones below it are paused, which is what a
    // menu over the field should do.
    this.scene?.update?.(deltaMs, this);

    const context = this.context;
    context.clearRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    const firstVisible = this.firstRenderIndex();
    for (let index = firstVisible; index < this.stack.length; index++) {
      this.stack[index].scene.render?.(context, this);
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= deltaMs;
      if (this.toastTimer <= 0) this.toastNode.hidden = true;
    }
  }

  /** The deepest scene that still needs drawing under the current one. */
  firstRenderIndex() {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      if (!this.stack[index].scene.keepBelow) return index;
    }
    return 0;
  }

  /**
   * A brief message along the bottom edge.
   * @param {string} message
   * @param {number} [durationMs]
   */
  toast(message, durationMs = 2600) {
    this.toastNode.textContent = message;
    this.toastNode.hidden = false;
    this.toastTimer = durationMs;
  }

  /**
   * Apply and persist a settings change, reacting to the ones that need it.
   * @param {Partial<any>} patch
   */
  async updateSettings(patch) {
    const before = this.settings;
    this.settings = await settingsApi.set(patch);
    this.audio.setVolumes(this.settings);
    if (this.settings.language !== before.language) {
      await setLanguage(this.settings.language);
      this.refreshScenes();
    }
    if (this.settings.scale !== before.scale) fitStage();
    return this.settings;
  }

  /** Re-mount every scene in place, used when the language changes. */
  refreshScenes() {
    for (const entry of this.stack) {
      if (!entry.node) continue;
      entry.scene.unmount?.(this);
      clear(entry.node);
      const node = entry.scene.mount?.(this) ?? null;
      if (node instanceof HTMLElement) entry.node.append(node);
    }
  }
}

/**
 * Scale the fixed-size stage to fill the window. Snapping to whole pixels
 * where possible keeps sprite edges clean.
 */
export function fitStage() {
  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const scale = Math.min(window.innerWidth / VIEW_WIDTH, window.innerHeight / VIEW_HEIGHT);
  const snapped = scale >= 1 ? Math.floor(scale * 4) / 4 : scale;
  stage.style.transform = `scale(${snapped})`;
  stage.style.left = `${Math.round((window.innerWidth - VIEW_WIDTH * snapped) / 2)}px`;
  stage.style.top = `${Math.round((window.innerHeight - VIEW_HEIGHT * snapped) / 2)}px`;
}

/**
 * Drive an app with the display's refresh rate.
 * @param {App} app
 */
export function runLoop(app) {
  let previous = performance.now();

  const frame = (now) => {
    // Clamp the step so a backgrounded window does not fast-forward the game
    // when it comes back.
    const delta = Math.min(now - previous, 100);
    previous = now;
    try {
      app.tick(delta);
    } catch (error) {
      // One bad frame must not end the run: the companion is meant to be left
      // alone for hours, so the loop reports and carries on.
      console.error('frame failed', error);
    }
    // Requested outside the try, so a throw can never stop the loop.
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

/** Remember where the user dragged the window to. */
export function trackWindowPosition() {
  let timer = 0;
  window.addEventListener('mouseup', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => windowControl.rememberPosition(), 200);
  });
}
