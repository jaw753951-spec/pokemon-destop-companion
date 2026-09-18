/**
 * Starter selection.
 *
 * Three Poké Balls on a table; picking one opens it to reveal the Pokémon,
 * which is how the Gen-4 games stage this moment.
 */
import { STARTERS } from '../../shared/constants.mjs';
import { url } from '../core/bridge.mjs';
import { gameData, speciesOf } from '../core/data.mjs';
import { button, el } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { Rng } from '../core/rng.mjs';
import { createPokemon } from '../engine/pokemon.mjs';
import { confirm } from '../ui/dialog.mjs';
import { startRun } from './field.mjs';

/** The level a starter begins at, as in the main series. */
const STARTER_LEVEL = 5;

/**
 * @param {{slot: number}} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function starterScene({ slot }) {
  return {
    mount(app) {
      const caption = el('p', {
        text: t('starter.prompt'),
        style: { fontSize: '11px', textAlign: 'center', color: 'var(--paper)' },
      });

      const balls = el(
        'div',
        { style: { display: 'flex', gap: '26px', justifyContent: 'center', alignItems: 'flex-end' } },
        STARTERS.map((speciesId) => ballButton(app, speciesId, slot, caption)),
      );

      return el(
        'div.screen',
        { style: { background: 'linear-gradient(180deg, #2b3448, #151a26)', justifyContent: 'center', gap: '16px' } },
        [
          caption,
          balls,
          el('div', { style: { display: 'flex', justifyContent: 'center' } }, [
            button(t('common.back'), () => {
              app.audio.blip('cancel');
              app.pop();
            }, { className: 'small ghost' }),
          ]),
        ],
      );
    },
  };
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {number} speciesId
 * @param {number} slot
 * @param {HTMLElement} caption
 */
function ballButton(app, speciesId, slot, caption) {
  const species = speciesOf(speciesId);
  const label = localized(species.name, species.slug);

  const sprite = el('img', {
    src: url('assets', `pokemon/${speciesId}/icon.png`),
    alt: label,
    style: { width: '56px', height: '56px', objectFit: 'contain', opacity: '0', transition: 'opacity 160ms' },
  });

  const ball = el('img', {
    src: url('assets', 'items/poke-ball.png'),
    alt: '',
    style: { width: '28px', height: '28px', objectFit: 'contain' },
  });

  const reveal = () => {
    sprite.style.opacity = '1';
    app.audio.playCry(speciesId);
    caption.textContent = localized(species.name, species.slug);
  };

  return el(
    'button',
    {
      type: 'button',
      style: {
        '-webkit-app-region': 'no-drag',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
        padding: '4px',
        border: '0',
        background: 'transparent',
        cursor: 'pointer',
      },
      onMouseEnter: reveal,
      onFocus: reveal,
      onClick: async () => {
        app.audio.blip('confirm');
        reveal();
        if (!(await confirm(app, t('starter.confirm', { name: label })))) return;
        await begin(app, slot, speciesId);
      },
    },
    [sprite, ball],
  );
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {number} slot
 * @param {number} speciesId
 */
async function begin(app, slot, speciesId) {
  const species = speciesOf(speciesId);
  const rng = new Rng();
  // Starters are a gift, so they get a guaranteed-decent spread rather than
  // the fully random one a wild Pokémon rolls.
  const starter = createPokemon(rng, speciesId, STARTER_LEVEL, { ivFloor: 12, ball: 'poke-ball' });

  app.toast(t('starter.chosen', { name: localized(species.name, species.slug) }));
  app.audio.playCry(speciesId);

  startRun(app, {
    slot,
    save: newSave(rng, starter),
  });
}

/**
 * The shape of a fresh save.
 * @param {Rng} rng
 * @param {import('../engine/pokemon.mjs').Pokemon} starter
 */
function newSave(rng, starter) {
  const areas = gameData().areas;
  return {
    seed: rng.seed,
    createdAt: Date.now(),
    party: { active: starter, box: [] },
    bag: { 'poke-ball': 5, potion: 3 },
    progress: {
      badges: [],
      champion: false,
      trainerWins: 0,
      playtime: 0,
      areaId: areas[0]?.id ?? null,
      machines: [],
    },
    dex: { seen: [starter.speciesId], caught: [starter.speciesId], champions: [] },
    autoBattle: null,
  };
}
