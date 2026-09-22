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
 * How much faster the travelling view runs while the pointer is held down.
 *
 * One event a minute is the idle pace; a player holding the pointer on the
 * companion is asking it to get on with it. Holding runs the walk and the
 * event clock at this multiple, and **letting go stops it on the spot** —
 * nothing is banked, so the pace a player sees is always the one their hand is
 * asking for. The older behaviour shouldered half a second off the wait per
 * click, which kept hurrying the game along long after the clicking stopped.
 */
export const HOLD_BOOST_RATE = 6;

/**
 * How fast the companion walks while the pointer is held, as a multiple of its
 * ordinary pace. Lower than the event clock's: the point is to read as a jog,
 * not to tear the map past the window.
 */
export const HOLD_BOOST_WALK = 2.5;

/**
 * Damage the player's own Pokémon takes, as a share of what the formula says.
 *
 * The companion fights on its own for hours at a time with nobody to switch it
 * out, so it is given a standing thirty per cent off everything aimed at it.
 * What it deals is untouched — this is armour, not strength.
 */
export const COMPANION_DAMAGE_TAKEN = 0.7;

/**
 * And what a hit it is weak to costs it on top of that.
 *
 * Flat damage reduction makes type matchups matter less, so the thing the
 * matchup is *about* is sharpened to compensate: a super-effective hit lands
 * half again as hard on the companion. Resisted and neutral hits are unchanged
 * beyond the reduction above.
 */
export const COMPANION_WEAKNESS_TAKEN = 1.5;

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
