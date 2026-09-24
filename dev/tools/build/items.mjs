/**
 * Collect item icons, and sort the items the game can hand out into rarity
 * tiers so the ball-pickup event can draw from a tier that matches the ball.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { fetchBuffer, writeOut } from '../lib/http.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { crop, opaqueBounds } from '../lib/image.mjs';
import { defaultLanguage } from '../../../app/shared/languages.mjs';
import { LANGUAGES } from '../languages.mjs';
import { BALL_TIERS, SPRITES } from '../sources.mjs';
import { signatureItems } from '../../../app/renderer/engine/forms.mjs';

/**
 * The language the tiers and the generated document are judged in: an item with
 * no official name of its own in it is one of the dex's unused oddities, and is
 * kept out of the field pickups.
 */
const BASE = defaultLanguage(LANGUAGES);

/**
 * That language's name for a record, or whatever it falls back to.
 * @param {{name?: Record<string, string>}} record
 * @param {string} fallback
 */
const label = (record, fallback) => record?.name?.[BASE.code] || fallback;

/**
 * Whether a record only carries the name it borrowed from another language.
 * @param {{name?: Record<string, string>}} record
 */
function unnamed(record) {
  const own = record?.name?.[BASE.code];
  if (!own) return true;
  return Boolean(BASE.fallback) && own === record.name[/** @type {string} */ (BASE.fallback)];
}

/**
 * @param {{assetDir: string, dataDir: string, docsDir: string, log: (message: string) => void, pool: <T>(task: () => Promise<T>) => Promise<T>}} context
 */
export async function buildItems({ assetDir, dataDir, docsDir, log, pool }) {
  /** @type {Record<string, any>} */
  const items = JSON.parse(await readFile(join(dataDir, 'items.json'), 'utf8'));
  /** @type {Record<string, string>} */
  const machines = JSON.parse(await readFile(join(dataDir, 'machines.json'), 'utf8'));
  /** @type {Record<string, any>} */
  const moves = JSON.parse(await readFile(join(dataDir, 'moves.json'), 'utf8'));

  let saved = 0;
  const withoutIcon = [];
  await Promise.all(
    Object.keys(items).map((name) =>
      pool(async () => {
        const icon = DRAWN_ICONS[name]?.() ?? (await firstAvailable(iconCandidates(name, items[name], machines, moves)));
        if (icon) {
          await writeOut(join(assetDir, 'items', `${name}.png`), icon);
          items[name].sprite = true;
          saved++;
        } else {
          items[name].sprite = false;
          withoutIcon.push(name);
        }
      }),
    ),
  );

  // A TM is only usable if we know which move it teaches.
  for (const [name, item] of Object.entries(items)) {
    if (item.pocket === 'machines') item.move = machines[name] ?? null;
  }

  const tiers = assignRarityTiers(items, moves);
  await writeOut(join(dataDir, 'items.json'), JSON.stringify(items));
  await writeOut(join(dataDir, 'item-tiers.json'), JSON.stringify(tiers));
  await writeOut(join(docsDir, 'item-rarity.md'), renderTierDocument(items, tiers, moves));

  log(`item icons ${saved}/${Object.keys(items).length} (${withoutIcon.length} without art)`);
  for (const tier of BALL_TIERS) log(`  ${tier.ball.padEnd(12)} ${tiers[tier.ball].length} items @ ${tier.chance}%`);
  return tiers;
}

/**
 * Where an item's icon might live. TMs and HMs share one icon per move type
 * rather than having their own art, which is also how the games draw them.
 *
 * @param {string} name
 * @param {any} item
 * @param {Record<string, string>} machines
 * @param {Record<string, any>} moves
 * @returns {string[]}
 */
function iconCandidates(name, item, machines, moves) {
  // The newest items are only drawn in the generation folders, and a few not
  // at all; those borrow the nearest picture there is.
  const drawn = ICON_STAND_INS[name] ?? name;
  const candidates = [
    `${SPRITES}/items/${drawn}.png`,
    `${SPRITES}/items/gen9/${drawn}.png`,
    `${SPRITES}/items/gen8/${drawn}.png`,
    `${POKESPRITE}/items/key-item/${drawn}.png`,
    `${POKESPRITE}/items/evo-item/${drawn}.png`,
  ];
  if (item.pocket === 'machines') {
    const type = moves[machines[name]]?.type;
    const prefix = name.startsWith('hm') ? 'hm' : 'tm';
    if (type) candidates.push(`${SPRITES}/items/${prefix}-${type}.png`);
    candidates.push(`${SPRITES}/items/${prefix}-normal.png`);
  }
  return candidates;
}

/** The PokéSprite item set, which draws a few key items PokeAPI does not. */
const POKESPRITE = 'https://raw.githubusercontent.com/msikma/pokesprite/master';

