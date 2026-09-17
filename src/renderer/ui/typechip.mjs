/**
 * The coloured type label the games put on moves and Pokémon.
 */
import { gameData } from '../core/data.mjs';
import { el } from '../core/dom.mjs';
import { name as localized } from '../core/i18n.mjs';

/**
 * @param {string} type a type slug
 * @param {boolean} [small]
 * @returns {HTMLElement}
 */
export function typeChip(type, small = false) {
  return el(`span.type-chip${small ? '.small' : ''}`, {
    text: localized(gameData().types[type]?.name, type),
    style: { background: `var(--type-${type}, var(--ink-soft))` },
  });
}
