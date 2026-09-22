/**
 * The battle scene.
 *
 * Battles are fought by the engine in whole turns; this scene plays the log it
 * produces back one entry at a time, so the fight reads at a watchable pace
 * even though it was decided instantly.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { weatherForArea } from '../../shared/area-tags.mjs';
import { loadSprite } from '../core/assets.mjs';
import { url } from '../core/bridge.mjs';
import { abilityOf, gameData, moveOf, speciesOf, spriteKey } from '../core/data.mjs';
import { button, el, setChildren, SHINY_MARK } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { chooseFromList } from '../ui/dialog.mjs';
import { Battle } from '../engine/battle.mjs';
import { healingItemFor, healingItems, throwItem } from '../engine/items.mjs';
import { evolveInto, levelOf, maxHp, pendingEvolution, setMove } from '../engine/pokemon.mjs';
import { Battler, battlerArt, battlerScale, FOE_DEPTH } from '../render/battler.mjs';
import { drawBackdrop, loadBackdrop } from '../render/backdrop.mjs';
import { inFieldSpace } from '../render/field.mjs';

/**
 * How long each log entry holds the screen.
 *
 * A click on the battle halves the wait for the entry currently on screen —
 * the cadence is a watchable default, not a rule — so these are the full-pace
 * numbers and `advance` does the halving.
 */
const BEAT_MS = { default: 620, move: 520, damage: 680, faint: 900, end: 1100 };

/** How much of a beat a click skips, as a share of the full wait. */
const CLICK_SPEEDUP = 0.5;

