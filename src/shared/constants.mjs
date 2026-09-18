/**
 * Values shared by the main and renderer processes.
 *
 * The renderer always draws at this fixed logical size and the window scales
 * it, so a pixel is always a pixel no matter how large the companion is.
 */
export const VIEW_WIDTH = 480;
export const VIEW_HEIGHT = 270;

/**
 * The scrolling area background fills the window, as the map does in the
 * handheld games; the HUD sits over it rather than beside it.
 */
export const BACKGROUND_HEIGHT = VIEW_HEIGHT;

/** How often the game writes to the active save slot. */
export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

/** How often the field rolls for a random event. */
export const EVENT_INTERVAL_MS = 60 * 1000;

/** An area is swapped for another one after a random gap in this range. */
export const AREA_ROTATION_MS = [7 * 60 * 1000, 10 * 60 * 1000];

/** The five daylight bands, and the hour each one starts at. */
export const TIME_BANDS = [
  { key: 'night', from: 0 },
  { key: 'dawn', from: 5 },
  { key: 'day', from: 10 },
  { key: 'afternoon', from: 14 },
  { key: 'dusk', from: 18 },
  { key: 'night', from: 21 },
];

/**
 * Which time-of-day background to show for a given local hour.
 * @param {Date} [now]
 * @returns {'dawn'|'day'|'afternoon'|'dusk'|'night'}
 */
export function timeOfDay(now = new Date()) {
  const hour = now.getHours();
  let key = 'night';
  for (const band of TIME_BANDS) {
    if (hour >= band.from) key = band.key;
  }
  return /** @type {any} */ (key);
}

/** The starters the game opens with, in Pokédex order. */
export const STARTERS = [1, 4, 7];

/** Maximum Pokémon held in the post-battle "keep or catch" tray. */
export const TRAY_LIMIT = 5;

/** Chances to catch a Pokémon once the capture screen opens. */
export const CAPTURE_ATTEMPTS = 3;

/** Badges needed before the Pokémon League opens. */
export const BADGES_FOR_LEAGUE = 8;

/** Trainer wins that summon a gym leader even without the random roll. */
export const TRAINER_WINS_FOR_LEADER = 50;

/** Chance a trainer encounter is a gym leader instead. */
export const LEADER_ENCOUNTER_CHANCE = 0.05;
