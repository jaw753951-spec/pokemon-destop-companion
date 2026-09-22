/**
 * Field events.
 *
 * Every event spawns whatever it involves beyond the right edge of the view
 * and lets the companion walk into it, so an encounter looks like something
 * met along the way rather than something that appeared on top of the player.
 * The runner owns the props and their timing; the field scene owns the walk.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, LEADER_ENCOUNTER_CHANCE, TRAINER_WINS_FOR_LEADER } from '../../shared/constants.mjs';
import { loadImage, loadSprite, Sprite } from '../core/assets.mjs';
import { artOf, gameData, itemOf, speciesOf } from '../core/data.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { BALL_TIERS } from '../../shared/ball-tiers.mjs';
import { TAG_TYPES } from '../../shared/area-tags.mjs';
import { evolveToLevel, giveTrainerItems, rollTrainer, rollWildPokemon } from '../engine/encounter.mjs';
import { createPokemon, levelOf } from '../engine/pokemon.mjs';
import { ACTOR_SCALE, COMPANION_X, groundY } from '../render/field.mjs';

/** How long each gathering phase takes, as the brief specifies. */
const HARVEST_MS = 10000;
const PICKUP_MS = 5000;
const SHOW_ITEM_MS = 3000;

/** A prop spawns this far beyond the right edge of the field. */
const SPAWN_MARGIN = 24;

/**
 * How far to the companion's right the prop ends up. Without a gap the two
 * sprites land on the same spot and the companion hides whatever it met.
 * Field pixels, so about a tile and a bit at the size they are drawn.
 */
const MEET_GAP = 20;

/** How wide a ball lying on the path is drawn, in field pixels — under a tile. */
const BALL_SIZE = 12;

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   onBattle: (setup: {foes: any[], trainer: any|null, leader: any|null}) => void,
 * }} options
 */
export function createEventRunner({ session, onBattle }) {
  /** @type {any} */
  let active = null;

  return {
    /** Whether an event is currently holding the walk. */
    get busy() {
      return active !== null;
    },

    /** Whether the companion should keep moving this frame. */
    get walking() {
      // 'passing' is the walk-out of a finished rest stop: the companion is
      // back on the road, so the world scrolls on behind it as before.
      return active === null || active.phase === 'approach' || active.phase === 'passing';
    },

    /** Whether the companion is out of sight — inside the Pokémon Center. */
    get hidesActor() {
      return Boolean(active?.hidesActor);
    },

    /**
     * @param {import('../engine/events.mjs').EventKind} kind
     * @param {number} offset the field's current world scroll
     * @param {import('../core/app.mjs').App} app
     */
    start(kind, offset, app) {
      if (active) return;
      const spawnAt = offset + (FIELD_WIDTH - COMPANION_X) + SPAWN_MARGIN;

      switch (kind) {
        case 'berry':
          active = startBerry(session, spawnAt);
          break;
        case 'ball':
          active = startBall(session, spawnAt);
          break;
        case 'heal':
          active = startHeal(session, spawnAt);
          break;
        case 'wild':
          active = startWild(session, spawnAt);
          break;
        case 'trainer':
          active = startTrainer(session, spawnAt);
          break;
        default:
          active = null;
      }
    },

    /**
     * @param {number} deltaMs
     * @param {number} offset
     * @param {import('../core/app.mjs').App} app
     */
    update(deltaMs, offset, app) {
      if (!active) return;

      if (active.phase === 'approach') {
        if (offset >= active.worldX - (active.meetGap ?? MEET_GAP)) {
          active.phase = active.onArrive ? active.onArrive(app) : 'done';
          active.timer = active.phaseDuration ?? 0;
        }
        return;
      }

      active.timer -= deltaMs;
      active.elapsed = (active.elapsed ?? 0) + deltaMs;
      if (active.timer > 0) return;

      // An event with a script of its own drives it one beat at a time; the
      // rest of them have only the three phases below.
      if (active.onTimer) {
        const next = active.onTimer(app);
        if (!next) {
          active = null;
          return;
        }
        active.phase = next.phase ?? active.phase;
        active.timer = next.duration;
        return;
      }

      if (active.phase === 'gather') {
        active.phase = 'show';
        active.timer = SHOW_ITEM_MS;
        if (active.onGathered) active.onGathered(app);
        return;
      }

      if (active.phase === 'battle') {
        const setup = active.setup;
        active = null;
        onBattle(setup);
        return;
      }

      active = null;
    },

    /**
     * @param {CanvasRenderingContext2D} context
     * @param {number} offset
     */
    render(context, offset, actorHeight = 24) {
      if (!active) return;
      const screenX = COMPANION_X + (active.worldX - offset);

      if (active.prop && screenX < FIELD_WIDTH + 64) {
        drawProp(context, active, screenX);
      }
      if (active.phase === 'show' && active.carried) {
        drawCarried(context, active.carried, actorHeight);
      }
      if (active.flash > 0) {
        context.fillStyle = `rgba(255, 255, 255, ${Math.min(0.55, active.flash)})`;
        context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
        active.flash -= 0.02;
      }
    },

    /** Abandon whatever is running, e.g. when the area changes underneath it. */
    cancel() {
      active = null;
    },
  };
}

