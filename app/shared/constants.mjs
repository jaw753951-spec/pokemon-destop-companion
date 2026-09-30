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

/**
 * The zoom the stage is drawn at for a window of a given width.
 *
 * Whole quarter steps once a source pixel is worth at least a screen pixel,
 * and free below that, where snapping would mean throwing away most of a tiny
 * window. Both the window sizer and the renderer read this, so a window is
 * never a size the picture inside it cannot fill.
 *
 * @param {number} zoom
 */
export const snapZoom = (zoom) => (zoom >= 1 ? Math.floor(zoom * 4) / 4 : zoom);

/**
 * The zoom a window is sized for, at a scale setting, on a screen this big.
 *
 * Scale 1 is a window about a quarter of the screen across. The zoom that
 * asks for is taken to the **nearest** quarter step rather than down to one:
 * rounding down swallowed most of a step, so on a 1080p screen 1.25x asked for
 * a zoom of 1.2 and got 1 — the same window as 1x, give or take four per cent.
 * Nearest keeps every scale setting its own size. A zoom that would not fit on
 * the screen comes down a step at a time until it does.
 *
 * @param {number} scale the setting
 * @param {number} screenWidth the work area, in pixels
 * @param {number} screenHeight
 */
export function windowZoom(scale, screenWidth, screenHeight) {
  const target = Math.min(screenWidth / 4, (screenHeight / 4) * (VIEW_WIDTH / VIEW_HEIGHT));
  const wanted = Math.max(0.5, (target * scale) / VIEW_WIDTH);
  if (wanted < 1) return wanted;
  let zoom = Math.max(1, Math.round(wanted * 4) / 4);
  while (zoom > 1 && (VIEW_WIDTH * zoom > screenWidth || VIEW_HEIGHT * zoom > screenHeight)) zoom -= 0.25;
  return zoom;
}

/** The field's own coordinate space, which the zoom scales up to the window. */
export const FIELD_WIDTH = VIEW_WIDTH / FIELD_ZOOM;
export const FIELD_HEIGHT = VIEW_HEIGHT / FIELD_ZOOM;

/**
 * The scrolling area background fills the field, as the map does in the
 * handheld games; the HUD sits over it rather than beside it.
 */
export const BACKGROUND_HEIGHT = FIELD_HEIGHT;

/**
 * How far below where the cartridge draws it the foe's platform stands in a
 * battle backdrop, in field pixels.
 *
 * The window is 135 field pixels tall where the Game Boy Advance was 160, and
 * a Black and White sprite stands up to 96 — so the far platform is moved
 * down this far to give the foe the height it needs, which the backdrop build
 * and the battle scene both read. It stops short of the near side's name
 * plate.
 */
export const FOE_PLATFORM_DROP = 10;

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
 * How fast an event on the road plays out while the pointer is held — a
 * berry picked, a ball opened, the find held up. As fast as the event clock:
 * waiting out ten seconds of picking is exactly what holding is asking to
 * skip, and there is no map to tear past.
 */
export const HOLD_BOOST_EVENT = 6;

/**
 * How the hurry comes on and goes off, in milliseconds.
 *
 * Switching the pace the instant the pointer moved made the road lurch: full
 * speed on the frame it went down, a dead stop on the frame it came up. It
 * now takes a moment to get going and glides back down to a walk when it is
 * let go — long enough to read as momentum, short enough that the pace is
 * still plainly the one the player's hand is asking for.
 */
export const HOLD_BOOST_RAMP_MS = 150;
export const HOLD_BOOST_GLIDE_MS = 800;

/**
 * Damage the player's own Pokémon takes, as a share of what the formula says.
 *
 * The companion fights on its own for hours at a time with nobody to switch it
 * out, so it is given a standing half off everything aimed at it. The cut
 * comes last, after type effectiveness has done its work. What it deals is
 * untouched — this is armour, not strength.
 */
export const COMPANION_DAMAGE_TAKEN = 0.5;

/**
 * What a weakness multiplies a hit on the companion by, in place of the
 * type chart's two.
 *
 * With no party to switch to, a bad matchup is not something the companion
 * can get out of, so being hit where it is weak costs it half again rather
 * than double. Each weakness counts: a double weakness is this squared.
 * Resisted and neutral hits are the chart's own.
 */
export const COMPANION_WEAKNESS = 1.5;

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
 * How soon a turn held back by a bridge overhead is tried again.
 *
 * Sooner than {@link EVENT_RETRY_MS}: the road moves on by itself, and five
 * seconds of walking is 170 field pixels, enough to step clean over a short
 * stretch of open road between two spans.
 */
export const OVERPASS_RETRY_MS = 1000;

/**
 * How long the walk from one area to the next takes, in milliseconds.
 *
 * Half of it is the screen shutting and half is it opening again, with the
 * road changed at the darkest point — which is how the games move you from
 * one place to another, and the reason somewhere else reads as somewhere else
 * rather than as the ground glitching under the companion's feet.
 */
export const CROSSING_MS = 900;

/**
 * How many events the companion sees in one area before moving on.
 *
 * It used to be ten minutes on a clock, which took no notice of the player at
 * all: a run being hurried along by clicking went through a dozen events
 * without the scenery ever changing. Counting events instead means the road
 * moves at the pace the run is actually being played at — ten things happen,
 * and then somewhere else.
 */
export const EVENTS_PER_AREA = 10;

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

/**
 * How often a trainer encounter is a gym leader instead, and how many trainer
 * wins in a row summon one without the roll — by how far into the journey the
 * companion is.
 *
 * One flat 5% and fifty wins made the late badges a long wait: by the sixth
 * badge the companion had long outgrown the road and was still walking it for
 * a leader who rarely came. So the odds rise with the badges in hand, or with
 * the companion's level for one that has levelled ahead of its badges —
 * whichever is further on. The wins that summon one were halved again, so a
 * leader is never more than a couple of dozen fights away.
 *
 * | stage | badges | or level | chance | wins |
 * |-------|--------|----------|--------|------|
 * | early |   0–3  |   < 30   |   5%   |  25  |
 * | mid   |   4–5  |  30–44   |  10%   |  15  |
 * | late  |   6–7  |   45+    |  15%   |  10  |
 */
export const LEADER_ODDS = [
  { badges: 0, level: 0, chance: 0.05, wins: 25 },
  { badges: 4, level: 30, chance: 0.1, wins: 15 },
  { badges: 6, level: 45, chance: 0.15, wins: 10 },
];

/** Trainer wins that summon a gym leader even without the random roll, at the start. */
export const TRAINER_WINS_FOR_LEADER = LEADER_ODDS[0].wins;

/** Chance a trainer encounter is a gym leader instead, at the start. */
export const LEADER_ENCOUNTER_CHANCE = LEADER_ODDS[0].chance;

/**
 * The leader odds for a companion this far along.
 *
 * @param {number} badges
 * @param {number} level
 * @returns {{chance: number, wins: number}}
 */
export function leaderOdds(badges, level) {
  let odds = LEADER_ODDS[0];
  for (const stage of LEADER_ODDS) {
    if (badges >= stage.badges || level >= stage.level) odds = stage;
  }
  return odds;
}
