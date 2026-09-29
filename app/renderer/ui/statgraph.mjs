/**
 * The six-stat hexagon the main series draws on a Pokémon's summary page.
 *
 * Two shapes are plotted over each other: the species' base stats, and what
 * this individual actually has once its IVs, effort and nature are counted.
 * The gap between them is the training the companion has done on its own,
 * which is the thing the player is really watching grow.
 */
import { t } from '../core/i18n.mjs';
import { STATS } from '../engine/stats.mjs';

const SIZE = 104;
const CENTRE = SIZE / 2;
const RADIUS = 38;

/** The order the games plot the axes in, starting at the top. */
const AXES = ['hp', 'atk', 'def', 'spe', 'spd', 'spa'];

/**
 * @param {{base: Record<string, number>, actual: Record<string, number>}} values
 *   `base` is the untrained baseline at the same level, so the two shapes are
 *   directly comparable and the gap between them is the training so far
 * @returns {SVGSVGElement}
 */
export function statHexagon({ base, actual }) {
  // One ceiling for both shapes, taken from the larger of the two so the
  // hexagon is filled at any level rather than shrinking to a dot at level 5.
  const ceiling = Math.max(
    10,
    ...AXES.map((stat) => Math.max(actual[stat] ?? 0, base[stat] ?? 0)),
  ) * 1.12;
  const baseMax = ceiling;
  const actualMax = ceiling;

  const svg = element('svg', {
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    width: String(SIZE),
    height: String(SIZE),
    class: 'stat-hex',
  });

  for (const ring of [0.25, 0.5, 0.75, 1]) {
    svg.append(element('polygon', {
      points: hexPoints(AXES.map(() => ring)),
      fill: 'none',
      stroke: 'rgba(56, 74, 99, 0.25)',
      'stroke-width': '1',
    }));
  }
  for (const axis of AXES) {
    const [x, y] = pointAt(AXES.indexOf(axis), 1);
    svg.append(element('line', {
      x1: String(CENTRE), y1: String(CENTRE), x2: String(x), y2: String(y),
      stroke: 'rgba(56, 74, 99, 0.2)', 'stroke-width': '1',
    }));
  }

  svg.append(element('polygon', {
    points: hexPoints(AXES.map((stat) => clamp01((base[stat] ?? 0) / baseMax))),
    fill: 'rgba(125, 151, 189, 0.28)',
    stroke: 'rgba(125, 151, 189, 0.8)',
    'stroke-width': '1',
  }));

  svg.append(element('polygon', {
    points: hexPoints(AXES.map((stat) => clamp01((actual[stat] ?? 0) / actualMax))),
    fill: 'rgba(216, 68, 60, 0.3)',
    stroke: 'var(--accent)',
    'stroke-width': '1.5',
  }));

  return svg;
}

/**
 * The numbers beside the hexagon, as the games' summary page lists them: HP
 * as what is left of the whole, the other five as they stand, and the two a
 * nature moves picked out the way the games have since Sun and Moon — the
 * stat it raises in red, the one it lowers in blue. The effort behind each
 * number is not written out, as the games never write it; the hexagon above
 * is where the training shows.
 *
 * @param {Record<string, number>} actual
 * @param {{hp: number, nature?: {increased?: string|null, decreased?: string|null}|null}} standing
 *   the Pokémon's current HP, and its nature
 * @returns {HTMLElement}
 */
export function statTable(actual, { hp, nature }) {
  const table = document.createElement('div');
  table.className = 'stat-table';
  // A neutral nature raises and lowers the same stat, which is no change.
  const moved = nature?.increased && nature.increased !== nature.decreased;

  for (const stat of STATS) {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const label = document.createElement('span');
    label.className = 'stat-label';
    if (moved && stat === nature?.increased) label.classList.add('raised');
    if (moved && stat === nature?.decreased) label.classList.add('lowered');
    label.textContent = t(`stat.${stat}`);

    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = stat === 'hp' ? `${Math.max(0, Math.round(hp))}/${actual.hp ?? 0}` : String(actual[stat] ?? 0);

    row.append(label, value);
    table.append(row);
  }
  return table;
}

/** @param {number[]} ratios one per axis, 0..1 */
function hexPoints(ratios) {
  return ratios.map((ratio, index) => pointAt(index, ratio).join(',')).join(' ');
}

/**
 * @param {number} index
 * @param {number} ratio
 * @returns {[number, number]}
 */
function pointAt(index, ratio) {
  const angle = (Math.PI * 2 * index) / AXES.length - Math.PI / 2;
  return [
    CENTRE + Math.cos(angle) * RADIUS * ratio,
    CENTRE + Math.sin(angle) * RADIUS * ratio,
  ];
}

const clamp01 = (value) => Math.max(0.04, Math.min(1, value));

/**
 * @param {string} tag
 * @param {Record<string, string>} attributes
 */
function element(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return /** @type {any} */ (node);
}