/**
 * Items no published set draws, and the one each is shown as: Legends: Arceus's
 * crystal and globe look like the orbs they replaced.
 *
 * @type {Record<string, string>}
 */
const ICON_STAND_INS = {
  // Let's Go's silver and golden catching berries, drawn as the plain berry
  // they are a better kind of.
  'silver-razz-berry': 'razz-berry',
  'golden-razz-berry': 'razz-berry',
  'silver-nanab-berry': 'nanab-berry',
  'golden-nanab-berry': 'nanab-berry',
  'silver-pinap-berry': 'pinap-berry',
  'golden-pinap-berry': 'pinap-berry',
  'adamant-crystal': 'adamant-orb',
  'lustrous-globe': 'lustrous-orb',
  // The evolution items of the newest games, drawn by nobody yet: each shown
  // as the nearest thing that is — an apple as an apple, an alloy as a coat
  // of metal, a cord as silk, armour as armour.
  'syrupy-apple': 'sweet-apple',
  'metal-alloy': 'metal-coat',
  'black-augurite': 'dusk-stone',
  'peat-block': 'soft-sand',
  'leaders-crest': 'razor-claw',
  'linking-cord': 'silk-scarf',
  'scroll-of-darkness': 'dread-plate',
  'auspicious-armor': 'protector',
  'malicious-armor': 'reaper-cloth',
  'meltan-candy': 'rare-candy',
  'gimmighoul-coin': 'amulet-coin',
  'scroll-of-waters': 'splash-plate',
};

/**
 * A Tera Orb, drawn here because no item set has one: a faceted crystal ball,
 * teal at the top and rose at the bottom, fourteen pixels across.
 *
 * @returns {Buffer}
 */
function drawTeraOrb() {
  const size = 14;
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  const top = [104, 214, 222];
  const bottom = [236, 118, 184];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const offset = (y * size + x) * 4;
      if (distance > radius - 1) {
        data.set([40, 44, 70, 255], offset);
        continue;
      }
      // Facets: the sphere cut into six wedges, alternately lit, over a fade
      // from the top colour to the bottom one.
      const mix = y / (size - 1);
      const facet = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 6) % 2 ? 1 : 0.84;
      const shade = [0, 1, 2].map((i) => Math.round((top[i] * (1 - mix) + bottom[i] * mix) * facet));
      data.set([...shade, 255], offset);
    }
  }
  // The glint.
  for (const [x, y] of [[4, 3], [5, 3], [4, 4]]) data.set([255, 255, 255, 255], (y * size + x) * 4);
  return encodePng(size, size, data);
}

/** Icons this step draws itself. @type {Record<string, () => Buffer>} */
const DRAWN_ICONS = { 'tera-orb': drawTeraOrb };

/**
 * The first icon that exists, trimmed to its opaque area.
 *
 * The published icons float inside a 30x30 canvas whose padding is most of the
 * image. In a bag cell that is invisible — the cell is a fixed box and the art
 * is centred in it either way — but in the field, where a gathered item is
 * held up over the companion's head at the map's own scale, the padding makes
 * a berry twice the size of the Pokémon holding it. Trimmed, an item comes out
 * about a tile across, which is what one looks like on the ground.
 *
 * @param {string[]} urls
 * @returns {Promise<Buffer|null>}
 */
async function firstAvailable(urls) {
  for (const url of urls) {
    const buffer = await fetchBuffer(url, { allowMissing: true });
    if (!buffer) continue;

    const png = decodePng(buffer);
    const bounds = opaqueBounds(png);
    if (!bounds) continue;

    const trimmed = crop(png, bounds.x, bounds.y, bounds.width, bounds.height);
    return encodePng(trimmed.width, trimmed.height, trimmed.data);
  }
  return null;
}

/**
 * Split the droppable items into one pool per ball tier.
 *
 * Rarity follows the games' own economy — shop cost first, with held items and
 * TMs weighted up because they are permanent gains here — but the cut points
 * are quantiles rather than fixed prices. Absolute prices cluster badly (most
 * of the dex's items are worth a few hundred, and the truly rare ones are
 * priceless, so they read as free), and quantiles guarantee every tier has
 * something to hand out.
 *
 * @param {Record<string, any>} items
 * @param {Record<string, any>} moves keyed by move name, for scoring TMs
 * @returns {Record<string, string[]>}
 */