/**
 * A berry tree grows at the roadside; the companion picks from it for ten
 * seconds, and the tree is left bare.
 */
function startBerry(session, spawnAt) {
  const berries = Object.entries(gameData().items)
    .filter(([, item]) => item.pocket === 'berries' && item.sprite)
    .map(([slug]) => slug);
  const berry = session.rng.pick(berries.length ? berries : ['oran-berry']);

  // `oran-berry` is drawn by a tree sheet named `oran`.
  const treeName = berry.replace(/-berry$/, '');
  const trees = gameData().actors?.props?.berryTrees ?? {};
  const tree = trees[treeName] ? treeName : Object.keys(trees)[0];

  const state = {
    kind: 'berry',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: HARVEST_MS,
    prop: { kind: 'berry-tree', sprite: null, frame: 'ripe' },
    carried: null,
    onArrive: () => 'gather',
    onGathered: (app) => {
      session.addItem(berry);
      state.prop.frame = 'bare';
      state.carried = { icon: `items/${berry}.png`, sprite: null };
      loadImage(`items/${berry}.png`).then((image) => {
        state.carried.sprite = stillSprite(image);
      });
      app.audio.playJingle(gameData().bgm.cues.obtainBerry ?? null);
      app.toast(t('event.berryFound', { name: localized(itemOf(berry)?.name, berry) }));
    },
  };

  if (tree) {
    loadImage(`props/berry-trees/${tree}.png`).then((image) => {
      state.prop.sprite = { image, meta: trees[tree] };
    });
  }
  return state;
}

/**
 * A ball sits on the path. Which ball it is decides how good the item inside
 * is; the companion spends five seconds retrieving it.
 */
function startBall(session, spawnAt) {
  const tier = session.rng.weighted(BALL_TIERS.map((entry) => ({ value: entry, weight: entry.chance })))
    ?? BALL_TIERS[0];
  const pool = gameData().itemTiers[tier.ball] ?? [];
  const item = pool.length ? session.rng.pick(pool) : 'poke-ball';

  const state = {
    kind: 'ball',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: PICKUP_MS,
    prop: { kind: 'ball', sprite: null, frame: 'closed', ball: tier.ball },
    carried: null,
    onArrive: () => 'gather',
    onGathered: (app) => {
      session.addItem(item);
      state.prop.frame = 'open';
      state.carried = { icon: `items/${item}.png`, sprite: null };
      loadImage(`items/${item}.png`).then((image) => {
        state.carried.sprite = stillSprite(image);
      });
      const cue = itemOf(item)?.pocket === 'machines' ? 'obtainTm' : 'obtainItem';
      app.audio.playJingle(gameData().bgm.cues[cue] ?? null);
      app.toast(t('event.itemFound', { name: localized(itemOf(item)?.name, item) }));
    },
  };

  loadImage(`items/${tier.ball}.png`).then((image) => {
    state.prop.sprite = { image, meta: { width: image.naturalWidth, height: image.naturalHeight, frames: 1 } };
  });
  return state;
}

/**
 * How many potions a rest stop hands over, and which one.
 *
 * A stop that only heals is worth nothing to a companion already at full
 * health, and the healing items the bag can throw have to come from somewhere.
 * Which potion is the one the level has any use for: five Potions are a
 * kindness at level ten and a rounding error at fifty.
 */
const SUPPLY_COUNT = 5;

/** @type {Array<{level: number, item: string}>} highest level last */
const SUPPLIES = [
  { level: 20, item: 'potion' },
  { level: 40, item: 'super-potion' },
  { level: 60, item: 'hyper-potion' },
  { level: Infinity, item: 'max-potion' },
];

/** How long the companion stays inside, out of sight, being seen to. */
const CENTER_STAY_MS = 5000;

/**
 * How long the Center stays on screen after the visit, while the walk carries
 * the companion past it. Long enough for the building to slide off the left
 * edge of the view at the walk's own pace, so the rest stop reads as a place
 * passed rather than a place that stopped existing.
 */
