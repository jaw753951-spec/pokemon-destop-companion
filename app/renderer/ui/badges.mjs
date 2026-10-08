/**
 * Badges, as small medals: the gym badges a Pokémon has won, and the crown it
 * wears once it has beaten the League's champion.
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
 * One gym badge: the medal the games award, in the colour of the type that
 * awarded it.
 *
 * The badge sheet holds the eight Hoenn medals, and the game generates leaders
 * for every region — so a type with no medal of its own borrows one, which is
 * honest enough when the badge is named for the type rather than for a gym.
 *
 * @param {string} type
 */
export function badgeIcon(type) {
  const record = gameData().types[type];
  const art = url('assets', `badges/${badgeArt(type)}.png`);

  return el('span.badge-art', {
    role: 'img',
    title: `${localized(record?.name, type)} ${t('badge.word')}`,
    style: { '--badge-art': `url("${art}")`, '--badge-color': `var(--type-${type}, var(--ink-soft))` },
  });
}

/** The champion's badge: a gold crown, for a Pokémon that has beaten the League. */
export function championIcon() {
  return el('span.badge-art.champion-badge', { role: 'img', title: t('dex.championBadge') });
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