/** How long the red damage ghost holds before draining to the real bar. */
const GHOST_DELAY_MS = 240;

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
 *   backdrop?: string|null,
 *   music?: string|null,
 *   weather?: string|null,
 *   onFinish: (result: {outcome: 'won'|'lost', defeated: import('../engine/pokemon.mjs').Pokemon[]}) => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function battleScene({ session, foes, trainer = null, backdrop = null, music = null, weather = undefined, onFinish }) {
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

  const message = el('div.battle-message');
  const conditions = el('div.battle-field');
  const playerBar = healthBar();
  const foeBar = healthBar();
  /** The trainer's remaining party, drawn as the balls still on their belt. */
  const foeBalls = el('div.battle-balls');
  /**
   * How long until each side's damage ghost settles: one beat after the hit
   * that opened the gap, so the red shows where the bar was before it drains.
   * @type {{player: number, foe: number}}
   */
  const ghostTimers = { player: 0, foe: 0 };

  /** Every Pokémon is seen the moment it appears. */
  for (const foe of foes) session.markSeen(foe.speciesId);

  /**
   * Put a battle sprite on a side, from the box icon both sides now fight in.
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
            }
          : {
              x: PLAYER_SPOT.x,
              y: PLAYER_SPOT.y,
              facing: 1,
              scale: battlerScale(sprite, pokemon, PLAYER_ROOM),
              // The icon faces the viewer's left; the companion stands on the
              // left, so it is mirrored to look up the field at its opponent.
              flip: true,
            }),
      });
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
    if (finished) return;
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
      ];
      updateBars();
      updateField();
      updateFoeBalls();

      // The whole screen is the click target: hurrying a fight along is what
      // anyone mashing through a message box expects, and the scene already
      // ignores pointer events except where the bag button asks for them.
      const screenNode = el('div.battle-clickcatch');
      screenNode.addEventListener('pointerdown', (event) => hurryBeat(app, event));

      return el('div.screen.battle-screen', {}, [
        screenNode,
        el('div.battle-bar.foe', {}, [nameplate(battle.foe?.pokemon), foeBar.root]),
        el('div.battle-bar.player', {}, [nameplate(session.active), playerBar.root]),
        el('div.battle-actions', {}, [
          foeBalls,
          button(t('battle.bag'), () => openBag(app), { className: 'small' }),
        ]),
        conditions,
        message,
      ]);
    },

    update(deltaMs, app) {
      playerBattler?.update(deltaMs);
      foeBattler?.update(deltaMs);
      tickBarGhosts(deltaMs);

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
      });
    },
  };

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
    const player = session.active;
    const foe = battle.foe?.pokemon;

    switch (entry.kind) {
      case 'intro':
        say(trainer
          ? t('event.trainer', { trainer: localized(trainer.name, '') })
          : t('event.wild', { name: nameOf(foe) }));
        break;

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
        updateBars({ hurt: entry.side });
        return BEAT_MS.damage;
      }

      case 'critical':
        say(t('battle.critical'));
        break;

      case 'effectiveness': {
        const value = entry.data?.effectiveness ?? 1;
        if (value === 0) say(t('battle.noEffect'));
        else if (value > 1) say(t('battle.superEffective'));
        else say(t('battle.notVeryEffective'));
        break;
      }

      case 'miss':
        say(t('battle.missed', { name: nameOf(entry.side === 'player' ? player : foe) }));
        break;

      case 'status': {
        const status = entry.data?.status;
        if (status) say(`${nameOf(entry.side === 'player' ? player : foe)} — ${t(`status.${status}`)}`);
        updateBars();
        break;
      }

      case 'statusBlocked':
        say(`${nameOf(entry.side === 'player' ? player : foe)} — ${t(`status.${entry.data?.status}`)}`);
        break;

      case 'statusDamage':
        battlerFor(entry.side)?.setPose('hit');
        updateBars();
        break;

      case 'stat': {
        const stat = t(`stat.${entry.data?.stat}`) ?? entry.data?.stat;
        say(`${nameOf(entry.side === 'player' ? player : foe)} — ${stat} ${entry.data?.change > 0 ? '▲' : '▼'}`);
        break;
      }

      case 'heal':
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
        say(t('battle.noEffect'));
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
        const fainter = entry.side === 'player' ? player : foe;
        say(t('battle.fainted', { name: nameOf(fainter) }));
        battlerFor(entry.side)?.setPose('lose');
        app.audio.blip('faint');
        if (entry.side === 'foe' && foe) defeated.push(foe);
        return BEAT_MS.faint;
      }

      case 'sendOut':
        loadedFoeId = '';
        loadedPlayerId = '';
        loadFoeSprite();
        loadBattler('player', player);
        updateBars();
        say(t('event.wild', { name: nameOf(battle.foe?.pokemon) }));
        if (battle.foe?.pokemon.shiny) queue.unshift({ kind: 'shiny', data: {} });
        return BEAT_MS.faint;

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
        if (player.moves.length < 4 && move) {
          setMove(player, player.moves.length, move);
          say(t('battle.learned', { name: nameOf(player), move: localized(moveOf(move)?.name, move) }));
        }
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
   * @param {{hurt?: 'player'|'foe'}} [just] the side a hit just landed on, so
   *   its ghost holds a beat before draining while the other's settles at once
   */
  function updateBars(just) {
    playerBar.set(session.active);
    foeBar.set(battle.foe?.pokemon ?? null);
    ghostTimers.player = just?.hurt === 'player' ? GHOST_DELAY_MS : 0;
    ghostTimers.foe = just?.hurt === 'foe' ? GHOST_DELAY_MS : 0;
    if (ghostTimers.player <= 0) playerBar.settle();
    if (ghostTimers.foe <= 0) foeBar.settle();
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
   * @param {number} deltaMs
   */
  function tickBarGhosts(deltaMs) {
    ghostTimers.player -= deltaMs;
    ghostTimers.foe -= deltaMs;
    if (ghostTimers.player <= 0) playerBar.settle();
    if (ghostTimers.foe <= 0) foeBar.settle();
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

/** A name and level caption over a health bar. */
function nameplate(pokemon) {
  const node = el('span.battle-name');
  if (pokemon) {
    const species = speciesOf(pokemon.speciesId);
    const gender = pokemon.gender ? t(`pokemon.gender.${pokemon.gender}`) : '';
    const shiny = pokemon.shiny ? SHINY_MARK : '';
    const name = pokemon.nickname || localized(species?.name, '');
    node.textContent = `${name}${gender}${shiny}  ${t('slot.level', { level: levelOf(pokemon) })}`;
  }
  return node;
}

function healthBar() {
  const fill = el('i');
  // The ghost trails the real bar down in red wherever damage just landed, the
  // way the handheld games show what was taken before it settles.
  const ghost = el('i.ghost');
  const text = el('span.battle-hp');
  const track = el('div.battle-track', {}, [fill, ghost, text]);

  return {
    root: track,
    /**
     * @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon
     */
    set(pokemon) {
      if (!pokemon) {
        fill.style.width = '0%';
        ghost.style.width = '0%';
        ghost.dataset.pending = 'false';
        text.textContent = '';
        return;
      }
      const max = maxHp(pokemon);
      const ratio = max > 0 ? Math.max(0, pokemon.hp) / max : 0;
      const width = `${ratio * 100}%`;
      fill.style.width = width;
      fill.style.background = ratio > 0.5 ? '#63bb5b' : ratio > 0.2 ? '#f3d23b' : '#d8443c';

      // The ghost shows where the bar stood before whatever just happened. A
      // heal pulls it up at once — showing damage backwards reads wrong — and
      // a hit leaves it where it was, red, until `settle` drains it to here.
      const previous = Number.parseFloat(ghost.style.width) || 0;
      if (ratio * 100 >= previous) {
        ghost.style.width = width;
        ghost.dataset.pending = 'false';
      } else if (ghost.dataset.pending !== 'true') {
        ghost.dataset.pending = 'true';
      }
      text.textContent = `${Math.max(0, Math.round(pokemon.hp))}/${max}`;
    },
    /**
     * Drain the ghost down to the real bar, once the hit has been seen.
     * The `.drain` class swaps the transition from the fill's easing to a
     * slower fall, and is removed again the moment it has done its work.
     */
    settle() {
      if (ghost.dataset.pending !== 'true') return;
      ghost.dataset.pending = 'false';
      ghost.classList.add('drain');
      ghost.style.width = fill.style.width;
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
