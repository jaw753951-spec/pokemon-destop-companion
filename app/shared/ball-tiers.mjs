/**
 * Which ball the item-pickup event spawns, and how often.
 *
 * The ball the player sees on the ground tells them how good the find is: each
 * tier draws from its own pool, built by `tools/build/items.mjs` and listed in
 * `docs/item-rarity.md`.
 */
export const BALL_TIERS = [
  { ball: 'poke-ball', chance: 70 },
  { ball: 'great-ball', chance: 20 },
  { ball: 'ultra-ball', chance: 9.9 },
  { ball: 'master-ball', chance: 0.1 },
];
