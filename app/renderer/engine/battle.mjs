/**
 * The battle engine.
 *
 * Turn resolution follows the main series: priority then Speed decides who
 * moves, damage uses the modern formula with STAB, type effectiveness, a
 * critical roll and the 85–100% spread, and status conditions tick at the end
 * of the turn. Battles are fought automatically, so the engine produces a list
 * of log entries per turn which the battle scene plays back as animation.
 */
import { COMPANION_DAMAGE_TAKEN, COMPANION_WEAKNESS } from '../../shared/constants.mjs';
import { itemOf, moveOf, speciesOf, typeEffectiveness } from '../core/data.mjs';
import { ABILITIES, abilityEffect, abilityName, auraMultiplier } from './abilities.mjs';
import { formeFor, SIGNATURE_MOVES, signatureType, standingForme } from './forms.mjs';
import {
  Field,
  FIELD_MOVES,
  FIELD_TURNS,
  hazardToll,
  TERRAIN,
  terrainBlocksPriority,
  terrainBlocksStatus,
  terrainDamage,
  WEATHER,
  weatherAccuracy,
  weatherBites,
  weatherDamage,
  weatherHealing,
  weatherStat,
} from './field.mjs';
import { applyHeldEffect, heldPassive, heldTrigger, heldShield, itemSuits } from './items.mjs';
import {
  addVolatile,
  clearVolatile,
  CONFUSION_POWER,
  CONFUSION_SELF_HIT,
  CONFUSION_TURNS,
  freshVolatile,
  hasVolatile,
  INFATUATION_BLOCK,
  LOCK_MOVES,
  oppositeGenders,
  PROTECT_BYPASS,
  PROTECT_MOVES,
  protectChance,
  tickVolatile,
  VOLATILE,
} from './volatile.mjs';
import { gainFromDefeat, levelOf, maxHp, statsOf } from './pokemon.mjs';
import { stageMultiplier } from './stats.mjs';

/**
 * @typedef {Object} Combatant
 * @property {import('./pokemon.mjs').Pokemon} pokemon
 * @property {Record<string, number>} stages
 * @property {boolean} flinched
 * @property {string|null} lockedMove the move a Choice item has it committed to
 * @property {number} turnsTaken
 * @property {number} [enteredTurn] the battle turn it came out on
 * @property {'player'|'foe'} side
 * @property {Record<string, any>} marks what an ability or item has left on it
 * @property {Record<string, any>} volatile the states that end with the battle
 * @property {string|null} charging a two-turn move part way through
 * @property {boolean} mustRecharge whether last turn's move has to be paid for
 * @property {string|null} lastMove for the items that reward repeating one
 * @property {number} repeats how many turns running that has been the move
 * @property {boolean} movedLast whether it acted second on the previous turn
 * @property {number} maxHp
 * @property {{speciesId: number, forme: string|null, stats: Record<string, number>, moves: Array<{move: string, pp: number}>}} [transform]
 *   what a Transform or an Imposter made it, for the rest of the battle
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} kind `move`, `damage`, `effectiveness`, `critical`, `miss`,
 *   `status`, `statusDamage`, `stat`, `statFailed`, `heal`, `faint`, `flinch`,
 *   `noEffect`, `failed`, `end`
 * @property {'player'|'foe'} [side]
 * @property {Record<string, any>} [data]
 * @property {{player: number, foe: number}} [hp] what both sides stood at when
 *   this line was written, so a bar can follow the turn rather than its end
 */

/** The stats a Starf Berry can land on. */
const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'];

/**
 * The two battle-only stages, as the move data spells them.
 *
 * Every other stat arrives already shortened — `special-attack` is `spa` by
 * the time it reaches here — but accuracy and evasion have no short form in
 * the source, so they came through written out. The hit roll reads `acc` and
 * `eva`, so a Sand Attack was filing its drop under a name nothing looked at
 * and quietly doing nothing at all.
 */
const STAGE_ALIASES = { accuracy: 'acc', evasion: 'eva' };

/** Status conditions the engine models. */
export const STATUS = { BURN: 'brn', POISON: 'psn', PARALYSIS: 'par', SLEEP: 'slp', FREEZE: 'frz' };

/**
 * What is left when nothing has PP.
 *
 * The move list has a `struggle` in it, filed as a Normal move like any other,
 * and using that one was wrong in both directions: a Ghost was immune to it,
 * so two Pokémon out of PP could stand there announcing Struggle at each other
 * for ever, and it cost its user nothing. The games make it typeless — nothing
 * resists it and nothing is immune — never miss, and take a quarter of the
 * user's health for using it, which is what ends a fight nothing else can.
 *
 * The type is a name the chart does not carry, and `typeEffectiveness` answers
 * 1 for a type it does not know, which is exactly the rule wanted here.
 */
export const STRUGGLE = {
  id: 165,
  name: { ko: '발버둥', en: 'Struggle' },
  type: 'typeless',
  damageClass: 'physical',
  power: 50,
  accuracy: null,
  pp: 1,
  priority: 0,
  target: 'selected-pokemon',
  text: { ko: '', en: '' },
  flags: ['contact'],
  meta: null,
  statChanges: [],
};

/** What Struggle costs the Pokémon that had to use it. */
const STRUGGLE_RECOIL = 1 / 4;

/** Moves are capped at this many turns so a stalemate cannot run forever. */
const TURN_LIMIT = 200;

/**
 * The engine's condition names back to the ailment names the move data uses,
 * so an ability can ask for a paralysis in the same words the save writes it.
 */
const STATUS_TO_AILMENT = { brn: 'burn', psn: 'poison', par: 'paralysis', slp: 'sleep', frz: 'freeze' };

/**
 * The moves that only work on the first turn after the user comes out: a Fake
 * Out is a surprise, and a surprise works once.
 */
export const FIRST_TURN_ONLY = new Set(['fake-out', 'first-impression', 'mat-block']);

/**
 * The moves whose side effect only lands on a target whose stats went up this
 * turn: a Burning Jealousy burns the one that just powered up, and nobody else.
 */
export const RAISED_THIS_TURN_ONLY = new Set(['burning-jealousy', 'alluring-voice']);

/**
 * The moves whose user goes down for using them. An Explosion costs its user
 * everything whether it hit, missed or went into a Ghost — only a Damp in
 * front of it stops it going off at all, and then it costs nothing.
 */
export const SELF_KNOCKOUT = new Set(['self-destruct', 'explosion', 'misty-explosion', 'memento']);

/** The status moves the type chart still applies to. */
const TYPE_CHECKED_STATUS = new Set(['thunder-wave']);

/** The type each terrain gives a Mimicry. @type {Record<string, string>} */
const MIMICRY_TYPES = { electric: 'electric', grassy: 'grass', misty: 'fairy', psychic: 'psychic' };

/**
 * The moves whose power the weights decide: a Low Kick and a Grass Knot by
 * how heavy the target is, a Heavy Slam and a Heat Crash by how many times
 * over the user outweighs it.
 */
const WEIGHT_MOVES = { 'low-kick': 'target', 'grass-knot': 'target', 'heavy-slam': 'ratio', 'heat-crash': 'ratio' };

/**
 * A weight move's power, or null for any other move.
 *
 * @param {any} move
 * @param {number} userWeight hectograms
 * @param {number} targetWeight hectograms
 * @returns {number|null}
 */
export function weightPower(move, userWeight, targetWeight) {
  const kind = Object.entries(WEIGHT_MOVES).find(([slug]) => moveOf(slug)?.id === move?.id)?.[1];
  if (!kind) return null;
  if (kind === 'target') {
    const kg = targetWeight / 10;
    return kg < 10 ? 20 : kg < 25 ? 40 : kg < 50 ? 60 : kg < 100 ? 80 : kg < 200 ? 100 : 120;
  }
  const ratio = userWeight / targetWeight;
  return ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
}

/** The forme whose Tera Starstorm is Stellar. */
const STELLAR_FORME = 'terapagos-stellar';

/** The two-turn moves that need no charging when the sun is out. */
const SUN_CHARGED = new Set(['solar-beam', 'solar-blade']);

/** @param {any} move @param {string} flag */
const hasFlag = (move, flag) => Boolean(move?.flags?.includes(flag));

export class Battle {
  /**
   * @param {{
   *   rng: import('../core/rng.mjs').Rng,
   *   player: import('./pokemon.mjs').Pokemon,
   *   foes: import('./pokemon.mjs').Pokemon[],
   *   policy: any,
   *   items?: {
   *     choose: (pokemon: import('./pokemon.mjs').Pokemon) => string|null,
   *     throw: (slug: string, pokemon: import('./pokemon.mjs').Pokemon) => boolean,
   *   }|null,
   *   trainerBattle?: boolean,
   *   weather?: string|null,
   * }} options
   */
  constructor({ rng, player, foes, policy, items = null, trainerBattle = false, weather = null }) {
    this.rng = rng;
    this.policy = policy;
    /**
     * The bag, as far as a battle needs one: what to throw unasked, how to
     * throw it, and whether a held berry is worth eating.
     */
    this.items = items;
    /** An item the player has chosen to throw, used instead of next turn's move. */
    /** @type {string|null} */
    this.pendingItem = null;
    this.trainerBattle = trainerBattle;

    this.player = makeCombatant(player, 'player');
    this.foeQueue = foes.map((foe) => makeCombatant(foe, 'foe'));
    this.foe = this.foeQueue.shift() ?? null;

    this.turn = 0;
    /** @type {'ongoing'|'won'|'lost'} */
    this.outcome = 'ongoing';
    /** The move each side committed to this turn, decided when order is set. */
    /** @type {Map<Combatant, string|null>|null} */
    this.pendingMoves = null;
    /** @type {Array<{experience: number, levelsGained: number, newLevel: number, learnable: string[]}>} */
    this.rewards = [];

    /** The weather, the terrain and the screens. */
    this.field = new Field();
    /**
     * The area's own sky, which the battle opens under.
     *
     * The maps carry it — Route 119 rains in the cartridge and the pipeline
     * has always exported that — so a battle fought there starts in the rain
     * without anyone having called for it, and it does not run out, because
     * the weather there is not a move somebody used.
     */
    this.areaWeather = weather && Object.values(WEATHER).includes(weather) ? weather : null;
    if (this.areaWeather) this.field.setWeather(this.areaWeather, Infinity);

    /** Log entries produced before the first turn, by whatever walked in. */
    /** @type {LogEntry[]} */
    this.opening = [];
    this.enter(this.player, this.opening);
    if (this.foe) this.enter(this.foe, this.opening);
  }

  /**
   * Whatever a Pokémon does simply by being sent out: an Intimidate, a
   * Drizzle, a Download reading the wall in front of it.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  enter(combatant, log) {
    const other = combatant === this.player ? this.foe : this.player;
    // The turn it came out on, which is what a Fake Out asks: the turn after
    // it is the only one the move works on.
    combatant.enteredTurn = this.turn;
    // An Unburden is waiting for the item to be gone, so it has to know there
    // was one to begin with.
    combatant.marks.hadItem = Boolean(combatant.pokemon.heldItem);

    // Whatever the weather on the field already says about the shape it
    // arrives in — a Forecast walks in as rain or snow made it.
    this.applyForme(combatant, {
      ...this.formeState(combatant),
      // A Disguise is whole the moment it walks in: the marks a battle
      // carries do not follow a Pokémon between battles, and the save never
      // held one.
      broken: false,
      usedMove: null,
    }, log);

    const ability = this.abilityOf(combatant);
    if (!ability?.start || !other) return;

    const before = log.length;
    ability.start(this.abilityContext(combatant, other, log));
    // A line naming the ability goes in front of whatever it did, so the
    // battle reads "Intimidate!" and then the Attack falling.
    if (log.length > before) {
      log.splice(before, 0, {
        kind: 'ability',
        side: combatant.side,
        data: { ability: abilityName(combatant.pokemon) },
      });
    }
  }

  /** @returns {boolean} whether the battle is still running */
  get running() {
    return this.outcome === 'ongoing';
  }

  /**
   * Throw an item on the companion's next action, which is what opening the
   * bag mid-battle does in the games: the turn is spent on the item rather
   * than on a move.
   *
   * @param {string} slug
   */
  queueItem(slug) {
    this.pendingItem = slug;
  }

  /**
   * The weather as the battle actually behaves under it.
   *
   * A Cloud Nine or an Air Lock on either side takes the sky out of the fight
   * without clearing it, so everything that asks about the weather asks here
   * rather than reading the field directly — and a Pokémon under a Utility
   * Umbrella asks with itself named, because the umbrella only covers its
   * holder.
   *
   * @param {Combatant} [forCombatant]
   * @returns {string|null}
   */
  weatherFor(forCombatant) {
    // A Mega Sol carries its own sunshine, whatever the sky is doing.
    if (forCombatant && this.ownAbility(forCombatant)?.actsSunny) return WEATHER.SUN;

    for (const combatant of [this.player, this.foe]) {
      if (combatant && this.ownAbility(combatant)?.suppressWeather) return null;
    }
    if (forCombatant && heldShield(forCombatant.pokemon, 'weatherEffects')) return null;
    return this.field.weather;
  }

  /**
   * The ability a combatant is acting on, as far as the other side is
   * concerned.
   *
   * A Mold Breaker attacking means the defender's ability is not there for the
   * duration of the move, which is the one place an ability is read through
   * somebody else's eyes.
   *
   * @param {Combatant} combatant
   * @param {Combatant} [against] who is acting on it
   */
  abilityOf(combatant, against) {
    if (against && this.ownAbility(against)?.ignoresAbilities) return null;
    // A Neutralizing Gas on the field quiets every ability but its own.
    const other = combatant === this.player ? this.foe : this.player;
    const own = this.ownAbility(combatant);
    if (other && !own?.neutralizes && this.ownAbility(other)?.neutralizes) return null;
    return own;
  }

  /**
   * The ability a combatant has now: one a battle gave it (a Mummy's touch,
   * a Transform's copy) over its forme's, over its own.
   *
   * @param {Combatant} combatant
   */
  abilitySlugOf(combatant) {
    return combatant.marks.ability ?? abilityName(combatant.pokemon);
  }

  /** @param {Combatant} combatant */
  ownAbility(combatant) {
    const slug = this.abilitySlugOf(combatant);
    return slug ? ABILITIES[slug] ?? null : null;
  }

  /**
   * How heavy a combatant is, in hectograms as the dex keeps it: its
   * species', or what it transformed into, doubled by a Heavy Metal, halved
   * by a Light Metal or a Float Stone.
   *
   * @param {Combatant} combatant
   */
  weightOf(combatant) {
    const species = speciesOf(combatant.transform?.speciesId ?? combatant.pokemon.speciesId);
    let weight = species?.weight ?? 100;
    const ability = this.abilityOf(combatant);
    if (ability?.weight) weight *= ability.weight;
    const float = heldPassive(combatant.pokemon, 'weight');
    if (float) weight *= float.multiplier;
    return Math.max(1, weight);
  }

  /**
   * The moves a combatant fights with: a Transform's copies while it is one.
   *
   * @param {Combatant} combatant
   */
  movesOf(combatant) {
    return combatant.transform?.moves ?? combatant.pokemon.moves;
  }

  /**
   * Become the target, the way a Transform or an Imposter does: its species'
   * look, its types, its stats but Hit Points, its stat stages, its ability,
   * and its moves at five PP each — for the rest of the battle.
   *
   * @param {Combatant} self
   * @param {Combatant} target
   * @param {LogEntry[]} log
   * @returns {boolean}
   */
  transformInto(self, target, log) {
    if (!target || target.transform || self.transform) return false;
    const stats = statsOf(target.pokemon, target.marks.forme ?? null);
    self.transform = {
      speciesId: target.pokemon.speciesId,
      forme: target.marks.forme ?? null,
      stats,
      moves: target.pokemon.moves.map((slot) => ({ move: slot.move, pp: Math.min(5, moveOf(slot.move)?.pp ?? 5) })),
    };
    self.marks.types = [...this.typesOf(target)];
    self.marks.ability = this.abilitySlugOf(target);
    self.stages = { ...target.stages };
    log.push({
      kind: 'transformed',
      side: self.side,
      data: { speciesId: target.pokemon.speciesId, forme: target.marks.forme ?? null },
    });
    return true;
  }

