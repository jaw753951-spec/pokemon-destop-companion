/**
 * The Pokémon League.
 *
 * Opens once eight badges are in hand. Which region's Elite Four and Champion
 * you face is decided on entry and then fixed for the run, and between rounds
 * the companion is fully restored and you choose whether to go straight on or
 * step back out to the field and prepare.
 */
import { VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { url } from '../core/bridge.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { button, el, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { createPokemon, levelOf } from '../engine/pokemon.mjs';
import { evolveToLevel } from '../engine/encounter.mjs';
import { backdropForLeagueRound, drawBackdrop, loadBackdrop } from '../render/backdrop.mjs';
import { inFieldSpace } from '../render/field.mjs';
import { battleScene } from './battle.mjs';

/** How far above the challenger each round is pitched. */
const LEVEL_STEP = [2, 4, 6, 8, 12];

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   onLeave: () => void,
 *   onCrowned: () => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function leagueScene({ session, onLeave, onCrowned }) {
  const league = resolveLeague(session);
  const rounds = [...league.eliteFour, league.champion];

  let index = 0;
  let busy = false;
  /** The chamber this round is fought in, drawn behind the challenge screen. */
  let room = /** @type {HTMLImageElement|null} */ (null);
  let loadedRoom = '';

  const heading = el('div.league-heading');
  const portrait = /** @type {HTMLImageElement} */ (el('img.league-portrait', { alt: '' }));
  const caption = el('div.league-caption');
  const actions = el('div.league-actions');

  return {
    keepBelow: true,

    mount(app) {
      app.audio.playMusic(gameData().bgm.cues.league ?? null);
      render(app);
      loadRoom();

      return el('div.screen.league-screen', {}, [
        heading,
        portrait,
        caption,
        actions,
      ]);
    },

    render(context) {
      if (!room) {
        context.fillStyle = 'rgba(8, 10, 20, 0.88)';
        context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
        return;
      }
      // The chamber itself, dimmed enough for the portrait and the buttons in
      // front of it to stay legible.
      inFieldSpace(context, (field) => drawBackdrop(field, room));
      context.fillStyle = 'rgba(8, 10, 20, 0.55)';
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    },
  };

  /** @param {import('../core/app.mjs').App} app */
  function render(app) {
    const round = rounds[index];
    const last = index === rounds.length - 1;

    heading.textContent = `${localized(league.name, league.region)} ${t(last ? 'league.champion' : 'league.eliteFour')}`;
    caption.textContent = localized(round.name, round.id);

    const art = round.portrait ? `trainers/portraits/${round.portrait}.png` : null;
    portrait.hidden = !art;
    if (art) portrait.src = url('assets', art);

    setChildren(actions, [
      button(t('league.next'), () => startRound(app), { className: 'primary', disabled: busy }),
      button(t('league.prepare'), () => {
        app.audio.blip('cancel');
        onLeave();
      }, { disabled: busy }),
    ]);
  }

  /** The chamber for the round about to be fought. */
  function loadRoom() {
    const id = backdropForLeagueRound(index, rounds.length);
    if (id === loadedRoom) return;
    loadedRoom = id;
    loadBackdrop(id).then((image) => {
      if (loadedRoom === id) room = image;
    });
  }

  /** @param {import('../core/app.mjs').App} app */
  function startRound(app) {
    if (busy) return;
    busy = true;

    const round = rounds[index];
    const last = index === rounds.length - 1;

    app.push(
      battleScene({
        session,
        foes: buildParty(session, round, LEVEL_STEP[Math.min(index, LEVEL_STEP.length - 1)]),
        trainer: round,
        backdrop: backdropForLeagueRound(index, rounds.length),
        music: gameData().bgm.cues[last ? 'battleChampion' : 'battleEliteFour'],
        onFinish: (result) => {
          app.pop();
          busy = false;

          if (result.outcome === 'lost') {
            // A loss ends the challenge rather than the run: the companion is
            // patched up and sent back to the field to try again.
            session.heal();
            app.toast(t('battle.lost'));
            onLeave();
            return;
          }

          // Every round is followed by a full restore, as the games' league does.
          session.heal();

          if (last) {
            crown(app);
            return;
          }

          index++;
          app.toast(t('league.healed'));
          render(app);
          loadRoom();
        },
      }),
    );
  }

  /** @param {import('../core/app.mjs').App} app */
  function crown(app) {
    session.champion = true;
    session.champions.add(session.active.speciesId);
    session.leagueRegion = league.region;

    const name = session.active.nickname || localized(speciesOf(session.active.speciesId)?.name, '');
    app.audio.playMusic(gameData().bgm.cues.victoryLeague ?? null);
    app.toast(`${t('league.crowned', { name })}\n${t('league.wentHome')}`, 5000);
    onCrowned();
  }
}

/**
 * The league this run faces, chosen once and then remembered in the save.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
export function resolveLeague(session) {
  const leagues = gameData().leagues ?? [];
  if (leagues.length === 0) return generatedLeague(session);

  const remembered = leagues.find((league) => league.region === session.leagueRegion);
  const chosen = remembered ?? session.rng.pick(leagues);
  session.leagueRegion = chosen.region;
  return chosen;
}

/**
 * A stand-in league for a checkout with no authored rosters: four type
 * specialists and a champion with a mixed team, so the ending is reachable
 * even before the real line-ups are filled in.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function generatedLeague(session) {
  const types = session.rng.shuffle(Object.keys(gameData().types)).slice(0, 4);
  return {
    region: 'unknown',
    name: { ko: t('league.enter'), en: t('league.enter') },
    eliteFour: types.map((type) => ({
      id: `elite-${type}`,
      name: gameData().types[type]?.name ?? { ko: type, en: type },
      type,
      portrait: null,
      party: [],
    })),
    champion: {
      id: 'champion',
      name: { ko: t('league.champion'), en: t('league.champion') },
      type: null,
      portrait: null,
      party: [],
    },
  };
}

/**
 * A league trainer's team: their named roster where one is on file, and
 * otherwise the strongest members of their speciality, always levelled
 * relative to the challenger so the ladder stays a ladder.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} trainer
 * @param {number} levelBonus
 */
export function buildParty(session, trainer, levelBonus) {
  const level = Math.min(100, levelOf(session.active) + levelBonus);
  const roster = (trainer.party ?? []).filter((id) => speciesOf(id));

  const species = roster.length ? roster : strongestOfType(session, trainer.type, 3);
  return species.map((id) => createPokemon(session.rng, evolveToLevel(id, level), level, { ivFloor: 24 }));
}

/**
 * @param {import('../engine/session.mjs').Session} session
 * @param {string|null} type
 * @param {number} count
 * @returns {number[]}
 */
function strongestOfType(session, type, count) {
  const candidates = Object.values(gameData().species)
    .filter((entry) => !entry.isMythical && (!type || entry.types.includes(type)))
    .sort((a, b) => total(b) - total(a))
    .slice(0, 20)
    .map((entry) => entry.id);

  return session.rng.shuffle(candidates).slice(0, count);
}

const total = (species) => Object.values(species.stats).reduce((sum, value) => sum + Number(value), 0);
