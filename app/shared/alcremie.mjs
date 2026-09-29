/**
 * The looks an Alcremie can have.
 *
 * The games have sixty-three — nine creams over seven sweets — but a picture
 * apiece is sixty-three files for a costume change, and the sprites cannot be
 * built from parts: each one is redrawn whole, its shading and outline moving
 * with the decoration (a cut-and-paste test mismatched over a tenth of every
 * picture). So seven are kept, each with a cream and a sweet of its own that no
 * other look shares.
 *
 * Which one it is is settled when a Milcery evolves — at random, whichever
 * sweet it held — and it is kept on the Pokémon as `look`, a slug in the form
 * PokeAPI files the pictures under (`ruby-cream-love-sweet`).
 */

/** Cream and sweet pairs, none repeated: seven creams, seven sweets. */
export const ALCREMIE_LOOKS = [
  'vanilla-cream-strawberry-sweet',
  'ruby-cream-love-sweet',
  'matcha-cream-clover-sweet',
  'mint-cream-berry-sweet',
  'lemon-cream-star-sweet',
  'caramel-swirl-flower-sweet',
  'rainbow-swirl-ribbon-sweet',
];

/**
 * One of them, at random.
 * @param {{pick?: <T>(list: T[]) => T}} [rng] the game's own stream where there is one
 * @returns {string}
 */
export function randomLook(rng) {
  return rng?.pick ? rng.pick(ALCREMIE_LOOKS) : ALCREMIE_LOOKS[Math.floor(Math.random() * ALCREMIE_LOOKS.length)];
}
