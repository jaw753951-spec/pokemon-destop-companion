/**
 * The Pokémon tab: who you are travelling with, and what they can do.
 *
 * Left is the sprite as it appears on the field, with the stat hexagon the
 * main series uses; right is the level, typing and the four move slots. A slot
 * opens the list of moves this Pokémon could hold instead — its level-up moves
 * so far, plus anything a TM has unlocked.
 */
import { MOVE_FLAG_SET } from '../../shared/move-flags.mjs';
import { url } from '../core/bridge.mjs';
import { abilityOf, artOf, gameData, moveOf, speciesOf } from '../core/data.mjs';
import { button, el, scrollable, shinyMark } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { abilityWorks } from '../engine/abilities.mjs';
import { availableMoves, experienceProgress, levelOf, maxHp, maxPp, setMove, statsOf } from '../engine/pokemon.mjs';
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
  const portrait = artOf(pokemon, 'front');

  return el('div.tab-body.pokemon-tab', {}, [
    el('div.pokemon-left', {}, [
      // The sprite is stored as a strip of frames; a window the width of one
      // frame, scrolled by CSS, shows the animation the field draws.
      portrait ? animatedPortrait(portrait, localized(species?.name, '')) : null,
      statHexagon({ base: baselineStats(species, level), actual: stats }),
      statTable(stats, pokemon.evs),
    ]),

    scrollable(
      el('div.pokemon-right', {}, [
        el('div.pokemon-heading', {}, [
          el('span.pokemon-nickname', { text: pokemon.nickname || localized(species?.name, '') }),
          shinyMark(pokemon, t('pokemon.shiny')),
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
        abilityLine(pokemon),
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
 * @param {{path: string, meta: {width: number, height: number, frames: number, delay: number}}} art
 * @param {string} label
 */
function animatedPortrait(art, label) {
  const meta = art.meta;
  const node = el('div.pokemon-portrait', {
    role: 'img',
    'aria-label': label,
    style: {
      width: `${meta.width}px`,
      height: `${meta.height}px`,
      backgroundImage: `url("${url('assets', art.path)}")`,
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
      el('span.move-pp', { text: `PP ${entry.pp}/${maxPp(entry)}` }),
    ]),
    moveClasses(move),
  ]);
}

/**
 * How a move is classified, as a row of chips: contact, punch, sound, powder
 * and the rest.
 *
 * These are what half the abilities and a good number of the held items key
 * off — a Static only answers a move that touched it, a pair of Safety
 * Goggles only stops powder — so a player choosing between two moves of the
 * same type and power is often choosing between these.
 *
 * @param {any} move
 */
function moveClasses(move) {
  const flags = (move.flags ?? []).filter((flag) => MOVE_FLAG_SET.has(flag));
  if (flags.length === 0) return null;
  return el('span.move-flags', {}, flags.map((flag) => el('span.move-flag', { text: t(`moveFlag.${flag}`) })));
}

/**
 * The ability, and what it does.
 *
 * An ability the engine has not been taught yet says so, in the same words the
 * bag uses for an item it cannot act on — a player should not have to fight a
 * battle to find out that nothing was going to happen.
 *
 * @param {import('../engine/pokemon.mjs').Pokemon} pokemon
 */
function abilityLine(pokemon) {
  const ability = abilityOf(pokemon.ability);
  const hidden = (speciesOf(pokemon.speciesId)?.abilities ?? []).some(
    (entry) => entry.name === pokemon.ability && entry.hidden,
  );

  return el('div.pokemon-line.pokemon-ability', {}, [
    el('span.label', { text: t('pokemon.ability') }),
    el('span.ability-body', {}, [
      el('span.ability-name', {}, [
        el('span', { text: localized(ability?.name, pokemon.ability) }),
        hidden ? el('span.ability-hidden', { text: t('pokemon.hiddenAbility') }) : null,
      ]),
      el('span.ability-text', {
        text: abilityWorks(pokemon.ability)
          ? localized(ability?.text, ability?.effect ?? '')
          : t('items.noEffectYet'),
      }),
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
