/**
 * The battle scene.
 *
 * Battles are fought by the engine in whole turns; this scene plays the log it
 * produces back one entry at a time, so the fight reads at a watchable pace
 * even though it was decided instantly.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { gameData, moveOf, speciesOf } from '../core/data.mjs';
import { button, el } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { chooseFromList } from '../ui/dialog.mjs';
import { Battle } from '../engine/battle.mjs';
import { healingItemFor, healingItems, throwItem } from '../engine/items.mjs';
import { evolveInto, levelOf, maxHp, pendingEvolution, setMove } from '../engine/pokemon.mjs';
import { Battler, fitScale } from '../render/battler.mjs';
import { drawBackdrop, loadBackdrop } from '../render/backdrop.mjs';
import { inFieldSpace } from '../render/field.mjs';

/** How long each log entry holds the screen. */
const BEAT_MS = { default: 620, move: 520, damage: 680, faint: 900, end: 1100 };

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
 *   onFinish: (result: {outcome: 'won'|'lost', defeated: import('../engine/pokemon.mjs').Pokemon[]}) => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function battleScene({ session, foes, trainer = null, backdrop = null, music = null, onFinish }) {
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
  let loadedFoeId = 0;

  const message = el('div.battle-message');
  const playerBar = healthBar();
  const foeBar = healthBar();

  /** Every Pokémon is seen the moment it appears. */
  for (const foe of foes) session.markSeen(foe.speciesId);

  const loadFoeSprite = () => {
    const foe = battle.foe?.pokemon;
    if (!foe || foe.speciesId === loadedFoeId) return;
    loadedFoeId = foe.speciesId;
    const meta = gameData().sprites[foe.speciesId]?.front;
    if (!meta) return;
    loadSprite(`pokemon/${foe.speciesId}/front.png`, meta).then((sprite) => {
      if (loadedFoeId !== foe.speciesId) return;
      // The BW set draws backs and fronts at much the same size (mean height 75
      // against 78), so the foe is shrunk to put it up the field. Without this
      // the two sit on the same plane and the battle reads flat.
      foeBattler = new Battler({
        sprite,
        x: FOE_SPOT.x,
        y: FOE_SPOT.y,
        facing: -1,
        scale: fitScale(sprite, FOE_ROOM, 0.8),
      });
    });
  };

  return {
    keepBelow: true,

    mount(app) {
      const active = session.active;
      const meta = gameData().sprites[active.speciesId];
      if (meta?.back) {
        loadSprite(`pokemon/${active.speciesId}/back.png`, meta.back).then((sprite) => {
          playerBattler = new Battler({
            sprite,
            x: PLAYER_SPOT.x,
            y: PLAYER_SPOT.y,
            facing: 1,
            scale: fitScale(sprite, PLAYER_ROOM, 1),
          });
        });
      } else if (meta?.front) {
        loadSprite(`pokemon/${active.speciesId}/front.png`, meta.front).then((sprite) => {
          // No back art: the front sprite stands in, mirrored so the companion
          // still looks up the field at what it is fighting.
          playerBattler = new Battler({
            sprite,
            x: PLAYER_SPOT.x,
            y: PLAYER_SPOT.y,
            facing: 1,
            scale: fitScale(sprite, PLAYER_ROOM, 1),
            flip: true,
          });
        });
      }
      loadFoeSprite();
      if (backdrop) loadBackdrop(backdrop).then((image) => { backdropImage = image; });

      app.audio.playMusic(music ?? gameData().bgm.cues[trainer ? 'battleTrainer' : 'battleWild']);
      app.audio.playCry(battle.foe?.pokemon.speciesId ?? active.speciesId);

      queue = [{ kind: 'intro', data: {} }];
      updateBars();

      return el('div.screen.battle-screen', {}, [
        el('div.battle-bar.foe', {}, [nameplate(battle.foe?.pokemon), foeBar.root]),
        el('div.battle-bar.player', {}, [nameplate(session.active), playerBar.root]),
        el('div.battle-actions', {}, [
          button(t('battle.bag'), () => openBag(app), { className: 'small' }),
        ]),
        message,
      ]);
    },

    update(deltaMs, app) {
      playerBattler?.update(deltaMs);
      foeBattler?.update(deltaMs);

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
      if (entry) beat = play(entry, app);
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
        updateBars();
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

      case 'item': {
        const name = localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? '');
        say(entry.data?.used
          ? t('battle.itemUsed', { name: nameOf(player), item: name })
          : t('items.cannotUse'));
        app.audio.blip(entry.data?.used ? 'confirm' : 'error');
        updateBars();
        break;
      }

      case 'berry': {
        const name = localized(gameData().items[entry.data?.item]?.name, entry.data?.item ?? '');
        say(t('battle.berryEaten', { name: nameOf(player), item: name }));
        app.audio.blip('confirm');
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
        loadedFoeId = 0;
        loadFoeSprite();
        updateBars();
        say(t('event.wild', { name: nameOf(battle.foe?.pokemon) }));
        return BEAT_MS.faint;

      case 'experience':
        say(t('battle.expGained', { name: nameOf(player), amount: entry.data?.amount ?? 0 }));
        break;

      case 'levelUp':
        say(t('battle.levelUp', { name: nameOf(player), level: entry.data?.level ?? levelOf(player) }));
        app.audio.playMusic(gameData().bgm.cues.levelUp ?? null);
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

  function updateBars() {
    playerBar.set(session.active);
    foeBar.set(battle.foe?.pokemon ?? null);
  }

  /** @param {import('../engine/pokemon.mjs').Pokemon|null|undefined} pokemon */
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
    node.textContent = `${pokemon.nickname || localized(species?.name, '')}  ${t('slot.level', { level: levelOf(pokemon) })}`;
  }
  return node;
}

function healthBar() {
  const fill = el('i');
  const text = el('span.battle-hp');
  const root = el('div.battle-track', {}, [fill, text]);

  return {
    root,
    /** @param {import('../engine/pokemon.mjs').Pokemon|null} pokemon */
    set(pokemon) {
      if (!pokemon) {
        fill.style.width = '0%';
        text.textContent = '';
        return;
      }
      const max = maxHp(pokemon);
      const ratio = max > 0 ? Math.max(0, pokemon.hp) / max : 0;
      fill.style.width = `${ratio * 100}%`;
      fill.style.background = ratio > 0.5 ? '#63bb5b' : ratio > 0.2 ? '#f3d23b' : '#d8443c';
      text.textContent = `${Math.max(0, Math.round(pokemon.hp))}/${max}`;
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
