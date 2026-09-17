/**
 * A run in progress: the save's contents plus the bookkeeping that only
 * matters while the game is open.
 *
 * Everything the player accumulates lives here, and `toSave` is the single
 * point where it turns back into the JSON written to a slot.
 */
import { AUTOSAVE_INTERVAL_MS, AREA_ROTATION_MS } from '../../shared/constants.mjs';
import { saves } from '../core/bridge.mjs';
import { gameData } from '../core/data.mjs';
import { Rng } from '../core/rng.mjs';
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
    this.autoBattle = save.autoBattle ?? defaultAutoBattle();
    /** @type {string|null} */
    this.leagueRegion = save.progress?.leagueRegion ?? null;

    this.area = this.findArea(save.progress?.areaId) ?? gameData().areas[0];
    this.areaTimer = this.rollAreaTimer();
    this.autosaveTimer = AUTOSAVE_INTERVAL_MS;

    /** Pokémon defeated but not yet caught or let go. */
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
   * @returns {{rotateArea: boolean, autosave: boolean}}
   */
  tick(deltaMs) {
    this.playtime += deltaMs;
    this.areaTimer -= deltaMs;
    this.autosaveTimer -= deltaMs;

    const rotateArea = this.areaTimer <= 0;
    if (rotateArea) this.areaTimer = this.rollAreaTimer();

    const autosave = this.autosaveTimer <= 0;
    if (autosave) this.autosaveTimer = AUTOSAVE_INTERVAL_MS;

    return { rotateArea, autosave };
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
   */
  storeInBox(pokemon) {
    const index = this.box.findIndex((entry) => !entry);
    if (index >= 0) this.box[index] = pokemon;
    else this.box.push(pokemon);
    this.markCaught(pokemon.speciesId);
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
      },
      dex: {
        seen: [...this.seen],
        caught: [...this.caught],
        champions: [...this.champions],
      },
      autoBattle: this.autoBattle,
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
    weights: { damage: 10, status: 4, stat: 3, field: 2, heal: 5 },
    conditions: { status: 'noStatus', stat: 'firstTurn', field: 'noField', heal: 'lowHp', damage: 'always' },
  };
}
