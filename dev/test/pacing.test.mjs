/**
 * The journey's pacing: when the gym leaders come, and what the League stands
 * at once all eight have been beaten.
 *
 * The badges are tied to levels so the eighth lands around 70, however fast
 * the companion levels, and the League waits in the 70s for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BADGE_LEVELS, BADGES_FOR_LEAGUE, leaderOdds } from '../../app/shared/constants.mjs';
import { LEAGUE_LEVELS, leagueLevel } from '../../app/renderer/scenes/league.mjs';

test('every badge has a level it is due by, rising, the eighth around 70', () => {
  assert.equal(BADGE_LEVELS.length, BADGES_FOR_LEAGUE);
  for (let index = 1; index < BADGE_LEVELS.length; index++) {
    assert.ok(BADGE_LEVELS[index] > BADGE_LEVELS[index - 1], `badge ${index + 1} after badge ${index}`);
  }
  const last = BADGE_LEVELS[BADGE_LEVELS.length - 1];
  assert.ok(last >= 65 && last <= 72, `the eighth badge is due at ${last}`);
});

test('a leader is all but certain once the next badge is due', () => {
  for (const [badges, due] of BADGE_LEVELS.entries()) {
    const odds = leaderOdds(badges, due);
    assert.ok(odds.chance >= 0.5, `badge ${badges + 1} at level ${due}`);
    assert.ok(odds.wins <= 3, 'a few fights at most');
    // Overdue is no less likely.
    assert.deepEqual(leaderOdds(badges, due + 15), odds);
  }
});

test('a leader can come a little early, by luck, but never a whole gym early', () => {
  for (const [badges, due] of BADGE_LEVELS.entries()) {
    const near = leaderOdds(badges, due - 3);
    assert.ok(near.chance > 0 && near.chance < 0.2, `badge ${badges + 1} three levels short`);
    assert.equal(near.wins, Infinity, 'fights won while too low do not add up to a summons');

    const far = leaderOdds(badges, due - 10);
    assert.equal(far.chance, 0, `badge ${badges + 1} ten levels short`);
    assert.equal(far.wins, Infinity);
  }
});

test('the League stands in the 70s, the champion at the top of it', () => {
  const levels = [0, 1, 2, 3, 4].map((index) => leagueLevel(index, 5));
  assert.deepEqual(levels, LEAGUE_LEVELS);
  for (const level of levels) assert.ok(level >= 70 && level <= 80, `${level}`);
  for (let index = 1; index < levels.length; index++) assert.ok(levels[index] > levels[index - 1]);
});

test('the champion is the last round whatever the league counts', () => {
  const top = LEAGUE_LEVELS[LEAGUE_LEVELS.length - 1];
  assert.equal(leagueLevel(5, 6), top, 'a six-round league ends on the champion');
  assert.ok(leagueLevel(4, 6) < top, 'and its fifth round is still an Elite Four member');
  assert.equal(leagueLevel(3, 4), top, 'a four-round league too');
});
