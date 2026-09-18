/**
 * A run in progress: the save's contents plus the bookkeeping that only
 * matters while the game is open.
 *
 * Everything the player accumulates lives here, and `toSave` is the single
 * point where it turns back into the JSON written to a slot.
 */
import { AUTOSAVE_INTERVAL_MS, AREA_ROTATION_MS, BOX_LIMIT, EVENT_INTERVAL_MS, TRAY_LIMIT } from '../../shared/constants.mjs';
import { saves } from '../core/bridge.mjs';
import { gameData } from '../core/data.mjs';
import { Rng } from '../core/rng.mjs';
import { EventScheduler } from './events.mjs';
import { fullyHeal } from './pokemon.mjs';

export class Session {
  /**
   * @param {{slot: number, save: any}} options
   */
  constructor({ slot, save }) {
    this.slot = slot;
    this.rng = new Rng(save.seed);

    this.active = save.party.active;
    /** @type {Array<import('./pokemon.mjs').Pokemon|null>} */
    this.box = save.party.box ?? [];
    /** @type {Record<string, number>} */
    this.bag = { ...(save.bag ?? {}) };

    this.badges = [...(save.progress?.badges ?? [])];
    this.champion = Boolean(save.progress?.champion);
    this.trainerWins = save.progress?.trainerWins ?? 0;
    this.playtime = save.progress?.playtime ?? 0;
    /** @type {string[]} move slugs unlocked by using TMs */
    this.machines = [...(save.progress?.machines ?? [])];

    this.seen = new Set(save.dex?.seen ?? []);
    this.caught = new Set(save.dex?.caught ?? []);
    this.champions = new Set(save.dex?.champions ?? []);

    /** @type {any} */
    this.autoBattle = normalizeAutoBattle(save.autoBattle);
    /** @type {any} */
    this.itemPolicy = normalizeItemPolicy(save.items);
    /** @type {string|null} */
    this.leagueRegion = save.progress?.leagueRegion ?? null;

    this.area = this.findArea(save.progress?.areaId) ?? gameData().areas[0];
    this.areaTimer = this.rollAreaTimer();
    this.autosaveTimer = AUTOSAVE_INTERVAL_MS;
    this.eventTimer = EVENT_INTERVAL_MS;
    this.events = new EventScheduler(save.progress?.events ?? {});

    /**
     * Pokémon defeated but not yet caught or let go. Deliberately not saved:
     * the tray is a moment's offer, not something to come back to days later.
     * @type {import('./pokemon.mjs').Pokemon[]}
     */
    this.tray = [];
  }

  /** @param {string|null|undefined} id */
  findArea(id) {
    return gameData().areas.find((area) => area.id === id) ?? null;
  }

  rollAreaTimer() {
    const [min, max] = AREA_ROTATION_MS;
    return this.rng.int(min, max);
  }

  /**
   * Advance the timers that run while the companion is travelling.
   *
   * @param {number} deltaMs
   * @returns {{rotateArea: boolean, autosave: boolean, event: boolean}}
   */
  tick(deltaMs) {
    this.playtime += deltaMs;
    this.areaTimer -= deltaMs;
    this.autosaveTimer -= deltaMs;
    this.eventTimer -= deltaMs;

    const rotateArea = this.areaTimer <= 0;
    if (rotateArea) this.areaTimer = this.rollAreaTimer();

    const autosave = this.autosaveTimer <= 0;
    if (autosave) this.autosaveTimer = AUTOSAVE_INTERVAL_MS;

    const event = this.eventTimer <= 0;
    if (event) this.eventTimer = EVENT_INTERVAL_MS;

    return { rotateArea, autosave, event };
  }

  /**
   * Hold a defeated Pokémon for the player to catch or release. The tray keeps
   * the five most recent; anything older is let go on its own.
   * @param {import('./pokemon.mjs').Pokemon} pokemon
   */
  addToTray(pokemon) {
    this.tray.push(pokemon);
    while (this.tray.length > TRAY_LIMIT) this.tray.shift();
  }

  /** Move to a different area, never repeating the current one. */
  rotateArea() {
    const options = gameData().areas.filter((area) => area.id !== this.area.id);
    if (options.length) this.area = this.rng.pick(options);
    return this.area;
  }

  /** @param {number} speciesId */
  markSeen(speciesId) {
    this.seen.add(speciesId);
  }

  /** @param {number} speciesId */
  markCaught(speciesId) {
    this.seen.add(speciesId);
    this.caught.add(speciesId);
  }

  /**
   * @param {string} item
   * @param {number} [count]
   */
  addItem(item, count = 1) {
    this.bag[item] = (this.bag[item] ?? 0) + count;
  }

  /**
   * @param {string} item
   * @param {number} [count]
   * @returns {boolean} whether the bag had enough
   */
  removeItem(item, count = 1) {
    const held = this.bag[item] ?? 0;
    if (held < count) return false;
    if (held === count) delete this.bag[item];
    else this.bag[item] = held - count;
    return true;
  }