const CENTER_PASS_MS = 6500;

/**
 * The visit, beat by beat: which door frame to show, how long to hold it, and
 * whether the companion is inside for it.
 *
 * Frame 0 is the door the building itself draws — shut. The three frames after
 * it are the games' own door animation, played forwards to open and backwards
 * to close, which is exactly how the cartridge does it.
 */
const CENTER_STEPS = [
  { frame: 1, ms: 90 },
  { frame: 2, ms: 90 },
  { frame: 3, ms: 240 },
  { frame: 3, ms: 140, inside: true },
  { frame: 2, ms: 90, inside: true },
  { frame: 1, ms: 90, inside: true },
  { frame: 0, ms: CENTER_STAY_MS, inside: true, heal: true },
  { frame: 1, ms: 90, inside: true },
  { frame: 2, ms: 90, inside: true },
  { frame: 3, ms: 240, inside: true },
  { frame: 3, ms: 200 },
  { frame: 2, ms: 90 },
  { frame: 1, ms: 90 },
  { frame: 0, ms: 300 },
];

/**
 * A Pokémon Center on the road ahead.
 *
 * The companion walks up to the door, waits for it to slide open, goes in, and
 * comes back out five seconds later patched up and carrying something for the
 * road — which is the whole of a visit to one, and reads better than a flash
 * of white where it stood.
 */
function startHeal(session, spawnAt) {
  let step = -1;

  const state = {
    kind: 'heal',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    // Right up to the doorstep, rather than the tile short of it that a berry
    // tree or a trainer is met at.
    meetGap: 4,
    hidesActor: false,
    prop: { kind: 'center', sprite: null, door: null, frame: 0 },
    carried: null,

    onArrive: () => 'visit',

    /** One beat of the visit; null once there are none left. */
    onTimer: (app) => {
      step += 1;
      const beat = CENTER_STEPS[step];
      if (beat) {
        state.prop.frame = beat.frame;
        state.hidesActor = Boolean(beat.inside);
        if (beat.heal) restAndResupply(session, app);
        return { phase: 'visit', duration: beat.ms };
      }

      // The visit is over, but the building is not: the companion walks on
      // past the Center and the map carries it off the left edge like any
      // other roadside scenery, instead of the place vanishing on the spot.
      state.phase = 'passing';
      state.hidesActor = false;
      return { phase: 'passing', duration: CENTER_PASS_MS };
    },
  };

  loadImage('props/poke-center.png').then((image) => {
    state.prop.sprite = { image, meta: gameData().actors?.props?.center };
  });
  loadImage('props/poke-center-door.png').then((image) => {
    state.prop.door = image;
  });

  return state;
}

/** What the visit is for: everything restored, and the bag stocked. */
function restAndResupply(session, app) {
  session.heal();

  const level = levelOf(session.active);
  const supply = SUPPLIES.find((entry) => level < entry.level) ?? SUPPLIES[SUPPLIES.length - 1];
  session.addItem(supply.item, SUPPLY_COUNT);

  app.audio.playJingle(gameData().bgm.cues.heal ?? null);
  app.toast(
    `${t('event.healed')}\n${t('event.supplied', {
      name: localized(itemOf(supply.item)?.name, supply.item),
      count: SUPPLY_COUNT,
    })}`,
    3200,
  );
}

/** A wild Pokémon steps out ahead. */
function startWild(session, spawnAt) {
  const wild = rollWildPokemon(session.rng, session.area, session.active);
  session.markSeen(wild.speciesId);

  const state = {
    kind: 'wild',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: 700,
    prop: { kind: 'pokemon', sprite: null, frame: 'ripe' },
    carried: null,
    setup: { foes: [wild], trainer: null, leader: null },
    onArrive: (app) => {
      app.audio.playCry(wild.speciesId);
      app.toast(t('event.wild', { name: localized(speciesOf(wild.speciesId)?.name, '') }));
      return 'battle';
    },
  };

  const art = artOf(wild, 'icon');
  if (art) {
    loadSprite(art.path, { ...art.meta, frames: 1, delay: 1000 }).then((sprite) => {
      state.prop.sprite = sprite;
    });
  }
  return state;
}

/**
 * A trainer blocks the path. Once eight badges are in hand leaders stop
 * appearing; before that a leader can turn up by chance, or be summoned by a
 * long enough winning streak.
 */
