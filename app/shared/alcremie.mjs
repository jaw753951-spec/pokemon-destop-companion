/**
 * The looks an Alcremie can have: one of nine creams over one of seven sweets.
 *
 * Which one it is is settled when a Milcery evolves — at random, whichever
 * sweet it held — and it is kept on the Pokémon as `look`, a slug in the form
 * PokeAPI files the pictures under (`ruby-cream-berry-sweet`).
 */

/** The nine creams, in the order the games list them. */
export const CREAMS = [
  'vanilla-cream',
  'ruby-cream',
  'matcha-cream',
  'mint-cream',
  'lemon-cream',
  'salted-cream',
  'ruby-swirl',
  'caramel-swirl',
  'rainbow-swirl',
];

/** The seven sweets that decorate it. */
export const DECORATIONS = [
  'strawberry-sweet',
  'berry-sweet',
  'love-sweet',
  'star-sweet',
  'clover-sweet',
  'flower-sweet',
  'ribbon-sweet',
];

/** Every look there is: 63 of them. */
export const ALCREMIE_LOOKS = CREAMS.flatMap((cream) => DECORATIONS.map((sweet) => `${cream}-${sweet}`));

/**
 * One of them, at random.
 * @param {{pick?: <T>(list: T[]) => T}} [rng] the game's own stream where there is one
 * @returns {string}
 */
export function randomLook(rng) {
  return rng?.pick ? rng.pick(ALCREMIE_LOOKS) : ALCREMIE_LOOKS[Math.floor(Math.random() * ALCREMIE_LOOKS.length)];
}
