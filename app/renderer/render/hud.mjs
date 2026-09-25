/**
 * The persistent overlay on the travelling view: who you are travelling with,
 * where you are, and the buttons into the menus.
 */
import { url } from '../core/bridge.mjs';
import { artPath, speciesOf } from '../core/data.mjs';
import { button, el, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { experienceProgress, levelOf, maxHp } from '../engine/pokemon.mjs';

/**
 * @param {{
 *   onInventory: () => void,
 *   onPokedex: () => void,
 *   onSettings: () => void,
 *   onLeague: () => void,
 *   onTraySelect: (index: number) => void,
 * }} handlers
 */
export function createHud(handlers) {
  const areaLabel = el('span', { style: { fontSize: '10px', color: 'var(--ink)', fontWeight: '700' } });
  const nameLabel = el('span', { style: { fontSize: '11px', fontWeight: '700' } });
  const levelLabel = el('span', { style: { fontSize: '10px', color: 'var(--ink-soft)' } });
  const hpFill = el('i', { style: barFill('#63bb5b') });
  const expFill = el('i', { style: barFill('#4d90d5') });
  const hpText = el('span', { style: { fontSize: '9px', color: 'var(--ink-soft)' } });

  const leagueButton = button(t('field.toLeague'), handlers.onLeague, { className: 'small primary' });
  leagueButton.hidden = true;
  leagueButton.style.position = 'absolute';
  leagueButton.style.left = '32%';
  leagueButton.style.top = '70%';
  leagueButton.style.transform = 'translateX(-50%)';

  /**
   * The caption over the tray.
   *
   * Without it the tray is a column of unlabelled icons in a corner, and a
   * player who has just knocked something down has no way of knowing that the
   * offer to catch it is sitting there. It is hidden while the tray is empty.
   */
  const trayLabel = el('div.hud-window', {
    style: { padding: '1px 5px', fontSize: '9px', fontWeight: '700', color: 'var(--ink)' },
    text: t('tray.title'),
  });

  const tray = el('div', {
    style: {
      position: 'absolute',
      top: '20px',
      right: '6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      alignItems: 'flex-end',
    },
  });

  const status = el('div.panel.hud-window', {
    style: {
      position: 'absolute',
      left: '6px',
      top: '20px',
      width: '150px',
      padding: '4px 6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    },
  }, [
    el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '4px' } }, [nameLabel, levelLabel]),
    el('div', { style: barTrack() }, [hpFill]),
    el('div', { style: { display: 'flex', justifyContent: 'space-between' } }, [
      el('span', { text: t('pokemon.hp'), style: { fontSize: '9px', color: 'var(--ink-soft)' } }),
      hpText,
    ]),
    el('div', { style: { ...barTrack(), height: '3px' } }, [expFill]),
  ]);

  const buttons = el('div', {
    style: { position: 'absolute', left: '6px', bottom: '6px', display: 'flex', gap: '4px' },
  }, [
    button(t('field.inventory'), handlers.onInventory, { className: 'small' }),
    button(t('field.pokedex'), handlers.onPokedex, { className: 'small' }),
    button(t('field.settings'), handlers.onSettings, { className: 'small' }),
  ]);

  const areaBadge = el('div.hud-window', {
    style: {
      position: 'absolute',
      right: '6px',
      bottom: '6px',
      padding: '2px 8px',
    },
  }, [areaLabel]);

  const root = el('div.screen', { style: { pointerEvents: 'none' } }, [status, tray, buttons, areaBadge, leagueButton]);
  for (const node of [status, tray, buttons, areaBadge, leagueButton]) node.style.pointerEvents = 'auto';

  /** What the tray was last built from, so it is only rebuilt when it changes. */
  let trayKey = '';

  return {
    root,
    tray,

    /** @param {import('../engine/session.mjs').Session} session */
    update(session) {
      // Rebuilt from the session rather than on notification, so a Pokémon
      // reaching the tray by any route shows up without a separate call.
      const key = session.tray.map((pokemon) => `${pokemon.speciesId}:${pokemon.caughtAt}`).join(',');
      if (key !== trayKey) {
        trayKey = key;
        this.updateTray(session.tray, handlers.onTraySelect);
      }

      const pokemon = session.active;
      const species = speciesOf(pokemon.speciesId);
      const max = maxHp(pokemon);
      const progress = experienceProgress(pokemon);

      nameLabel.textContent = pokemon.nickname || localized(species.name, species.slug);
      levelLabel.textContent = t('slot.level', { level: levelOf(pokemon) });
      hpText.textContent = `${Math.max(0, Math.round(pokemon.hp))}/${max}`;

      const ratio = max > 0 ? Math.max(0, pokemon.hp) / max : 0;
      hpFill.style.width = `${ratio * 100}%`;
      hpFill.style.background = ratio > 0.5 ? '#63bb5b' : ratio > 0.2 ? '#f3d23b' : '#d8443c';
      expFill.style.width = `${progress.ratio * 100}%`;

      areaLabel.textContent = localized(session.area?.name, session.area?.id ?? '');
      leagueButton.hidden = !(session.badges.length >= 8 && !session.champion);
    },

    /**
     * The tray of defeated Pokémon waiting to be caught or let go.
     * @param {Array<import('../engine/pokemon.mjs').Pokemon>} entries
     * @param {(index: number) => void} onSelect
     */
    updateTray(entries, onSelect) {
      setChildren(tray, [
        entries.length ? trayLabel : null,
        ...entries.map((pokemon, index) =>
          el('button.hud-window', {
            type: 'button',
            title: localized(speciesOf(pokemon.speciesId)?.name, ''),
            style: {
              '-webkit-app-region': 'no-drag',
              width: '30px',
              height: '30px',
              padding: '0',
              cursor: 'pointer',
            },
            onClick: () => onSelect(index),
          }, [
            el('img', {
              src: url('assets', artPath(pokemon) ?? ''),
              alt: '',
              style: { width: '28px', height: '28px', objectFit: 'contain' },
            }),
          ]),
        ),
      ]);
    },
  };
}

const barTrack = () => ({
  position: 'relative',
  height: '5px',
  borderRadius: '3px',
  background: 'rgba(56, 74, 99, 0.3)',
  overflow: 'hidden',
});

/** @param {string} color */
const barFill = (color) => ({
  display: 'block',
  height: '100%',
  width: '0%',
  background: color,
  transition: 'width 220ms ease-out',
});
