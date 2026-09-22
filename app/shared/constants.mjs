/**
 * Values shared by the main and renderer processes.
 *
 * The renderer always draws at this fixed logical size and the window scales
 * it, so a pixel is always a pixel no matter how large the companion is.
 */
export const VIEW_WIDTH = 480;
export const VIEW_HEIGHT = 270;

/**
 * The field is drawn at twice the size of everything else.
 *
 * At 1:1 the window showed thirty 16px tiles across — twice the handheld's
 * fifteen — which made the map a busy carpet and every sprite on it a speck.
 * Doubling brings the framing back to what a Game Boy Advance actually put on
 * screen, and the companion and the things it meets come up to a size you can
 * read at a glance.
 */
export const FIELD_ZOOM = 2;

/** The field's own coordinate space, which the zoom scales up to the window. */
export const FIELD_WIDTH = VIEW_WIDTH / FIELD_ZOOM;
export const FIELD_HEIGHT = VIEW_HEIGHT / FIELD_ZOOM;

/**
 * The scrolling area background fills the field, as the map does in the
 * handheld games; the HUD sits over it rather than beside it.
 */
export const BACKGROUND_HEIGHT = FIELD_HEIGHT;

/** How often the game writes to the active save slot. */
export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

/** How often the field rolls for a random event. */
export const EVENT_INTERVAL_MS = 60 * 1000;

/**
 * How much a click on the travelling view pulls the next event in.
 *
 * One event a minute is the idle pace; a player poking at the companion is
 * asking it to get on with it, so each click shoulders a second off the wait
 * — a handful of clicks visibly matters without ever emptying it.
 */
export const CLICK_EVENT_BONUS_MS = 1000;

/**
 * How much of a victory fanfare is played, in seconds.
 *
 * The cartridge's own victory theme runs for as long as the cartridge wanted
 * to hold the screen — a good ten seconds for a trainer. Here it holds the
 * area music off for that whole time while the companion is already walking
 * again, so it is cut to its opening phrase: long enough to be the fanfare,
 * short enough that the road gets its music back.
 */
export const VICTORY_CUE_SECONDS = 4;

/**
 * How a poke at the companion hurries the walk.
 *
 * Trimming the event clock is the substance of a click, but a second off a
 * minute is not something anyone can watch happening. So the road goes past
 * faster for a moment as well: each click buys a short burst, they stack up to
 * a couple of seconds, and the speed is a clear change without turning the
 * walk into a blur.
 */
export const HURRY_PER_CLICK_MS = 600;
export const HURRY_MAX_MS = 2400;
export const HURRY_SPEED = 2.6;

/**
 * How long to wait before trying again when a roll came due while an event was
 * still playing out.
 *
 * The timers run on the walk, not on what is happening on it, so a rest stop
 * that takes a quarter of a minute can be holding the road when the next event
 * — or the area change — falls due. Putting the timer back to its full period
 * threw that turn away: a player watching a Pokémon Center would then go a
 * further minute with nothing happening, or ten more in the same place.
 */
export const EVENT_RETRY_MS = 5 * 1000;

/**
 * How long the companion stays in one area before moving on: ten minutes,
 * fixed. The range that used to sit here made the interval something the
 * player could only guess at; a fixed figure is one you can set a clock by.
 */
export const AREA_ROTATION_MS = 10 * 60 * 1000;

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

/**
 * How many Pokémon the box holds.
 *
 * The main series gives a box thirty spaces and then another box; one box of a
 * hundred is the same storage without a box-switching screen to build, and the
 * grid scrolls rather than paginates.
 */
export const BOX_LIMIT = 100;

/** Chances to catch a Pokémon once the capture screen opens. */
export const CAPTURE_ATTEMPTS = 3;

/** Badges needed before the Pokémon League opens. */
export const BADGES_FOR_LEAGUE = 8;

/** Trainer wins that summon a gym leader even without the random roll. */
export const TRAINER_WINS_FOR_LEADER = 50;

/** Chance a trainer encounter is a gym leader instead. */
export const LEADER_ENCOUNTER_CHANCE = 0.05;
