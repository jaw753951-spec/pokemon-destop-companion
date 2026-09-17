/**
 * The travelling scene — the game's home screen.
 *
 * The companion walks rightwards forever; the world scrolls, the area changes
 * every few minutes, and the run autosaves on its own. Once a minute an event
 * spawns something ahead on the path, and the walk carries on until it is
 * reached — so nothing ever simply appears on top of the player.
 */
import { timeOfDay } from '../../shared/constants.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { Session } from '../engine/session.mjs';
import { COMPANION_X, drawApron, drawBackground, drawShadow, GROUND_Y, WALK_SPEED, walkBob } from '../render/field.mjs';
import { createHud } from '../render/hud.mjs';
import { battleScene } from './battle.mjs';
import { captureScene } from './capture.mjs';
import { createEventRunner } from './fieldevents.mjs';
import { inventoryScene } from '../ui/inventory.mjs';
import { pokedexScene } from '../ui/pokedex.mjs';
import { chooseAction, confirm } from '../ui/dialog.mjs';
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
  /** Set while a menu or battle is on top; the walk and its timers stop. */
  let paused = false;
  /**
   * Cleared while a battle or the capture screen is up: those draw their own
   * version of the companion, and two of it at once reads as a bug.
   */
  let showActor = true;

  let hud = /** @type {ReturnType<typeof createHud>|null} */ (null);
  /** @type {ReturnType<typeof createEventRunner>|null} */
  let events = null;
  /** @type {import('../core/app.mjs').App|null} */
  let host = null;

  /** Load whatever art the current area and companion need. */
  const refreshArt = (app) => {
    const key = `${session.area?.id}/${timeOfDay()}`;
    if (session.area && key !== loadedAreaKey) {
      loadedAreaKey = key;
      loadImage(`areas/${session.area.id}/${timeOfDay()}.png`)
        .then((image) => {
          // A slower load must not overwrite a newer area.
          if (loadedAreaKey === key) background = image;
        })
        .catch(() => {
          background = null;
        });
      app.audio.playMusic(session.area.music);
    }

    const speciesId = session.active.speciesId;
    if (speciesId !== loadedSpriteId) {
      loadedSpriteId = speciesId;
      const meta = gameData().sprites[speciesId]?.front;
      if (meta) {
        loadSprite(`pokemon/${speciesId}/front.png`, meta)
          .then((sprite) => {
            if (loadedSpriteId === speciesId) companion = sprite;
          })
          .catch(() => {
            companion = null;
          });
      }
    }
  };

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {number} index
   */
  async function openTrayMenu(app, index) {
    const pokemon = session.tray[index];
    if (!pokemon) return;
    const label = localized(speciesOf(pokemon.speciesId)?.name, '');

    const choice = await chooseAction(app, label, [
      { value: 'capture', label: t('tray.capture') },
      { value: 'release', label: t('tray.release'), danger: true },
    ]);

    if (choice === 'capture') {
      session.tray.splice(index, 1);
      paused = true;
      showActor = false;
      app.push(
        captureScene({
          session,
          target: pokemon,
          onFinish: () => {
            app.pop();
            paused = false;
            showActor = true;
            refreshArt(app);
          },
        }),
      );
      return;
    }

    if (choice === 'release') {
      if (!(await confirm(app, t('tray.releaseConfirm'), { danger: true }))) return;
      session.tray.splice(index, 1);
      app.toast(t('tray.released', { name: label }));
    }
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {{foes: any[], trainer: any|null, leader: any|null}} setup
   */
  function startBattle(app, setup) {
    paused = true;
    showActor = false;
    app.push(
      battleScene({
        session,
        foes: setup.foes,
        trainer: setup.trainer,
        music: setup.leader ? gameData().bgm.cues.battleLeader : undefined,
        onFinish: (result) => {
          app.pop();
          paused = false;
          showActor = true;
          finishBattle(app, setup, result);
        },
      }),
    );
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {{foes: any[], trainer: any|null, leader: any|null}} setup
   * @param {{outcome: 'won'|'lost', defeated: any[]}} result
   */
  function finishBattle(app, setup, result) {
    if (result.outcome === 'lost') {
      // Blacking out costs nothing but the walk: the companion is patched up
      // and carries on, which is what a desktop pet should do.
      session.heal();
      app.toast(t('battle.lost'));
      refreshArt(app);
      return;
    }

    if (setup.leader) {
      session.badges.push(setup.leader.type);
      session.trainerWins = 0;
      app.audio.playMusic(gameData().bgm.cues.obtainBadge ?? null);
      app.toast(t('badge.obtained', { name: badgeLabel(setup.leader) }));
    } else if (setup.trainer) {
      session.trainerWins++;
      app.audio.playMusic(gameData().bgm.cues.victoryTrainer ?? null);
    } else {
      // Only wild Pokémon can be caught, so only they reach the tray.
      for (const pokemon of result.defeated) session.addToTray(pokemon);
      app.audio.playMusic(gameData().bgm.cues.victoryWild ?? null);
    }

    refreshArt(app);
  }

  return {
    mount(app) {
      host = app;
      hud = createHud({
        onInventory: () => {
          app.audio.blip('select');
          paused = true;
          app.push(inventoryScene({ session, onClose: () => closeMenu(app) }));
        },
        onPokedex: () => {
          app.audio.blip('select');
          paused = true;
          app.push(pokedexScene({ session, onClose: () => closeMenu(app) }));
        },
        onSettings: () => {
          app.audio.blip('select');
          paused = true;
          app.push(
            settingsScene({
              onClose: () => closeMenu(app),
              onSaveAndQuit: () => saveAndQuit(app),
            }),
          );
        },
        onLeague: () => app.toast(t('league.enter')),
        onTraySelect: (index) => openTrayMenu(app, index),
      });

      events = createEventRunner({
        session,
        onBattle: (setup) => startBattle(app, setup),
      });

      refreshArt(app);
      hud.update(session);
      return hud.root;
    },

    unmount() {
      hud = null;
      events = null;
      host = null;
    },

    update(deltaMs, app) {
      elapsed += deltaMs;
      if (paused) return;

      const walking = events?.walking ?? true;
      if (walking) offset += (WALK_SPEED * deltaMs) / 1000;

      const { rotateArea, autosave, event } = session.tick(deltaMs);

      if (rotateArea && !events?.busy) {
        session.rotateArea();
        refreshArt(app);
      }
      if (event && !events?.busy) {
        events?.start(session.events.roll(session.rng), offset, app);
      }
      if (autosave) {
        session
          .save()
          .then(() => app.toast(t('field.saved'), 1400))
          .catch(() => {});
      }

      events?.update(deltaMs, offset, app);
      refreshArt(app);
      hud?.update(session);
    },

    render(context) {
      drawBackground(context, background, Math.round(offset));
      events?.render(context, offset);
      drawApron(context);

      if (companion && showActor) {
        const moving = !paused && (events?.walking ?? true);
        const lift = moving ? walkBob(elapsed, companion.duration) : 0;
        drawShadow(context, COMPANION_X, GROUND_Y, companion.width);
        companion.draw(context, COMPANION_X, GROUND_Y - lift, { frame: companion.frameAt(elapsed) });
      }
    },

    setPaused(value) {
      paused = value;
    },

    get offset() {
      return offset;
    },
  };

  /** @param {import('../core/app.mjs').App} app */
  function closeMenu(app) {
    app.pop();
    paused = false;
    showActor = true;
    refreshArt(app);
    void host;
  }
}

/**
 * A badge is named for its type, which avoids inventing names for the badges
 * of regions whose leaders the game generates rather than ships.
 * @param {any} leader
 */
function badgeLabel(leader) {
  const type = gameData().types[leader.type];
  return localized(type?.name, leader.type);
}