export function assignRarityTiers(items, moves = {}) {
  /** @type {Map<string, Array<{name: string, score: number}>>} */
  const byPocket = new Map();

  for (const [name, item] of Object.entries(items)) {
    if (!item.sprite) continue;
    // Sword and Shield's records teach what the TMs already do, and would
    // bury them a hundred deep in the machine pool.
    if (item.pocket === 'machines' && /^tr\d+$/.test(name)) continue;
    if (item.pocket === 'key') continue;
    // A legendary's own item turns up only while it is the one travelling,
    // which the find decides at the time (`fieldevents.mjs`).
    if (SIGNATURE.has(name)) continue;
    if (EXCLUDED_CATEGORIES.has(item.category)) continue;
    if (unnamed(item)) continue;

    let score = item.cost > 0 ? item.cost : UNPRICED_SCORE[item.pocket] ?? 3000;
    // Every TM is priced the same in the data, so rank them by the move they
    // teach instead — otherwise the rarest tiers fill up with TMs in number
    // order and nothing else.
    if (item.pocket === 'machines') score = machineScore(moves[item.move]);
    if (item.attributes.includes('holdable-active')) score = Math.max(score, 4000);

    const list = byPocket.get(item.pocket) ?? [];
    list.push({ name, score });
    byPocket.set(item.pocket, list);
  }

  /** @type {Record<string, string[]>} */
  const tiers = Object.fromEntries(BALL_TIERS.map((tier) => [tier.ball, []]));

  // Quantiles are taken per pocket rather than over the whole pool, so that
  // every tier offers a mix of medicine, berries, held items, balls and TMs
  // instead of one pocket monopolising the rare end.
  for (const list of byPocket.values()) {
    // Ties must not straddle a tier boundary unpredictably, so sort by name too.
    list.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    let start = 0;
    BALL_TIERS.forEach((tier, index) => {
      const end = index === BALL_TIERS.length - 1
        ? list.length
        : Math.round(list.length * TIER_QUANTILES[index]);
      const slice = list.slice(start, Math.max(end, Math.min(start + 1, list.length)));
      tiers[tier.ball].push(...slice.map((entry) => entry.name));
      start = Math.max(end, Math.min(start + 1, list.length));
    });
  }

  for (const list of Object.values(tiers)) list.sort();
  return tiers;
}

/**
 * How valuable a TM is, from the move it teaches: raw power for attacks, and a
 * flat mid-tier value for status moves, which are useful but not jackpots.
 * @param {any} move
 */
function machineScore(move) {
  if (!move) return 2000;
  if (move.damageClass === 'status') return 2600;
  const power = move.power ?? 60;
  const accuracy = (move.accuracy ?? 100) / 100;
  return Math.round(1200 + power * accuracy * 32);
}

/** Pocket labels for the generated document, which is written in Korean. */
const POCKET_LABELS = {
  medicine: '회복',
  berries: '나무열매',
  pokeballs: '볼',
  machines: '기술머신',
  misc: '도구',
};

/** Cumulative share of the item pool below each tier boundary. */
const TIER_QUANTILES = [0.6, 0.85, 0.97];

/** Categories that would be meaningless or game-breaking as a field pickup. */
/** The items that are one species' own. */
const SIGNATURE = signatureItems();

const EXCLUDED_CATEGORIES = new Set([
  'plates',
  'species-specific',
  'all-mail',
  'unused',
  'event-items',
  'gameplay',
  'loot',
  'mega-stones',
  'z-crystals',
  'dynamax-crystals',
]);

/** Items the games never sell still need a rarity; judge them by pocket. */
const UNPRICED_SCORE = {
  medicine: 900,
  berries: 700,
  pokeballs: 900,
  machines: 6000,
  misc: 2500,
};

/**
 * @param {Record<string, any>} items
 * @param {Record<string, string[]>} tiers
 * @param {Record<string, any>} moves
 */
function renderTierDocument(items, tiers, moves = {}) {
  const lines = [
    '# 아이템 희귀도 티어',
    '',
    '필드의 몬스터볼 이벤트에서 어떤 볼이 나오느냐에 따라 뽑히는 아이템 풀이 달라집니다.',
    '이 문서는 `tools/build/items.mjs` 가 자동 생성합니다 — 직접 편집하지 마세요.',
    '',
    '| 볼 | 등장 확률 | 아이템 수 |',
    '| --- | ---: | ---: |',
    ...BALL_TIERS.map((tier) => `| ${label(items[tier.ball], tier.ball)} | ${tier.chance}% | ${tiers[tier.ball].length} |`),
    '',
  ];

  for (const tier of BALL_TIERS) {
    lines.push(`## ${label(items[tier.ball], tier.ball)} (${tier.chance}%)`, '');
    lines.push('| 아이템 | 포켓 | 비고 |');
    lines.push('| --- | --- | --- |');
    for (const name of tiers[tier.ball]) {
      const item = items[name];
      const note = item.pocket === 'machines'
        ? label(moves[item.move], item.move ?? '-')
        : item.cost > 0 ? `${item.cost}원` : '-';
      lines.push(`| ${label(item, name)} | ${POCKET_LABELS[item.pocket] ?? item.pocket} | ${note} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