  /** @param {string} item */
  countOf(item) {
    return this.bag[item] ?? 0;
  }

  /** Items in a pocket that the player actually holds. */
  pocket(pocket) {
    const items = gameData().items;
    return Object.entries(this.bag)
      .filter(([slug, count]) => count > 0 && items[slug]?.pocket === pocket)
      .map(([slug, count]) => ({ slug, count, item: items[slug] }));
  }

  /** Every ball the player holds, rarest last, for the capture screen. */
  balls() {
    return this.pocket('pokeballs').sort((a, b) => (a.item.cost || 0) - (b.item.cost || 0));
  }

  /**
   * Put a Pokémon in the first free box space.
   * @param {import('./pokemon.mjs').Pokemon} pokemon
   * @returns {boolean} whether the box had room
   */
  storeInBox(pokemon) {
    const index = this.box.findIndex((entry) => !entry);
    if (index >= 0) this.box[index] = pokemon;
    else if (this.box.length < BOX_LIMIT) this.box.push(pokemon);
    else return false;
    this.markCaught(pokemon.speciesId);
    return true;
  }

  /** Whether every space in the box is taken. */
  get boxFull() {
    return this.box.filter(Boolean).length >= BOX_LIMIT;
  }

  /**
   * Swap the travelling Pokémon with one from the box.
   * @param {number} index
   */
  switchActive(index) {
    const chosen = this.box[index];
    if (!chosen) return null;
    this.box[index] = this.active;
    this.active = chosen;
    return chosen;
  }

  /** Heal the travelling Pokémon completely. */
  heal() {
    fullyHeal(this.active);
  }

  /** @returns {any} the JSON written to the save slot */
  toSave() {
    return {
      seed: this.rng.seed,
      party: { active: this.active, box: this.box },
      bag: this.bag,
      progress: {
        badges: this.badges,
        champion: this.champion,
        trainerWins: this.trainerWins,
        playtime: Math.round(this.playtime),
        areaId: this.area?.id ?? null,
        machines: this.machines,
        leagueRegion: this.leagueRegion,
        events: this.events.toJSON(),
      },
      dex: {
        seen: [...this.seen],
        caught: [...this.caught],
        champions: [...this.champions],
      },
      autoBattle: this.autoBattle,
      items: this.itemPolicy,
    };
  }

  /** Write the run to its slot. */
  async save() {
    await saves.write(this.slot, this.toSave());
  }
}

/**
 * The default auto-battle policy: lead with a stat boost, then attack, and
 * prefer damage when nothing else applies.
 */
export function defaultAutoBattle() {
  return {
    mode: 'repeatAll',
    /** @type {Array<string|null>} four slots, fired left to right */
    order: [null, null, null, null],
    /**
     * When each kind of move may be used, `never` included. With no move order
     * set this is the whole policy: attacks are always allowed, and the engine
     * reaches for the hardest-hitting one it holds.
     */
    conditions: { damage: 'always', status: 'noStatus', stat: 'firstTurn', field: 'noField', heal: 'hpHalf' },
  };
}

/**
 * How the bag is used without being opened.
 *
 * `berries` are the restock choices in order of preference, any of which may
 * be left unset; `healing` names an item to throw, or null for whatever fits
 * the damage taken, and the health it is thrown at — `never` for a player who
 * would rather do it by hand.
 */
export function defaultItemPolicy() {
  return {
    /** @type {Array<string|null>} */
    berries: [null, null, null],
    healing: { item: /** @type {string|null} */ (null), condition: 'hpThird' },
  };
}

/** @param {any} policy */
export function normalizeItemPolicy(policy) {
  const fresh = defaultItemPolicy();
  if (!policy) return fresh;

  const berries = Array.isArray(policy.berries) ? policy.berries.slice(0, 3) : [];
  while (berries.length < 3) berries.push(null);

  return {
    berries: berries.map((slug) => slug || null),
    healing: {
      item: policy.healing?.item ?? null,
      condition: policy.healing?.condition ?? fresh.healing.condition,
    },
  };
}

/**
 * Bring a stored policy up to the shape the engine reads.
 *
 * Two older shapes are read for what they plainly meant. A policy carrying a
 * weight per category — numbers the player could not see the effect of — used
 * zero to mean "never", and one carrying a tick per category said the same
 * thing with a box. Either way the answer is a condition, so both fold into
 * the one field the engine now reads.
 *
 * @param {any} policy
 */
export function normalizeAutoBattle(policy) {
  const fresh = defaultAutoBattle();
  if (!policy) return fresh;

  const conditions = { ...fresh.conditions, ...(policy.conditions ?? {}) };
  for (const category of Object.keys(fresh.conditions)) {
    const off = policy.use ? policy.use[category] === false : (policy.weights?.[category] ?? 1) <= 0;
    if (off) conditions[category] = 'never';
  }

  return {
    mode: policy.mode ?? fresh.mode,
    order: policy.order ?? fresh.order,
    conditions,
  };
}
