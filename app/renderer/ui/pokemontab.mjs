/**
 * The Pokémon tab: who you are travelling with, and what they can do.
 *
 * Left is the sprite as it appears on the field, with the stat hexagon the
 * main series uses; right is the level, typing and the four move slots. A slot
 * opens the list of moves this Pokémon could hold instead — its level-up moves
 * so far, plus anything a TM has unlocked.
 */
import { url } from '../core/bridge.mjs';
import { gameData, moveOf, speciesOf } from '../core/data.mjs';
import { button, el, scrollable } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { availableMoves, experienceProgress, levelOf, maxHp, setMove, statsOf } from '../engine/pokemon.mjs';
import { computeStat, STATS } from '../engine/stats.mjs';
import { autoBattleScene } from './autobattle.mjs';
import { chooseFromList } from './dialog.mjs';
import { statHexagon, statTable } from './statgraph.mjs';
import { typeChip } from './typechip.mjs';

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
export function pokemonTab(app, session, refresh) {
  const pokemon = session.active;
  const species = speciesOf(pokemon.speciesId);
  const stats = statsOf(pokemon);
  const level = levelOf(pokemon);
  const progress = experienceProgress(pokemon);
  const spriteMeta = gameData().sprites[pokemon.speciesId]?.front;

  return el('div.tab-body.pokemon-tab', {}, [
    el('div.pokemon-left', {}, [
      // The sprite is stored as a strip of frames; a window the width of one
      // frame, scrolled by CSS, shows the animation the field draws.
      spriteMeta ? animatedPortrait(pokemon.speciesId, spriteMeta, localized(species?.name, '')) : null,
      statHexagon({ base: baselineStats(species, level), actual: stats }),
      statTable(stats, pokemon.evs),
    ]),

    scrollable(
      el('div.pokemon-right', {}, [
        el('div.pokemon-heading', {}, [
          el('span.pokemon-nickname', { text: pokemon.nickname || localized(species?.name, '') }),
          el('span.pokemon-level', { text: t('slot.level', { level }) }),
        ]),
        el('div.pokemon-types', {}, (species?.types ?? []).map((type) => typeChip(type))),

        el('div.pokemon-line', {}, [
          el('span.label', { text: t('pokemon.hp') }),
          el('span', { text: `${Math.max(0, Math.round(pokemon.hp))}/${maxHp(pokemon)}` }),
        ]),
        el('div.pokemon-line', {}, [
          el('span.label', { text: t('pokemon.exp') }),
          el('span', { text: progress.needed ? `${progress.into}/${progress.needed}` : '—' }),
        ]),
        el('div.pokemon-line', {}, [
          el('span.label', { text: t('pokemon.held') }),
          el('span', {
            text: pokemon.heldItem
              ? localized(gameData().items[pokemon.heldItem]?.name, pokemon.heldItem)
              : '—',
          }),
        ]),

        el('div.section-title', { text: t('pokemon.moves') }),
        el('div.move-grid', {}, [0, 1, 2, 3].map((slot) => moveSlot(app, session, slot, refresh))),

        button(t('pokemon.autoBattle'), () => {
          app.audio.blip('select');
          app.push(autoBattleScene({ session, onClose: () => app.pop() }));
        }, { className: 'small' }),
      ]),
    ),
  ]);
}

/**
 * The stats this species would have at this level with no investment at all.
 *
 * Plotting that under the Pokémon's real stats makes the hexagon show what the
 * companion's own training has added, rather than just the species' shape.
 *
 * @param {any} species
 * @param {number} level
 * @returns {Record<string, number>}
 */
function baselineStats(species, level) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const stat of STATS) {
    out[stat] = computeStat(species?.stats?.[stat] ?? 1, 0, 0, level, 1, stat === 'hp');
  }
  return out;
}

/**
 * A one-frame window onto the sprite strip, animated by stepping the
 * background position — the same frames and timing the field uses.
 *
 * @param {number} speciesId
 * @param {{width: number, height: number, frames: number, delay: number}} meta
 * @param {string} label
 */
function animatedPortrait(speciesId, meta, label) {
  const node = el('div.pokemon-portrait', {
    role: 'img',
    'aria-label': label,
    style: {
      width: `${meta.width}px`,
      height: `${meta.height}px`,
      backgroundImage: `url("${url('assets', `pokemon/${speciesId}/front.png`)}")`,
      backgroundRepeat: 'no-repeat',
    },
  });

  let frame = 0;
  const step = () => {
    node.style.backgroundPosition = `-${frame * meta.width}px 0`;
    frame = (frame + 1) % meta.frames;
  };
  step();

  const timer = window.setInterval(() => {
    // Stop once the tab has been replaced, which is the only way this node
    // leaves the document.
    if (!node.isConnected) {
      window.clearInterval(timer);
      return;
    }
    step();
  }, Math.max(60, meta.delay));

  return node;
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} slot
 * @param {() => void} refresh
 */
function moveSlot(app, session, slot, refresh) {
  const pokemon = session.active;
  const entry = pokemon.moves[slot];
  const move = entry ? moveOf(entry.move) : null;

  if (!move) {
    return el('button.move-slot.empty', {
      type: 'button',
      text: '—',
      onClick: () => openReplace(app, session, slot, refresh),
    });
  }

  return el('button.move-slot', {
    type: 'button',
    onClick: () => openReplace(app, session, slot, refresh),
  }, [
    el('span.move-name', { text: localized(move.name, entry.move) }),
    el('span.move-meta', {}, [
      typeChip(move.type, true),
      el('span.move-pp', { text: `PP ${entry.pp}/${move.pp}` }),
    ]),
  ]);
}

/**
 * @param {import('../core/app.mjs').App} app
 * @param {import('../engine/session.mjs').Session} session
 * @param {number} slot
 * @param {() => void} refresh
 */
async function openReplace(app, session, slot, refresh) {
  const pokemon = session.active;
  const known = new Set(pokemon.moves.map((entry) => entry.move));
  const choices = availableMoves(pokemon, session.machines)
    .filter((move) => !known.has(move) || move === pokemon.moves[slot]?.move)
    .map((move) => {
      const record = moveOf(move);
      const power = record?.power ? `${record.power}` : '—';
      return {
        value: move,
        label: localized(record?.name, move),
        detail: `${localized(gameData().types[record?.type]?.name, record?.type ?? '')}  ·  ${power}  ·  PP ${record?.pp ?? '—'}`,
      };
    });

  const chosen = await chooseFromList(app, t('pokemon.replaceMove'), choices);
  if (!chosen) return;

  setMove(pokemon, slot, chosen);
  refresh();
}
