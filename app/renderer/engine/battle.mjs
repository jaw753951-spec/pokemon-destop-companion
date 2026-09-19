/**
 * The battle engine.
 *
 * Turn resolution follows the main series: priority then Speed decides who
 * moves, damage uses the modern formula with STAB, type effectiveness, a
 * critical roll and the 85–100% spread, and status conditions tick at the end
 * of the turn. Battles are fought automatically, so the engine produces a list
 * of log entries per turn which the battle scene plays back as animation.
 */
import { moveOf, speciesOf, typeEffectiveness } from '../core/data.mjs';
import { abilityEffect } from './abilities.mjs';
import {
  Field,
  FIELD_MOVES,
  FIELD_TURNS,
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
import { gainFromDefeat, levelOf, maxHp, statsOf } from './pokemon.mjs';
import { stageMultiplier } from './stats.mjs';

/**
 * @typedef {Object} Combatant
 * @property {import('./pokemon.mjs').Pokemon} pokemon
 * @property {Record<string, number>} stages
 * @property {boolean} flinched
 * @property {string|null} lockedMove the move a Choice item has it committed to
 * @property {number} turnsTaken
 * @property {'player'|'foe'} side
 * @property {Record<string, any>} marks what an ability or item has left on it
 * @property {string|null} charging a two-turn move part way through
 * @property {boolean} mustRecharge whether last turn's move has to be paid for
 * @property {string|null} lastMove for the items that reward repeating one
 * @property {number} repeats how many turns running that has been the move
 * @property {boolean} movedLast whether it acted second on the previous turn
 * @property {number} maxHp
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} kind `move`, `damage`, `effectiveness`, `critical`, `miss`,
 *   `status`, `statusDamage`, `stat`, `heal`, `faint`, `flinch`, `end`
 * @property {'player'|'foe'} [side]
 * @property {Record<string, any>} [data]
 */

/** The stats a Starf Berry can land on. */
const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'];

/** Status conditions the engine models. */
export const STATUS = { BURN: 'brn', POISON: 'psn', PARALYSIS: 'par', SLEEP: 'slp', FREEZE: 'frz' };

/** Moves are capped at this many turns so a stalemate cannot run forever. */
const TURN_LIMIT = 200;

/**
 * The engine's condition names back to the ailment names the move data uses,
 * so an ability can ask for a paralysis in the same words the save writes it.
 */
const STATUS_TO_AILMENT = { brn: 'burn', psn: 'poison', par: 'paralysis', slp: 'sleep', frz: 'freeze' };

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
    const ability = abilityEffect(combatant.pokemon);
    if (!ability?.start || !other) return;

    const before = log.length;
    ability.start(this.abilityContext(combatant, other, log));
    // A line naming the ability goes in front of whatever it did, so the
    // battle reads "Intimidate!" and then the Attack falling.
    if (log.length > before) {
      log.splice(before, 0, {
        kind: 'ability',
        side: combatant.side,
        data: { ability: combatant.pokemon.ability },
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
    for (const combatant of [this.player, this.foe]) {
      if (combatant && abilityEffect(combatant.pokemon)?.suppressWeather) return null;
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
    if (against && abilityEffect(against.pokemon)?.ignoresAbilities) return null;
    return abilityEffect(combatant.pokemon);
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
        log.push({ kind, side: self.side, data: { ability: self.pokemon.ability, ...data } });
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
          data: { amount, ability: self.pokemon.ability },
        });
      },

      /** @param {Combatant} target @param {number} fraction */
      heal(target, fraction) {
        const max = target.maxHp;
        if (target.pokemon.hp <= 0 || target.pokemon.hp >= max) return;
        const amount = Math.max(1, Math.floor(max * fraction));
        target.pokemon.hp = Math.min(max, target.pokemon.hp + amount);
        log.push({ kind: 'heal', side: target.side, data: { amount, ability: self.pokemon.ability } });
      },

      /** @param {Combatant} target @param {string} stat @param {number} change */
      raise(target, stat, change) {
        if (target.pokemon.hp <= 0) return false;
        // A Clear Amulet, and every ability that answers a drop, only care
        // about a drop the other side caused.
        if (change < 0 && target !== self && heldShield(target.pokemon, 'statDrops')) return false;
        return battle.applyStage(target, stat, change, log, { ability: self.pokemon.ability });
      },

      /** @param {Combatant} target @param {string} status @param {number} chance */
      inflict(target, status, chance) {
        if (!battle.rng.chance(chance)) return false;
        return battle.inflictStatus(target, STATUS_TO_AILMENT[status] ?? status, log);
      },

      /** @param {Combatant} target */
      cure(target) {
        if (!target.pokemon.status) return;
        target.pokemon.status = null;
        target.pokemon.statusTurns = 0;
        log.push({
          kind: 'status',
          side: target.side,
          data: { status: null, ability: self.pokemon.ability },
        });
      },

      /** @param {string} weather */
      setWeather: (weather) => this.startWeather(weather, self, log),
      /** @param {string} terrain */
      setTerrain: (terrain) => this.startTerrain(terrain, self, log),
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
   * @param {Record<string, any>} [data]
   * @returns {boolean} whether anything moved
   */
  applyStage(target, stat, change, log, data = {}) {
    const before = target.stages[stat] ?? 0;
    const after = Math.max(-6, Math.min(6, before + change));
    if (after === before) return false;
    target.stages[stat] = after;
    // A White Herb remembers that something was lowered so it can undo it.
    if (change < 0) target.marks.lowered = true;
    log.push({ kind: 'stat', side: target.side, data: { stat, change, stage: after, ...data } });
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
        if (this.applyStage(combatant, stat, seed.stages ?? 1, log)) used = true;
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
    if (combatant.pokemon.ability === 'levitate') return false;
    return !speciesOf(combatant.pokemon.speciesId).types.includes('flying');
  }

  /**
   * Play one turn and return everything that happened in it.
   * @returns {LogEntry[]}
   */
  takeTurn() {
    /** @type {LogEntry[]} */
    const log = [];
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
      this.checkFaint(log);
      // Checked between the two sides' moves as well as at the end of the
      // turn: a berry that waits until the turn is over is a berry that lets
      // its holder faint first.
      this.eatHeldBerry(log);
    }

    if (this.running) {
      for (const combatant of [this.player, this.foe]) {
        if (!combatant || combatant.pokemon.hp <= 0) continue;
        this.endOfTurnHeld(combatant, log);
        this.endOfTurnStatus(combatant, log);
        this.endOfTurnField(combatant, log);
        this.endOfTurnAbility(combatant, log);
      }
      this.tickField(log);
      this.checkFaint(log);
      this.eatHeldBerry(log);
    }

    return log;
  }

  /**
   * What the sky and the ground do to whoever is standing in them.
   *
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  endOfTurnField(combatant, log) {
    const ability = this.abilityOf(combatant);
    const types = speciesOf(combatant.pokemon.speciesId).types;
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
    const ability = abilityEffect(combatant.pokemon);
    if (!ability?.turn || !other) return;
    ability.turn(this.abilityContext(combatant, other, log));
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

    // An item is thrown before either Pokémon moves, as it is in the games,
    // and the companion has no move to commit to that turn.
    if (this.pendingItem) {
      this.pendingMoves = new Map([
        [this.player, null],
        [this.foe, this.chooseMove(this.foe, this.player)],
      ]);
      return [this.player, this.foe];
    }

    // Both sides commit before either acts, so priority can be compared and
    // the choice cannot change once the turn is under way.
    const playerChoice = this.chooseMove(this.player, this.foe);
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
    return playerSpeed > foeSpeed ? [this.player, this.foe] : [this.foe, this.player];
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

  /** @param {Combatant} combatant */
  speedOf(combatant) {
    return this.stat(combatant, 'spe');
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
    // standing on it.
    if (terrainBlocksPriority(this.field.terrain, priority, this.grounded(defender))) return 0;
    return priority;
  }

  /**
   * Pick the move a combatant will use this turn.
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @returns {string} a move slug, or `struggle` when nothing has PP
   */
  chooseMove(attacker, defender) {
    let usable = attacker.pokemon.moves.filter((slot) => slot.pp > 0 && moveOf(slot.move));
    if (usable.length === 0) return 'struggle';

    const restriction = heldPassive(attacker.pokemon, 'stat');

    // A Choice item locks its holder into the first move it picks, for as long
    // as that move has PP — which is the price it charges for the power.
    if (restriction?.lock) {
      const locked = usable.find((slot) => slot.move === attacker.lockedMove);
      if (locked) return locked.move;
    }

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
        : bestDamageMove(this, attacker, defender, usable) ?? this.rng.pick(usable).move;

    if (restriction?.lock) attacker.lockedMove = chosen;
    return chosen;
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
      attacker.turnsTaken++;
      log.push({ kind: 'item', side: attacker.side, data: { item: slug, used } });
      return;
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
    const base = moveOf(moveName);
    attacker.turnsTaken++;

    if (!base) {
      log.push({ kind: 'move', side: attacker.side, data: { move: 'struggle' } });
      return;
    }

    // The charge turn: everything but the move itself, and then the wait.
    if (hasFlag(base, 'charge') && !attacker.charging && !this.skipsCharge(attacker, moveName, log)) {
      const slot = attacker.pokemon.moves.find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
      attacker.charging = moveName;
      log.push({ kind: 'charging', side: attacker.side, data: { move: moveName } });
      return;
    }

    // PP was already spent on the charge turn.
    if (!attacker.charging) {
      const slot = attacker.pokemon.moves.find((entry) => entry.move === moveName);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
    }
    attacker.charging = null;

    // A Metronome pays for repeating the same move, so the count is kept even
    // when nothing is holding one.
    attacker.repeats = attacker.lastMove === moveName ? attacker.repeats + 1 : 0;
    attacker.lastMove = moveName;

    const move = this.effectiveMove(attacker, defender, base);
    log.push({ kind: 'move', side: attacker.side, data: { move: moveName } });

    // A move the defender is simply sealed against — a sound at a Soundproof,
    // a bullet at a Bulletproof, a powder at a Grass type or a pair of Safety
    // Goggles — never gets as far as an accuracy roll.
    if (this.movePrevented(attacker, defender, move)) {
      log.push({ kind: 'noEffect', side: defender.side });
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

    if (move.damageClass === 'status') {
      this.applyStatusMove(attacker, defender, move, log);
    } else {
      this.applyDamagingMove(attacker, defender, move, log);
    }

    this.afterUse(attacker, defender, move, log);

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
    if (hasFlag(move, 'powder') && speciesOf(defender.pokemon.speciesId).types.includes('grass')) return true;

    const shield = heldShield(defender.pokemon, 'flags');
    if (shield && move.flags?.some((flag) => shield.includes(flag))) return true;

    return Boolean(this.abilityOf(defender, attacker)?.blockMove?.(this.abilityContext(defender, attacker, []), move));
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
      if (this.applyStage(attacker, stat, policy.stages ?? 1, log)) used = true;
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
    const spray = heldPassive(attacker.pokemon, 'used');
    if (!spray || !spray.flags?.some((flag) => hasFlag(move, flag))) return;

    let used = false;
    for (const stat of spray.stats) {
      if (this.applyStage(attacker, stat, spray.stages ?? 1, log)) used = true;
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
   * Eat the held berry if its moment has come, which is what makes one worth
   * holding — and what the bag's restock setting then replaces.
   *
   * Only the companion's is checked: nothing the game sends against it is
   * given anything to hold.
   *
   * @param {LogEntry[]} log
   */
  eatHeldBerry(log) {
    const combatant = this.player;
    const trigger = heldTrigger(combatant.pokemon);
    if (!trigger) return;

    const { slug, held } = trigger;
    if (held.stat) {
      // A stat berry raises a stage, which lives on the combatant rather than
      // on the Pokémon, so the battle applies that one itself.
      const stat = held.stat === 'random' ? this.rng.pick(STAT_KEYS) : held.stat;
      if (!this.applyStage(combatant, stat, held.stages ?? 1, log)) return;
    } else if (held.crit) {
      // A Lansat sharpens the next hit rather than raising a stat.
      combatant.marks.critStages = (combatant.marks.critStages ?? 0) + held.crit;
    } else if (held.accuracy) {
      combatant.marks.accuracy = held.accuracy;
    } else if (held.first) {
      // A Custap is spent when the turn order is decided, not here.
      return;
    } else if (!applyHeldEffect(combatant.pokemon, held)) {
      return;
    }

    combatant.pokemon.heldItem = null;
    log.push({ kind: 'berry', side: combatant.side, data: { item: slug } });
  }

  /**
   * Sleep, freeze and paralysis can all keep a Pokémon from moving.
   * @param {Combatant} combatant
   * @param {LogEntry[]} log
   */
  canAct(combatant, log) {
    const pokemon = combatant.pokemon;

    if (pokemon.status === STATUS.SLEEP) {
      pokemon.statusTurns--;
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

    return true;
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

      const survives = this.survivesHit(defender, result.damage);
      defender.pokemon.hp = Math.max(survives ? 1 : 0, defender.pokemon.hp - result.damage);
      total += result.damage;
      if (survives) {
        log.push({
          kind: 'endure',
          side: defender.side,
          data: survives.ability
            ? { ability: defender.pokemon.ability }
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

    // A berry eaten on the way in is announced before the damage it softened.
    if (defender.marks.ateResist) {
      log.push({ kind: 'berry', side: defender.side, data: { item: defender.marks.ateResist } });
      defender.marks.ateResist = null;
    }

    if (critical) log.push({ kind: 'critical', side: defender.side });
    log.push({ kind: 'damage', side: defender.side, data: { amount: total, hits } });
    if (effectiveness !== 1) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness } });
    }

    // Drain and recoil are expressed as a percentage of the damage dealt.
    const drain = move.meta?.drain ?? 0;
    if (drain > 0 && total > 0) {
      const healed = Math.max(1, Math.floor((total * drain) / 100));
      attacker.pokemon.hp = Math.min(maxHp(attacker.pokemon), attacker.pokemon.hp + healed);
      log.push({ kind: 'heal', side: attacker.side, data: { amount: healed } });
    } else if (drain < 0 && total > 0) {
      const recoil = Math.max(1, Math.floor((total * -drain) / 100));
      attacker.pokemon.hp = Math.max(0, attacker.pokemon.hp - recoil);
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
    if (!min) return 1;
    const max = move.meta.maxHits ?? min;

    if (this.abilityOf(attacker)?.maxHits) return max;
    const dice = heldPassive(attacker.pokemon, 'multiHit');
    return this.rng.int(dice ? Math.min(max, dice.min) : min, max);
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
    log.push({ kind: 'ability', side: defender.side, data: { ability: defender.pokemon.ability } });

    if (absorbed.heal) context.heal(defender, absorbed.heal);
    if (absorbed.stat) context.raise(defender, absorbed.stat, absorbed.stages ?? 1);
    if (absorbed.mark) defender.marks[absorbed.mark] = true;
    if (!absorbed.heal && !absorbed.stat && !absorbed.mark) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness: 0 } });
    }
    return true;
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
      ability?.hit?.(this.abilityContext(defender, attacker, log), move, damage);
    }

    if (!this.touches(attacker, defender, move)) return;

    // What the attacker walks into by touching: an ability, and a helmet.
    if (defender.pokemon.hp > 0) {
      const ability = this.abilityOf(defender, attacker);
      const before = log.length;
      ability?.contact?.(this.abilityContext(defender, attacker, log));
      if (log.length > before) {
        log.splice(before, 0, { kind: 'ability', side: defender.side, data: { ability: defender.pokemon.ability } });
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
      if (this.applyStage(defender, stat, held.stages ?? 1, log)) used = true;
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
    const effectiveness = typeEffectiveness(move.type, speciesOf(defender.pokemon.speciesId).types);
    if (effectiveness === 0) return { damage: 0, effectiveness: 0, critical: false };

    const critical = this.rollCritical(attacker, defender, move);
    const attack = this.stat(attacker, attackStat, critical ? { ignoreNegative: true } : {});
    const defence = this.stat(defender, defenceStat, critical ? { ignorePositive: true } : {});

    const base = Math.floor(
      Math.floor((Math.floor((2 * level) / 5 + 2) * (move.power ?? 0) * attack) / defence) / 50,
    ) + 2;

    const species = speciesOf(attacker.pokemon.speciesId);
    const stab = species.types.includes(move.type) ? 1.5 : 1;

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

    const held = this.heldDamage(attacker, move, effectiveness);
    const resisted = this.heldResist(defender, move, effectiveness);
    const weather = weatherDamage(this.weatherFor(attacker), move.type);
    const terrain = terrainDamage(
      this.field.terrain,
      move.type,
      this.grounded(attacker),
      this.grounded(defender),
    );
    const screen = this.screenMultiplier(defender, move, critical);

    const damage = Math.max(
      1,
      Math.floor(
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
          weather *
          terrain *
          screen,
      ),
    );
    return { damage, effectiveness, critical };
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
    // Sheer Force trades every secondary effect away for the damage it adds,
    // and a Covert Cloak refuses them from the other side.
    if (ability?.noSecondary || heldShield(defender.pokemon, 'secondary')) return;

    // Serene Grace doubles the odds of whatever a move was already going to do.
    const odds = ability?.secondary ?? 1;

    if (meta.ailment && meta.ailment !== 'none' && meta.ailmentChance > 0) {
      if (this.rng.next() < (meta.ailmentChance / 100) * odds) this.inflictStatus(defender, meta.ailment, log);
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
    }

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
      if (this.rng.next() < chance && this.inflictStatus(defender, meta.ailment, log)) did = true;
    }

    if (move.statChanges?.length) {
      if (this.applyStatChanges(attacker, defender, move, log)) did = true;
    }

    if (!did) log.push({ kind: 'noEffect', side: defender.side });
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
    // the opponent. That holds for essentially every move in the games.
    let changed = false;
    for (const change of move.statChanges) {
      const target = change.change > 0 ? attacker : defender;
      // A Clear Amulet refuses a drop the other side is trying to apply.
      if (change.change < 0 && heldShield(target.pokemon, 'statDrops')) continue;
      if (this.applyStage(target, change.stat, change.change, log)) changed = true;
    }
    return changed;
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

    const types = speciesOf(target.pokemon.speciesId).types;
    if (IMMUNE_TYPES[status]?.some((type) => types.includes(type))) return false;

    // Nothing freezes in sunshine, which is the one condition the weather has
    // an opinion about.
    if (status === STATUS.FREEZE && this.weatherFor(target) === WEATHER.SUN) return false;

    // Misty Terrain keeps everything off whatever is standing on it; Electric
    // Terrain only keeps it awake.
    if (terrainBlocksStatus(this.field.terrain, status) && this.grounded(target)) return false;

    const other = target === this.player ? this.foe : this.player;
    const ability = this.abilityOf(target, other ?? undefined);
    if (ability?.blockStatus?.(this.abilityContext(target, other ?? target, log), status)) {
      log.push({ kind: 'ability', side: target.side, data: { ability: target.pokemon.ability } });
      return false;
    }

    target.pokemon.status = status;
    target.pokemon.statusTurns = status === STATUS.SLEEP ? this.rng.int(1, 3) : 0;
    log.push({ kind: 'status', side: target.side, data: { status } });
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
    if (!this.foe) return;

    if (this.foe.pokemon.hp <= 0) {
      log.push({ kind: 'faint', side: 'foe', data: { speciesId: this.foe.pokemon.speciesId } });
      this.onFaint(this.foe, log);
      this.awardExperience(this.foe, log);

      const next = this.foeQueue.shift();
      if (next) {
        this.foe = next;
        log.push({ kind: 'sendOut', side: 'foe', data: { speciesId: next.pokemon.speciesId } });
        // Whatever walks in next does so with its own ability in hand.
        this.enter(next, log);
      } else {
        this.foe = null;
        this.outcome = 'won';
        log.push({ kind: 'end', data: { outcome: 'won' } });
      }
      return;
    }

    if (this.player.pokemon.hp <= 0) {
      log.push({ kind: 'faint', side: 'player', data: { speciesId: this.player.pokemon.speciesId } });
      this.onFaint(this.player, log);
      this.outcome = 'lost';
      log.push({ kind: 'end', data: { outcome: 'lost' } });
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
    const ability = abilityEffect(fallen.pokemon);
    if (!ability?.faint || !other) return;

    const byContact = this.touches(other, fallen, moveOf(other.lastMove ?? '') ?? {});
    const before = log.length;
    ability.faint(this.abilityContext(fallen, other, log, { byContact }));
    if (log.length > before) {
      log.splice(before, 0, { kind: 'ability', side: fallen.side, data: { ability: fallen.pokemon.ability } });
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
 * @param {{ignorePositive?: boolean, ignoreNegative?: boolean, battle?: any}} [options]
 */
export function effectiveStat(combatant, stat, options = {}) {
  const base = statsOf(combatant.pokemon)[stat] ?? 1;
  let stage = combatant.stages[stat] ?? 0;
  if (options.ignorePositive && stage > 0) stage = 0;
  if (options.ignoreNegative && stage < 0) stage = 0;

  const battle = options.battle ?? null;
  const ability = battle ? battle.abilityOf(combatant) : null;
  const types = speciesOf(combatant.pokemon.speciesId).types;

  // An ability and the weather both scale the finished stat rather than the
  // base one, which is where the games apply them too.
  const fromAbility = ability?.stat?.(battle.abilityContext(combatant, combatant, []), stat) ?? 1;
  const fromWeather = battle ? weatherStat(battle.weatherFor(combatant), stat, types) : 1;

  let value = Math.floor(
    base * stageMultiplier(stage) * heldStatMultiplier(combatant.pokemon, stat) * fromAbility * fromWeather,
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
    const score = expectedDamage(attacker, defender, move);
    if (score > bestScore) {
      bestScore = score;
      best = slot.move;
    }
  }
  return best;
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
  if (!move.power) return 0;
  const level = levelOf(attacker.pokemon);
  const physical = move.damageClass === 'physical';
  const attack = effectiveStat(attacker, physical ? 'atk' : 'spa');
  const defence = effectiveStat(defender, physical ? 'def' : 'spd');

  const base = Math.floor(
    Math.floor((Math.floor((2 * level) / 5 + 2) * move.power * attack) / defence) / 50,
  ) + 2;

  const species = speciesOf(attacker.pokemon.speciesId);
  const stab = species.types.includes(move.type) ? 1.5 : 1;
  const effectiveness = typeEffectiveness(move.type, speciesOf(defender.pokemon.speciesId).types);
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

  return bestDamageMove(battle, attacker, defender, usable) ?? battle.rng.pick(usable).move;
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