  /**
   * Everything an ability hook is handed, with the doing-and-saying already
   * paired up.
   *
   * @param {Combatant} self whose ability it is
   * @param {Combatant} foe
   * @param {LogEntry[]} log
   * @param {Record<string, any>} [extra]
   */
  abilityContext(self, foe, log, extra = {}) {
    const battle = this;
    return {
      battle,
      self,
      foe,
      rng: this.rng,
      log,
      field: this.field,
      weather: this.weatherFor(self),
      terrain: this.field.terrain,
      movingLast: self.movedLast,
      ...extra,

      /** @param {Combatant} combatant */
      statsOf: (combatant) => statsOf(combatant.pokemon),

      /**
       * @param {string} kind
       * @param {Record<string, any>} [data]
       */
      note(kind, data = {}) {
        log.push({ kind, side: self.side, data: { ability: abilityName(self.pokemon), ...data } });
      },

      /** @param {Combatant} target @param {number} fraction of maximum HP */
      damage(target, fraction) {
        if (target.pokemon.hp <= 0) return;
        if (battle.abilityOf(target)?.indirectImmune) return;
        const amount = Math.max(1, Math.floor(target.maxHp * fraction));
        target.pokemon.hp = Math.max(0, target.pokemon.hp - amount);
        log.push({
          kind: 'abilityDamage',
          side: target.side,
          data: { amount, ability: abilityName(self.pokemon) },
        });
      },

      /** @param {Combatant} target @param {number} fraction */
      heal(target, fraction) {
        const max = target.maxHp;
        if (target.pokemon.hp <= 0 || target.pokemon.hp >= max) return;
        const amount = Math.max(1, Math.floor(max * fraction));
        target.pokemon.hp = Math.min(max, target.pokemon.hp + amount);
        log.push({ kind: 'heal', side: target.side, data: { amount, ability: abilityName(self.pokemon) } });
      },

      /** @param {Combatant} target @param {string} stat @param {number} change */
      raise(target, stat, change) {
        if (target.pokemon.hp <= 0) return false;
        // A Clear Amulet, and every ability that answers a drop, only care
        // about a drop the other side caused.
        if (change < 0 && target !== self && heldShield(target.pokemon, 'statDrops')) return false;
        return battle.applyStage(target, stat, change, log, {
          ability: abilityName(self.pokemon),
          ...(target === self ? { source: 'self' } : {}),
        });
      },

      /** @param {Combatant} target @param {string} status @param {number} chance */
      inflict(target, status, chance) {
        if (!battle.rng.chance(chance)) return false;
        const other = target === self ? foe : self;
        return battle.inflictAilment(other, target, STATUS_TO_AILMENT[status] ?? status, log);
      },

      /** @param {Combatant} target */
      cure(target) {
        if (!target.pokemon.status) return;
        target.pokemon.status = null;
        target.pokemon.statusTurns = 0;
        log.push({
          kind: 'status',
          side: target.side,
          data: { status: null, ability: abilityName(self.pokemon) },
        });
      },

      /** @param {string} weather */
      setWeather: (weather) => this.startWeather(weather, self, log),
      /** @param {string} terrain */
      setTerrain: (terrain) => this.startTerrain(terrain, self, log),

      /** @param {Combatant} target */
      transform: (target) => this.transformInto(self, target, log),

      /**
       * The other Pokémon's ability becomes this one, for the rest of the
       * battle — a Mummy's touch.
       *
       * @param {Combatant} target
       * @param {string} ability
       */
      replaceAbility: (target, ability) => {
        if (this.abilitySlugOf(target) === ability) return false;
        target.marks.ability = ability;
        log.push({ kind: 'abilityChanged', side: target.side, data: { ability } });
        return true;
      },

      /** The two swap abilities — a Wandering Spirit's touch. */
      swapAbilities: () => {
        const mine = this.abilitySlugOf(self);
        const theirs = this.abilitySlugOf(foe);
        if (!mine || !theirs || mine === theirs) return false;
        self.marks.ability = theirs;
        foe.marks.ability = mine;
        log.push({ kind: 'abilityChanged', side: foe.side, data: { ability: mine } });
        log.push({ kind: 'abilityChanged', side: self.side, data: { ability: theirs } });
        return true;
      },

      /**
       * Use up the held item, the way a berry is eaten — a Booster Energy.
       *
       * @param {Combatant} target
       */
      spendItem: (target) => {
        const item = target.pokemon.heldItem;
        if (!item) return;
        log.push({ kind: 'berry', side: target.side, data: { item } });
        target.pokemon.heldItem = null;
      },

      /** Weather and terrain both gone, whoever laid them. */
      clearField: () => {
        const cleared = [];
        if (this.field.weather) {
          log.push({ kind: 'weatherEnded', data: { value: this.field.weather } });
          this.field.weather = null;
          this.field.weatherTurns = 0;
          cleared.push('weather');
        }
        if (this.field.terrain) {
          log.push({ kind: 'terrainEnded', data: { value: this.field.terrain } });
          this.field.terrain = null;
          this.field.terrainTurns = 0;
          cleared.push('terrain');
        }
        if (cleared.includes('weather')) this.evaluateFormes(log);
        return cleared.length > 0;
      },

      /** @param {Combatant} target @param {number} chance */
      infatuate: (target, chance) => battle.rng.chance(chance) && battle.infatuate(self, target, log),

      /** @param {Combatant} target */
      confuse: (target) => battle.confuse(target, log),

      /** @param {Combatant} target @param {number} chance */
      disable(target, chance) {
        if (!battle.rng.chance(chance)) return false;
        if (!target.lastMove || !battle.movesOf(target).some((slot) => slot.move === target.lastMove)) return false;
        if (battle.blocksVolatile(target, VOLATILE.DISABLE, log)) return false;
        if (!addVolatile(target, VOLATILE.DISABLE, 4, { disabledMove: target.lastMove })) return false;
        log.push({ kind: 'volatile', side: target.side, data: { state: VOLATILE.DISABLE, move: target.lastMove } });
        battle.eatMentalHerb(target, log);
        return true;
      },

      /** Start the count on both sides, which is what a Perish Body does. */
      perish() {
        for (const combatant of [self, foe]) {
          if (!addVolatile(combatant, VOLATILE.PERISH, 4)) continue;
          log.push({ kind: 'volatile', side: combatant.side, data: { state: VOLATILE.PERISH } });
        }
      },

      /** @param {string} hazard laid at the other side's feet */
      layHazard(hazard) {
        if (!battle.field.addHazard(foe.side, hazard)) return false;
        log.push({ kind: 'hazard', side: foe.side, data: { hazard } });
        return true;
      },

      /** @param {Combatant} target @param {number} amount in hit points */
      damageFlat(target, amount) {
        if (target.pokemon.hp <= 0 || amount <= 0) return;
        if (battle.abilityOf(target)?.indirectImmune) return;
        const dealt = Math.min(target.pokemon.hp, Math.round(amount));
        target.pokemon.hp -= dealt;
        log.push({ kind: 'abilityDamage', side: target.side, data: { amount: dealt, ability: abilityName(self.pokemon) } });
      },

      /** Take down whatever the other side put up. */
      clearScreens() {
        let cleared = false;
        for (const side of /** @type {const} */ (['player', 'foe'])) {
          for (const kind of /** @type {const} */ (['physical', 'special'])) {
            if (battle.field.screens[side][kind] <= 0) continue;
            battle.field.screens[side][kind] = 0;
            cleared = true;
          }
        }
        if (cleared) log.push({ kind: 'screenEnded', side: self.side, data: {} });
        return cleared;
      },

      /** Take the other side's held item, if it has one and is not holding on. */
      steal() {
        if (self.pokemon.heldItem || !foe.pokemon.heldItem) return false;
        if (battle.abilityOf(foe, self)?.keepsItem) return false;
        const slug = foe.pokemon.heldItem;
        foe.pokemon.heldItem = null;
        self.pokemon.heldItem = slug;
        log.push({ kind: 'stole', side: self.side, data: { item: slug } });
        return true;
      },
    };
  }

  /**
   * Move a stat stage and say so, which is the one thing three different
   * systems all needed to do the same way.
   *
   * @param {Combatant} target
   * @param {string} stat
   * @param {number} change
   * @param {LogEntry[]} log
   * @param {Record<string, any>} [data] carried onto the entry, less `quiet`:
   *   set that where the answer decides whether an item is spent at all, so a
   *   berry that stays in the hand does not announce a stage it never moved
   * @returns {boolean} whether anything moved
   */
  applyStage(target, stat, change, log, data = {}) {
    stat = STAGE_ALIASES[stat] ?? stat;
    const { quiet = false, ...detail } = data;
    const other = target === this.player ? this.foe : this.player;
    const ability = this.abilityOf(target);

    // A Contrary reads every change the other way round, and a Simple reads
    // every one twice as far.
    let shift = change;
    if (ability?.invertStages) shift = -shift;
    if (ability?.doubleStages) shift *= 2;

    // Something the other side is doing to it, and it says no.
    const fromOther = shift < 0 && data.source !== 'self';
    if (fromOther && ability?.statDrop?.(this.abilityContext(target, other ?? target, log), stat)) {
      log.push({ kind: 'ability', side: target.side, data: { ability: abilityName(target.pokemon) } });
      return false;
    }
    // Or says no and hands it back, which is what a Mirror Armor does.
    if (fromOther && ability?.reflectsDrops && other) {
      log.push({ kind: 'ability', side: target.side, data: { ability: abilityName(target.pokemon) } });
      return this.applyStage(other, stat, shift, log, { source: 'self' });
    }

    const before = target.stages[stat] ?? 0;
    const after = Math.max(-6, Math.min(6, before + shift));
    // What a Burning Jealousy looks for.
    if (after > before) target.marks.raisedTurn = this.turn;
    // Already as high or as low as it goes. The games say so rather than
    // letting the move look like it did nothing at all.
    if (after === before) {
      if (!quiet) log.push({ kind: 'statFailed', side: target.side, data: { stat, change: shift } });
      return false;
    }
    target.stages[stat] = after;
    // A White Herb remembers that something was lowered so it can undo it.
    if (shift < 0) target.marks.lowered = true;
    log.push({ kind: 'stat', side: target.side, data: { stat, change: shift, stage: after, ...detail } });

    // An Opportunist helps itself to whatever the other side just worked for.
    if (shift > 0 && data.source !== 'copied' && other && this.abilityOf(other)?.copiesRaises) {
      log.push({ kind: 'ability', side: other.side, data: { ability: abilityName(other.pokemon) } });
      this.applyStage(other, stat, shift, log, { source: 'copied' });
    }

    // And what answering a drop is worth: a Defiant's two stages of Attack.
    if (fromOther && ability?.onStatDropped && other) {
      const mark = log.length;
      ability.onStatDropped(this.abilityContext(target, other, log), stat);
      if (log.length > mark) {
        log.splice(mark, 0, { kind: 'ability', side: target.side, data: { ability: abilityName(target.pokemon) } });
      }
    }
    return true;
  }

  /**
   * Put weather over the field, for as long as whoever called it can hold it.
   *
   * @param {string} weather
   * @param {Combatant} source
   * @param {LogEntry[]} log
   */
  startWeather(weather, source, log) {
    const extend = heldPassive(source.pokemon, 'extend');
    const turns = extend?.what === 'weather' ? extend.turns : FIELD_TURNS;
    if (!this.field.setWeather(weather, turns)) return false;
    log.push({ kind: 'weather', side: source.side, data: { weather, turns } });
    this.checkSeeds(log);
    this.evaluateFormes(log);
    return true;
  }

  /**
   * @param {string} terrain
   * @param {Combatant} source
   * @param {LogEntry[]} log
   */
  startTerrain(terrain, source, log) {
    const extend = heldPassive(source.pokemon, 'extend');
    const turns = extend?.what === 'terrain' ? extend.turns : FIELD_TURNS;
    if (!this.field.setTerrain(terrain, turns)) return false;
    log.push({ kind: 'terrain', side: source.side, data: { terrain, turns } });
    this.checkSeeds(log);
    return true;
  }

