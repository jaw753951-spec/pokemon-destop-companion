/**
 * The travelling scene — the game's home screen.
 *
 * The companion walks rightwards forever; the world scrolls, the area changes
 * every few minutes, and the run autosaves on its own. Once a minute an event
 * spawns something ahead on the path, and the walk carries on until it is
 * reached — so nothing ever simply appears on top of the player.
 */
import { CLICK_EVENT_BONUS_MS, EVENT_RETRY_MS, FIELD_HEIGHT, timeOfDay } from '../../shared/constants.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { artOf, gameData, speciesOf, spriteKey } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { restockBerry } from '../engine/items.mjs';
import { Session } from '../engine/session.mjs';
import {
  ACTOR_SCALE,
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
import { createHud } from '../render/hud.mjs';
import { battleScene } from './battle.mjs';
import { captureScene } from './capture.mjs';
import { createEventRunner } from './fieldevents.mjs';
import { leagueScene } from './league.mjs';
import { inventoryScene } from '../ui/inventory.mjs';
import { pokedexScene } from '../ui/pokedex.mjs';
import { chooseAction, confirm } from '../ui/dialog.mjs';
import { saveAndExit, saveAndQuit, settingsScene } from '../ui/settings.mjs';

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

  let hud = /** @type {ReturnType<typeof createHud>|null} */ (null);
  /** @type {ReturnType<typeof createEventRunner>|null} */
  let events = null;
  /** @type {import('../core/app.mjs').App|null} */
  let host = null;
  /** Clicks since the last frame: consumed one per event-second pulled in. */
  let clicks = 0;
  /** The overlay click listener this scene registered, removed on unmount. */
  let onClick = null;

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
      resumeMusic(app);
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
      openCapture(app, pokemon);
      return;
    }

    if (choice === 'release') {
      if (!(await confirm(app, t('tray.releaseConfirm'), { danger: true }))) return;
      session.tray.splice(index, 1);
      app.toast(t('tray.released', { name: label }));
    }
  }

  /**
   * Open the capture screen on a Pokémon that has been knocked down.
   *
   * One that is neither caught nor scared off goes back to the tray, so
   * closing the screen by mistake does not throw the catch away.
   *
   * @param {import('../core/app.mjs').App} app
   * @param {import('../engine/pokemon.mjs').Pokemon} target
   */
  function openCapture(app, target) {
    paused = true;
    showActor = false;
    app.push(
      captureScene({
        session,
        target,
        onFinish: ({ caught, fled }) => {
          app.pop();
          paused = false;
          showActor = true;
          if (!caught && !fled) session.addToTray(target);
          resumeMusic(app);
          refreshArt(app);
        },
      }),
    );
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
        leader: Boolean(setup.leader),
        // A gym leader is fought in their gym, everyone else where they stand.
        backdrop: setup.leader ? 'leader' : backdropForArea(session.area),
        music: setup.leader ? gameData().bgm.cues.battleLeader : undefined,
        onFinish: (result) => {
          app.pop();
          paused = false;
          showActor = true;
          // Before the fanfares: the audio engine holds this as the track to
          // come back to once a cue has finished, so the area's music is what
          // returns rather than the battle theme.
          resumeMusic(app);
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

    // Knocking a wild Pokémon down is what earns the throw, so the capture
    // screen opens on it rather than waiting to be found in the tray. With no
    // ball in the bag there is nothing to throw and it stays there instead.
    if (!setup.trainer && session.balls().length > 0) {
      const next = session.tray[session.tray.length - 1];
      if (next && result.defeated.includes(next)) {
        session.tray.pop();
        openCapture(app, next);
      }
    }
  }

  /**
   * Put the area's own music back on.
   *
   * Everything that opens over the road — a battle, the capture screen, the
   * league — plays music of its own, and nothing brought the area's back
   * afterwards: a fight left the battle theme looping over the walk until the
   * area happened to rotate. The audio engine ignores a track that is already
   * playing, so this is safe to call on every return.
   *
   * @param {import('../core/app.mjs').App} app
   */
  function resumeMusic(app) {
    app.audio.playMusic(session.area?.music ?? null);
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
              onSaveAndExit: () => saveAndExit(app),
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

      // The stage is scaled, so the click's own coordinates are of no use
      // here: it only has to say "the player asked for the next event",
      // wherever on the view it landed. Menu clicks are filtered out by the
      // paused flag they set — a settled pause is not a poke at the road.
      onClick = (event) => {
        if (paused) return;
        // A click on a control is not a poke at the road, however it reaches
        // this listener on its way up: the tray and the dialogs it opens sit
        // in the same overlay, and a menu button answers for itself.
        const target = event.target;
        if (target instanceof Element && target.closest('button, .modal, .panel')) return;

        clicks += 1;
        // A ring where the pointer landed. Half a second off a minute's wait
        // is not something a player can see happening, so the click answers
        // for itself — without it the poke reads as having done nothing.
        app.clickRipple(event);
      };
      document.getElementById('overlay')?.addEventListener('click', onClick);

      refreshArt(app);
      hud.update(session);
      return hud.root;
    },

    unmount() {
      if (onClick) document.getElementById('overlay')?.removeEventListener('click', onClick);
      onClick = null;
      hud = null;
      events = null;
      host = null;
    },

    update(deltaMs, app) {
      if (paused) return;

      // A click anywhere on the travelling view pulls the next event in: a
      // click per half a second trimmed, which is what a player poking at the
      // companion is asking for. Menus and battles sit above this scene, so a
      // click on those never reaches here.
      while (clicks > 0) {
        clicks -= 1;
        session.eventTimer = Math.max(0, session.eventTimer - CLICK_EVENT_BONUS_MS);
      }

      const walking = events?.walking ?? true;
      if (walking) offset += (WALK_SPEED * deltaMs) / 1000;

      const { rotateArea, autosave, event } = session.tick(deltaMs);

      // A turn that came due mid-event is held rather than dropped: the timer
      // goes back to a few seconds instead of its whole period, so the walk
      // picks it up as soon as the road is clear again.
      if (rotateArea) {
        if (events?.busy) session.areaTimer = EVENT_RETRY_MS;
        else {
          session.rotateArea();
          refreshArt(app);
        }
      }
      if (event) {
        if (events?.busy) session.eventTimer = EVENT_RETRY_MS;
        else events?.start(session.events.roll(session.rng), offset, app);
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
      inFieldSpace(context, (field) => {
        drawBackground(field, background, Math.round(offset));
        // The height the companion is actually drawn at, so a carried item
        // clears the head of a Wailord as surely as that of a Wurmple.
        events?.render(field, offset, Math.round((companion?.height ?? 24) * ACTOR_SCALE));

        if (companion && showActor && !events?.hidesActor) {
          const moving = !paused && (events?.walking ?? true);
          const walk = {
            x: COMPANION_X,
            y: groundY(),
            distance: offset,
            moving,
            // Standing still in front of a berry tree for ten seconds reads as
            // a frozen game; the bob says it is picking.
            lift: events?.actorLift ?? 0,
          };
          drawStepDust(field, walk);
          drawWalker(field, companion, walk);
        }
      });
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
    resumeMusic(app);
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
