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
import { gainFromDefeat, levelOf, maxHp, statsOf } from './pokemon.mjs';
import { stageMultiplier } from './stats.mjs';

/**
 * @typedef {Object} Combatant
 * @property {import('./pokemon.mjs').Pokemon} pokemon
 * @property {Record<string, number>} stages
 * @property {boolean} flinched
 * @property {number} turnsTaken
 * @property {'player'|'foe'} side
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} kind `move`, `damage`, `effectiveness`, `critical`, `miss`,
 *   `status`, `statusDamage`, `stat`, `heal`, `faint`, `flinch`, `end`
 * @property {'player'|'foe'} [side]
 * @property {Record<string, any>} [data]
 */

/** Status conditions the engine models. */
export const STATUS = { BURN: 'brn', POISON: 'psn', PARALYSIS: 'par', SLEEP: 'slp', FREEZE: 'frz' };

/** Moves are capped at this many turns so a stalemate cannot run forever. */
const TURN_LIMIT = 200;

export class Battle {
  /**
   * @param {{
   *   rng: import('../core/rng.mjs').Rng,
   *   player: import('./pokemon.mjs').Pokemon,
   *   foes: import('./pokemon.mjs').Pokemon[],
   *   policy: any,
   *   trainerBattle?: boolean,
   * }} options
   */
  constructor({ rng, player, foes, policy, trainerBattle = false }) {
    this.rng = rng;
    this.policy = policy;
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
  }

  /** @returns {boolean} whether the battle is still running */
  get running() {
    return this.outcome === 'ongoing';
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

    const first = this.orderOfPlay();
    for (const attacker of first) {
      if (!this.running || !this.foe) break;
      const defender = attacker === this.player ? this.foe : this.player;
      if (attacker.pokemon.hp <= 0 || defender.pokemon.hp <= 0) continue;
      this.resolveMove(attacker, defender, log);
      this.checkFaint(log);
    }

    if (this.running) {
      for (const combatant of [this.player, this.foe]) {
        if (!combatant || combatant.pokemon.hp <= 0) continue;
        this.endOfTurnStatus(combatant, log);
      }
      this.checkFaint(log);
    }

    return log;
  }

  /** Priority first, then Speed, with a coin flip to break an exact tie. */
  orderOfPlay() {
    if (!this.foe) return [this.player];

    // Both sides commit before either acts, so priority can be compared and
    // the choice cannot change once the turn is under way.
    const playerChoice = this.chooseMove(this.player, this.foe);
    const foeChoice = this.chooseMove(this.foe, this.player);
    this.pendingMoves = new Map([
      [this.player, playerChoice],
      [this.foe, foeChoice],
    ]);

    const playerPriority = moveOf(playerChoice)?.priority ?? 0;
    const foePriority = moveOf(foeChoice)?.priority ?? 0;
    if (playerPriority !== foePriority) {
      return playerPriority > foePriority ? [this.player, this.foe] : [this.foe, this.player];
    }

    const playerSpeed = effectiveStat(this.player, 'spe');
    const foeSpeed = effectiveStat(this.foe, 'spe');
    if (playerSpeed === foeSpeed) {
      return this.rng.chance(0.5) ? [this.player, this.foe] : [this.foe, this.player];
    }
    return playerSpeed > foeSpeed ? [this.player, this.foe] : [this.foe, this.player];
  }