  /**
   * The four seeds, which are waiting for a terrain to be laid under them.
   * @param {LogEntry[]} log
   */
  checkSeeds(log) {
    for (const combatant of [this.player, this.foe]) {
      if (!combatant || combatant.pokemon.hp <= 0) continue;
      const seed = heldPassive(combatant.pokemon, 'terrain');
      if (!seed || seed.terrain !== this.field.terrain) continue;

      let used = false;
      for (const stat of seed.stats) {
        if (this.applyStage(combatant, stat, seed.stages ?? 1, log, { quiet: true })) used = true;
      }
      if (!used) continue;
      log.push({ kind: 'berry', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      combatant.pokemon.heldItem = null;
    }
  }

  /**
   * Whether a Pokémon is standing on the ground, which is the whole of what
   * decides if the terrain reaches it.
   *
   * @param {Combatant} combatant
   */
  grounded(combatant) {
    // An Iron Ball drags anything down, and it wins over everything else.
    if (heldPassive(combatant.pokemon, 'stat')?.grounds) return true;

    const balloon = heldPassive(combatant.pokemon, 'immune');
    if (balloon?.moveType === 'ground' && !combatant.marks.popped) return false;
    if (this.abilityOf(combatant)?.floats) return false;
    return !this.typesOf(combatant).includes('flying');
  }

  /**
   * A turn's log: an ordinary array that stamps each entry with the hit points
   * on both sides at the moment it was written.
   *
   * The screen plays a turn back after the engine has finished working it out,
   * so a bar that reads the Pokémon's own `hp` while playing reads the value
   * at the *end* of the turn. Both bars therefore fell together on the first
   * blow of the turn, whoever it landed on — the opponent's attack appearing
   * to take effect only when the companion next swung. The stamp is what the
   * bar stood at on that line.
   *
   * @returns {LogEntry[]}
   */
  makeLog() {
    /** @type {LogEntry[]} */
    const log = [];
    const push = Array.prototype.push.bind(log);
    Object.defineProperty(log, 'push', {
      configurable: true,
      value: (...entries) => {
        for (const entry of entries) {
          if (entry && !entry.hp) entry.hp = this.hitPoints();
        }
        return push(...entries);
      },
    });
    return log;
  }

  /** What both sides are on right now. */
  hitPoints() {
    return {
      player: this.player.pokemon.hp,
      foe: this.foe ? this.foe.pokemon.hp : 0,
    };
  }

  /**
   * Play one turn and return everything that happened in it.
   * @returns {LogEntry[]}
   */
  takeTurn() {
    const log = this.makeLog();
    if (!this.running || !this.foe) return log;

    this.turn++;
    if (this.turn > TURN_LIMIT) {
      // A pair that cannot hurt each other would otherwise loop forever; the
      // wild Pokémon leaving is the least disruptive way out.
      this.outcome = 'won';
      log.push({ kind: 'end', data: { reason: 'stalemate' } });
      return log;
    }

    // Anything a Pokémon sent out this turn does on the way in — and, on the
    // first turn, what the two of them did before a blow was struck.
    if (this.opening.length) {
      log.push(...this.opening);
      this.opening = [];
    }

    const first = this.orderOfPlay();
    for (const [index, attacker] of first.entries()) {
      attacker.movedLast = index > 0;
      if (!this.running || !this.foe) break;
      const defender = attacker === this.player ? this.foe : this.player;
      if (attacker.pokemon.hp <= 0 || defender.pokemon.hp <= 0) continue;
      this.resolveMove(attacker, defender, log);
      this.collectSelfKnockout(attacker, log);
      this.checkFaint(log);
      // Checked between the two sides' moves as well as at the end of the
      // turn: a berry that waits until the turn is over is a berry that lets
      // its holder faint first.
      this.eatHeldBerry(log);
    }

    // A flinch is for the turn it happened in: it stops a Pokémon that has not
    // moved yet, and is gone once the turn is over. One landed by the slower
    // side — on a Pokémon that had already moved — used to wait for its
    // target's next turn and take that instead, so every slow Pokémon with a
    // Bite flinched its opponent far more often than the move says.
    this.player.flinched = false;
    if (this.foe) this.foe.flinched = false;

    if (this.running) {
      for (const combatant of [this.player, this.foe]) {
        if (!combatant || combatant.pokemon.hp <= 0) continue;
        this.endOfTurnHeld(combatant, log);
        this.endOfTurnStatus(combatant, log);
        this.endOfTurnField(combatant, log);
        this.endOfTurnAbility(combatant, log);
        this.regrowBerry(combatant, log);
        this.tickStates(combatant, log);
      }
      this.evaluateFormes(log);
      this.tickField(log);
      this.checkFaint(log);
      this.eatHeldBerry(log);
    }

    return log;
  }

  /**
   * An Explosion's user going down with it, once the move has played out.
   *
   * @param {Combatant} attacker
   * @param {LogEntry[]} log
   */
  collectSelfKnockout(attacker, log) {
    if (!attacker.marks.spent) return;
    attacker.marks.spent = false;
    if (attacker.pokemon.hp <= 0) return;
    const amount = attacker.pokemon.hp;
    attacker.pokemon.hp = 0;
    log.push({ kind: 'damage', side: attacker.side, data: { amount, recoil: true } });
  }

  /**
   * The forme each side should be wearing, if either has changed shape.
   *
   * Called at the moments a forme can flip: on the way in, when the weather
   * moves, at the end of a turn (health checks), after a move that catches
   * something, and after a hit that breaks something. A species with no forme
   * to wear costs this a map lookup and returns, which is the common case.
   *
   * @param {LogEntry[]} log
   */
  evaluateFormes(log) {
    for (const combatant of [this.player, this.foe]) {
      if (!combatant || combatant.pokemon.hp <= 0) continue;
      this.applyForme(combatant, this.formeState(combatant), log);
    }
  }

  /**
   * What the shape a combatant wears hangs off, in the one shape every
   * caller passes it: the sky above, the health it is at, whether something
   * about it has been broken, and what it last did.
   *
   * @param {Combatant} combatant
   * @returns {{current: string|null, weather: string|null, weatherTurns: number, overhp: number, maxhp: number, broken: boolean, usedMove: string|null, relicSongs: number, stance: string|null, hangry: boolean}}
   */
  formeState(combatant) {
    return {
      current: combatant.marks.forme ?? null,
      weather: this.weatherFor(combatant),
      weatherTurns: this.field.weatherTurns,
      overhp: combatant.pokemon.hp,
      maxhp: combatant.maxHp,
      broken: Boolean(combatant.marks.formeBroken),
      usedMove: combatant.lastMove,
      relicSongs: combatant.marks.relicSongs ?? 0,
      stance: combatant.marks.stance ?? null,
      hangry: Boolean(combatant.marks.hangry),
    };
  }

  /**
   * Move a combatant into the forme its condition now calls for.
   *
   * The max hit points a forme brings with it are added on the way in and
   * taken back off on the way out, the way evolution tops a level-up up — a
   * Zen Mode's larger bar should not read as having healed into it. A wanted
   * forme of `null` means back to the species' ordinary shape: the forme's
   * health comes off, and the marks are cleared rather than pointed at a slug
   * the data would then be asked to look up.
   *
   * @param {Combatant} combatant
   * @param {{current?: string|null, weather: string|null, weatherTurns: number, overhp: number, maxhp: number, broken: boolean, usedMove: string|null}} state
   * @param {LogEntry[]} log
   * @returns {boolean} whether the forme moved
   */
  applyForme(combatant, state, log) {
    const current = combatant.marks.forme ?? null;
    // A busted Disguise is a state, not a shape the weather can undo: while
    // the mark is set, the busted forme is the only one on offer, whatever
    // the periodic checks keep asking for.
    if (combatant.marks.formeBroken) {
      const busted = this.bustedFormeOf(combatant.pokemon);
      if (busted) {
        if (current === busted) return false;
        combatant.marks.forme = busted;
        combatant.pokemon.forme = busted;
        return true;
      }
    }
    const found = formeFor(combatant.pokemon, { ...state, current });
    // The species' own slug is its ordinary shape, which the marks write as
    // no forme at all — a Castform walking in under a clear sky has not
    // changed into anything.
    const wanted = found === speciesOf(combatant.pokemon.speciesId)?.slug ? null : found;
    if (wanted === current) return false;

    const before = current ? statsOf(combatant.pokemon, current).hp : maxHp(combatant.pokemon);
    // A mask, an Origin Forme, a Sky Forme is worn on the road as well;
    // walking into a battle already in it is not a change anybody sees.
    const alreadyWorn = Boolean(wanted) && combatant.pokemon.forme === wanted && standingForme(combatant.pokemon) === wanted;
    combatant.marks.forme = wanted;
    // The Pokémon wears the slug too, so every screen that holds one — the
    // health bars, the nameplates, the sprite cache keys — reads the shape it
    // is in straight off it, without knowing what a combatant is.
    combatant.pokemon.forme = wanted;
    const after = wanted ? statsOf(combatant.pokemon, wanted).hp : maxHp(combatant.pokemon);
    combatant.pokemon.hp = Math.max(1, Math.min(after, combatant.pokemon.hp + (after - before)));
    // The forme replaces the species' types, which is where its resistances
    // live; an explicit rewrite would fight the next forme change.
    combatant.marks.types = null;
    if (alreadyWorn) return true;
    log.push({
      kind: 'formChanged',
      side: combatant.side,
      data: { forme: wanted, ability: abilityName(combatant.pokemon) },
    });
    return true;
  }

  /**
   * What the sky and the ground do to whoever is standing in them.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnField(combatant, log) {
    const ability = this.abilityOf(combatant);
    const types = this.typesOf(combatant);
    const weather = this.weatherFor(combatant);

    const sheltered =
      ability?.weatherImmune || ability?.indirectImmune || heldShield(combatant.pokemon, 'weather');
    if (!sheltered && weatherBites(weather, types)) {
      const amount = Math.max(1, Math.floor(combatant.maxHp / 16));
      combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - amount);
      log.push({ kind: 'weatherDamage', side: combatant.side, data: { weather, amount } });
    }

    // Grassy Terrain feeds whatever is standing on it.
    if (this.field.terrain === TERRAIN.GRASSY && this.grounded(combatant)) {
      const max = combatant.maxHp;
      if (combatant.pokemon.hp > 0 && combatant.pokemon.hp < max) {
        const amount = Math.max(1, Math.floor(max / 16));
        combatant.pokemon.hp = Math.min(max, combatant.pokemon.hp + amount);
        log.push({ kind: 'heal', side: combatant.side, data: { amount, terrain: TERRAIN.GRASSY } });
      }
    }
  }

  /**
   * The abilities that act between turns rather than during one.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnAbility(combatant, log) {
    const other = combatant === this.player ? this.foe : this.player;
    const ability = this.abilityOf(combatant);
    if (!ability?.turn || !other) return;
    ability.turn(this.abilityContext(combatant, other, log));
  }

  /**
   * Count a combatant's battle-long states down and announce what wore off.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  tickStates(combatant, log) {
    for (const state of tickVolatile(combatant)) {
      // A perish count running out is the one that is not a relief.
      if (state === VOLATILE.PERISH) {
        combatant.pokemon.hp = 0;
        log.push({ kind: 'perished', side: combatant.side });
        continue;
      }
      log.push({ kind: 'volatileEnded', side: combatant.side, data: { state } });
    }
  }

  /**
   * Count the field's clocks down and announce whatever ran out.
   * @param {LogEntry[]} log
   */
  tickField(log) {
    for (const gone of this.field.tick()) {
      log.push({ kind: `${gone.kind}Ended`, side: /** @type {any} */ (gone.side), data: { value: gone.value } });
    }
  }

  /** Priority first, then Speed, with a coin flip to break an exact tie. */
  orderOfPlay() {
    if (!this.foe) return [this.player];

    // Nothing was thrown by hand, so the policy gets its say before the turn
    // is planned.
    if (!this.pendingItem) this.pendingItem = this.items?.choose(this.player.pokemon) ?? null;

    // An item takes the companion's own action: it is used when the companion
    // would have moved, in its place in the order, instead of a move. It used
    // to jump the whole turn, which read as the bag acting the moment it was
    // closed rather than on the companion's next turn.
    //
    // Otherwise both sides commit before either acts, so priority can be
    // compared and the choice cannot change once the turn is under way.
    const playerChoice = this.pendingItem ? null : this.chooseMove(this.player, this.foe);
    const foeChoice = this.chooseMove(this.foe, this.player);
    this.pendingMoves = new Map([
      [this.player, playerChoice],
      [this.foe, foeChoice],
    ]);

    const playerPriority = this.priorityOf(this.player, this.foe, playerChoice);
    const foePriority = this.priorityOf(this.foe, this.player, foeChoice);
    if (playerPriority !== foePriority) {
      return playerPriority > foePriority ? [this.player, this.foe] : [this.foe, this.player];
    }

    // Inside a priority bracket, something can still jump the queue: a Quick
    // Claw, a Quick Draw, or a Custap Berry on its last legs.
    const jumps = (combatant) => {
      const claw = heldPassive(combatant.pokemon, 'first');
      if (claw && this.rng.chance(claw.chance)) return true;
      const custap = heldTrigger(combatant.pokemon);
      if (custap?.held.first) {
        combatant.pokemon.heldItem = null;
        return true;
      }
      const draw = this.abilityOf(combatant)?.movesFirst;
      return Boolean(draw && this.rng.chance(draw));
    };
    // And something can give it up: a Lagging Tail, or a Stall.
    const dawdles = (combatant) =>
      Boolean(heldPassive(combatant.pokemon, 'last')) || Boolean(this.abilityOf(combatant)?.movesLast);

    const playerJumps = jumps(this.player);
    const foeJumps = jumps(this.foe);
    if (playerJumps !== foeJumps) return playerJumps ? [this.player, this.foe] : [this.foe, this.player];

    const playerDawdles = dawdles(this.player);
    const foeDawdles = dawdles(this.foe);
    if (playerDawdles !== foeDawdles) return playerDawdles ? [this.foe, this.player] : [this.player, this.foe];

    const playerSpeed = this.speedOf(this.player);
    const foeSpeed = this.speedOf(this.foe);
    if (playerSpeed === foeSpeed) {
      return this.rng.chance(0.5) ? [this.player, this.foe] : [this.foe, this.player];
    }
    // Inside a Trick Room the slower one goes first. Priority still comes
    // before it: a Quick Attack is quick in any room.
    const playerFirst = this.field.trickRoom > 0 ? playerSpeed < foeSpeed : playerSpeed > foeSpeed;
    return playerFirst ? [this.player, this.foe] : [this.foe, this.player];
  }

  /**
   * A stat as this battle sees it — with the abilities and the weather in,
   * which is the whole reason it is not simply `effectiveStat`.
   *
   * @param {Combatant} combatant
   * @param {string} stat
   * @param {{ignorePositive?: boolean, ignoreNegative?: boolean}} [options]
   */
  stat(combatant, stat, options = {}) {
    return effectiveStat(combatant, stat, { ...options, battle: this });
  }

  /**
   * The Speed the turn order is decided on: doubled by a Tailwind at the
   * combatant's back.
   * @param {Combatant} combatant
   */
  speedOf(combatant) {
    const tailwind = this.field.tailwind?.[combatant.side] > 0 ? 2 : 1;
    return this.stat(combatant, 'spe') * tailwind;
  }

  /**
   * How much the other side's mere presence takes off a stat.
   *
   * The four Ruin abilities each weigh on one stat of everything on the field
   * but their own holder, which is why this is asked of the other side rather
   * than of the Pokémon whose stat it is.
   *
   * @param {Combatant} combatant whose stat is being read
   * @param {string} stat
   */
  ruinFactor(combatant, stat) {
    const other = combatant === this.player ? this.foe : this.player;
    const ruin = other ? this.abilityOf(other)?.ruin : null;
    return ruin?.stat === stat ? ruin.multiplier : 1;
  }

  /**
   * What a Pokémon counts as right now.
   *
   * Usually its species' types, and the games do not let that change outside
   * a battle — but a Protean rewrites it every time its holder attacks and a
   * Color Change rewrites it every time its holder is hit, so the answer
   * lives on the combatant and the species is only the starting point. An
   * alternate forme carries its own types the same way.
   *
   * @param {Combatant} combatant
   * @returns {string[]}
   */
  typesOf(combatant) {
    const species = speciesOf(combatant.pokemon.speciesId);
    const forme = combatant.marks.forme
      ? (species.forms ?? []).find((form) => form.slug === combatant.marks.forme)
      : null;
    // A Mimicry wears the terrain's type for as long as the terrain lasts.
    const terrainType = MIMICRY_TYPES[this.field.terrain ?? ''];
    if (terrainType && this.abilityOf(combatant)?.mimicry) return [terrainType];
    return combatant.marks.types ?? forme?.types ?? species.types;
  }

  /**
   * Make a Pokémon a different type for the rest of the battle.
   *
   * @param {Combatant} combatant
   * @param {string[]} types
   * @param {LogEntry[]} log
   * @returns {boolean} whether it was anything other than what it already was
   */
  becomeType(combatant, types, log) {
    const before = this.typesOf(combatant);
    if (before.length === types.length && types.every((type, index) => before[index] === type)) return false;
    combatant.marks.types = types;
    log.push({ kind: 'typeChanged', side: combatant.side, data: { types } });
    return true;
  }

  /**
   * A move's priority once the attacker's ability and the ground have had
   * their say.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {string} choice
   */
  priorityOf(attacker, defender, choice) {
    const move = moveOf(choice);
    if (!move) return 0;

    const ability = this.abilityOf(attacker);
    const priority = (move.priority ?? 0) + (ability?.priority?.(this.abilityContext(attacker, defender, []), move) ?? 0);

    // Psychic Terrain refuses to let anything cut in front of a Pokémon
    // standing on it, and so do the abilities that do nothing else.
    if (terrainBlocksPriority(this.field.terrain, priority, this.grounded(defender))) return 0;
    if (priority > 0 && this.abilityOf(defender, attacker)?.blocksPriority) return 0;

    // A Mycelium Might gives up the queue for its status moves in exchange
    // for the other side's ability not counting against them.
    if (move.damageClass === 'status' && ability?.movesLastWithStatus) return -7;
    return priority;
  }

  /**
   * Pick the move a combatant will use this turn.
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @returns {string} a move slug, or `struggle` when nothing has PP
   */
  chooseMove(attacker, defender) {
    let usable = this.movesOf(attacker).filter((slot) => slot.pp > 0 && moveOf(slot.move));
    if (usable.length === 0) return 'struggle';

    const restriction = heldPassive(attacker.pokemon, 'stat');

    // An Encore takes the choice away entirely: the last move, again.
    if (hasVolatile(attacker, VOLATILE.ENCORE)) {
      const encored = usable.find((slot) => slot.move === attacker.volatile.encoreMove);
      if (encored) return encored.move;
    }

    // A Choice item locks its holder into the first move it picks, for as long
    // as that move has PP — which is the price it charges for the power.
    if (restriction?.lock) {
      const locked = usable.find((slot) => slot.move === attacker.lockedMove);
      if (locked) return locked.move;
    }

    // And what has been taken away: the move a Disable named, every status
    // move under a Taunt, and the one it used last under a Torment.
    usable = this.stillAllowed(attacker, usable);
    if (usable.length === 0) return 'struggle';

    // An Assault Vest buys Special Defence with the holder's status moves.
    if (restriction?.noStatus) {
      const attacks = usable.filter((slot) => moveOf(slot.move)?.damageClass !== 'status');
      if (attacks.length > 0) usable = attacks;
    }

    // The player's side follows the policy the user configured; the opponent
    // plays a simple best-damage game, as the games' trainers broadly do.
    const chosen =
      attacker.side === 'player' && this.policy
        ? choosePolicyMove(this, attacker, defender, usable)
        : bestDamageMove(this, attacker, defender, usable)
          ?? this.rng.pick(movesWorthUsing(attacker, defender, usable)).move;

    if (restriction?.lock) attacker.lockedMove = chosen;
    return chosen;
  }

  /**
   * The moves still open to a Pokémon that has had some taken away.
   *
   * Everything here narrows the list; nothing widens it, so a Pokémon left
   * with nothing struggles, which is what the games do when a Taunt lands on
   * something that only knows status moves.
   *
   * @param {Combatant} attacker
   * @param {Array<{move: string, pp: number}>} usable
   */
  stillAllowed(attacker, usable) {
    let left = usable;
    // A Fake Out after the first turn out is a move that fails, so it is not
    // offered once that turn has gone — unless there is nothing else.
    if (!this.firstTurnOut(attacker)) {
      const others = left.filter((slot) => !FIRST_TURN_ONLY.has(slot.move));
      if (others.length > 0) left = others;
    }
    if (hasVolatile(attacker, VOLATILE.DISABLE)) {
      left = left.filter((slot) => slot.move !== attacker.volatile.disabledMove);
    }
    if (hasVolatile(attacker, VOLATILE.TAUNT)) {
      const attacks = left.filter((slot) => moveOf(slot.move)?.damageClass !== 'status');
      if (attacks.length > 0) left = attacks;
    }
    if (hasVolatile(attacker, VOLATILE.TORMENT)) {
      const others = left.filter((slot) => slot.move !== attacker.lastMove);
      if (others.length > 0) left = others;
    }
    return left;
  }

  /**
   * Whether this is the first turn since the combatant came out.
   * @param {Combatant} combatant
   */
  firstTurnOut(combatant) {
    return this.turn === (combatant.enteredTurn ?? 0) + 1;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {LogEntry[]} log
   */
  resolveMove(attacker, defender, log) {
    // The item is thrown by the trainer, so nothing about the Pokémon's own
    // state — asleep, flinching, paralysed — can stop it.
    if (attacker.side === 'player' && this.pendingItem) {
      const slug = this.pendingItem;
      this.pendingItem = null;
      const used = this.items?.throw(slug, attacker.pokemon) ?? false;
      // A medicine that clears conditions clears the two that never reach the
      // save as well, which is what a player throwing a Full Heal expects.
      if (used && itemOf(slug)?.use?.status === 'any') this.cureVolatile(attacker, log);
      attacker.turnsTaken++;
      log.push({ kind: 'item', side: attacker.side, data: { item: slug, used } });
      return;
    }

    // A Truant works every other turn and loafs the rest, which is the price
    // of whatever it was given in exchange.
    if (this.abilityOf(attacker)?.skipsEveryOther) {
      attacker.marks.loafing = !attacker.marks.loafing;
      if (attacker.marks.loafing) {
        attacker.turnsTaken++;
        log.push({ kind: 'ability', side: attacker.side, data: { ability: abilityName(attacker.pokemon) } });
        log.push({ kind: 'loafing', side: attacker.side });
        return;
      }
    }

    // A move that has to be paid for costs the turn after it, which is what
    // the recharge classification means.
    if (attacker.mustRecharge) {
      attacker.mustRecharge = false;
      attacker.turnsTaken++;
      log.push({ kind: 'recharge', side: attacker.side });
      return;
    }

    if (attacker.flinched) {
      attacker.flinched = false;
      log.push({ kind: 'flinch', side: attacker.side });
      const steadfast = this.abilityOf(attacker);
      steadfast?.onFlinch?.(this.abilityContext(attacker, defender, log));
      return;
    }
    // A Pokémon part way through a two-turn move is committed to finishing it,
    // asleep or not — which is why this comes before the condition check.
    if (!attacker.charging && !this.canAct(attacker, log)) return;

    const moveName = attacker.charging ?? this.pendingMoves?.get(attacker) ?? this.chooseMove(attacker, defender);
    const base = moveName === 'struggle' ? STRUGGLE : moveOf(moveName);
    attacker.turnsTaken++;

    if (!base) {
      log.push({ kind: 'move', side: attacker.side, data: { move: moveName } });
      return;
    }

    // The charge turn: everything but the move itself, and then the wait.
    if (hasFlag(base, 'charge') && !attacker.charging && !this.skipsCharge(attacker, moveName, log)) {
      const slot = this.movesOf(attacker).find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
      attacker.charging = moveName;
      log.push({ kind: 'charging', side: attacker.side, data: { move: moveName } });
      return;
    }

    // PP was already spent on the charge turn.
    if (!attacker.charging) {
      const slot = this.movesOf(attacker).find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
    }
    attacker.charging = null;

    // A move some evolution counts is counted on the Pokémon, for good.
    const counted = speciesOf(attacker.pokemon.speciesId)?.evolutions?.some((evolution) => evolution.usedMove === moveName);
    if (counted) {
      attacker.pokemon.moveUses ??= {};
      attacker.pokemon.moveUses[moveName] = (attacker.pokemon.moveUses[moveName] ?? 0) + 1;
    }

    // A Metronome pays for repeating the same move, so the count is kept even
    // when nothing is holding one.
    attacker.repeats = attacker.lastMove === moveName ? attacker.repeats + 1 : 0;
    attacker.lastMove = moveName;
    // A guard only gets harder to put up while it keeps going up.
    if (!PROTECT_MOVES[moveName]) attacker.volatile.protectStreak = 0;

    const move = this.effectiveMove(attacker, defender, base);

    // A Protean becomes whatever it is about to use.
    if (this.abilityOf(attacker)?.retypes === 'move') {
      if (this.becomeType(attacker, [move.type], log)) {
        log.splice(log.length - 1, 0, { kind: 'ability', side: attacker.side, data: { ability: abilityName(attacker.pokemon) } });
      }
    }

    // A Pressure on the other side charges a second point for being aimed at.
    if (this.abilityOf(defender)?.pressures) {
      const slot = this.movesOf(attacker).find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
    }

    log.push({ kind: 'move', side: attacker.side, data: { move: moveName } });

    // An Aegislash draws its blade to strike and raises its shield to guard,
    // before the move goes off.
    if (this.abilityOf(attacker)?.stanceChange) {
      const stance = move.damageClass !== 'status' ? 'blade' : moveName === 'kings-shield' ? 'shield' : null;
      if (stance && (attacker.marks.stance ?? 'shield') !== stance) {
        attacker.marks.stance = stance;
        const before = log.length;
        if (this.applyForme(attacker, this.formeState(attacker), log)) {
          log.splice(before, 0, { kind: 'ability', side: attacker.side, data: { ability: this.abilitySlugOf(attacker) } });
        }
      }
    }

    // Used after the first turn out, a Fake Out is only a lunge: the PP is
    // gone and nothing happens.
    if (FIRST_TURN_ONLY.has(moveName) && !this.firstTurnOut(attacker)) {
      log.push({ kind: 'failed', side: attacker.side });
      return;
    }

    if (SELF_KNOCKOUT.has(moveName)) {
      // A Damp keeps the thing from going off at all.
      if (moveName !== 'memento' && this.abilityOf(defender, attacker)?.dampens) {
        log.push({ kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
        log.push({ kind: 'failed', side: attacker.side });
        return;
      }
      // Paid however the rest of the move goes: `takeTurn` collects it once
      // the move is over, whichever way out of here it took.
      attacker.marks.spent = true;
    }

    // A move the defender is simply sealed against — a sound at a Soundproof,
    // a bullet at a Bulletproof, a powder at a Grass type or a pair of Safety
    // Goggles, a Thunder Wave at a Ground type — never gets as far as an
    // accuracy roll.
    if (this.movePrevented(attacker, defender, move)) {
      log.push({ kind: 'noEffect', side: defender.side });
      return;
    }

    // Something between the two of them.
    if (this.blockedByGuard(attacker, defender, move, moveName, log)) return;

    // A Magic Bounce sends a status move back where it came from.
    if (move.damageClass === 'status' && this.abilityOf(defender, attacker)?.bouncesStatus) {
      log.push({ kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
      log.push({ kind: 'bounced', side: defender.side });
      this.applyStatusMove(defender, attacker, move, log);
      return;
    }

    if (!this.rollAccuracy(attacker, defender, move)) {
      log.push({ kind: 'miss', side: attacker.side });
      this.afterMiss(attacker, log);
      return;
    }

    // A move that thaws its user does so whether or not it was meant to.
    if (attacker.pokemon.status === STATUS.FREEZE && hasFlag(move, 'defrost')) {
      attacker.pokemon.status = null;
      log.push({ kind: 'status', side: attacker.side, data: { status: null, thawed: true } });
    }

    const moveLogStart = log.length;
    // A Transform becomes the target outright.
    if (moveOf('transform')?.id === move.id) {
      if (!this.transformInto(attacker, defender, log)) log.push({ kind: 'failed', side: attacker.side });
    } else if (move.damageClass === 'status') {
      this.applyStatusMove(attacker, defender, move, log);
    } else {
      this.applyDamagingMove(attacker, defender, move, log);
    }

    // A quarter of the user's health, whatever the move did — which is the
    // only thing that brings a fight between two empty Pokémon to an end.
    if (moveName === 'struggle' && attacker.pokemon.hp > 0) {
      const recoil = Math.max(1, Math.floor(maxHp(attacker.pokemon) * STRUGGLE_RECOIL));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - recoil);
      log.push({ kind: 'damage', side: attacker.side, data: { amount: recoil, recoil: true } });
    }

    this.afterUse(attacker, defender, move, log);

    // A Relic Song that went off turns a Meloetta, and the next one turns it
    // back.
    const landed = log.slice(moveLogStart).some((entry) => entry.kind === 'damage' && entry.side === defender.side);
    if (moveName === 'relic-song' && landed) {
      attacker.marks.relicSongs = (attacker.marks.relicSongs ?? 0) + 1;
    }

    // Whatever a move caught in its mouth, or a shape its health had just
    // crossed into, is a shape change worth showing as it happens rather than
    // waiting for the turn to end. The turn-end check still runs, so this is
    // an early word on things that have already changed and no word at all on
    // things that have not.
    this.evaluateFormes(log);

    // A move that has to be recharged says so now, so the next turn can be
    // spent paying for it.
    if (hasFlag(move, 'recharge') && attacker.pokemon.hp > 0) attacker.mustRecharge = true;
  }

  /**
   * Whether a two-turn move goes off at once.
   *
   * A Power Herb buys the charge turn outright, and a Solar Beam does not need
   * one in sunshine.
   *
   * @param {Combatant} attacker
   * @param {string} moveName
   * @param {LogEntry[]} log
   */
  skipsCharge(attacker, moveName, log) {
    if (SUN_CHARGED.has(moveName) && this.weatherFor(attacker) === WEATHER.SUN) return true;

    const herb = heldPassive(attacker.pokemon, 'charge');
    if (!herb) return false;
    log.push({ kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.pokemon.heldItem = null;
    return true;
  }

  /**
   * The move as it actually leaves, once the attacker's ability has had a say
   * in what type it is.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  effectiveMove(attacker, defender, move) {
    // A signature move is whatever type the item behind it says: an Ivy
    // Cudgel the mask, a Judgment the plate, a Multi-Attack the memory, a
    // Techno Blast the drive.
    const signature = SIGNATURE_MOVES.get(speciesOf(attacker.pokemon.speciesId)?.slug ?? '');
    if (signature && moveOf(signature)?.id === move.id) {
      const type = signatureType(attacker.pokemon, signature);
      if (type && type !== move.type) move = { ...move, type };
    }
    // A move whose power is a matter of weight.
    const weighed = weightPower(move, this.weightOf(attacker), this.weightOf(defender));
    if (weighed !== null) move = { ...move, power: weighed };
    // A hungry Morpeko's Aura Wheel is Dark.
    if (attacker.marks.forme === 'morpeko-hangry' && moveOf('aura-wheel')?.id === move.id) {
      move = { ...move, type: 'dark' };
    }
    // A Stellar Terapagos's Tera Starstorm is Stellar — neutral on everything
    // — and hits from whichever of its two attacking stats is higher.
    if (attacker.marks.forme === STELLAR_FORME && moveOf('tera-starstorm')?.id === move.id) {
      const physical = this.stat(attacker, 'atk') > this.stat(attacker, 'spa');
      move = { ...move, type: 'stellar', damageClass: physical ? 'physical' : 'special' };
    }
    const ability = this.abilityOf(attacker);
    const retyped = ability?.moveType?.(this.abilityContext(attacker, defender, []), move);
    if (!retyped || retyped === move.type) return move;
    return { ...move, type: retyped, retyped: true };
  }

  /**
   * Whether the move never reaches the defender at all.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  movePrevented(attacker, defender, move) {
    // Psychic Terrain refuses a move that would cut the queue.
    if (terrainBlocksPriority(this.field.terrain, move.priority ?? 0, this.grounded(defender))) return true;

    // Powder does nothing to a Grass type, which is the one classification the
    // games gate on a type rather than on an ability.
    if (hasFlag(move, 'powder') && this.typesOf(defender).includes('grass')) return true;

    // Status moves ignore the type chart, all but Thunder Wave: electricity
    // still has to reach its target, and a Ground type is out of its way.
    if (TYPE_CHECKED_STATUS.has(attacker.lastMove ?? '') && typeEffectiveness(move.type, this.typesOf(defender)) === 0) {
      return true;
    }

    const shield = heldShield(defender.pokemon, 'flags');
    if (shield && move.flags?.some((flag) => shield.includes(flag))) return true;

    return Boolean(this.abilityOf(defender, attacker)?.blockMove?.(this.abilityContext(defender, attacker, []), move));
  }

  /**
   * Whether the Pokémon in front got behind something this turn, and what
   * running into it costs.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {string} moveName
   * @param {LogEntry[]} log
   */
  blockedByGuard(attacker, defender, move, moveName, log) {
    if (defender.volatile.protectTurn !== this.turn) return false;
    // A guard is something to hide behind, not something to stand behind while
    // the other side helps itself — a move aimed at its user goes through.
    if (move.damageClass === 'status' && !(move.statChanges ?? []).some((change) => change.change < 0)) {
      if ((move.meta?.ailment ?? 'none') === 'none') return false;
    }
    if (PROTECT_BYPASS.has(moveName)) return false;

    // An Unseen Fist reaches through one as long as it is touching, and a
    // Piercing Drill simply goes through.
    const ability = this.abilityOf(attacker);
    if (ability?.piercing || (ability?.unseenFist && hasFlag(move, 'contact'))) return false;

    log.push({ kind: 'protected', side: defender.side });

    // What the guard charges for touching it.
    const price = PROTECT_MOVES[defender.volatile.protectMove ?? ''] ?? {};
    if (!hasFlag(move, 'contact') || this.abilityOf(attacker)?.indirectImmune) return true;
    if (heldShield(attacker.pokemon, 'contactEffects')) return true;

    if (price.damage) {
      const amount = Math.max(1, Math.floor(attacker.maxHp * price.damage));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - amount);
      log.push({ kind: 'damage', side: attacker.side, data: { amount } });
    }
    if (price.stat) this.applyStage(attacker, price.stat, price.stages ?? -1, log);
    if (price.status) this.inflictStatus(attacker, STATUS_TO_AILMENT[price.status] ?? price.status, log);
    return true;
  }

  /**
   * What answering a missed move is worth: a Blunder Policy's two stages of
   * Speed, and nothing else.
   *
   * @param {Combatant} attacker
   * @param {LogEntry[]} log
   */
  afterMiss(attacker, log) {
    const policy = heldPassive(attacker.pokemon, 'miss');
    if (!policy) return;

    let used = false;
    for (const stat of policy.stats) {
      if (this.applyStage(attacker, stat, policy.stages ?? 1, log, { quiet: true })) used = true;
    }
    if (!used) return;
    log.push({ kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.pokemon.heldItem = null;
  }

  /**
   * What using a move of a particular class is worth to its user — which today
   * is a Throat Spray answering a sound move.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  afterUse(attacker, defender, move, log) {
    // A Gulp Missile has already been wearing what it caught since the move
    // that caught it, so this is where it catches it — the catch is
    // registered through the shared evaluateFormes, which re-reads the move
    // the combatant just used.
    this.evaluateFormes(log);

    const spray = heldPassive(attacker.pokemon, 'used');
    if (!spray || !spray.flags?.some((flag) => hasFlag(move, flag))) return;

    let used = false;
    for (const stat of spray.stats) {
      if (this.applyStage(attacker, stat, spray.stages ?? 1, log, { quiet: true })) used = true;
    }
    if (!used) return;
    log.push({ kind: 'berry', side: attacker.side, data: { item: attacker.pokemon.heldItem } });
    attacker.pokemon.heldItem = null;
  }

  /**
   * The upkeep a held item pays, or charges, at the end of a turn: the
   * Leftovers that give a sixteenth back, the Black Sludge that does the same
   * for a Poison type and poisons anything else that carries it.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnHeld(combatant, log) {
    // An orb hands its holder the condition it carries, which is the price of
    // whatever the holder wanted a burn or a poison for.
    const orb = heldPassive(combatant.pokemon, 'selfStatus');
    if (orb && !combatant.pokemon.status) {
      // An orb is not spent: it hands over the same condition every battle,
      // which is why anything holding one wanted it.
      const before = log.length;
      if (this.inflictStatus(combatant, STATUS_TO_AILMENT[orb.status] ?? orb.status, log)) {
        log.splice(before, 0, { kind: 'heldFired', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      }
    }

    // A White Herb puts back whatever was taken off it.
    const herb = heldPassive(combatant.pokemon, 'restore');
    if (herb && combatant.marks.lowered) {
      let restored = false;
      for (const [stat, stage] of Object.entries(combatant.stages)) {
        if (stage >= 0) continue;
        combatant.stages[stat] = 0;
        restored = true;
      }
      combatant.marks.lowered = false;
      if (restored) {
        log.push({ kind: 'restored', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
        if (herb.consumed) combatant.pokemon.heldItem = null;
      }
    }

    const held = heldPassive(combatant.pokemon, 'turn');
    if (!held) return;

    const max = maxHp(combatant.pokemon);
    const suits = !held.type || speciesOf(combatant.pokemon.speciesId).types.includes(held.type);

    if (suits && held.heal) {
      if (combatant.pokemon.hp >= max) return;
      const healed = Math.max(1, Math.floor(max * held.heal.fraction));
      combatant.pokemon.hp = Math.min(max, combatant.pokemon.hp + healed);
      log.push({ kind: 'heal', side: combatant.side, data: { amount: healed, item: combatant.pokemon.heldItem } });
      return;
    }

    // A Black Sludge only bites what it does not suit; a Sticky Barb names no
    // type at all and bites whoever is carrying it.
    if (held.harm && (held.type ? !suits : true) && !this.abilityOf(combatant)?.indirectImmune) {
      const damage = Math.max(1, Math.floor(max * held.harm.fraction));
      combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
      log.push({ kind: 'damage', side: combatant.side, data: { amount: damage, item: combatant.pokemon.heldItem } });
    }
  }

  /**
   * Whether a Rock Head or a Magic Guard spares its holder the recoil.
   * @param {Combatant} attacker
   */
  recoilFree(attacker) {
    const ability = this.abilityOf(attacker);
    return Boolean(ability?.recoilImmune || ability?.indirectImmune);
  }

  /**
   * Whether something keeps a Pokémon standing through a hit that would
   * otherwise knock it out — a Sturdy from full health, a Focus Sash from the
   * same, a Focus Band on a roll.
   *
   * @param {Combatant} defender
   * @param {number} damage
   * @returns {{consumed: boolean, ability?: boolean}|null}
   */
  survivesHit(defender, damage) {
    if (damage < defender.pokemon.hp) return null;

    // A Sturdy is a Focus Sash that never runs out.
    if (this.abilityOf(defender)?.sturdy && defender.pokemon.hp >= maxHp(defender.pokemon)) {
      return { consumed: false, ability: true };
    }

    const held = heldPassive(defender.pokemon, 'survive');
    if (!held) return null;

    if (held.fromFull && defender.pokemon.hp < maxHp(defender.pokemon)) return null;
    if (held.chance !== undefined && !this.rng.chance(held.chance)) return null;
    return { consumed: Boolean(held.consumed) };
  }

  /**
   * Eat a held berry whose moment has come, on either side.
   *
   * Both sides are checked now that they both carry things: a wild Pokémon
   * rolls its species' held item the way the cartridge rolls it, and a gym
   * leader's ace is handed a berry the way a gym leader's ace always is. The
   * bag's restock setting then replaces the companion's.
   *
   * @param {LogEntry[]} log
   */
  eatHeldBerry(log) {
    for (const combatant of [this.player, this.foe]) {
      if (combatant) this.eatOneBerry(combatant, log);
    }
  }

  /**
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  eatOneBerry(combatant, log) {
    // An Unnerve on the other side is what keeps a berry in its wrapper.
    const other = combatant === this.player ? this.foe : this.player;
    if (other && this.abilityOf(other)?.blocksBerries) return;

    // A Persim cures the confusion that never reaches the save, and a Lum
    // cures it along with everything else, so both are asked here rather than
    // through the trigger, which only sees what the Pokémon is carrying.
    const cure = heldPassive(combatant.pokemon, 'status');
    if (cure && (cure.status === 'cnf' || cure.status === 'any') && this.cureVolatile(combatant, log)) {
      log.push({ kind: 'berry', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
      combatant.pokemon.heldItem = null;
      return;
    }

    // A Gluttony reaches for a pinch berry at half rather than a quarter.
    const ability = this.abilityOf(combatant);
    const trigger = heldTrigger(combatant.pokemon, { early: Boolean(ability?.berryEarly) });
    if (!trigger) return;

    const { slug, held } = trigger;
    // A Ripen makes the berry worth twice what it says.
    const ripe = ability?.berryDouble ? { ...held, ...doubled(held) } : held;
    if (held.stat) {
      // A stat berry raises a stage, which lives on the combatant rather than
      // on the Pokémon, so the battle applies that one itself.
      const stat = held.stat === 'random' ? this.rng.pick(STAT_KEYS) : held.stat;
      if (!this.applyStage(combatant, stat, ripe.stages ?? 1, log, { source: 'self', quiet: true })) return;
    } else if (held.crit) {
      // A Lansat sharpens the next hit rather than raising a stat.
      combatant.marks.critStages = (combatant.marks.critStages ?? 0) + held.crit;
    } else if (held.accuracy) {
      combatant.marks.accuracy = held.accuracy;
    } else if (held.first) {
      // A Custap is spent when the turn order is decided, not here.
      return;
    } else if (!applyHeldEffect(combatant.pokemon, ripe)) {
      return;
    }

    combatant.pokemon.heldItem = null;
    combatant.marks.ateBerry = slug;
    log.push({ kind: 'berry', side: combatant.side, data: { item: slug } });

    // A Cheek Pouch is paid for eating whatever it was.
    if (ability?.onBerry) {
      log.push({ kind: 'ability', side: combatant.side, data: { ability: abilityName(combatant.pokemon) } });
      ability.onBerry(this.abilityContext(combatant, other ?? combatant, log));
    }
  }

  /**
   * A berry growing back in the holder's hand, which is what a Harvest does
   * half the time and a Cud Chew always does the turn after.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  regrowBerry(combatant, log) {
    const chance = this.abilityOf(combatant)?.regrowsBerry;
    if (!chance || combatant.pokemon.heldItem || !combatant.marks.ateBerry) return;
    if (!this.rng.chance(chance)) return;

    combatant.pokemon.heldItem = combatant.marks.ateBerry;
    combatant.marks.ateBerry = null;
    log.push({ kind: 'ability', side: combatant.side, data: { ability: abilityName(combatant.pokemon) } });
    log.push({ kind: 'regrew', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
  }

  /**
   * Sleep, freeze and paralysis can all keep a Pokémon from moving.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  canAct(combatant, log) {
    const pokemon = combatant.pokemon;

    if (pokemon.status === STATUS.SLEEP) {
      pokemon.statusTurns -= this.abilityOf(combatant)?.wakesTwiceAsFast ? 2 : 1;
      if (pokemon.statusTurns <= 0) {
        pokemon.status = null;
        log.push({ kind: 'status', side: combatant.side, data: { status: null, woke: true } });
        return true;
      }
      log.push({ kind: 'statusBlocked', side: combatant.side, data: { status: STATUS.SLEEP } });
      return false;
    }

    if (pokemon.status === STATUS.FREEZE) {
      // 20% thaw chance per turn, as in the games.
      if (this.rng.chance(0.2)) {
        pokemon.status = null;
        log.push({ kind: 'status', side: combatant.side, data: { status: null, thawed: true } });
        return true;
      }
      log.push({ kind: 'statusBlocked', side: combatant.side, data: { status: STATUS.FREEZE } });
      return false;
    }

    if (pokemon.status === STATUS.PARALYSIS && this.rng.chance(0.25)) {
      log.push({ kind: 'statusBlocked', side: combatant.side, data: { status: STATUS.PARALYSIS } });
      return false;
    }

    // Confusion is checked after the conditions in the save, as the games
    // order it, and lands its hit on the Pokémon itself rather than on
    // anything in front of it.
    if (hasVolatile(combatant, VOLATILE.CONFUSION)) {
      log.push({ kind: 'volatileActive', side: combatant.side, data: { state: VOLATILE.CONFUSION } });
      if (this.rng.chance(CONFUSION_SELF_HIT)) {
        this.hitSelf(combatant, log);
        return false;
      }
    }

    if (hasVolatile(combatant, VOLATILE.INFATUATION) && this.rng.chance(INFATUATION_BLOCK)) {
      log.push({ kind: 'volatileBlocked', side: combatant.side, data: { state: VOLATILE.INFATUATION } });
      return false;
    }

    return true;
  }

  /**
   * The hit a confused Pokémon lands on itself.
   *
   * A typeless physical 40 against its own Defence, with no type chart, no
   * critical roll and nothing held or able to change it — which is what makes
   * confusion worth inflicting on something that would otherwise out-tank you.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  hitSelf(combatant, log) {
    const level = levelOf(combatant.pokemon);
    const attack = this.stat(combatant, 'atk');
    const defence = this.stat(combatant, 'def');
    const base =
      Math.floor(Math.floor((Math.floor((2 * level) / 5 + 2) * CONFUSION_POWER * attack) / defence) / 50) + 2;
    const damage = Math.max(1, Math.floor(base * (this.rng.int(85, 100) / 100)));

    combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
    log.push({ kind: 'confusionDamage', side: combatant.side, data: { amount: damage } });
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  rollAccuracy(attacker, defender, move) {
    // A null accuracy means the move cannot miss, and so does a No Guard.
    if (move.accuracy === null || move.accuracy === undefined) return true;
    if (this.abilityOf(attacker)?.neverMisses || this.abilityOf(defender, attacker)?.neverMisses) return true;

    // The weather has the last word on a Thunder or a Blizzard.
    const fromWeather = weatherAccuracy(this.weatherFor(attacker), attacker.lastMove ?? '');
    if (fromWeather === 'always') return true;

    const attackerAbility = this.abilityOf(attacker);
    const defenderAbility = this.abilityOf(defender, attacker);

    // A Keen Eye reads straight through an evasion the defender has raised.
    const evasion = attackerAbility?.ignoresEvasion ? 0 : defender.stages.eva ?? 0;
    const stages = (attacker.stages.acc ?? 0) - evasion;

    const lens = heldPassive(attacker.pokemon, 'accuracy');
    const fromLens = lens && (!lens.movingLast || attacker.movedLast) ? lens.multiplier : 1;
    const fromMark = attacker.marks.accuracy ?? 1;
    attacker.marks.accuracy = 1;

    const chance =
      (move.accuracy / 100) *
      stageMultiplier(stages, true) *
      fromWeather *
      fromLens *
      fromMark *
      (attackerAbility?.accuracy?.(this.abilityContext(attacker, defender, []), move) ?? 1) *
      (defenderAbility?.evasion?.(this.abilityContext(defender, attacker, []), move) ?? 1) *
      (heldPassive(defender.pokemon, 'evasion')?.multiplier ?? 1);
    return this.rng.next() < chance;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applyDamagingMove(attacker, defender, move, log) {
    // A type the defender drinks rather than takes: the move lands and
    // something good happens to the target instead of damage.
    if (this.absorbMove(attacker, defender, move, log)) return;

    const hits = this.hitCount(attacker, move);
    let total = 0;
    let effectiveness = 1;
    let critical = false;

    for (let hit = 0; hit < hits && defender.pokemon.hp > 0; hit++) {
      const result = this.computeDamage(attacker, defender, move);
      effectiveness = result.effectiveness;
      critical = critical || result.critical;
      if (result.effectiveness === 0) break;

      // A Disguise or an Ice Face takes the hit and shatters instead of
      // letting any of it through — whatever the hit would have done.
      if (this.bustForme(attacker, defender)) {
        defender.marks.formeBroken = true;
        this.applyForme(defender, { ...this.formeState(defender), broken: true }, log);
        log.push({ kind: 'formBroken', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
        break;
      }

      const survives = this.survivesHit(defender, result.damage);
      defender.pokemon.hp = Math.max(survives ? 1 : 0, defender.pokemon.hp - result.damage);
      total += result.damage;
      if (survives) {
        log.push({
          kind: 'endure',
          side: defender.side,
          data: survives.ability
            ? { ability: abilityName(defender.pokemon) }
            : { item: defender.pokemon.heldItem },
        });
        if (survives.consumed) defender.pokemon.heldItem = null;
        break;
      }
    }

    if (effectiveness === 0) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness: 0 } });
      return;
    }

    // A shattering disguise took every hit of the move: there is nothing to
    // report as damage, and none of what hangs off damage — drain, recoil,
    // secondary effects — applies to a hit nobody took.
    if (total === 0) return;

    // A berry eaten on the way in is announced before the damage it softened.
    if (defender.marks.ateResist) {
      log.push({ kind: 'berry', side: defender.side, data: { item: defender.marks.ateResist } });
      defender.marks.ateResist = null;
    }

    // The hit lands first and the reasons follow it, which is the order the
    // games read in: the bar drains, then "급소에 맞았다!", then "효과가
    // 굉장했다!".
    log.push({ kind: 'damage', side: defender.side, data: { amount: total, hits } });
    if (critical) {
      log.push({ kind: 'critical', side: defender.side });
      // Three in one battle is how a Galarian Farfetch'd evolves.
      attacker.marks.crits = (attacker.marks.crits ?? 0) + 1;
      // An Anger Point turns a weak spot into the highest Attack there is.
      const angered = this.abilityOf(defender, attacker);
      if (angered?.onCrit && defender.pokemon.hp > 0) {
        log.push({ kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
        angered.onCrit(this.abilityContext(defender, attacker, log));
      }
    }
    if (effectiveness !== 1) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness } });
    }

    // Drain and recoil are expressed as a percentage of the damage dealt.
    const drain = move.meta?.drain ?? 0;
    if (drain > 0 && total > 0) {
      const healed = Math.max(1, Math.floor((total * drain) / 100));
      // A Liquid Ooze turns the drink into the same amount of damage.
      if (this.abilityOf(defender, attacker)?.drainHurts) {
        attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - healed);
        log.push({ kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
        log.push({ kind: 'damage', side: attacker.side, data: { amount: healed } });
      } else {
        attacker.pokemon.hp = Math.min(maxHp(attacker.pokemon), attacker.pokemon.hp + healed);
        log.push({ kind: 'heal', side: attacker.side, data: { amount: healed } });
      }
    } else if (drain < 0 && total > 0) {
      const recoil = Math.max(1, Math.floor((total * -drain) / 100));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - recoil);
      // A white-striped Basculin counts the recoil it has lived through.
      if (speciesOf(attacker.pokemon.speciesId)?.evolutions?.some((evolution) => evolution.recoil)) {
        attacker.pokemon.recoilTaken = attacker.pokemon.hp > 0 ? (attacker.pokemon.recoilTaken ?? 0) + recoil : 0;
      }
      log.push({ kind: 'damage', side: attacker.side, data: { amount: recoil, recoil: true } });
    }

    // A Shell Bell pays its holder a share of what it just dealt, and a Life
    // Orb charges for the extra damage it added.
    const shell = heldPassive(attacker.pokemon, 'drain');
    if (shell && total > 0 && attacker.pokemon.hp > 0) {
      const healed = Math.max(1, Math.floor(total * shell.fraction));
      const before = attacker.pokemon.hp;
      attacker.pokemon.hp = Math.min(maxHp(attacker.pokemon), attacker.pokemon.hp + healed);
      if (attacker.pokemon.hp !== before) {
        log.push({ kind: 'heal', side: attacker.side, data: { amount: attacker.pokemon.hp - before } });
      }
    }

    const orb = heldPassive(attacker.pokemon, 'damage');
    if (orb?.cost && total > 0) {
      const cost = Math.max(1, Math.floor(maxHp(attacker.pokemon) * orb.cost));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - cost);
      log.push({ kind: 'damage', side: attacker.side, data: { amount: cost, recoil: true } });
    }

    defender.marks.lastDamage = total;
    if (total > 0) this.answerHit(attacker, defender, move, total, effectiveness, log);
    this.applySecondaryEffects(attacker, defender, move, log);
  }

  /**
   * How many times a move lands.
   *
   * A Skill Link and a pair of Loaded Dice both push a multi-hit move towards
   * the top of its range, from opposite directions: the ability takes the
   * maximum every time, the item raises the floor.
   *
   * @param {Combatant} attacker
   * @param {any} move
   */
  hitCount(attacker, move) {
    const min = move.meta?.minHits;
    // A Parental Bond adds a second, weaker hit to a move that had one.
    if (!min) return this.abilityOf(attacker)?.hitsTwice && move.damageClass !== 'status' ? 2 : 1;
    const max = move.meta.maxHits ?? min;

    if (this.abilityOf(attacker)?.maxHits) return max;
    const dice = heldPassive(attacker.pokemon, 'multiHit');
    return this.rng.int(dice ? Math.min(max, dice.min) : min, max);
  }

  /**
   * The charge an ability stored off something aimed at it, spent on the next
   * Electric move that goes out.
   *
   * @param {Combatant} attacker
   * @param {any} move
   */
  chargeMultiplier(attacker, move) {
    if (!attacker.marks.charged || move.type !== 'electric') return 1;
    attacker.marks.charged = false;
    return 2;
  }

  /**
   * A type the defender takes something other than damage from.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   * @returns {boolean} whether the move was drunk rather than taken
   */
  absorbMove(attacker, defender, move, log) {
    const ability = this.abilityOf(defender, attacker);
    const absorbed = ability?.absorb?.(this.abilityContext(defender, attacker, log), move);
    if (!absorbed) return false;

    const context = this.abilityContext(defender, attacker, log);
    log.push({ kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });

    if (absorbed.heal) context.heal(defender, absorbed.heal);
    if (absorbed.stat) context.raise(defender, absorbed.stat, absorbed.stages ?? 1);
    if (absorbed.mark) defender.marks[absorbed.mark] = true;
    if (!absorbed.heal && !absorbed.stat && !absorbed.mark) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness: 0 } });
    }
    return true;
  }

  /**
   * Whether the hit that just reached the defender broke something about its
   * shape instead of hurting it — a Disguise shattering, an Ice Face coming
   * off. The first hit only, and not while a Mold Breaker is swinging.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @returns {boolean}
   */
  bustForme(attacker, defender) {
    if (defender.marks.formeBroken) return false;
    return Boolean(this.abilityOf(defender, attacker)?.busted);
  }

  /**
   * The broken shape of a Disguise or an Ice Face, if the species wears one.
   *
   * @param {import('./pokemon.mjs').Pokemon} pokemon
   * @returns {string|null}
   */
  bustedFormeOf(pokemon) {
    const species = speciesOf(pokemon.speciesId);
    if (!species) return null;
    const slug = species.slug;
    return slug === 'mimikyu' ? 'mimikyu-busted' : slug === 'eiscue' ? 'eiscue-noice' : null;
  }

  /**
   * What taking a hit costs the Pokémon that landed it, and what it is worth
   * to the one that took it.
   *
   * Contact is the classification most of this hangs off — a Static only fires
   * when something touched it — and a Punching Glove or a pair of Protective
   * Pads is a way of not touching.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {number} damage
   * @param {number} effectiveness
   * @param {LogEntry[]} log
   */
  answerHit(attacker, defender, move, damage, effectiveness, log) {
    // A balloon pops on the first hit that reaches it, whatever the hit was.
    const balloon = heldPassive(defender.pokemon, 'immune');
    if (balloon?.popped && !defender.marks.popped) {
      defender.marks.popped = true;
      log.push({ kind: 'berry', side: defender.side, data: { item: defender.pokemon.heldItem } });
      defender.pokemon.heldItem = null;
    }

    if (defender.pokemon.hp > 0) {
      this.answerWithItem(attacker, defender, move, effectiveness, log);
      const ability = this.abilityOf(defender, attacker);

      // A Color Change becomes whatever just hit it.
      if (ability?.retypes === 'hit') this.becomeType(defender, [move.type], log);
      // And the two that store a charge off it.
      if (ability?.absorbCharge?.(this.abilityContext(defender, attacker, log), move)) {
        defender.marks.charged = true;
        log.push({ kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
      }

      const before = log.length;
      ability?.hit?.(this.abilityContext(defender, attacker, log), move, damage);
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
      }
    }

    // And what landing one is worth to the Pokémon that did.
    const dealt = this.abilityOf(attacker);
    if (dealt?.onHitDealt && attacker.pokemon.hp > 0) {
      const before = log.length;
      dealt.onHitDealt(this.abilityContext(attacker, defender, log), move, damage);
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: attacker.side, data: { ability: abilityName(attacker.pokemon) } });
      }
    }

    if (!this.touches(attacker, defender, move)) return;

    // What the attacker walks into by touching: an ability, and a helmet.
    if (defender.pokemon.hp > 0) {
      const ability = this.abilityOf(defender, attacker);
      const before = log.length;
      ability?.contact?.(this.abilityContext(defender, attacker, log));
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: defender.side, data: { ability: abilityName(defender.pokemon) } });
      }
    }

    const helmet = heldPassive(defender.pokemon, 'contact');
    if (helmet?.recoil && attacker.pokemon.hp > 0 && !this.abilityOf(attacker)?.indirectImmune) {
      const amount = Math.max(1, Math.floor(maxHp(attacker.pokemon) * helmet.recoil.fraction));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - amount);
      log.push({ kind: 'damage', side: attacker.side, data: { amount, item: defender.pokemon.heldItem } });
    }
  }

  /**
   * Whether a move counts as touching for everything that keys off contact.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  touches(attacker, defender, move) {
    if (!hasFlag(move, 'contact')) return false;
    // A Long Reach never touches anything.
    if (this.abilityOf(attacker)?.noContact) return false;
    // A Punching Glove takes the contact out of a punch, and Protective Pads
    // keep whatever is on the other side from mattering.
    const glove = heldPassive(attacker.pokemon, 'damage');
    if (glove?.dropsContact && glove.flags?.some((flag) => hasFlag(move, flag))) return false;
    return !heldShield(attacker.pokemon, 'contactEffects');
  }

  /**
   * The held items that answer being hit: the policies, the bulbs and the
   * berries with thorns on.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {number} effectiveness
   * @param {LogEntry[]} log
   */
  answerWithItem(attacker, defender, move, effectiveness, log) {
    const held = heldPassive(defender.pokemon, 'hurt');
    if (!held) return;
    if (held.superEffective && effectiveness <= 1) return;
    if (held.moveType && move.type !== held.moveType) return;
    if (held.damageClass && move.damageClass !== held.damageClass) return;

    const slug = defender.pokemon.heldItem;
    let used = false;

    for (const stat of held.stats ?? []) {
      if (this.applyStage(defender, stat, held.stages ?? 1, log, { quiet: true })) used = true;
    }
    if (held.heal) {
      const max = maxHp(defender.pokemon);
      const amount = Math.max(1, Math.floor(max * held.heal.fraction));
      if (defender.pokemon.hp < max) {
        defender.pokemon.hp = Math.min(max, defender.pokemon.hp + amount);
        log.push({ kind: 'heal', side: defender.side, data: { amount } });
        used = true;
      }
    }
    if (held.recoil && attacker.pokemon.hp > 0) {
      const amount = Math.max(1, Math.floor(maxHp(attacker.pokemon) * held.recoil.fraction));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - amount);
      log.push({ kind: 'damage', side: attacker.side, data: { amount, item: slug } });
      used = true;
    }

    if (!used) return;
    log.push({ kind: 'berry', side: defender.side, data: { item: slug } });
    if (held.consumed) defender.pokemon.heldItem = null;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @returns {{damage: number, effectiveness: number, critical: boolean}}
   */
  computeDamage(attacker, defender, move) {
    const level = levelOf(attacker.pokemon);
    const physical = move.damageClass === 'physical';
    const attackStat = physical ? 'atk' : 'spa';
    const defenceStat = physical ? 'def' : 'spd';

    const attackerAbility = this.abilityOf(attacker);
    const defenderAbility = this.abilityOf(defender, attacker);
    const effectiveness = this.effectivenessOf(attacker, move, defender);
    if (effectiveness === 0) return { damage: 0, effectiveness: 0, critical: false };

    const critical = this.rollCritical(attacker, defender, move);
    // An Unaware on either side reads the other's stages as zero: the
    // attacker's boosts do not help it, the defender's walls do not hold.
    const blindAttacker = Boolean(defenderAbility?.ignoresStages);
    const blindDefender = Boolean(attackerAbility?.ignoresStages);
    const attack = this.stat(attacker, attackStat, {
      ...(critical ? { ignoreNegative: true } : {}),
      ...(blindAttacker ? { ignoreStages: true } : {}),
    });
    const defence = this.stat(defender, defenceStat, {
      ...(critical ? { ignorePositive: true } : {}),
      ...(blindDefender ? { ignoreStages: true } : {}),
    });

    const base = Math.floor(
      Math.floor((Math.floor((2 * level) / 5 + 2) * (move.power ?? 0) * attack) / defence) / 50,
    ) + 2;

    const stab = this.typesOf(attacker).includes(move.type) ? 1.5 : 1;

    // Burn halves physical damage, unless the ability holding it is the sort
    // that thrives on a condition.
    const burn =
      physical && attacker.pokemon.status === STATUS.BURN && !attackerAbility?.ignoresBurn ? 0.5 : 1;
    const spread = this.rng.int(85, 100) / 100;
    const criticalBonus = critical ? 1.5 * (attackerAbility?.critBonus ?? 1) : 1;

    const attackContext = this.abilityContext(attacker, defender, [], { retyped: Boolean(move.retyped) });
    const defendContext = this.abilityContext(defender, attacker, []);
    const abilityPower = attackerAbility?.power?.(attackContext, move, effectiveness) ?? 1;
    const abilityTaken = defenderAbility?.taken?.(defendContext, move, effectiveness) ?? 1;
    const aura = auraMultiplier([this.abilityOf(attacker), this.abilityOf(defender)], move);

    const held = this.heldDamage(attacker, move, effectiveness);
    const charged = attackerAbility?.absorbCharge ? this.chargeMultiplier(attacker, move) : 1;
    const resisted = this.heldResist(defender, move, effectiveness);
    const weather = weatherDamage(this.weatherFor(attacker), move.type);
    const terrain = terrainDamage(
      this.field.terrain,
      move.type,
      this.grounded(attacker),
      this.grounded(defender),
    );
    // An Infiltrator is not stopped by anything the other side put up.
    const screen = attackerAbility?.infiltrates ? 1 : this.screenMultiplier(defender, move, critical);
    const formula = Math.floor(
      base *
        stab *
        effectiveness *
        burn *
        spread *
        criticalBonus *
        held *
        resisted *
        abilityPower *
        abilityTaken *
        aura *
        weather *
        terrain *
        screen *
        charged,
    );
    // The companion's armour comes off the finished hit, weakness and all.
    const damage = Math.max(1, Math.floor(formula * companionArmour(defender, effectiveness)));
    return { damage, effectiveness, critical };
  }

  /**
   * How well a move goes against what is in front of it.
   *
   * A Scrappy or a Mind's Eye reads a Ghost's immunity to Normal and Fighting
   * as no immunity at all, which is the one thing that can turn a zero into
   * something.
   *
   * @param {Combatant} attacker
   * @param {any} move
   * @param {Combatant} defender
   */
  effectivenessOf(attacker, move, defender) {
    const types = this.typesOf(defender);
    const plain = typeEffectiveness(move.type, types);
    if (plain > 0) return plain;

    const ability = this.abilityOf(attacker);
    if (!ability?.hitsGhosts || !['normal', 'fighting'].includes(move.type)) return plain;
    // Only the Ghost part of the immunity is ignored; the rest of the chart
    // still applies, so a Ghost/Flying takes the Flying half as usual.
    return typeEffectiveness(move.type, types.filter((type) => type !== 'ghost'));
  }

  /**
   * Whether this hit lands on a weak spot.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   */
  rollCritical(attacker, defender, move) {
    const armour = this.abilityOf(defender, attacker)?.crit?.(this.abilityContext(defender, attacker, []));
    if (armour?.immune) return false;

    const sharp = this.abilityOf(attacker)?.crit?.(this.abilityContext(attacker, defender, []));
    if (sharp?.always) return true;

    const lens = heldPassive(attacker.pokemon, 'crit');
    const fromItem = lens && itemSuits(lens, attacker.pokemon) ? lens.stages ?? 0 : 0;
    const stage =
      (move.meta?.critRate ?? 0) + fromItem + (sharp?.stages ?? 0) + (attacker.marks.critStages ?? 0);
    return this.rng.next() < criticalChance(stage);
  }

  /**
   * How much a screen on the defender's side softens this hit.
   *
   * A critical hit goes straight through one, as it always has.
   *
   * @param {Combatant} defender
   * @param {any} move
   * @param {boolean} critical
   */
  screenMultiplier(defender, move, critical) {
    if (critical || move.damageClass === 'status') return 1;
    return this.field.screens[defender.side][move.damageClass] > 0 ? 0.5 : 1;
  }

  /**
   * How much the attacker's held item multiplies this move.
   *
   * @param {Combatant} attacker
   * @param {any} move
   * @param {number} effectiveness
   */
  heldDamage(attacker, move, effectiveness) {
    const held = heldPassive(attacker.pokemon, 'damage');
    if (!held || !itemSuits(held, attacker.pokemon)) return 1;

    // A Metronome pays for persistence rather than for the move itself.
    if (held.consecutive) {
      return Math.min(held.max ?? 2, 1 + held.consecutive * attacker.repeats);
    }
    if (held.moveTypes) return held.moveTypes.includes(move.type) ? held.multiplier : 1;
    if (held.moveType) return move.type === held.moveType ? held.multiplier : 1;
    if (held.flags) return held.flags.some((flag) => hasFlag(move, flag)) ? held.multiplier : 1;
    if (held.damageClass) return move.damageClass === held.damageClass ? held.multiplier : 1;
    if (held.superEffective) return effectiveness > 1 ? held.multiplier : 1;
    return held.multiplier ?? 1;
  }

  /**
   * The type-resisting berries: eaten on the way in, and the only held effect
   * that changes a hit the holder is in the middle of taking.
   *
   * @param {Combatant} defender
   * @param {any} move
   * @param {number} effectiveness
   */
  heldResist(defender, move, effectiveness) {
    const berry = heldPassive(defender.pokemon, 'resist');
    if (!berry || berry.moveType !== move.type) return 1;
    if (berry.superEffectiveOnly && effectiveness <= 1) return 1;

    defender.marks.ateResist = defender.pokemon.heldItem;
    defender.pokemon.heldItem = null;
    return berry.multiplier;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applySecondaryEffects(attacker, defender, move, log) {
    const meta = move.meta;
    if (!meta) return;

    const ability = this.abilityOf(attacker);
    // Sheer Force trades every secondary effect away for the damage it adds;
    // a Covert Cloak and a Shield Dust refuse them from the other side.
    if (ability?.noSecondary || heldShield(defender.pokemon, 'secondary')) return;
    if (this.abilityOf(defender, attacker)?.noSecondaryTaken) return;

    // Serene Grace doubles the odds of whatever a move was already going to do.
    const odds = ability?.secondary ?? 1;

    const jealous = !RAISED_THIS_TURN_ONLY.has(attacker.lastMove ?? '') || defender.marks.raisedTurn === this.turn;
    if (meta.ailment && meta.ailment !== 'none' && meta.ailmentChance > 0 && jealous) {
      if (this.rng.next() < (meta.ailmentChance / 100) * odds) this.inflictAilment(attacker, defender, meta.ailment, log);
    }

    const flinchChance = Math.max(
      meta.flinchChance / 100,
      // A King's Rock adds a flinch to a move that had none, and Stench does
      // the same for an ability.
      hasFlag(move, 'contact') || move.damageClass !== 'status'
        ? Math.max(heldPassive(attacker.pokemon, 'flinch')?.chance ?? 0, ability?.flinch ?? 0)
        : 0,
    );
    if (flinchChance > 0 && this.rng.next() < flinchChance * odds && !this.abilityOf(defender, attacker)?.flinchImmune) {
      defender.flinched = true;
    }

    if (move.statChanges?.length && meta.statChance > 0) {
      if (this.rng.next() < (meta.statChance / 100) * odds) {
        this.applyStatChanges(attacker, defender, move, log);
      }
    }
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applyStatusMove(attacker, defender, move, log) {
    const meta = move.meta;
    const before = log.length;
    let did = false;

    // A move that calls the weather, lays the terrain or puts up a screen.
    const field = FIELD_MOVES[attacker.lastMove ?? ''];
    if (field) {
      if (field.weather && this.startWeather(field.weather, attacker, log)) did = true;
      if (field.terrain && this.startTerrain(field.terrain, attacker, log)) did = true;
      if (field.screen) {
        const clay = heldPassive(attacker.pokemon, 'extend');
        const turns = clay?.what === 'screen' ? clay.turns : FIELD_TURNS;
        if (this.field.setScreen(attacker.side, /** @type {any} */ (field.screen), turns)) {
          log.push({ kind: 'screen', side: attacker.side, data: { screen: field.screen, turns } });
          did = true;
        }
      }
      // A Trick Room twists the order of the turn for everyone, and a
      // Tailwind blows behind the side that called it.
      if (field.room) {
        const state = this.field.toggleTrickRoom();
        log.push({ kind: 'trickRoom', side: attacker.side, data: { state } });
        did = true;
      }
      if (field.tailwind && this.field.setTailwind(attacker.side)) {
        log.push({ kind: 'tailwind', side: attacker.side });
        did = true;
      }
      // A hazard is laid at the other side's feet, not at the user's.
      if (field.hazard && this.field.addHazard(defender.side, field.hazard)) {
        log.push({ kind: 'hazard', side: defender.side, data: { hazard: field.hazard } });
        did = true;
      }
    }

    // Getting behind something for the turn.
    const guard = PROTECT_MOVES[attacker.lastMove ?? ''];
    if (guard) {
      const streak = attacker.volatile.protectStreak ?? 0;
      if (this.rng.chance(protectChance(streak))) {
        attacker.volatile.protectStreak = streak + 1;
        attacker.volatile.protectTurn = this.turn;
        attacker.volatile.protectMove = attacker.lastMove;
        log.push({ kind: 'protect', side: attacker.side, data: { move: attacker.lastMove } });
        did = true;
      } else {
        attacker.volatile.protectStreak = 0;
      }
    }

    // Taking a move away.
    const lock = LOCK_MOVES[attacker.lastMove ?? ''];
    if (lock && this.applyLock(attacker, defender, lock, log)) did = true;

    if (meta?.healing > 0) {
      // Sunshine makes a Synthesis worth two thirds of a bar and any other
      // weather a quarter; every other healing move takes its own number.
      const healing = weatherHealing(this.weatherFor(attacker), attacker.lastMove ?? '', meta.healing);
      const amount = Math.max(1, Math.floor((maxHp(attacker.pokemon) * healing) / 100));
      const before = attacker.pokemon.hp;
      attacker.pokemon.hp = Math.min(maxHp(attacker.pokemon), attacker.pokemon.hp + amount);
      if (attacker.pokemon.hp !== before) {
        log.push({ kind: 'heal', side: attacker.side, data: { amount: attacker.pokemon.hp - before } });
        did = true;
      }
    }

    if (meta?.ailment && meta.ailment !== 'none') {
      // A status move's listed chance is 0 when it always applies.
      const chance = meta.ailmentChance > 0 ? meta.ailmentChance / 100 : 1;
      if (this.rng.next() < chance && this.inflictAilment(attacker, defender, meta.ailment, log)) did = true;
    }

    if (move.statChanges?.length) {
      if (this.applyStatChanges(attacker, defender, move, log)) did = true;
    }

    // "하지만 실패했다!" — which is a different thing from a type the move
    // cannot touch, and is only worth saying when nothing else was. A Swords
    // Dance at the ceiling has already said that its Attack will go no
    // higher, and a Clear Body has already refused the drop in its own name.
    if (!did && log.length === before) log.push({ kind: 'failed', side: attacker.side });
  }

  /**
   * Take a move, or every status move, away from the Pokémon in front.
   *
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {{state: string, turns: number}} lock
   * @param {LogEntry[]} log
   */
  applyLock(attacker, defender, lock, log) {
    // A Disable and an Encore both need something to have been used first.
    if (lock.state === VOLATILE.DISABLE || lock.state === VOLATILE.ENCORE) {
      if (!defender.lastMove || !this.movesOf(defender).some((slot) => slot.move === defender.lastMove)) {
        return false;
      }
    }
    if (this.blocksVolatile(defender, lock.state, log)) return false;

    const extra =
      lock.state === VOLATILE.DISABLE
        ? { disabledMove: defender.lastMove }
        : lock.state === VOLATILE.ENCORE
          ? { encoreMove: defender.lastMove }
          : {};
    if (!addVolatile(defender, lock.state, lock.turns, extra)) return false;

    log.push({ kind: 'volatile', side: defender.side, data: { state: lock.state, move: defender.lastMove } });
    // A Mental Herb is spent the moment something is taken away.
    this.eatMentalHerb(defender, log);
    return true;
  }

  /**
   * A Mental Herb, which undoes whatever has just been taken away.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  eatMentalHerb(combatant, log) {
    if (!heldPassive(combatant.pokemon, 'free')) return;

    let freed = false;
    for (const state of [VOLATILE.INFATUATION, VOLATILE.TAUNT, VOLATILE.ENCORE, VOLATILE.DISABLE, VOLATILE.TORMENT]) {
      if (!clearVolatile(combatant, state)) continue;
      log.push({ kind: 'volatileEnded', side: combatant.side, data: { state } });
      freed = true;
    }
    if (!freed) return;
    log.push({ kind: 'heldFired', side: combatant.side, data: { item: combatant.pokemon.heldItem } });
    combatant.pokemon.heldItem = null;
  }

  /**
   * What a Pokémon just sent out walks onto.
   *
   * Only the opponent's side ever has anything on it in practice — the
   * companion never leaves the field — but the toll is read the same way for
   * both, because the rule is the rule.
   *
   * @param {Combatant} arriving
   * @param {LogEntry[]} log
   */
  walkOntoHazards(arriving, log) {
    const hazards = this.field.hazards[arriving.side];
    if (Object.values(hazards).every((layers) => layers === 0)) return;

    // A pair of Heavy-Duty Boots steps over the lot.
    if (heldShield(arriving.pokemon, 'hazards')) return;

    const types = this.typesOf(arriving);
    const toll = hazardToll(hazards, { types, grounded: this.grounded(arriving) }, typeEffectiveness);

    if (toll.absorbs) {
      hazards.toxicSpikes = 0;
      log.push({ kind: 'hazardCleared', side: arriving.side, data: { hazard: 'toxicSpikes' } });
    }
    if (toll.damage > 0 && !this.abilityOf(arriving)?.indirectImmune) {
      const amount = Math.max(1, Math.floor(arriving.maxHp * toll.damage));
      arriving.pokemon.hp = Math.max(0, arriving.pokemon.hp - amount);
      log.push({ kind: 'hazardDamage', side: arriving.side, data: { amount } });
    }
    if (toll.stat) this.applyStage(arriving, toll.stat, -1, log);
    if (toll.status && arriving.pokemon.hp > 0) {
      this.inflictStatus(arriving, STATUS_TO_AILMENT[toll.status] ?? toll.status, log);
    }
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   * @returns {boolean} whether any stage actually moved
   */
  applyStatChanges(attacker, defender, move, log) {
    // A move that raises stats targets its user; one that lowers them targets
    // the opponent. That holds for essentially every move in the games — bar
    // the two that raise the opponent's on purpose, to confuse something that
    // now hits harder, which the move data files under its own category.
    const raisesTheOther = move.meta?.category === 'swagger';
    let changed = false;
    for (const change of move.statChanges) {
      const target = change.change > 0 && !raisesTheOther ? attacker : defender;
      // A Clear Amulet refuses a drop the other side is trying to apply.
      if (change.change < 0 && heldShield(target.pokemon, 'statDrops')) continue;
      if (this.applyStage(target, change.stat, change.change, log)) changed = true;
    }
    return changed;
  }

  /**
   * Hand a Pokémon whatever condition a move or an ability is trying to give
   * it, major or not.
   *
   * The five that go into the save go one way and the two that end with the
   * battle go the other, but a move does not distinguish between them — a
   * Confuse Ray and a Thunder Wave are both a move with an ailment on it — so
   * neither does the caller.
   *
   * @param {Combatant} source who is doing it
   * @param {Combatant} target
   * @param {string} ailment as the move data names it
   * @param {LogEntry[]} log
   * @returns {boolean} whether it took hold
   */
  inflictAilment(source, target, ailment, log) {
    if (ailment === 'confusion') return this.confuse(target, log);
    if (ailment === 'infatuation') return this.infatuate(source, target, log);
    return this.inflictStatus(target, ailment, log);
  }

  /**
   * Confuse a Pokémon for the two to five turns the games roll.
   *
   * @param {Combatant} target
   * @param {LogEntry[]} log
   */
  confuse(target, log) {
    if (target.pokemon.hp <= 0) return false;
    if (this.blocksVolatile(target, VOLATILE.CONFUSION, log)) return false;
    if (!addVolatile(target, VOLATILE.CONFUSION, this.rng.int(...CONFUSION_TURNS))) return false;

    log.push({ kind: 'volatile', side: target.side, data: { state: VOLATILE.CONFUSION } });
    // A Persim Berry is eaten the moment the confusion lands, as it is in the
    // games; the ordinary berry check would not come round until the turn ends.
    this.eatOneBerry(target, log);
    return true;
  }

  /**
   * Infatuate a Pokémon with the one in front of it, which needs one of each.
   *
   * @param {Combatant} source
   * @param {Combatant} target
   * @param {LogEntry[]} log
   */
  infatuate(source, target, log) {
    if (target.pokemon.hp <= 0) return false;
    if (!oppositeGenders(source.pokemon, target.pokemon)) return false;
    if (this.blocksVolatile(target, VOLATILE.INFATUATION, log)) return false;
    // No clock: it lasts as long as the pair are facing each other.
    if (!addVolatile(target, VOLATILE.INFATUATION, Infinity)) return false;

    log.push({ kind: 'volatile', side: target.side, data: { state: VOLATILE.INFATUATION } });
    this.eatOneBerry(target, log);
    return true;
  }

  /**
   * Clear the states a medicine can reach: the confusion and the infatuation
   * that a Full Heal or a Lum Berry says it cures.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   * @returns {boolean} whether there was anything to clear
   */
  cureVolatile(combatant, log) {
    let cured = false;
    for (const state of [VOLATILE.CONFUSION, VOLATILE.INFATUATION]) {
      if (!clearVolatile(combatant, state)) continue;
      log.push({ kind: 'volatileEnded', side: combatant.side, data: { state } });
      cured = true;
    }
    return cured;
  }

  /**
   * Whether something keeps a battle-long state off a Pokémon: an ability, a
   * herb, or Misty Terrain under its feet.
   *
   * @param {Combatant} target
   * @param {string} state
   * @param {LogEntry[]} log
   */
  blocksVolatile(target, state, log) {
    if (this.field.terrain === TERRAIN.MISTY && this.grounded(target)) return true;

    const other = target === this.player ? this.foe : this.player;
    const ability = this.abilityOf(target, other ?? undefined);
    if (ability?.blockVolatile?.(this.abilityContext(target, other ?? target, log), state)) {
      log.push({ kind: 'ability', side: target.side, data: { ability: abilityName(target.pokemon) } });
      return true;
    }
    return false;
  }

  /**
   * @param {Combatant} target
   * @param {string} ailment
   * @param {LogEntry[]} log
   * @returns {boolean} whether it took hold
   */
  inflictStatus(target, ailment, log) {
    const status = AILMENT_TO_STATUS[ailment];
    if (!status) return false;
    if (target.pokemon.status) return false;

    const types = this.typesOf(target);
    const source = target === this.player ? this.foe : this.player;
    // A Corrosion poisons the two types that are supposed to be past it.
    const corrodes = status === STATUS.POISON && this.abilityOf(source ?? target)?.corrodes;
    if (!corrodes && IMMUNE_TYPES[status]?.some((type) => types.includes(type))) return false;

    // Nothing freezes in sunshine, which is the one condition the weather has
    // an opinion about.
    if (status === STATUS.FREEZE && this.weatherFor(target) === WEATHER.SUN) return false;

    // Misty Terrain keeps everything off whatever is standing on it; Electric
    // Terrain only keeps it awake.
    if (terrainBlocksStatus(this.field.terrain, status) && this.grounded(target)) return false;

    const other = source;
    const ability = this.abilityOf(target, other ?? undefined);
    if (ability?.blockStatus?.(this.abilityContext(target, other ?? target, log), status)) {
      log.push({ kind: 'ability', side: target.side, data: { ability: abilityName(target.pokemon) } });
      return false;
    }

    target.pokemon.status = status;
    target.pokemon.statusTurns = status === STATUS.SLEEP ? this.rng.int(1, 3) : 0;
    log.push({ kind: 'status', side: target.side, data: { status } });

    // A Synchronize passes what it was given straight back.
    if (ability?.reflectsStatus && other && other.pokemon.hp > 0 && !other.pokemon.status) {
      log.push({ kind: 'ability', side: target.side, data: { ability: abilityName(target.pokemon) } });
      this.inflictStatus(other, ailment, log);
    }
    return true;
  }

  /**
   * Burn and poison bite at the end of the turn.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnStatus(combatant, log) {
    const status = combatant.pokemon.status;
    if (status !== STATUS.BURN && status !== STATUS.POISON) return;

    const ability = this.abilityOf(combatant);
    // A Magic Guard takes nothing it was not hit by, and a Poison Heal is fed
    // by the poison rather than worn down by it.
    if (ability?.indirectImmune) return;
    if (status === STATUS.POISON && ability?.feedsOnPoison) return;

    const damage = Math.max(1, Math.floor(maxHp(combatant.pokemon) / 16));
    combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
    log.push({ kind: 'statusDamage', side: combatant.side, data: { status, amount: damage } });
  }

  /** @param {LogEntry[]} log */
  checkFaint(log) {
    if (!this.running || !this.foe) return;

    if (this.foe.pokemon.hp <= 0) {
      // The Pokémon itself rides along with the entry. A whole turn is played
      // back after the engine has finished it, and by then `this.foe` is the
      // next one out — or nothing at all, the fight being over — so a screen
      // reading the entry later has no other way to name what just fell.
      const fallen = this.foe.pokemon;
      log.push({ kind: 'faint', side: 'foe', data: { speciesId: fallen.speciesId, pokemon: fallen } });
      this.onFaint(this.foe, log);
      this.onKnockOut(this.player, this.foe, log);
      this.awardExperience(this.foe, log);

      const next = this.foeQueue.shift();
      if (next) {
        this.foe = next;
        log.push({
          kind: 'sendOut',
          side: 'foe',
          data: { speciesId: next.pokemon.speciesId, pokemon: next.pokemon },
        });
        // It walks onto whatever was laid down for the one before it, and
        // then does whatever its own ability does on the way in.
        this.walkOntoHazards(next, log);
        this.enter(next, log);
      } else {
        this.foe = null;
      }
    }

    // The companion can go down in the same moment as what it was fighting —
    // to a Struggle's recoil, to a Life Orb, to an Aftermath — and being the
    // last one standing on no hit points is not a win. Checked after the foe
    // rather than instead of it, so the knock-out it earned still counts.
    if (this.player.pokemon.hp <= 0) {
      // Fainting starts a Basculin's count of recoil over.
      if (this.player.pokemon.recoilTaken) this.player.pokemon.recoilTaken = 0;
      log.push({
        kind: 'faint',
        side: 'player',
        data: { speciesId: this.player.pokemon.speciesId, pokemon: this.player.pokemon },
      });
      this.onFaint(this.player, log);
      if (this.foe) this.onKnockOut(this.foe, this.player, log);
      this.outcome = 'lost';
      log.push({ kind: 'end', data: { outcome: 'lost' } });
      return;
    }

    if (!this.foe) {
      this.outcome = 'won';
      log.push({ kind: 'end', data: { outcome: 'won' } });
    }
  }

  /**
   * What taking something down is worth to whoever did it.
   *
   * @param {Combatant} winner
   * @param {Combatant} fallen
   * @param {LogEntry[]} log
   */
  onKnockOut(winner, fallen, log) {
    if (winner.pokemon.hp <= 0) return;
    const ability = this.abilityOf(winner);
    if (!ability?.onKnockOut) return;

    const before = log.length;
    ability.onKnockOut(this.abilityContext(winner, fallen, log));
    if (log.length > before) {
      log.splice(before, 0, { kind: 'ability', side: winner.side, data: { ability: abilityName(winner.pokemon) } });
    }
  }

  /**
   * What a Pokémon leaves behind — an Aftermath taking the Pokémon that
   * touched it down with it.
   *
   * @param {Combatant} fallen
   * @param {LogEntry[]} log
   */
  onFaint(fallen, log) {
    const other = fallen === this.player ? this.foe : this.player;
    const ability = this.ownAbility(fallen);
    if (!ability?.faint || !other) return;

    // A Damp on the other side is what an Aftermath runs into.
    if (this.abilityOf(other)?.dampens) return;
    const byContact = this.touches(other, fallen, moveOf(other.lastMove ?? '') ?? {});
    const before = log.length;
    ability.faint(this.abilityContext(fallen, other, log, { byContact, lastDamage: fallen.marks.lastDamage ?? 0 }));
    if (log.length > before) {
      log.splice(before, 0, { kind: 'ability', side: fallen.side, data: { ability: abilityName(fallen.pokemon) } });
    }
  }

  /**
   * @param {Combatant} defeated
   * @param {LogEntry[]} log
   */
  awardExperience(defeated, log) {
    if (this.player.pokemon.hp <= 0) return;
    const species = speciesOf(defeated.pokemon.speciesId);
    const reward = gainFromDefeat(
      this.player.pokemon,
      { baseStats: species.stats, baseExp: species.baseExp, level: levelOf(defeated.pokemon) },
      {
        trainerBattle: this.trainerBattle,
        experienceMultiplier: heldPassive(this.player.pokemon, 'experience')?.multiplier ?? 1,
        effortMultiplier: heldPassive(this.player.pokemon, 'effort')?.multiplier ?? 1,
      },
    );
    this.rewards.push(reward);

    log.push({ kind: 'experience', side: 'player', data: { amount: reward.experience } });
    if (reward.levelsGained > 0) {
      log.push({ kind: 'levelUp', side: 'player', data: { level: reward.newLevel } });
    }
    for (const move of reward.learnable) {
      log.push({ kind: 'canLearn', side: 'player', data: { move } });
    }
  }
}

/**
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {'player'|'foe'} side
 * @returns {Combatant}
 */
function makeCombatant(pokemon, side) {
  return {
    pokemon,
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    flinched: false,
    lockedMove: null,
    turnsTaken: 0,
    side,
    marks: {},
    volatile: freshVolatile(),
    charging: null,
    mustRecharge: false,
    lastMove: null,
    repeats: 0,
    movedLast: false,
    // Read rather than stored: a level-up mid-battle raises it, and every
    // ability that asks about full or half health has to see that.
    get maxHp() {
      return maxHp(this.pokemon);
    },
  };
}

/**
 * A stat after its stage multiplier, and paralysis' Speed penalty.
 * @param {Combatant} combatant
 * @param {string} stat
 * @param {{ignorePositive?: boolean, ignoreNegative?: boolean, ignoreStages?: boolean, battle?: any}} [options]
 */
export function effectiveStat(combatant, stat, options = {}) {
  // The forme the combatant wears carries its own base stats — a Zen Mode's
  // Attack comes out of the forme, not out of the species.
  // A Transform fights on the stats it copied, all but its own Hit Points.
  const copied = stat !== 'hp' ? combatant.transform?.stats?.[stat] : undefined;
  const base = copied ?? statsOf(combatant.pokemon, combatant.marks?.forme)[stat] ?? 1;
  let stage = options.ignoreStages ? 0 : combatant.stages[stat] ?? 0;
  if (options.ignorePositive && stage > 0) stage = 0;
  if (options.ignoreNegative && stage < 0) stage = 0;

  const battle = options.battle ?? null;
  const ability = battle ? battle.abilityOf(combatant) : null;
  const types = battle ? battle.typesOf(combatant) : speciesOf(combatant.pokemon.speciesId).types;

  // An ability and the weather both scale the finished stat rather than the
  // base one, which is where the games apply them too.
  const fromAbility = ability?.stat?.(battle.abilityContext(combatant, combatant, []), stat) ?? 1;
  const fromWeather = battle ? weatherStat(battle.weatherFor(combatant), stat, types) : 1;
  const fromRuin = battle ? battle.ruinFactor(combatant, stat) : 1;

  // An Unburden doubles the Speed of a Pokémon that has spent what it had.
  const unburdened =
    ability?.unburden && combatant.marks.hadItem && !combatant.pokemon.heldItem && stat === 'spe' ? 2 : 1;

  let value = Math.floor(
    base *
      stageMultiplier(stage) *
      heldStatMultiplier(combatant.pokemon, stat) *
      fromAbility *
      fromWeather *
      fromRuin *
      unburdened,
  );
  // Paralysis costs half the Speed it leaves, unless the ability carrying it
  // is one that turns a condition into an advantage.
  if (stat === 'spe' && combatant.pokemon.status === STATUS.PARALYSIS && !ability?.ignoresParalysis) {
    value = Math.floor(value * 0.5);
  }
  return Math.max(1, value);
}

/**
 * How much a held item changes a stat.
 *
 * A Choice Band's fifty percent, an Eviolite's half again for something that
 * still has an evolution ahead of it, and the Speed a Macho Brace costs for
 * the effort it earns.
 *
 * @param {import('./pokemon.mjs').Pokemon} pokemon
 * @param {string} stat
 */
function heldStatMultiplier(pokemon, stat) {
  const held = heldPassive(pokemon, 'stat');
  const effort = heldPassive(pokemon, 'effort');
  let multiplier = 1;

  if (held?.stats?.includes(stat) && itemSuits(held, pokemon)) {
    const unevolved = (speciesOf(pokemon.speciesId).evolutions ?? []).length > 0;
    if (!held.unevolvedOnly || unevolved) multiplier *= held.multiplier;
  }
  if (stat === 'spe' && effort?.speed) multiplier *= effort.speed;
  return multiplier;
}

/** Critical-hit chance by the move's crit-rate stage, as in Gen 7+. */
function criticalChance(critRate) {
  return [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, Math.max(0, critRate))];
}

/** PokeAPI ailment names mapped onto the conditions the engine models. */
const AILMENT_TO_STATUS = {
  burn: STATUS.BURN,
  poison: STATUS.POISON,
  paralysis: STATUS.PARALYSIS,
  sleep: STATUS.SLEEP,
  freeze: STATUS.FREEZE,
};

/** Types the games make immune to a condition. */
const IMMUNE_TYPES = {
  [STATUS.BURN]: ['fire'],
  [STATUS.POISON]: ['poison', 'steel'],
  [STATUS.PARALYSIS]: ['electric'],
  [STATUS.FREEZE]: ['ice'],
};

/**
 * The move that would deal the most damage this turn, by expected value.
 * @param {Battle} battle
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 * @returns {string|null}
 */
export function bestDamageMove(battle, attacker, defender, usable) {
  let best = null;
  let bestScore = -1;

  for (const slot of usable) {
    const move = moveOf(slot.move);
    if (!move || move.damageClass === 'status') continue;
    // A type the other side simply does not take is not a choice; the games'
    // own trainers will not throw one either.
    if (cannotTouch(defender, move)) continue;
    const score = expectedDamage(attacker, defender, move);
    if (score > bestScore) {
      bestScore = score;
      best = slot.move;
    }
  }
  return best;
}

/**
 * Whether the target's typing makes this attack unable to land at all.
 *
 * Only the type chart is read: an ability that drinks a type is the
 * opponent's secret until it happens, which is how the games play it too.
 *
 * @param {Combatant} defender
 * @param {any} move
 */
export function cannotTouch(defender, move) {
  if (!move || move.damageClass === 'status') return false;
  const against = defender.marks?.types ?? speciesOf(defender.pokemon.speciesId).types;
  return typeEffectiveness(move.type, against) === 0;
}

/**
 * The moves worth reaching for at all: everything but the attacks that cannot
 * land. An empty answer means every move is one of those, and the caller may
 * as well use any of them.
 *
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 */
function movesThatCanLand(defender, usable) {
  const left = usable.filter((slot) => !cannotTouch(defender, moveOf(slot.move)));
  return left.length ? left : usable;
}

/**
 * The moves that would plainly do something this turn.
 *
 * This is the net the policy falls into when none of its own conditions hold:
 * without it the companion reaches for whatever is left, which can be a burn
 * aimed at something already burning or a boost at a stage that will not
 * move. The checks are only the obvious ones — an attack the target cannot
 * take, a stage at its limit, a condition already in place, a heal at full
 * health — so nothing subtle is ruled out by guesswork.
 *
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 */
function movesWorthUsing(attacker, defender, usable) {
  const worth = usable.filter((slot) => {
    const move = moveOf(slot.move);
    if (!move) return false;
    if (cannotTouch(defender, move)) return false;
    switch (categoryOf(move)) {
      case 'stat':
        return hasRoomToChange(move, attacker, defender);
      case 'status':
        return !defender.pokemon.status;
      case 'heal':
        return attacker.pokemon.hp < maxHp(attacker.pokemon);
      default:
        return true;
    }
  });
  return worth.length ? worth : movesThatCanLand(defender, usable);
}

/**
 * Average damage a move would do, ignoring the random spread — enough to rank
 * moves without rolling dice.
 *
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {any} move
 */
export function expectedDamage(attacker, defender, move) {
  const weighed = weightPower(
    move,
    speciesOf(attacker.pokemon.speciesId)?.weight ?? 100,
    speciesOf(defender.pokemon.speciesId)?.weight ?? 100,
  );
  if (weighed !== null) move = { ...move, power: weighed };
  if (!move.power) return 0;
  const level = levelOf(attacker.pokemon);
  const physical = move.damageClass === 'physical';
  const attack = effectiveStat(attacker, physical ? 'atk' : 'spa');
  const defence = effectiveStat(defender, physical ? 'def' : 'spd');

  const base = Math.floor(
    Math.floor((Math.floor((2 * level) / 5 + 2) * move.power * attack) / defence) / 50,
  ) + 2;

  const types = attacker.marks?.types ?? speciesOf(attacker.pokemon.speciesId).types;
  const stab = types.includes(move.type) ? 1.5 : 1;
  const against = defender.marks?.types ?? speciesOf(defender.pokemon.speciesId).types;
  const effectiveness = typeEffectiveness(move.type, against);
  const accuracy = (move.accuracy ?? 100) / 100;
  const hits = move.meta?.minHits ? ((move.meta.minHits + (move.meta.maxHits ?? move.meta.minHits)) / 2) : 1;

  return base * stab * effectiveness * accuracy * hits * 0.925;
}

/**
 * Choose a move from the player's auto-battle policy.
 *
 * The policy has three parts, applied in order: an explicit move order the
 * user laid out, the `mode` that decides what happens once that order runs
 * out, and the kinds of move the companion may reach for, each with a
 * condition. Anything the policy cannot decide falls through to the strongest
 * attack.
 *
 * @param {Battle} battle
 * @param {Combatant} attacker
 * @param {Combatant} defender
 * @param {Array<{move: string, pp: number}>} usable
 * @returns {string}
 */
export function choosePolicyMove(battle, attacker, defender, usable) {
  const policy = battle.policy;
  const known = new Set(usable.map((slot) => slot.move));
  const order = (policy.order ?? []).filter((move) => move && known.has(move));

  if (order.length) {
    const index = attacker.turnsTaken;
    if (policy.mode === 'repeatLast' && index >= order.length) return order[order.length - 1];
    if (policy.mode === 'repeatAll' || index < order.length) return order[index % order.length];
  }

  if (policy.mode === 'damageFirst') {
    const damaging = bestDamageMove(battle, attacker, defender, usable);
    if (damaging) return damaging;
  }

  /** @type {Array<{value: string, weight: number}>} */
  const candidates = [];
  /** The hardest-hitting attack, which is the only one of its kind offered. */
  let bestDamage = /** @type {{value: string, damage: number}|null} */ (null);

  for (const slot of usable) {
    const move = moveOf(slot.move);
    if (!move) continue;
    const category = categoryOf(move);
    if (!conditionHolds(policy.conditions?.[category] ?? 'always', battle, attacker, defender)) continue;

    // Attacks do not compete with each other: holding four of them and no
    // instructions about which to use means using the one that hits hardest,
    // rather than rolling between a Flamethrower and a Tackle every turn.
    if (category === 'damage') {
      if (cannotTouch(defender, move)) continue;
      const damage = expectedDamage(attacker, defender, move);
      if (!bestDamage || damage > bestDamage.damage) bestDamage = { value: slot.move, damage };
      continue;
    }

    // A stat move that cannot move anything accomplishes nothing.
    if (category === 'stat' && !hasRoomToChange(move, attacker, defender)) continue;
    candidates.push({ value: slot.move, weight: 1 });
  }

  if (bestDamage) candidates.push({ value: bestDamage.value, weight: 1 });

  const chosen = battle.rng.weighted(candidates);
  if (chosen) return chosen;

  // Nothing the policy allows applies this turn. Rather than stand there
  // repeating an attack the other side cannot take — which never ends and
  // never even reads as a mistake — the fallback is anything that can land.
  const worth = movesWorthUsing(attacker, defender, usable);
  return bestDamageMove(battle, attacker, defender, worth) ?? battle.rng.pick(worth).move;
}

/**
 * The auto-battle category a move belongs to.
 * @param {any} move
 * @returns {'damage'|'heal'|'status'|'stat'|'field'}
 */
export function categoryOf(move) {
  if (move.damageClass !== 'status') return 'damage';
  if ((move.meta?.healing ?? 0) > 0) return 'heal';
  if (move.meta?.ailment && move.meta.ailment !== 'none') return 'status';
  if (move.statChanges?.length) return 'stat';
  return 'field';
}

/**
 * Whether a kind of move may be used this turn.
 *
 * One condition per kind is the whole of the auto-battle policy beyond the
 * move order: `never` takes a kind out of the fight altogether, and the rest
 * name the moment it is worth reaching for.
 *
 * @param {string} condition
 * @param {Battle} battle
 * @param {Combatant} attacker
 * @param {Combatant} defender
 */
function conditionHolds(condition, battle, attacker, defender) {
  const health = () => attacker.pokemon.hp / Math.max(1, maxHp(attacker.pokemon));

  switch (condition) {
    case 'never':
      return false;
    case 'firstTurn':
      return attacker.turnsTaken === 0;
    case 'noStatus':
      return !defender.pokemon.status;
    case 'foeStatus':
      return Boolean(defender.pokemon.status);
    case 'noField':
      // Now that there is weather and terrain, this asks what it always read
      // as: reach for a field move when there is no field effect already.
      return battle.field ? battle.field.quiet : true;
    case 'hpTwoThirds':
      return health() <= 2 / 3;
    // `lowHp` is what half health was called before the fractions were named.
    case 'lowHp':
    case 'hpHalf':
      return health() <= 1 / 2;
    case 'hpThird':
      return health() <= 1 / 3;
    case 'hpQuarter':
      return health() <= 1 / 4;
    case 'always':
    default:
      return true;
  }
}

/**
 * Whether a stat move would move any stage that is not already at its limit.
 * @param {any} move
 * @param {Combatant} attacker
 * @param {Combatant} defender
 */
function hasRoomToChange(move, attacker, defender) {
  return move.statChanges.some((change) => {
    const target = change.change > 0 ? attacker : defender;
    const stage = target.stages[change.stat] ?? 0;
    return change.change > 0 ? stage < 6 : stage > -6;
  });
}

/**
 * What a berry is worth to something that ripened it.
 *
 * A Ripen doubles the effect rather than the item, so only the numbers the
 * effect carries are touched — the condition it waits for is not.
 *
 * @param {any} held
 */
function doubled(held) {
  /** @type {Record<string, any>} */
  const out = {};
  if (held.stages) out.stages = held.stages * 2;
  if (held.heal?.fraction) out.heal = { ...held.heal, fraction: held.heal.fraction * 2 };
  if (held.heal?.amount) out.heal = { ...held.heal, amount: held.heal.amount * 2 };
  if (held.amount) out.amount = held.amount * 2;
  if (held.multiplier !== undefined && held.on === 'resist') out.multiplier = 0;
  return out;
}

/**
 * The standing allowance the player's own Pokémon fights under.
 *
 * The companion travels alone: there is no party to switch to, no second
 * chance at a bad matchup, and nobody watching to pull it out of one. So it
 * takes half of everything aimed at it, and a weakness costs it half again
 * rather than double — a double weakness, half again twice. Both come off the
 * finished number, after type effectiveness, STAB and the rest, by undoing
 * each of the chart's doublings and putting {@link COMPANION_WEAKNESS} in
 * its place.
 *
 * Only what it *takes* is touched. What it deals goes through the formula
 * untouched, so nothing about the player's own damage changes.
 *
 * @param {Combatant|null|undefined} defender
 * @param {number} effectiveness the type chart's multiplier for the hit
 * @returns {number}
 */
export function companionArmour(defender, effectiveness) {
  if (defender?.side !== 'player') return 1;
  const weaknesses = effectiveness > 1 ? Math.log2(effectiveness) : 0;
  return COMPANION_DAMAGE_TAKEN * (COMPANION_WEAKNESS / 2) ** weaknesses;
}
