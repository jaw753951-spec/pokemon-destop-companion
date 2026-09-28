/**
 * Money, and the shop it is spent in.
 *
 * The companion earns its money the way a trainer does in the games: beating
 * a trainer pays a prize of so much per level of their last Pokémon, and
 * losing to one pays the winner. Wild Pokémon neither pay nor charge.
 *
 * PokeAPI's item records carry no prices any more, so the prices here are the
 * main series' own where the games sell the thing — Scarlet and Violet's,
 * mostly — and set by the same scale where they never did: a held item at
 * the price of the battle items it stands beside, a TM at the price of a
 * stone. The legendaries' own items are not for sale; a find is the only way
 * to them, and the Master Ball stays a prize.
 */
import { gameData, itemOf } from '../core/data.mjs';
import { signatureItems } from './forms.mjs';
import { levelOf } from './pokemon.mjs';

/** What a new journey starts with, as the games start it. */
export const STARTING_MONEY = 3000;

/** The most the purse holds, as the games cap it. */
export const MONEY_CAP = 9_999_999;

/**
 * Prize money per level of a trainer's last Pokémon: an ordinary trainer's,
 * a gym leader's, and the League's. The games give each class its own base —
 * a Youngster 16, a Gentleman 200 — which averages out about here for the
 * classes the road sends.
 */
export const PRIZE_PER_LEVEL = { trainer: 40, leader: 100, league: 200 };

/**
 * What losing to a trainer costs, per level of the companion, by how many
 * badges it holds — Diamond and Pearl's table, which every game since keeps.
 */
const LOSS_PER_LEVEL = [8, 16, 24, 36, 48, 64, 80, 100, 120];

/** Prices the games set, by item. */
const PRICES = {
  potion: 200, 'super-potion': 700, 'hyper-potion': 1500, 'max-potion': 2500, 'full-restore': 3000,
  'fresh-water': 200, 'soda-pop': 300, lemonade: 400, 'moomoo-milk': 600, 'berry-juice': 100, 'sweet-heart': 300,
  'energy-powder': 500, 'energy-root': 1200,
  antidote: 200, 'burn-heal': 300, 'ice-heal': 300, awakening: 300, 'paralyze-heal': 300, 'full-heal': 400,
  'heal-powder': 300,
  revive: 2000, 'max-revive': 4000, 'revival-herb': 2800, 'sacred-ash': 50000, 'max-honey': 8000,
  ether: 1200, 'max-ether': 2000, elixir: 3000, 'max-elixir': 4500,
  'hp-up': 10000, protein: 10000, iron: 10000, calcium: 10000, zinc: 10000, carbos: 10000,
  'rare-candy': 20000, 'pp-up': 10000, 'pp-max': 30000, 'ability-capsule': 50000, 'ability-patch': 100000,
  'poke-ball': 200, 'great-ball': 600, 'ultra-ball': 800, 'premier-ball': 200,
  'safari-ball': 1000, 'sport-ball': 1000,
  'net-ball': 1000, 'dive-ball': 1000, 'nest-ball': 1000, 'repeat-ball': 1000, 'timer-ball': 1000,
  'luxury-ball': 3000, 'dusk-ball': 1000, 'heal-ball': 300, 'quick-ball': 1000,
  'dream-ball': 3000, 'beast-ball': 3000,
  'lure-ball': 3000, 'level-ball': 3000, 'moon-ball': 3000, 'heavy-ball': 3000, 'fast-ball': 3000,
  'friend-ball': 3000, 'love-ball': 3000,
  'choice-band': 20000, 'choice-specs': 20000, 'choice-scarf': 20000, 'life-orb': 20000,
  leftovers: 20000, 'focus-sash': 10000, 'assault-vest': 20000, eviolite: 20000, 'rocky-helmet': 20000,
  'lucky-egg': 30000, 'exp-share': 30000, 'soothe-bell': 10000, everstone: 3000,
};

/** And by kind, for what the games price only through its kind or not at all. */
const CATEGORY_PRICES = {
  healing: 500, 'status-cures': 300, revival: 2000, 'pp-recovery': 2000, vitamins: 10000, 'nature-mints': 20000,
  'standard-balls': 1000, 'special-balls': 1000, 'apricorn-balls': 3000,
  medicine: 500, 'picky-healing': 800, 'in-a-pinch': 3000, 'type-protection': 1000, 'effort-drop': 1500,
  'catching-bonus': 1500, other: 3000,
  'all-machines': 3000, evolution: 3000, jewels: 1500, 'held-items': 8000, choice: 20000,
  'type-enhancement': 5000, 'effort-training': 6000, 'bad-held-items': 5000, training: 10000,
  'species-specific': 5000,
};

/**
 * The kinds of item nobody sells: a legendary's key to its shape, a story's
 * key item, a thing kept for show.
 */