function startTrainer(session, spawnAt) {
  const classes = gameData().trainerClasses ?? [];
  const leader = shouldSummonLeader(session) ? pickLeader(session) : null;
  const { trainerClass, party } = rollTrainer(session.rng, session.area, session.active, classes);

  const roster = leader ? leaderParty(session, leader) : party;
  for (const member of roster) session.markSeen(member.speciesId);

  const state = {
    kind: 'trainer',
    worldX: spawnAt,
    phase: 'approach',
    timer: 0,
    flash: 0,
    phaseDuration: 800,
    prop: { kind: 'trainer', sprite: null, frame: 'ripe' },
    carried: null,
    setup: { foes: roster, trainer: leader ?? trainerClass, leader },
    onArrive: (app) => {
      const name = localized((leader ?? trainerClass).name, '');
      app.toast(leader ? t('event.leader', { trainer: name }) : t('event.trainer', { trainer: name }));
      return 'battle';
    },
  };

  const fieldSprite = leader?.field ?? trainerClass?.field;
  const meta = fieldSprite ? gameData().actors?.overworld?.[fieldSprite] : null;
  if (meta) {
    loadSprite(`trainers/field/${fieldSprite}.png`, { ...meta, delay: 240 }).then((sprite) => {
      state.prop.sprite = sprite;
    });
  }
  return state;
}

/** @param {import('../engine/session.mjs').Session} session */
function shouldSummonLeader(session) {
  if (session.badges.length >= 8) return false;
  if (session.trainerWins >= TRAINER_WINS_FOR_LEADER) return true;
  return session.rng.chance(LEADER_ENCOUNTER_CHANCE);
}

/**
 * A leader whose badge the player does not already hold, preferring one whose
 * type suits the area's terrain — a Rock leader on a mountain path rather than
 * at the seaside.
 *
 * @param {import('../engine/session.mjs').Session} session
 */
function pickLeader(session) {
  const held = new Set(session.badges);
  const available = (gameData().leaders ?? []).filter((leader) => !held.has(leader.type));
  if (available.length === 0) return null;

  const suited = new Set((session.area?.tags ?? []).flatMap((tag) => TAG_TYPES[tag] ?? []));
  const local = available.filter((leader) => suited.has(leader.type));
  return session.rng.pick(local.length ? local : available);
}

/**
 * A leader's party: the species they are known for, levelled to the player so
 * the fight stays a challenge whenever it happens rather than being fixed to
 * the point in a journey the leader originally sat at.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {any} leader
 */
export function leaderParty(session, leader) {
  const level = Math.min(100, levelOf(session.active) + (leader.levelBonus ?? 3));
  const roster = (leader.party ?? []).filter((id) => speciesOf(id));

  const species = roster.length
    ? roster
    : // No roster on file: fall back to strong members of the leader's type.
      pickTypeRoster(session, leader.type, 3);

  const party = species.map((id) => createPokemon(session.rng, evolveToLevel(id, level), level, { ivFloor: 20 }));
  return giveTrainerItems(session.rng, party, 'leader');
}

/**
 * The highest-statted non-legendary species of a type, which is what a gym
 * leader would plausibly have trained.
 *
 * @param {import('../engine/session.mjs').Session} session
 * @param {string} type
 * @param {number} count
 * @returns {number[]}
 */
function pickTypeRoster(session, type, count) {
  const candidates = Object.values(gameData().species)
    .filter((entry) => !entry.isLegendary && !entry.isMythical && entry.types.includes(type))
    .sort((a, b) => totalStats(b) - totalStats(a))
    .slice(0, 24)
    .map((entry) => entry.id);

  return session.rng.shuffle(candidates).slice(0, count);
}

const totalStats = (species) => Object.values(species.stats).reduce((sum, value) => sum + Number(value), 0);

/**
 * @param {CanvasRenderingContext2D} context
 * @param {any} state
 * @param {number} screenX
 */
function drawProp(context, state, screenX) {
  const prop = state.prop;
  if (!prop?.sprite) return;

  if (prop.kind === 'berry-tree') {
    drawBerryTree(context, prop, screenX);
    return;
  }
  if (prop.kind === 'ball') {
    drawBall(context, prop, screenX);
    return;
  }
  if (prop.kind === 'center') {
    drawCenter(context, prop, screenX);
    return;
  }

  // A Pokémon or trainer waiting on the path, at the size the companion walks
  // at so the two meet as equals rather than as a giant and a doll.
  const sprite = /** @type {Sprite} */ (prop.sprite);
  sprite.draw(context, screenX, groundY(), {
    frame: sprite.frameAt(state.elapsed ?? 0),
    scale: ACTOR_SCALE,
  });
}

/**
 * Berry sheets hold the tree's growth stages; the last is fruit-bearing and
 * the first is the bare plant left after a harvest.
 */
