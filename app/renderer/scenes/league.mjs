/**
 * The Pokémon League.
 *
 * Opens once eight badges are in hand. Which region's Elite Four and Champion
 * you face is rolled each time you walk in — the four and their champion are
 * one line-up and travel together, so a challenge is always somebody's real
 * league rather than a pick-and-mix. Between rounds the companion is fully
 * restored and you choose whether to go straight on or step back out to the
 * field and prepare.
 */
import { VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { url } from '../core/bridge.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { button, el, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { createPokemon, levelOf } from '../engine/pokemon.mjs';
import { evolveToLevel, giveTrainerItems } from '../engine/encounter.mjs';
import { backdropForLeagueRound, drawBackdrop, loadRoom } from '../render/backdrop.mjs';
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
  /** The room this round is challenged in, drawn behind the challenge screen. */
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
      refreshRoom();

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
      // The room itself, dimmed enough for the portrait and the buttons in
      // front of it to stay legible.
      inFieldSpace(context, (field) => drawBackdrop(field, room));
      context.fillStyle = 'rgba(8, 10, 20, 0.5)';
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    },
  };

  /** @param {import('../core/app.mjs').App} app */
  function render(app) {
    const round = rounds[index];
    const last = index === rounds.length - 1;

    heading.textContent = `${localized(league.name, league.region)} ${t(last ? 'league.champion' : 'league.eliteFour')}`;
    caption.textContent = localized(round.name, round.id);

    const art = portraitFor(round);
    portrait.hidden = !art;
    if (art) portrait.src = url('assets', `trainers/portraits/${art}.png`);

    setChildren(actions, [
      button(t('league.next'), () => startRound(app), { className: 'primary', disabled: busy }),
      button(t('league.prepare'), () => {
        app.audio.blip('cancel');
        onLeave();
      }, { disabled: busy }),
    ]);
  }

  /** The room the round about to be fought is challenged in. */
  function refreshRoom() {
    const id = backdropForLeagueRound(index, rounds.length);
    if (id === loadedRoom) return;
    loadedRoom = id;
    loadRoom(id).then((image) => {
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
            // sent back to the field on its last hit point, and to the rest
            // stop the field will now put in its way.
            session.blackOut();
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
          refreshRoom();
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
 * The picture to put a name to.
 *
 * Hoenn's league was drawn by the game this art all comes from, and Kanto's
 * and Johto's people were drawn by two others the pipeline also reads. Nobody
 * from Sinnoh onwards was ever drawn on a Game Boy Advance, and there is no
 * honest way to invent a likeness — so they are shown as a trainer of their
 * speciality instead, which is what the games themselves do with everyone who
 * is not a name. The choice is fixed by the person's own id, so the same
 * champion is met by the same stand-in every time.
 *
 * @param {any} trainer
 * @returns {string|null}
 */
function portraitFor(trainer) {
  const portraits = gameData().actors?.portraits ?? {};
  if (trainer.portrait && portraits[trainer.portrait]) return trainer.portrait;

  const classes = (gameData().trainerClasses ?? []).filter(
    (entry) => entry.portrait && portraits[entry.portrait] && entry.types?.includes(trainer.type),
  );
  if (classes.length === 0) return null;

  return classes[fingerprint(trainer.id ?? '') % classes.length].portrait;
}

/** A small stable number from a string, so a choice made from it never moves. */
function fingerprint(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash;
}

/**
 * The league this challenge faces, rolled from every line-up the game ships.
 *
 * A line-up is a set: the Elite Four a region sends out and the champion
 * waiting behind them are the people of one game, and splitting them would
 * make the ladder a collection of strangers. So one whole league is drawn, and
 * the region is remembered only to say afterwards which one was beaten.
 *
 * A league may also carry `alternates` — people who share one seat, where the
 * games themselves let a roster differ (Alola's fourth seat is Hala's or
 * Molayne's depending on the game). One of them is rolled at the door and
 * walks in with the four, so a challenge still faces four and a champion —
 * and the same challenger meets the same four all the way through, because
 * the roll is made once, here, and not again between rounds.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
export function resolveLeague(session) {
  const leagues = gameData().leagues ?? [];
  if (leagues.length === 0) return generatedLeague(session);

  const chosen = session.rng.pick(leagues);
  if (chosen.alternates?.length) {
    chosen.eliteFour = [...chosen.eliteFour, session.rng.pick(chosen.alternates)];
    delete chosen.alternates;
  }
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
  const party = species.map((id) => createPokemon(session.rng, evolveToLevel(id, level), level, { ivFloor: 24 }));
  // The Elite Four and the champion save the berry for the Pokémon they lead
  // with last, as every one of them does in Emerald.
  return giveTrainerItems(session.rng, party, 'champion');
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