const NOT_SOLD_CATEGORIES = new Set([
  'plot-advancement', 'gameplay', 'unused', 'event-items', 'dex-completion', 'species-candies',
  'tm-materials', 'picnic', 'loot', 'collectibles', 'memories', 'plates',
]);

/** The one ball a shop never has. */
const NOT_SOLD = new Set(['master-ball']);

/** Built once: the items a legendary's shape is keyed to. */
let unique = /** @type {Set<string>|null} */ (null);

/**
 * What an item costs in the shop, or null when it is not for sale.
 *
 * @param {string} slug
 * @returns {number|null}
 */
export function priceOf(slug) {
  const item = itemOf(slug);
  if (!item || item.works === false || NOT_SOLD.has(slug) || NOT_SOLD_CATEGORIES.has(item.category)) return null;
  unique ??= new Set(signatureItems().keys());
  if (unique.has(slug)) return null;
  return PRICES[/** @type {keyof typeof PRICES} */ (slug)] ?? CATEGORY_PRICES[/** @type {keyof typeof CATEGORY_PRICES} */ (item.category)] ?? null;
}

/**
 * Whether an item is used up — a potion drunk, a berry eaten, a stone spent
 * on an evolution, a Focus Sash torn — or kept for good once had: a
 * Leftovers, a Choice Band, a TM's move. What is kept is only ever had once:
 * a second one from a find or a shop would be a thing with nothing to do.
 *
 * @param {string} slug
 */
export function isConsumable(slug) {
  const item = itemOf(slug);
  if (!item) return true;
  if (item.pocket === 'medicine' || item.pocket === 'berries' || item.pocket === 'pokeballs') return true;
  if (item.pocket === 'machines') return false;
  if (['evolution', 'jewels', 'species-candies', 'tm-materials', 'loot', 'dex-completion', 'picnic', 'collectibles'].includes(item.category)) return true;
  return Boolean(item.held?.consumed || item.use?.consumed);
}

/**
 * Whether the player already has one of a kept item, in the bag or in a
 * Pokémon's hand — the travelling one's or one in the box.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 */
export function alreadyOwned(session, slug) {
  if (isConsumable(slug)) return false;
  if (session.countOf(slug) > 0) return true;
  if (itemOf(slug)?.pocket === 'machines' && session.machines.includes(itemOf(slug)?.move ?? '')) return true;
  return [session.active, ...session.box].some((pokemon) => pokemon?.heldItem === slug);
}

/**
 * Everything the shop has, pocket by pocket, cheapest first.
 *
 * @returns {Array<{slug: string, item: any, price: number}>}
 */
export function shopStock() {
  return Object.entries(gameData().items)
    .map(([slug, item]) => ({ slug, item, price: priceOf(slug) }))
    .filter((entry) => entry.price !== null)
    .map((entry) => /** @type {{slug: string, item: any, price: number}} */ (entry))
    .sort((a, b) => a.price - b.price || a.slug.localeCompare(b.slug));
}

/**
 * Buy some of an item, if the purse covers it and, for a kept item, the
 * player has none yet.
 *
 * @param {import('./session.mjs').Session} session
 * @param {string} slug
 * @param {number} [count]
 * @returns {'bought'|'poor'|'owned'|'unsold'}
 */
export function buy(session, slug, count = 1) {
  const price = priceOf(slug);
  if (price === null) return 'unsold';
  if (alreadyOwned(session, slug)) return 'owned';
  const quantity = isConsumable(slug) ? Math.max(1, Math.floor(count)) : 1;
  if (session.money < price * quantity) return 'poor';
  session.money -= price * quantity;
  session.addItem(slug, quantity);
  return 'bought';
}

/**
 * A trainer's prize: so much per level of the last Pokémon they sent out.
 *
 * @param {import('./pokemon.mjs').Pokemon[]} foes
 * @param {'trainer'|'leader'|'league'} rank
 */
export function prizeFor(foes, rank) {
  const last = foes[foes.length - 1];
  if (!last) return 0;
  return PRIZE_PER_LEVEL[rank] * levelOf(last);
}

/**
 * What losing to a trainer costs: so much per level of the companion, more
 * with every badge, and never more than is in the purse.
 *
 * @param {import('./session.mjs').Session} session
 */
export function lossFor(session) {
  const rate = LOSS_PER_LEVEL[Math.min(LOSS_PER_LEVEL.length - 1, session.badges.length)];
  return Math.min(session.money, rate * levelOf(session.active));
}

/**
 * Money as the games print it: grouped by thousands.
 * @param {number} amount
 */
export function formatMoney(amount) {
  return Math.round(amount).toLocaleString('en-US');
}

/**
 * Add to the purse, or take from it, within its bounds.
 *
 * @param {import('./session.mjs').Session} session
 * @param {number} amount
 */
export function earn(session, amount) {
  session.money = Math.max(0, Math.min(MONEY_CAP, session.money + Math.round(amount)));
}