  /**
   * Pick the move a combatant will use this turn.
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @returns {string} a move slug, or `struggle` when nothing has PP
   */
  chooseMove(attacker, defender) {
    const usable = attacker.pokemon.moves.filter((slot) => slot.pp > 0 && moveOf(slot.move));
    if (usable.length === 0) return 'struggle';

    // The player's side follows the policy the user configured; the opponent
    // plays a simple best-damage game, as the games' trainers broadly do.
    if (attacker.side === 'player' && this.policy) {
      return choosePolicyMove(this, attacker, defender, usable);
    }
    return bestDamageMove(this, attacker, defender, usable) ?? this.rng.pick(usable).move;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {LogEntry[]} log
   */
  resolveMove(attacker, defender, log) {
    if (attacker.flinched) {
      attacker.flinched = false;
      log.push({ kind: 'flinch', side: attacker.side });
      return;
    }
    if (!this.canAct(attacker, log)) return;

    const moveName = this.pendingMoves?.get(attacker) ?? this.chooseMove(attacker, defender);
    const move = moveOf(moveName);
    attacker.turnsTaken++;

    if (!move) {
      log.push({ kind: 'move', side: attacker.side, data: { move: 'struggle' } });
      return;
    }

    const slot = attacker.pokemon.moves.find((entry) => entry.move === moveName);
    if (slot) slot.pp = Math.max(0, slot.pp - 1);

    log.push({ kind: 'move', side: attacker.side, data: { move: moveName } });

    if (!this.rollAccuracy(attacker, defender, move)) {
      log.push({ kind: 'miss', side: attacker.side });
      return;
    }

    if (move.damageClass === 'status') {
      this.applyStatusMove(attacker, defender, move, log);
      return;
    }

    this.applyDamagingMove(attacker, defender, move, log);
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
    // A null accuracy means the move cannot miss.
    if (move.accuracy === null || move.accuracy === undefined) return true;
    const stages = (attacker.stages.acc ?? 0) - (defender.stages.eva ?? 0);
    const chance = (move.accuracy / 100) * stageMultiplier(stages, true);
    return this.rng.next() < chance;
  }

  /**
   * @param {Combatant} attacker
   * @param {Combatant} defender
   * @param {any} move
   * @param {LogEntry[]} log
   */
  applyDamagingMove(attacker, defender, move, log) {
    const hits = move.meta?.minHits ? this.rng.int(move.meta.minHits, move.meta.maxHits ?? move.meta.minHits) : 1;
    let total = 0;
    let effectiveness = 1;
    let critical = false;

    for (let hit = 0; hit < hits && defender.pokemon.hp > 0; hit++) {
      const result = this.computeDamage(attacker, defender, move);
      effectiveness = result.effectiveness;
      critical = critical || result.critical;
      if (result.effectiveness === 0) break;

      defender.pokemon.hp = Math.max(0, defender.pokemon.hp - result.damage);
      total += result.damage;
    }

    if (effectiveness === 0) {
      log.push({ kind: 'effectiveness', side: defender.side, data: { effectiveness: 0 } });
      return;
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

    this.applySecondaryEffects(attacker, defender, move, log);
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

    // A critical hit ignores the defender's positive defence stages and the
    // attacker's negative offence ones.
    const critical = this.rng.next() < criticalChance(move.meta?.critRate ?? 0);
    const attack = effectiveStat(attacker, attackStat, critical ? { ignoreNegative: true } : {});
    const defence = effectiveStat(defender, defenceStat, critical ? { ignorePositive: true } : {});

    const base = Math.floor(
      Math.floor((Math.floor((2 * level) / 5 + 2) * (move.power ?? 0) * attack) / defence) / 50,
    ) + 2;

    const species = speciesOf(attacker.pokemon.speciesId);
    const stab = species.types.includes(move.type) ? 1.5 : 1;
    const effectiveness = typeEffectiveness(move.type, speciesOf(defender.pokemon.speciesId).types);
    if (effectiveness === 0) return { damage: 0, effectiveness: 0, critical: false };

    // Burn halves physical damage.
    const burn = physical && attacker.pokemon.status === STATUS.BURN ? 0.5 : 1;
    const spread = this.rng.int(85, 100) / 100;
    const criticalBonus = critical ? 1.5 : 1;

    const damage = Math.max(1, Math.floor(base * stab * effectiveness * burn * spread * criticalBonus));
    return { damage, effectiveness, critical };
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

    if (meta.ailment && meta.ailment !== 'none' && meta.ailmentChance > 0) {
      if (this.rng.next() < meta.ailmentChance / 100) this.inflictStatus(defender, meta.ailment, log);
    }

    if (meta.flinchChance > 0 && this.rng.next() < meta.flinchChance / 100) {
      defender.flinched = true;
    }

    if (move.statChanges?.length && meta.statChance > 0) {
      if (this.rng.next() < meta.statChance / 100) {
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

    if (meta?.healing > 0) {
      const amount = Math.max(1, Math.floor((maxHp(attacker.pokemon) * meta.healing) / 100));
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
      const before = target.stages[change.stat] ?? 0;
      const after = Math.max(-6, Math.min(6, before + change.change));
      if (after === before) continue;
      target.stages[change.stat] = after;
      changed = true;
      log.push({
        kind: 'stat',
        side: target.side,
        data: { stat: change.stat, change: change.change, stage: after },
      });
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

    const damage = Math.max(1, Math.floor(maxHp(combatant.pokemon) / 16));
    combatant.pokemon.hp = Math.max(0, combatant.pokemon.hp - damage);
    log.push({ kind: 'statusDamage', side: combatant.side, data: { status, amount: damage } });
  }

  /** @param {LogEntry[]} log */
  checkFaint(log) {
    if (!this.foe) return;

    if (this.foe.pokemon.hp <= 0) {
      log.push({ kind: 'faint', side: 'foe', data: { speciesId: this.foe.pokemon.speciesId } });
      this.awardExperience(this.foe, log);

      const next = this.foeQueue.shift();
      if (next) {
        this.foe = next;
        log.push({ kind: 'sendOut', side: 'foe', data: { speciesId: next.pokemon.speciesId } });
      } else {
        this.foe = null;
        this.outcome = 'won';
        log.push({ kind: 'end', data: { outcome: 'won' } });
      }
      return;
    }

    if (this.player.pokemon.hp <= 0) {
      log.push({ kind: 'faint', side: 'player', data: { speciesId: this.player.pokemon.speciesId } });
      this.outcome = 'lost';
      log.push({ kind: 'end', data: { outcome: 'lost' } });
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
      { trainerBattle: this.trainerBattle },
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
    turnsTaken: 0,
    side,
  };
}

/**
 * A stat after its stage multiplier, and paralysis' Speed penalty.
 * @param {Combatant} combatant
 * @param {string} stat
 * @param {{ignorePositive?: boolean, ignoreNegative?: boolean}} [options]
 */
export function effectiveStat(combatant, stat, options = {}) {
  const base = statsOf(combatant.pokemon)[stat] ?? 1;
  let stage = combatant.stages[stat] ?? 0;
  if (options.ignorePositive && stage > 0) stage = 0;
  if (options.ignoreNegative && stage < 0) stage = 0;

  let value = Math.floor(base * stageMultiplier(stage));
  if (stat === 'spe' && combatant.pokemon.status === STATUS.PARALYSIS) value = Math.floor(value * 0.5);
  return Math.max(1, value);
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
      // No weather or terrain is modelled yet, so a field move is always fair
      // game under this condition.
      return true;
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
