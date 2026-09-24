/**
 * The Treasures tab: the badges won so far, and the champion title.
 *
 * Badges are named for their type rather than for the gym that awarded them,
 * because the game generates leaders for every region and inventing badge
 * names for them would be inventing official ones.
 */
import { url } from '../core/bridge.mjs';
import { gameData } from '../core/data.mjs';
import { el } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';

/**
 * @param {import('../engine/session.mjs').Session} session
 * @returns {HTMLElement}
 */
export function treasuresTab(session) {
  if (session.badges.length === 0 && !session.champion) {
    return el('div.tab-body.empty', { text: t('treasures.empty') });
  }

  return el('div.tab-body.treasures-tab', {}, [
    el('div.section-title', { text: `${t('treasures.badges')} ${session.badges.length}/8` }),
    el('div.badge-grid', {}, session.badges.map((type) => badge(type))),
    session.champion
      ? el('div.champion-mark', { text: t('dex.championBadge') })
      : null,
  ]);
}

/**
 * One badge: the medal the games award, in the colour of the type that awarded
 * it.
 *
 * The badge sheet holds the eight Hoenn medals, and the game generates leaders
 * for every region — so a type with no medal of its own borrows one, which is
 * honest enough when the badge is named for the type rather than for a gym.
 *
 * @param {string} type
 */
function badge(type) {
  const record = gameData().types[type];
  const art = url('assets', `badges/${badgeArt(type)}.png`);

  return el('div.badge', { style: { borderColor: `var(--type-${type}, var(--frame))` } }, [
    el('span.badge-art', {
      style: { '--badge-art': `url("${art}")`, '--badge-color': `var(--type-${type}, var(--ink-soft))` },
    }),
    el('span', { text: localized(record?.name, type) }),
  ]);
}

/** @param {string} type */
function badgeArt(type) {
  const badges = gameData().battle?.badges ?? [];
  if (badges.length === 0) return type;
  if (badges.includes(type)) return type;
  // Deterministic, so a badge never changes shape between two openings of the
  // bag: the type's place in the type chart picks which medal it borrows.
  const chart = Object.entries(gameData().types).filter(([, entry]) => !entry.special).map(([slug]) => slug);
  const index = chart.indexOf(type);
  return badges[(index < 0 ? 0 : index) % badges.length];
}
