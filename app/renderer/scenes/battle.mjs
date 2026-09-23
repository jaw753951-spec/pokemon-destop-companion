/**
 * The battle scene.
 *
 * Battles are fought by the engine in whole turns; this scene plays the log it
 * produces back one entry at a time, so the fight reads at a watchable pace
 * even though it was decided instantly.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { weatherForArea } from '../../shared/area-tags.mjs';
import { loadImage, loadSprite } from '../core/assets.mjs';
import { url } from '../core/bridge.mjs';
import { abilityOf, gameData, moveOf, speciesOf, spriteKey } from '../core/data.mjs';
import { button, el, setChildren, SHINY_MARK } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { chooseFromList } from '../ui/dialog.mjs';
import { Battle } from '../engine/battle.mjs';
import { healingItemFor, healingItems, throwItem } from '../engine/items.mjs';
import { evolveInto, levelOf, maxHp, pendingEvolution, setMove } from '../engine/pokemon.mjs';
import { Battler, battlerArt, battlerScale, FOE_DEPTH, mirrorFor } from '../render/battler.mjs';
import { drawBackdrop, loadBackdrop } from '../render/backdrop.mjs';
import { inFieldSpace } from '../render/field.mjs';

/**
 * How long each log entry holds the screen.
 *
 * A click on the battle halves the wait for the entry currently on screen —
 * the cadence is a watchable default, not a rule — so these are the full-pace
 * numbers and `advance` does the halving.
 */
const BEAT_MS = { default: 620, intro: 1000, move: 520, damage: 680, stat: 700, faint: 900, end: 1100, go: 1050 };

/**
 * A Pokémon sent out of its ball: how long the ball is in the air, how high it
 * arcs, how big it is drawn, and how long the light it opens in lasts. All in
 * field pixels and milliseconds.
 */
const TOSS_MS = 520;
const TOSS_ARC = 34;
const TOSS_BALL_SIZE = 12;
const BURST_MS = 260;

/** How much of a beat a click skips, as a share of the full wait. */
const CLICK_SPEEDUP = 0.5;

/**
 * The way into a battle, in milliseconds.
 *
 * The games never cut from the road to the fight: the screen flashes, goes
 * dark, and opens on the battle. A cut is the one thing that reads as a
 * mistake rather than as a transition, and this is a game whose battles
 * arrive on their own while the player is looking at something else — so the
 * moment it happens has to announce itself.
 *
 * Three phases: the road flashing white, the dark closing over it, and the
 * dark opening on the battle.
 */
const ENTRY_MS = 780;
const ENTRY_FLASHES = 3;
/** Where the flashing ends and the dark begins, as a share of the whole. */
const ENTRY_SHUT = 0.42;
/** Where the dark is complete and starts opening again. */
const ENTRY_OPEN = 0.62;

/**
 * The lines a condition reads, for the conditions that have one of their own.
 *
 * Only a burn and a poison bite at the end of a turn, and only sleep, freeze
 * and paralysis keep a Pokémon from moving — so those are the ones with
 * wording in the games. Anything else falls back to a plain line rather than
 * inventing a sentence the cartridge never says.
 */
const STATUS_HURT = { brn: 'status.brn.hurt', psn: 'status.psn.hurt' };
const STATUS_BLOCKED = { slp: 'status.slp.blocked', frz: 'status.frz.blocked', par: 'status.par.blocked' };

/**
 * How fast a health bar moves: the time a *whole* bar takes to drain, and the
 * least time any change takes.
 *
 * The games drain at a constant rate, so a scratch is over in a moment and a
 * heavy hit takes a visible while — which is how a player reads how much it
 * cost without looking at the number. A fixed duration for every change, which
 * is what a CSS transition gives, makes the two look the same and the bar look
 * as though it is guessing.
 */
const DRAIN_FULL_MS = 1100;
const DRAIN_MIN_MS = 110;

/**
 * The message box's top edge, in field pixels: it is 34 tall and sits 8 from
 * the bottom of the window, which is half that in the field's own space.
 */
const MESSAGE_TOP = FIELD_HEIGHT - 21;

/**
 * Where the two combatants stand: on the two platforms the backdrop draws, the
 * foe on the far one and the companion on the near one.
 *
 * Field coordinates, because the battlers are drawn in the same doubled space
 * as the backdrop behind them, and the backdrop is composed at exactly that
 * size — so these are the platforms' own pixels rather than a guess.
 */
const FOE_SPOT = { x: Math.round(FIELD_WIDTH * 0.73), y: Math.round(FIELD_HEIGHT * 0.55) };
const PLAYER_SPOT = { x: Math.round(FIELD_WIDTH * 0.26), y: MESSAGE_TOP - 3 };

/**
 * How much room each side has to stand in, in field pixels.
 *
 * The foe has everything above its platform: its own name plate is over on the
 * left, away from it. The companion's head has to stay clear of that plate, so
 * it gets the window below it. Both are kept inside the window horizontally by
 * the room either side of the spot they stand on.
 */
