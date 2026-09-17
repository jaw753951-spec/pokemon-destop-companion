/**
 * The Treasures tab: the badges won so far, and the champion title.
 *
 * Badges are named for their type rather than for the gym that awarded them,
 * because the game generates leaders for every region and inventing badge
 * names for them would be inventing official ones.
 */
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

/** @param {string} type */
function badge(type) {
  const record = gameData().types[type];
  return el('div.badge', { style: { borderColor: `var(--type-${type}, var(--frame))` } }, [
    el('span.badge-dot', { style: { background: `var(--type-${type}, var(--ink-soft))` } }),
    el('span', { text: localized(record?.name, type) }),
  ]);
}
