/**
 * The travelling scene — the game's home screen.
 *
 * The companion walks rightwards forever; the world scrolls, the area changes
 * every few minutes, and the run autosaves on its own. Once a minute an event
 * spawns something ahead on the path, and the walk carries on until it is
 * reached — so nothing ever simply appears on top of the player.
 */
import { FIELD_HEIGHT, HOLD_BOOST_RATE, HOLD_BOOST_WALK, timeOfDay } from '../../shared/constants.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { artOf, gameData, speciesOf, spriteKey } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { restockBerry } from '../engine/items.mjs';
import { Session } from '../engine/session.mjs';
import {
  actorHeight,
  actorScale,
  COMPANION_X,
  drawBackground,
  drawStepDust,
  drawWalker,
  groundY,
  inFieldSpace,
  setGroundY,
  WALK_SPEED,
} from '../render/field.mjs';
import { backdropForArea } from '../render/backdrop.mjs';
import { createWeather, weatherLayerFor } from '../render/weather.mjs';
import { createHud } from '../render/hud.mjs';
import { battleScene } from './battle.mjs';
import { captureScene } from './capture.mjs';
import { createEventRunner } from './fieldevents.mjs';
import { leagueScene } from './league.mjs';
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
  /** Which art is on screen: the species, and which of its two palettes. */
  let loadedSpriteId = '';
  let offset = 0;
  /** Set while a menu or battle is on top; the walk and its timers stop. */
  let paused = false;
  /**
   * Cleared while a battle or the capture screen is up: those draw their own
   * version of the companion, and two of it at once reads as a bug.
   */
  let showActor = true;

  /**
   * The rain, snow or ash over this area, made fresh when the area changes so
   * one place's sky never drifts into the next one's.
   * @type {ReturnType<typeof createWeather>|null}
   */
  let weather = null;
  let loadedWeather = /** @type {string|null|undefined} */ (undefined);

  let hud = /** @type {ReturnType<typeof createHud>|null} */ (null);
  /** @type {ReturnType<typeof createEventRunner>|null} */
  let events = null;
  /** @type {import('../core/app.mjs').App|null} */
  let host = null;
  /**
   * Whether the pointer is being held on the travelling view.
   *
   * The hurry-up is a live state rather than a bank of clicks: while it is
   * true the walk and the event clock run fast, and the frame it goes false
   * they are back to their ordinary pace with nothing carried over.
   */
  let boosting = false;
  /** The overlay listeners this scene registered, removed on unmount. */
  let onPointerDown = null;
  let onPointerUp = null;

  /** Load whatever art the current area and companion need. */
  const refreshArt = (app) => {
    const key = `${session.area?.id}/${timeOfDay()}`;
    if (session.area && key !== loadedAreaKey) {
      loadedAreaKey = key;
      // The strip is anchored to the bottom of the field, so the area's own
      // walkable lane is measured from there too.
      setGroundY(FIELD_HEIGHT - session.area.height + session.area.groundY);
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

    const sky = weatherLayerFor(session.area);
    if (sky !== loadedWeather) {
      loadedWeather = sky;
      weather = sky ? createWeather(sky) : null;
    }

    const speciesId = spriteKey(session.active);
    if (speciesId !== loadedSpriteId) {
      loadedSpriteId = speciesId;
      // The box icon, not the battle sprite: it is the only official art drawn
      // at overworld scale, so a Wurmple stays ankle-high and a Wailord fills
      // the road, each in proportion to the map's own tiles.
      const art = artOf(session.active, 'icon');
      if (art) {
        loadSprite(art.path, { ...art.meta, frames: 1, delay: 1000 })
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
        // A gym leader is fought in their gym, everyone else where they stand.
        backdrop: setup.leader ? 'leader' : backdropForArea(session.area),
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
      // Blacking out costs the catch and nothing else. A wild Pokémon that was
      // never beaten cannot be thrown a ball — it is the one that walked away
      // — while a trainer takes no more from you than the walk to the next
      // rest stop, which is where the companion heads either way, on the one
      // hit point the loss leaves it.
      session.blackOut();
      app.toast(t(setup.trainer ? 'battle.lost' : 'battle.lostWild'));
      restock(app);
      refreshArt(app);
      return;
    }

    if (setup.leader) {
      session.badges.push(setup.leader.type);
      session.trainerWins = 0;
      app.audio.playJingle(gameData().bgm.cues.obtainBadge ?? null);
      app.toast(t('badge.obtained', { name: badgeLabel(setup.leader) }));
    } else if (setup.trainer) {
      session.trainerWins++;
      app.audio.playJingle(gameData().bgm.cues.victoryTrainer ?? null);
    } else {
      // Only wild Pokémon can be caught, so only they reach the tray — and
      // only when the companion was the one left standing.
      for (const pokemon of result.defeated) session.addToTray(pokemon);
      app.audio.playJingle(gameData().bgm.cues.victoryWild ?? null);
    }

    restock(app);
    refreshArt(app);
  }

  /**
   * Put a berry back in the companion's hand if the fight emptied it, which is
   * what the bag's restock setting is for.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function restock(app) {
    const berry = restockBerry(session, session.active);
    if (berry) app.toast(t('items.restocked', { name: localized(gameData().items[berry]?.name, berry) }));
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
        onLeague: () => {
          app.audio.blip('confirm');
          paused = true;
          showActor = false;
          app.push(
            leagueScene({
              session,
              onLeave: () => closeMenu(app),
              onCrowned: () => {
                // Champion or not, the run carries on with everything intact.
                closeMenu(app);
              },
            }),
          );
        },
        onTraySelect: (index) => openTrayMenu(app, index),
      });

      events = createEventRunner({
        session,
        onBattle: (setup) => startBattle(app, setup),
      });

      // The stage is scaled, so the pointer's own coordinates are of no use
      // here: holding it anywhere on the view says "get on with it", wherever
      // on the view it landed. Menu presses are filtered out by the paused
      // flag they set — a settled pause is not a poke at the road.
      //
      // Held rather than counted, and released rather than spent: a player
      // who stops pressing gets the ordinary pace back on the very next frame,
      // instead of the game still working through clicks banked a minute ago.
      onPointerDown = (event) => {
        if (paused) return;
        if (/** @type {PointerEvent} */ (event).button !== 0) return;
        boosting = true;
      };
      // Every way a press can end, including the pointer leaving the window
      // mid-press — a button released off-screen must not leave the walk
      // running fast with nothing holding it.
      onPointerUp = () => {
        boosting = false;
      };

      const overlay = document.getElementById('overlay');
      overlay?.addEventListener('pointerdown', onPointerDown);
      for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
        overlay?.addEventListener(name, onPointerUp);
      }
      window.addEventListener('blur', onPointerUp);

      refreshArt(app);
      hud.update(session);
      return hud.root;
    },

    unmount() {
      const overlay = document.getElementById('overlay');
      if (onPointerDown) overlay?.removeEventListener('pointerdown', onPointerDown);
      if (onPointerUp) {
        for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
          overlay?.removeEventListener(name, onPointerUp);
        }
        window.removeEventListener('blur', onPointerUp);
      }
      onPointerDown = null;
      onPointerUp = null;
      boosting = false;
      weather = null;
      loadedWeather = undefined;
      hud = null;
      events = null;
      host = null;
    },

    update(deltaMs, app) {
      if (paused) return;

      // Holding the pointer on the travelling view runs the clock fast, so the
      // next event comes round sooner; the frame the pointer goes up this is 1
      // again and the pace is back to normal, with nothing owed either way.
      // Menus and battles sit above this scene, so a press on those never
      // reaches here.
      const boost = boosting ? HOLD_BOOST_RATE : 1;

      const walking = events?.walking ?? true;
      const pace = boosting ? HOLD_BOOST_WALK : 1;
      if (walking) offset += (WALK_SPEED * pace * deltaMs) / 1000;

      const { rotateArea, autosave, event } = session.tick(deltaMs, { eventRate: boost });

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
      weather?.update(deltaMs);
      refreshArt(app);
      hud?.update(session);
    },

    render(context) {
      inFieldSpace(context, (field) => {
        drawBackground(field, background, Math.round(offset));
        // The height the companion is actually drawn at, so a carried item
        // clears the head of a Wailord as surely as that of a Wurmple.
        events?.render(field, offset, actorHeight(companion, session.active));

        if (companion && showActor && !events?.hidesActor) {
          const moving = !paused && (events?.walking ?? true);
          const walk = {
            x: COMPANION_X,
            y: groundY(),
            distance: offset,
            moving,
            scale: actorScale(companion, session.active),
          };
          drawStepDust(field, walk);
          drawWalker(field, companion, walk);
        }

        // Over everything, because it is between the player and the place.
        weather?.draw(field);
      });
    },

    setPaused(value) {
      paused = value;
      // Whatever was holding the walk fast is not holding it any more: a menu
      // opening over the road ends the hurry-up along with everything else.
      if (value) boosting = false;
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