const FOE_ROOM = {
  width: 2 * Math.min(FOE_SPOT.x, FIELD_WIDTH - FOE_SPOT.x),
  height: FOE_SPOT.y - 2,
};
const PLAYER_ROOM = {
  width: 2 * Math.min(PLAYER_SPOT.x, FIELD_WIDTH - PLAYER_SPOT.x),
  height: PLAYER_SPOT.y - 30,
};

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   foes: import('../engine/pokemon.mjs').Pokemon[],
 *   trainer?: {name: {ko: string, en: string}, portrait?: string|null, kind?: string}|null,
 *   leader?: boolean,
 *   backdrop?: string|null,
 *   music?: string|null,
 *   weather?: string|null,
 *   onFinish: (result: {outcome: 'won'|'lost', defeated: import('../engine/pokemon.mjs').Pokemon[]}) => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function battleScene({ session, foes, trainer = null, leader = false, backdrop = null, music = null, weather = undefined, onFinish }) {
  const battle = new Battle({
    rng: session.rng,
    player: session.active,
    foes,
    policy: session.autoBattle,
    // The bag, reduced to the three things a battle asks of it.
    items: {
      choose: (pokemon) => autoHeal(session, pokemon),
      throw: (slug, pokemon) => throwItem(session, slug, pokemon),
    },
    trainerBattle: Boolean(trainer),
    // The sky the place is under, unless the caller names one of its own.
    weather: weather === undefined ? weatherForArea(session.area) : weather,
  });

  /** @type {import('../engine/battle.mjs').LogEntry[]} */
  let queue = [];
  let beat = 0;
  let finished = false;
  /** How far into the way in, in milliseconds; past `ENTRY_MS` it is over. */
  let entering = 0;
  /** The battle's own controls, hidden until the screen has opened on them. */
  let screenRoot = /** @type {HTMLElement|null} */ (null);
  /** @type {import('../engine/pokemon.mjs').Pokemon[]} */
  const defeated = [];

  /** @type {HTMLImageElement|null} */
  let backdropImage = null;
  /** @type {Battler|null} */
  let playerBattler = null;
  /** @type {Battler|null} */
  let foeBattler = null;
  let loadedFoeId = '';
  /** The sprite key the player's battler was drawn from, so a changed shape reloads it. */
  let loadedPlayerId = '';

  /**
   * Whether each side's Pokémon has come out of its ball yet. A battler that
   * finishes loading before its ball lands stays hidden until it does. A wild
   * Pokémon was never in one: it is standing there from the start.
   */
  const sentOut = { player: false, foe: !trainer };
  /**
   * Balls in the air, and the light each opens in once it lands.
   * @type {Array<{side: 'player'|'foe', pokemon: any, image: HTMLImageElement|null,
   *   from: {x: number, y: number}, to: {x: number, y: number}, elapsed: number, landed: boolean}>}
   */
  let tosses = [];

  /**
   * Throw a side's Pokémon out in the ball it lives in — the one it was caught
   * in, for anything the player caught, and a Poké Ball for everything else.
   *
   * @param {'player'|'foe'} side
   * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
   */
  const toss = (side, pokemon) => {
    const ball = pokemon?.ball && gameData().items[pokemon.ball] ? pokemon.ball : 'poke-ball';
    const spot = side === 'player' ? PLAYER_SPOT : FOE_SPOT;
    const entry = {
      side,
      pokemon,
      image: /** @type {HTMLImageElement|null} */ (null),
      // The companion's trainer stands off the bottom left; a foe's off the top right.
      from: side === 'player' ? { x: -8, y: spot.y - 44 } : { x: FIELD_WIDTH + 8, y: spot.y - 52 },
      to: { x: spot.x, y: spot.y - 8 },
      elapsed: 0,
      landed: false,
    };
    loadImage(`items/${ball}.png`).then((image) => { entry.image = image; }).catch(() => {});
    sentOut[side] = false;
    const battler = side === 'player' ? playerBattler : foeBattler;
    if (battler) battler.visible = false;
    tosses.push(entry);
  };

  /**
   * @param {number} deltaMs
   * @param {import('../core/app.mjs').App} app
   */
  const updateTosses = (deltaMs, app) => {
    for (const entry of tosses) {
      entry.elapsed += deltaMs;
      if (entry.landed || entry.elapsed < TOSS_MS) continue;
      // The ball opens: the Pokémon comes out in a flash of light, and calls.
      entry.landed = true;
      sentOut[entry.side] = true;
      const battler = entry.side === 'player' ? playerBattler : foeBattler;
      if (battler) {
        battler.visible = true;
        battler.setPose('emerge');
      }
      app.audio.blip('confirm');
      if (entry.pokemon && entry.side === 'player') app.audio.playCry(entry.pokemon.speciesId);
    }
    tosses = tosses.filter((entry) => entry.elapsed < TOSS_MS + BURST_MS);
  };

  /** @param {CanvasRenderingContext2D} context field space */
  const drawTosses = (context) => {
    for (const entry of tosses) {
      if (!entry.landed) {
        const progress = Math.min(1, entry.elapsed / TOSS_MS);
        const x = entry.from.x + (entry.to.x - entry.from.x) * progress;
        const y = entry.from.y + (entry.to.y - entry.from.y) * progress - Math.sin(progress * Math.PI) * TOSS_ARC;
        if (!entry.image) continue;
        context.save();
        context.translate(Math.round(x), Math.round(y));
        // Spinning as it flies, the way a thrown ball does.
        context.rotate(progress * Math.PI * 3 * (entry.side === 'player' ? 1 : -1));
        const scale = TOSS_BALL_SIZE / Math.max(entry.image.naturalWidth, entry.image.naturalHeight);
        const width = entry.image.naturalWidth * scale;
        const height = entry.image.naturalHeight * scale;
        context.drawImage(entry.image, -width / 2, -height / 2, width, height);
        context.restore();
        continue;
      }
      // The burst it opens in: a ring of light, widening and fading.
      const burst = Math.min(1, (entry.elapsed - TOSS_MS) / BURST_MS);
      context.save();
      context.globalAlpha = (1 - burst) * 0.85;
      context.fillStyle = '#ffffff';
      context.beginPath();
      context.arc(entry.to.x, entry.to.y, 4 + burst * 18, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  };
  /**
   * The foe whose name and bar are on screen.
   *
   * Not `battle.foe`: the engine has finished the turn before any of it is
   * played back, so by then the next Pokémon is already out — or the fight is
   * over and there is none. This is the one the player is looking at.
   * @type {import('../engine/pokemon.mjs').Pokemon|null}
   */
  let shownFoe = battle.foe?.pokemon ?? null;
  /** The entry being played, so the bars can read what it stood at. */
  let playing = /** @type {import('../engine/battle.mjs').LogEntry|null} */ (null);

  const message = el('div.battle-message');
  const conditions = el('div.battle-field');
  const playerPlate = nameplate(session.active);
  const foePlate = nameplate(shownFoe);
  const playerBar = healthBar();
  const foeBar = healthBar();
  /** The trainer's remaining party, drawn as the balls still on their belt. */
  const foeBalls = el('div.battle-balls');
  /** Every Pokémon is seen the moment it appears. */
  for (const foe of foes) session.markSeen(foe.speciesId);

  /**
   * Put a battle sprite on a side, from the standing art both sides fight in.
   *
   * Both sides go through the same path — keyed on the sprite key, so a
   * Pokémon whose shape changes mid-fight is reloaded like a new picture
   * rather than left wearing the old one.
   *
   * @param {'player'|'foe'} side
   * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
   */
  const loadBattler = (side, pokemon) => {
    const key = spriteKey(pokemon);
    if (!pokemon || !key) return;
    const loaded = side === 'player' ? loadedPlayerId : loadedFoeId;
    if (key === loaded) return;
    if (side === 'player') loadedPlayerId = key;
    else loadedFoeId = key;

    const art = battlerArt(pokemon);
    if (!art) return;
    loadSprite(art.path, art.meta).then((sprite) => {
      const latest = side === 'player' ? loadedPlayerId : loadedFoeId;
      if (latest !== key) return; // a newer shape already took the spot
      const battler = new Battler({
        sprite,
        ...(side === 'foe'
          ? {
              x: FOE_SPOT.x,
              y: FOE_SPOT.y,
              facing: -1,
              // Drawn smaller to put it up the field: without a depth cue the
              // two sit on the same plane and the battle reads flat.
              scale: battlerScale(sprite, pokemon, FOE_ROOM, FOE_DEPTH),
              flip: mirrorFor(sprite, 'left'),
            }
          : {
              x: PLAYER_SPOT.x,
              y: PLAYER_SPOT.y,
              facing: 1,
              scale: battlerScale(sprite, pokemon, PLAYER_ROOM),
              // The companion stands on the left, looking up the field at its
              // opponent.
              flip: mirrorFor(sprite, 'right'),
            }),
      });
      // Hidden until its ball has landed, if it is still in the air.
      battler.visible = sentOut[side];
      if (side === 'player') playerBattler = battler;
      else foeBattler = battler;
    });
  };

  const loadFoeSprite = () => loadBattler('foe', battle.foe?.pokemon ?? null);

  /**
   * The opponent's remaining party, one ball per Pokémon still standing.
   *
   * Trainers carry their team on their belt and the games count it down there
   * as it faints; a wild Pokémon has no trainer, and the row stays empty.
   */
  function updateFoeBalls() {
    const standing = (battle.foeQueue?.length ?? 0) + (battle.foe?.pokemon.hp > 0 ? 1 : 0);
    setChildren(
      foeBalls,
      Array.from({ length: standing }, () =>
        el('img.battle-ball', { src: url('assets', 'items/poke-ball.png'), alt: '' })),
    );
  }

  /**
   * A click on the battle brings the next entry on at half the remaining wait
   * — enough to hurry the fight along without skipping what is being said —
   * and answers with a ring where the pointer landed.
   * @param {import('../core/app.mjs').App} app
   * @param {MouseEvent} event
   */
  function hurryBeat(app, event) {
    if (finished || entering < ENTRY_MS) return;
    // Half of the beat that is still to run, floored so a late click does not
    // revive a beat that had already finished.
    beat = Math.min(beat, Math.max(beat * (1 - CLICK_SPEEDUP), 16));
    app.clickRipple(event);
  }

  return {
    keepBelow: true,

    mount(app) {
      loadBattler('player', session.active);
      loadFoeSprite();
      if (backdrop) loadBackdrop(backdrop).then((image) => { backdropImage = image; });

      app.audio.playMusic(music ?? gameData().bgm.cues[trainer ? 'battleTrainer' : 'battleWild']);
      app.audio.playCry(battle.foe?.pokemon.speciesId ?? session.active.speciesId);

      // A shiny gets a line of its own, after the one that says what turned
      // up: in the cartridges it is a sparkle and a chime, and here it is the
      // only thing that would tell a player what they are looking at.
      queue = [
        { kind: 'intro', data: {} },
        ...(battle.foe?.pokemon.shiny ? [{ kind: 'shiny', data: {} }] : []),
        { kind: 'go', data: {} },
      ];
      updateBars();
      updateField();
      updateFoeBalls();

      // The whole screen is the click target: hurrying a fight along is what
      // anyone mashing through a message box expects, and the scene already
      // ignores pointer events except where the bag button asks for them.
      const screenNode = el('div.battle-clickcatch');
      screenNode.addEventListener('pointerdown', (event) => hurryBeat(app, event));

      screenRoot = el('div.screen.battle-screen', {}, [
        screenNode,
        el('div.battle-bar.foe', {}, [foePlate.root, foeBar.root]),
        el('div.battle-bar.player', {}, [playerPlate.root, playerBar.root]),
        el('div.battle-actions', {}, [
          foeBalls,
          button(t('battle.bag'), () => openBag(app), { className: 'small' }),
        ]),
        conditions,
        message,
      ]);
      // Nothing of the battle shows until the dark opens on it.
      screenRoot.style.visibility = 'hidden';
      return screenRoot;
    },

    update(deltaMs, app) {
      // The way in runs before anything is said, so the first line of the
      // fight is not read out over a road the player is still looking at.
      if (entering < ENTRY_MS) {
        entering += deltaMs;
        if (screenRoot) {
          screenRoot.style.visibility = entering / ENTRY_MS >= ENTRY_OPEN ? 'visible' : 'hidden';
        }
        return;
      }

      playerBattler?.update(deltaMs);
      foeBattler?.update(deltaMs);
      updateTosses(deltaMs, app);
      playerBar.update(deltaMs);
      foeBar.update(deltaMs);

      if (finished) return;
      beat -= deltaMs;
      if (beat > 0) return;

      if (queue.length === 0) {
        if (!battle.running) {
          finishUp(app);
          return;
        }
        queue = battle.takeTurn();
        if (queue.length === 0) {
          finishUp(app);
          return;
        }
      }

      const entry = queue.shift();
      if (entry) {
        beat = play(entry, app);
        // The party count follows the faints and the send-outs, wherever in
        // the turn they happened to fall.
        updateFoeBalls();
      }
    },

    render(context) {
      const step = entering / ENTRY_MS;

      // The road is still on the canvas underneath; it flashes rather than
      // being covered, which is the first half of the way in.
      if (step < ENTRY_SHUT) {
        drawEntryFlash(context, step / ENTRY_SHUT);
        return;
      }

      // Until the backdrop has decoded, dim whatever the field left on the
      // canvas rather than flashing the map at full brightness for a frame.
      if (!backdropImage) {
        context.fillStyle = 'rgba(12, 16, 26, 0.55)';
        context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      }

      inFieldSpace(context, (field) => {
        if (backdropImage) drawBackdrop(field, backdropImage);
        foeBattler?.draw(field);
        playerBattler?.draw(field);
        drawTosses(field);
      });

      if (step < 1) drawEntryShutters(context, step);
    },
  };

  /**
   * The road going white, three times, on the way into a fight.
   * @param {CanvasRenderingContext2D} context
   * @param {number} step 0 to 1 across the flashing phase
   */
  function drawEntryFlash(context, step) {
    const pulse = Math.abs(Math.sin(step * Math.PI * ENTRY_FLASHES));
    context.save();
    context.globalAlpha = Math.min(1, pulse * (0.4 + step * 0.8));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    context.restore();
  }

  /**
   * The dark closing over the road and opening on the battle.
   * @param {CanvasRenderingContext2D} context
   * @param {number} step 0 to 1 across the whole way in
   */
  function drawEntryShutters(context, step) {
    const shut = step < ENTRY_OPEN
      ? (step - ENTRY_SHUT) / (ENTRY_OPEN - ENTRY_SHUT)
      : 1 - (step - ENTRY_OPEN) / (1 - ENTRY_OPEN);
    const reach = Math.ceil((VIEW_HEIGHT / 2) * Math.max(0, Math.min(1, shut * 1.1)));
    if (reach <= 0) return;

    context.save();
    context.fillStyle = '#05070c';
    context.fillRect(0, 0, VIEW_WIDTH, reach);
    context.fillRect(0, VIEW_HEIGHT - reach, VIEW_WIDTH, reach);
    context.restore();
  }

  /**
   * Open the bag mid-battle.
   *
   * Whatever is chosen is thrown on the companion's next action rather than
   * immediately: a turn spent on an item is a turn not spent attacking, which
   * is the cost the games charge for it.
   *
   * @param {import('../core/app.mjs').App} app
   */
  async function openBag(app) {
    if (finished) return;
    app.audio.blip('select');

    const usable = healingItems(session, session.active);
    const chosen = await chooseFromList(
      app,
      t('battle.bag'),
      usable.map(({ slug, count, item, restores }) => ({
        value: slug,
        label: localized(item.name, slug),
        detail: `${t('items.count', { count })}  ·  ${t('battle.restores', { amount: restores })}`,
      })),
      { empty: t('battle.noItems') },
    );

    if (!chosen || finished) return;
    battle.queueItem(chosen);
    say(t('battle.itemReady', { item: localized(gameData().items[chosen]?.name, chosen) }));
  }

  /**
   * Show one log entry and return how long to hold on it.
   * @param {import('../engine/battle.mjs').LogEntry} entry
   * @param {import('../core/app.mjs').App} app
   * @returns {number}
   */
  function play(entry, app) {
    playing = entry;
    const player = session.active;
    const foe = shownFoe ?? battle.foe?.pokemon;

    switch (entry.kind) {
      case 'intro':
        // The field used to toast this line and the battle repeat it a beat
        // later; the announcement lives here now, where the fight is.
        say(trainer
          ? t(leader ? 'event.leader' : 'event.trainer', { trainer: localized(trainer.name, '') })
          : t('event.wild', { name: nameOf(foe) }));
        // A trainer's Pokémon comes out of a ball; a wild one is already there.
        if (trainer) toss('foe', foe);
        return BEAT_MS.intro;

      // The companion is sent out after whatever it is being sent out against
      // has been named, which is the order the games read in.
      case 'go':
        say(t('battle.go', { name: nameOf(player) }));
        toss('player', player);
        return BEAT_MS.go;

      case 'move': {
        const attacker = entry.side === 'player' ? player : foe;
        const move = moveOf(entry.data?.move);
        say(t('battle.usedMove', {
          name: nameOf(attacker),
          move: move ? localized(move.name, entry.data?.move) : t('battle.struggle'),
        }));
        battlerFor(entry.side)?.setPose('attack');
        break;
      }

      case 'damage': {
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;
      }

      case 'critical':
        say(t('battle.critical'));
        break;

      case 'effectiveness': {
        const value = entry.data?.effectiveness ?? 1;
        const name = nameOf(entry.side === 'player' ? player : foe);
        if (value === 0) say(t('battle.noEffect', { name }));
        else if (value > 1) say(t('battle.superEffective'));
        else say(t('battle.notVeryEffective'));
        break;
      }

      case 'miss':
        say(t('battle.missed', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'status': {
        const name = nameOf(entry.side === 'player' ? player : foe);
        const status = entry.data?.status;
        // A null status is one that has just lifted: woken, thawed, or cured
        // by an ability. Each says so in its own words rather than leaving
        // whatever was on the screen before it standing.
        if (status) say(t(`status.${status}.gained`, { name }));
        else if (entry.data?.woke) say(t('status.slp.ended', { name }));
        else if (entry.data?.thawed) say(t('status.frz.ended', { name }));
        else say(t('status.cured', { name }));
        updateBars();
        break;
      }

      case 'statusBlocked':
        say(t(STATUS_BLOCKED[entry.data?.status] ?? 'battle.cannotMove', {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        break;

      case 'statusDamage':
        say(t(STATUS_HURT[entry.data?.status] ?? 'battle.statusHurt', {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'stat': {
        // How far it moved decides the wording, as in the games: one stage
        // rises, two rise sharply, three or more drastically.
        const change = entry.data?.change ?? 0;
        const steps = Math.min(3, Math.max(1, Math.abs(change)));
        say(t(`battle.stat.${change < 0 ? 'fell' : 'rose'}${steps}`, {
          name: nameOf(entry.side === 'player' ? player : foe),
          stat: t(`stat.${entry.data?.stat}`),
        }));
        battlerFor(entry.side)?.showStatChange(change > 0 ? 1 : -1);
        app.audio.blip(change > 0 ? 'confirm' : 'cancel');
        return BEAT_MS.stat;
      }

      case 'statFailed': {
        // Already as high or as low as the stage goes.
        const change = entry.data?.change ?? 0;
        say(t(`battle.stat.${change < 0 ? 'bottomed' : 'maxed'}`, {
          name: nameOf(entry.side === 'player' ? player : foe),
          stat: t(`stat.${entry.data?.stat}`),
        }));
        break;
      }

      case 'heal':
        say(t('battle.healed', { name: nameOf(entry.side === 'player' ? player : foe) }));
        updateBars();
        break;

      case 'volatile':
        say(t(`volatile.${entry.data?.state}.start`, {
          name: nameOf(entry.side === 'player' ? player : foe),
          move: localized(moveOf(entry.data?.move)?.name, entry.data?.move ?? ''),
        }));
        break;

      case 'volatileActive':
        say(t(`volatile.${entry.data?.state}.active`, {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        break;

      case 'volatileBlocked':
        say(t(`volatile.${entry.data?.state}.blocked`, {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        break;

      case 'volatileEnded':
        say(t(`volatile.${entry.data?.state}.end`, {
          name: nameOf(entry.side === 'player' ? player : foe),
        }));
        break;

      case 'confusionDamage':
        say(t('battle.confusionDamage', { name: nameOf(entry.side === 'player' ? player : foe) }));
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'perished':
        say(t('battle.perished', { name: nameOf(entry.side === 'player' ? player : foe) }));
        updateBars();
        break;

      case 'protect':
        say(t('battle.protecting', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'protected':
        say(t('battle.protected', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'bounced':
        say(t('battle.bounced', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'loafing':
        say(t('battle.loafing', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'stole':
      case 'regrew': {
        const slug = entry.data?.item ?? '';
        say(t(entry.kind === 'stole' ? 'battle.stole' : 'battle.regrew', {
          name: nameOf(entry.side === 'player' ? player : foe),
          item: localized(gameData().items[slug]?.name, slug),
        }));
        break;
      }

      case 'formChanged': {
        // The shape a Pokémon now wears: the sprite is reloaded by the key
        // change, the way a sent-out one is. A forme of null means back to
        // the ordinary shape, which is the usual thing a message names.
        const shifter = entry.side === 'player' ? player : foe;
        loadBattler(entry.side, entry.side === 'player' ? player : foe);
        if (entry.data?.forme) {
          const formName = speciesOf(shifter?.speciesId)?.forms?.find((form) => form.slug === entry.data.forme);
          say(t('battle.formChanged', {
            name: nameOf(shifter),
            form: localized(formName?.name, entry.data.forme),
          }));
        } else {
          say(t('battle.formReverted', { name: nameOf(shifter) }));
        }
        updateBars();
        app.audio.blip('confirm');
        break;
      }

      case 'formBroken':
        // The disguise shattering is its own moment: the ability line already
        // played, and the shape swap rides the same key change as above.
        loadBattler(entry.side, entry.side === 'player' ? player : foe);
        say(t('battle.formBroken', {
          name: nameOf(entry.side === 'player' ? player : foe),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'typeChanged':
        say(t('battle.typeChanged', {
          name: nameOf(entry.side === 'player' ? player : foe),
          types: (entry.data?.types ?? [])
            .map((type) => localized(gameData().types[type]?.name, type))
            .join('·'),
        }));
        break;

      case 'hazard':
        say(t(`hazard.${entry.data?.hazard}`));
        break;

      case 'hazardCleared':
        say(t('hazard.cleared'));
        break;

      case 'hazardDamage':
        say(t('battle.hazardDamage', { name: nameOf(entry.side === 'player' ? player : foe) }));
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'noEffect':
        say(t('battle.noEffect', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      // A move that went off and achieved nothing — not one the target was
      // immune to, which is the line above.
      case 'failed':
        say(t('battle.failed'));
        break;

      case 'flinch':
        say(t('battle.flinched', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'shiny':
        say(t('battle.shiny'));
        app.audio.blip('confirm');
        break;

      case 'ability':
        say(t('battle.ability', {
          name: nameOf(entry.side === 'player' ? player : foe),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        break;

      case 'abilityTraced':
        say(t('battle.abilityTraced', {
          name: nameOf(player),
          ability: localized(abilityOf(entry.data?.ability)?.name, entry.data?.ability ?? ''),
        }));
        break;

      case 'abilityDamage':
        battlerFor(entry.side)?.setPose('hit');
        app.audio.blip('hit');
        updateBars();
        return BEAT_MS.damage;

      case 'weather':
        say(t(`weather.${entry.data?.weather}.start`));
        updateField();
        break;

      case 'weatherEnded':
        say(t(`weather.${entry.data?.value}.end`));
        updateField();
        break;

      case 'weatherDamage':
        say(t(`weather.${entry.data?.weather}.hurt`, { name: nameOf(entry.side === 'player' ? player : foe) }));
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        break;

      case 'terrain':
        say(t(`terrain.${entry.data?.terrain}.start`));
        updateField();
        break;

      case 'terrainEnded':
        say(t(`terrain.${entry.data?.value}.end`));
        updateField();
        break;

      case 'screen':
        say(t(`screen.${entry.data?.screen}`));
        break;

      case 'screenEnded':
        say(t('screen.ended'));
        break;

      case 'charging':
        say(t('battle.charging', {
          name: nameOf(entry.side === 'player' ? player : foe),
          move: localized(moveOf(entry.data?.move)?.name, entry.data?.move ?? ''),
        }));
        break;

      case 'recharge':
        say(t('battle.recharge', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'restored':
        say(t('battle.restored', {
          name: nameOf(entry.side === 'player' ? player : foe),
          item: localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? ''),
        }));
        break;

      case 'item': {
        const name = localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? '');
        say(entry.data?.used
          ? t('battle.itemUsed', { name: nameOf(player), item: name })
          : t('items.cannotUse'));
        app.audio.blip(entry.data?.used ? 'confirm' : 'error');
        updateBars();
        break;
      }

      case 'berry':
      case 'heldFired': {
        // A berry is eaten; a policy, a seed or an orb simply goes off. The
        // item's own pocket is what tells them apart, so the engine does not
        // have to carry two log entries for one moment.
        const slug = entry.data?.item ?? '';
        const item = gameData().items[slug];
        const holder = entry.side === 'foe' ? foe : player;
        say(t(item?.pocket === 'berries' ? 'battle.berryEaten' : 'battle.heldFired', {
          name: nameOf(holder),
          item: localized(item?.name, slug),
        }));
        app.audio.blip('confirm');
        updateBars();
        break;
      }

      case 'endure': {
        const holder = entry.side === 'player' ? player : foe;
        // A Sturdy holds on where a Focus Sash would have been spent, so the
        // line names whichever of the two did it.
        const name = entry.data?.ability
          ? localized(abilityOf(entry.data.ability)?.name, entry.data.ability)
          : localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? '');
        say(t('battle.endured', { name: nameOf(holder), item: name }));
        app.audio.blip('hit');
        updateBars();
        break;
      }

      case 'faint': {
        // From the entry rather than from `battle.foe`: by the time the log is
        // played back the engine has already moved on, and the last foe to
        // fall leaves `battle.foe` empty — which is why the line read
        // "은(는) 쓰러졌다!" with no name, and why nothing reached the tray.
        const fainter = entry.data?.pokemon ?? (entry.side === 'player' ? player : foe);
        say(t('battle.fainted', { name: nameOf(fainter) }));
        battlerFor(entry.side)?.setPose('lose');
        app.audio.blip('faint');
        if (entry.side === 'foe' && fainter) defeated.push(fainter);
        return BEAT_MS.faint;
      }

      case 'sendOut': {
        loadedFoeId = '';
        loadedPlayerId = '';
        if (trainer) toss('foe', entry.data?.pokemon ?? battle.foe?.pokemon ?? null);
        loadFoeSprite();
        loadBattler('player', player);
        updateBars();
        // A trainer sends the next one out; only a wild Pokémon appears of its
        // own accord, so only a wild battle reads the encounter line here.
        const sent = entry.data?.pokemon ?? battle.foe?.pokemon ?? null;
        shownFoe = sent;
        foePlate.set(sent);
        updateBars();
        say(trainer
          ? t('battle.foeSentOut', { trainer: localized(trainer.name, ''), name: nameOf(sent) })
          : t('event.wild', { name: nameOf(sent) }));
        if (sent?.shiny) queue.unshift({ kind: 'shiny', data: {} });
        return BEAT_MS.faint;
      }

      case 'experience':
        say(t('battle.expGained', { name: nameOf(player), amount: entry.data?.amount ?? 0 }));
        break;

      case 'levelUp':
        say(t('battle.levelUp', { name: nameOf(player), level: entry.data?.level ?? levelOf(player) }));
        app.audio.playJingle(gameData().bgm.cues.levelUp ?? null);
        updateBars();
        break;

      case 'canLearn': {
        // A free slot means the move is simply learned, as in the games; with
        // four moves already the player swaps it in from the Pokémon screen.
        const move = entry.data?.move;
        if (!move) break;
        const moveName = localized(moveOf(move)?.name, move);
        if (player.moves.length < 4) {
          setMove(player, player.moves.length, move);
          say(t('battle.learned', { name: nameOf(player), move: moveName }));
          break;
        }
        // Four already. The games say so rather than dropping the move
        // silently, which left no sign anywhere that there was something new
        // waiting in the Pokémon screen's move list.
        say(t('battle.cannotLearnMore', { name: nameOf(player), move: moveName }));
        app.toast(t('battle.cannotLearnMore', { name: nameOf(player), move: moveName }), 3200);
        break;
      }

      case 'end':
        if (battle.outcome === 'won') {
          say(t('battle.won'));
          playerBattler?.setPose('win');
        } else {
          say(t('battle.lost'));
        }
        return BEAT_MS.end;

      default:
        return 120;
    }
    return BEAT_MS[entry.kind] ?? BEAT_MS.default;
  }

  /** @param {import('../core/app.mjs').App} app */
  function finishUp(app) {
    if (finished) return;
    finished = true;

    if (battle.outcome === 'won') {
      const evolution = pendingEvolution(session.active);
      if (evolution) {
        const from = nameOf(session.active);
        evolveInto(session.active, evolution.to);
        session.markCaught(evolution.to);
        app.toast(t('battle.evolving', { name: from, target: nameOf(session.active) }));
        app.audio.playCry(session.active.speciesId);
      }
    }

    onFinish({ outcome: battle.outcome === 'lost' ? 'lost' : 'won', defeated });
  }

  /** @param {'player'|'foe'|undefined} side */
  function battlerFor(side) {
    return side === 'player' ? playerBattler : foeBattler;
  }

  /** @param {string} text */
  function say(text) {
    message.textContent = text;
  }

  /**
   * Point both bars at what the line being played says they stood at.
   *
   * Falling back to the Pokémon's own hit points covers the first paint, and
   * any entry written before the stamp existed.
   */
  function updateBars() {
    playerBar.set(session.active, playing?.hp?.player);
    foeBar.set(shownFoe, playing?.hp?.foe);
    playerPlate.set(session.active);
  }

  /**
   * What is over and under the field, as a line of chips above the message
   * box: a battle where the rain decides the damage should say that it is
   * raining for as long as it is, not only on the turn it started.
   */
  function updateField() {
    const field = battle.field;
    setChildren(conditions, [
      field.weather
        ? el('span.field-chip', { text: t(`weather.${field.weather}.name`), title: t(`weather.${field.weather}.start`) })
        : null,
      field.terrain
        ? el('span.field-chip', { text: t(`terrain.${field.terrain}.name`), title: t(`terrain.${field.terrain}.start`) })
        : null,
    ]);
  }

  /**
   * @param {import('../engine/pokemon.mjs').Pokemon|null|undefined} pokemon
   * @returns {string}
   */
  function nameOf(pokemon) {
    if (!pokemon) return '';
    return pokemon.nickname || localized(speciesOf(pokemon.speciesId)?.name, '');
  }

}

/**
 * A name and level caption over a health bar.
 *
 * It can be pointed at somebody else: a trainer sends out a second Pokémon and
 * the plate over the bar was still naming the one that fainted.
 */
function nameplate(pokemon) {
  const node = el('span.battle-name');

  /** @param {import('../engine/pokemon.mjs').Pokemon|null|undefined} next */
  const set = (next) => {
    if (!next) {
      node.textContent = '';
      return;
    }
    const species = speciesOf(next.speciesId);
    const gender = next.gender ? t(`pokemon.gender.${next.gender}`) : '';
    const shiny = next.shiny ? SHINY_MARK : '';
    const name = next.nickname || localized(species?.name, '');
    node.textContent = `${name}${gender}${shiny}  ${t('slot.level', { level: levelOf(next) })}`;
  };

  set(pokemon);
  return { root: node, set };
}

/**
 * One bar, moving at one speed — which is what the games have.
 *
 * The bar is animated here rather than by a CSS transition: a transition runs
 * for the time it is given whatever distance it has to cover, so a two-point
 * scratch and a bar-emptying hit took exactly as long as each other. The
 * number counts along with it, as it does on the cartridge, so the two never
 * disagree about how much is left.
 */
export function healthBar() {
  const fill = el('i');
  const text = el('span.battle-hp');
  const track = el('div.battle-track', {}, [fill, text]);

  /** What the bar is showing, what it is heading for, and how fast. */
  let shown = /** @type {{hp: number, max: number}|null} */ (null);
  let goal = 0;
  /** Hit points a millisecond, signed. */
  let rate = 0;

  function paint() {
    if (!shown) {
      fill.style.width = '0%';
      text.textContent = '';
      return;
    }
    const ratio = shown.max > 0 ? Math.max(0, Math.min(1, shown.hp / shown.max)) : 0;
    fill.style.width = `${ratio * 100}%`;
    // The thresholds the games change colour at: half, and a fifth.
    fill.style.background = ratio > 0.5 ? '#63bb5b' : ratio > 0.2 ? '#f3d23b' : '#d8443c';
    text.textContent = `${Math.round(shown.hp)}/${shown.max}`;
  }

  return {
    root: track,

    /**
     * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
     * @param {number} [at] the hit points to show, where the caller knows them
     *   better than the Pokémon does — which is any moment during the playback
     *   of a turn the engine has already finished
     */
    set(pokemon, at) {
      if (!pokemon) {
        shown = null;
        rate = 0;
        paint();
        return;
      }

      const max = maxHp(pokemon);
      const hp = Math.max(0, Math.min(max, typeof at === 'number' ? at : pokemon.hp));

      // A bar arriving for the first time, or one whose Pokémon has just
      // changed shape under it, is simply drawn where it stands.
      if (!shown || shown.max !== max) {
        shown = { hp, max };
        goal = hp;
        rate = 0;
        paint();
        return;
      }

      goal = hp;
      const distance = Math.abs(goal - shown.hp) / max;
      const duration = Math.max(DRAIN_MIN_MS, distance * DRAIN_FULL_MS);
      rate = (goal - shown.hp) / duration;
      paint();
    },

    /** @param {number} deltaMs */
    update(deltaMs) {
      if (!shown || rate === 0 || shown.hp === goal) return;
      const next = shown.hp + rate * deltaMs;
      shown.hp = rate > 0 ? Math.min(goal, next) : Math.max(goal, next);
      if (shown.hp === goal) rate = 0;
      paint();
    },
  };
}

/**
 * The item the policy would throw this turn, if any.
 *
 * A condition is the whole of it — the same vocabulary the auto-battle screen
 * uses — and `never` means the bag only opens when the player opens it.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 * @returns {string|null}
 */
function autoHeal(session, pokemon) {
  const policy = session.itemPolicy?.healing;
  if (!policy || policy.condition === 'never') return null;

  const health = pokemon.hp / Math.max(1, maxHp(pokemon));
  const thresholds = { hpTwoThirds: 2 / 3, hpHalf: 1 / 2, hpThird: 1 / 3, hpQuarter: 1 / 4 };
  const threshold = thresholds[policy.condition];
  if (threshold === undefined || health > threshold) return null;

  return healingItemFor(session, pokemon, policy.item);
}