function drawBerryTree(context, prop, screenX) {
  const { image, meta } = prop.sprite;
  const frameWidth = 16;
  const frameHeight = 32;
  const columns = Math.max(1, Math.floor(image.naturalWidth / frameWidth));
  const total = Math.max(1, meta?.frames ?? columns);
  const index = prop.frame === 'ripe' ? total - 1 : 0;

  const sx = (index % columns) * frameWidth;
  const sy = Math.floor(index / columns) * frameHeight;
  // A berry tree is one tile wide and easy to miss against a busy route, so it
  // is drawn at the same size as the actors that walk up to it.
  const scale = ACTOR_SCALE;

  context.drawImage(
    image,
    sx,
    sy,
    frameWidth,
    frameHeight,
    Math.round(screenX - (frameWidth * scale) / 2),
    Math.round(groundY() - frameHeight * scale),
    frameWidth * scale,
    frameHeight * scale,
  );
}

/**
 * The Pokémon Center, standing on the road with its door on the ground line.
 *
 * The building is drawn at the map's own scale — it is a piece of map — and
 * the door frames are laid over the doorway it already has, so opening it is
 * one blit rather than a second copy of the building.
 */
function drawCenter(context, prop, screenX) {
  const { image, meta } = prop.sprite;
  const door = meta?.door;

  // Lined up so the doorway is where the companion stopped, not the middle of
  // the wall: a Pokémon Center is wider on one side than the other.
  const left = Math.round(screenX - (door ? door.x + door.width / 2 : image.naturalWidth / 2));
  const top = Math.round(groundY() - image.naturalHeight);
  context.drawImage(image, left, top);

  if (!door || !prop.door || prop.frame <= 0) return;
  const frame = Math.min(prop.frame, door.frames) - 1;
  context.drawImage(
    prop.door,
    frame * door.width,
    0,
    door.width,
    door.height,
    left + door.x,
    top + door.y,
    door.width,
    door.height,
  );
}

/**
 * The ball on the ground. Once emptied it is drawn as the same ball with its
 * top half tipped back off the base — the games have no "opened ball" sprite
 * of their own for the overworld. (Exported so the check harness can render
 * the shape headlessly.)
 *
 * Tipping it by rotating the lid leaves the two square halves overhanging
 * empty air at their corners, which is the "broken image" look. Instead the
 * base stays put and the lid is **sheared off to the right and shortened** —
 * a row per blit, each row shifted a little further and squashed a little
 * thinner, so the lid reads as hinged at its back edge and curled over, and
 * every drawn pixel stays inside the sprite's own footprint.
 */
export function drawBall(context, prop, screenX) {
  const { image } = prop.sprite;
  const size = image.naturalHeight;
  // Item icons are drawn for a bag list, where they are the only thing on the
  // row; on the ground one at its own size is a boulder, so it is brought down
  // to something a Pokémon could pick up.
  const drawn = BALL_SIZE;
  const left = Math.round(screenX - drawn / 2);
  const top = Math.round(groundY() - drawn);

  if (prop.frame === 'closed') {
    context.drawImage(image, left, top, drawn, drawn);
    return;
  }

  const half = Math.floor(size / 2);
  // The base keeps its place on the ground.
  context.drawImage(image, 0, half, size, size - half, left, top + drawn / 2, drawn, drawn / 2);
  // The lid: one blit per source row, hinged at its back (right) edge and
  // curling forward — the further up the lid a row sits, the further right
  // and the thinner it is drawn, so the lid reads as tipped over rather than
  // rotated into a square-shaped hole. `imageSmoothingEnabled` is already off
  // in field space, so the squash stays as crisp as the rest of the field.
  const lidHeight = drawn / 2;
  const rowHeight = lidHeight / half;
  for (let row = 0; row < half; row++) {
    // 0 at the hinge (bottom of the lid), 1 at its rim (top).
    const lifted = 1 - row / half;
    const shift = lifted * drawn * 0.38;
    const height = rowHeight * (1 - lifted * 0.45);
    context.drawImage(
      image,
      0,
      row,
      size,
      1,
      Math.round(left + shift),
      Math.round(top + row * rowHeight),
      drawn,
      Math.max(1, height),
    );
  }
}

/**
 * The item held up over the companion's head after a gather, clear of whatever
 * height that species happens to be.
 */
function drawCarried(context, carried, actorHeight) {
  if (!carried.sprite) return;
  carried.sprite.draw(context, COMPANION_X, groundY() - actorHeight - 4);
}

/** @param {HTMLImageElement} image */
function stillSprite(image) {
  return new Sprite(image, {
    width: image.naturalWidth,
    height: image.naturalHeight,
    frames: 1,
    delay: 1000,
  });
}
