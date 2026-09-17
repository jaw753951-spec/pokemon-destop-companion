/**
 * The travelling scene — the game's home screen.
 *
 * The companion walks rightwards forever; the world scrolls, the area changes
 * every few minutes, and the run autosaves on its own. Random events pause the
 * walk and take over, which later milestones hook in through `beginEvent`.
 */
import { timeOfDay } from '../../shared/constants.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { gameData } from '../core/data.mjs';
import { t } from '../core/i18n.mjs';
import { Session } from '../engine/session.mjs';
import { COMPANION_X, drawApron, drawBackground, drawShadow, GROUND_Y, WALK_SPEED, walkBob } from '../render/field.mjs';
import { createHud } from '../render/hud.mjs';
import { saveAndQuit, settingsScene } from '../ui/settings.mjs';

/**
 * Start or resume a run, replacing whatever is on screen.
 * @param {import('../core/app.mjs').App} app
 * @param {{slot: number, save: any}} options
 */
export function startRun(app, { slot, save }) {
  const session = new Session({ slot, save });
  app.session = session;
  app.setScene(fieldScene(session));
}

/**
 * @param {Session} session
 * @returns {import('../core/app.mjs').Scene}
 */
export function fieldScene(session) {
  /** @type {HTMLImageElement|null} */
  let background = null;
  /** @type {import('../core/assets.mjs').Sprite|null} */
  let companion = null;

  let loadedAreaKey = '';
  let loadedSpriteId = 0;
  let offset = 0;
  let elapsed = 0;
  /** Set while an event has taken over; the walk stops but timers keep running. */
  let paused = false;

  let hud = /** @type {ReturnType<typeof createHud>|null} */ (null);

  /** Load whatever art the current area and companion need. */
  const refreshArt = (app) => {
    const key = `${session.area?.id}/${timeOfDay()}`;
    if (session.area && key !== loadedAreaKey) {
      loadedAreaKey = key;
      loadImage(`areas/${session.area.id}/${timeOfDay()}.png`).then((image) => {
        // A slower load must not overwrite a newer area.
        if (loadedAreaKey === key) background = image;
      }).catch(() => {
        background = null;
      });
      app.audio.playMusic(session.area.music);
    }

    const speciesId = session.active.speciesId;
    if (speciesId !== loadedSpriteId) {
      loadedSpriteId = speciesId;
      const meta = gameData().sprites[speciesId]?.front;
      if (meta) {
        loadSprite(`pokemon/${speciesId}/front.png`, meta).then((sprite) => {
          if (loadedSpriteId === speciesId) companion = sprite;
        }).catch(() => {
          companion = null;
        });
      }
    }
  };

  return {
    mount(app) {
      hud = createHud({
        onInventory: () => app.toast(t('inventory.pokemon')),
        onPokedex: () => app.toast(t('dex.title')),
        onSettings: () => {
          app.audio.blip('select');
          app.push(
            settingsScene({
              onClose: () => app.pop(),
              onSaveAndQuit: () => saveAndQuit(app),
            }),
          );
        },
        onLeague: () => app.toast(t('league.enter')),
      });

      refreshArt(app);
      hud.update(session);
      return hud.root;
    },

    unmount() {
      hud = null;
    },

    update(deltaMs, app) {
      elapsed += deltaMs;
      if (!paused) offset += (WALK_SPEED * deltaMs) / 1000;

      const { rotateArea, autosave } = session.tick(deltaMs);
      if (rotateArea && !paused) {
        session.rotateArea();
        refreshArt(app);
      }
      if (autosave) {
        session.save().then(() => app.toast(t('field.saved'), 1400)).catch(() => {});
      }

      refreshArt(app);
      hud?.update(session);
    },

    render(context) {
      drawBackground(context, background, Math.round(offset));
      drawApron(context);

      if (companion) {
        const lift = paused ? 0 : walkBob(elapsed, companion.duration);
        drawShadow(context, COMPANION_X, GROUND_Y, companion.width);
        companion.draw(context, COMPANION_X, GROUND_Y - lift, {
          frame: companion.frameAt(elapsed),
        });
      }
    },

    /** Stop the walk while an event plays out. */
    setPaused(value) {
      paused = value;
    },

    /** The world offset, so events can spawn props just off the right edge. */
    get offset() {
      return offset;
    },
  };
}
