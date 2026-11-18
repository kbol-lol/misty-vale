import assert from 'node:assert/strict';
import test from 'node:test';
import {
  totalXpForLevel,
  levelFromTotalXp,
  getLevelProgress,
  xpToNextLevel,
  normalizeLevelingConfig,
  normalizeRewards,
  computeRoleChanges,
  matchTierRoles,
  parseArcaneLevelUp,
  parseLevelImportText,
  renderTemplate,
} from '../src/utils/levelMath.js';

test('xp curve is consistent in both directions', () => {
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(1), 100);
  assert.equal(totalXpForLevel(2), 100 + 155);
  for (let level = 0; level <= 120; level++) {
    const xp = totalXpForLevel(level);
    assert.equal(levelFromTotalXp(xp), level);
    if (level > 0) assert.equal(levelFromTotalXp(xp - 1), level - 1);
  }
  assert.equal(totalXpForLevel(11) - totalXpForLevel(10), xpToNextLevel(10));
});

test('progress reports current and needed xp', () => {
  const p = getLevelProgress(totalXpForLevel(5) + 40);
  assert.equal(p.level, 5);
  assert.equal(p.currentXp, 40);
  assert.equal(p.neededXp, xpToNextLevel(5));
});

test('config normalisation clamps and repairs values', () => {
  const cfg = normalizeLevelingConfig({ xpMin: 50, xpMax: 10, xpMultiplier: 999, cooldownSeconds: -5, roleMode: 'nope' });
  assert.equal(cfg.xpMax >= cfg.xpMin, true);
  assert.equal(cfg.xpMultiplier, 50);
  assert.equal(cfg.cooldownSeconds, 0);
  assert.equal(cfg.roleMode, 'replace');
  assert.equal(normalizeLevelingConfig(null).enabled, true);
});

test('rewards are validated, de-duplicated and sorted', () => {
  const r = normalizeRewards([
    { level: 10, roleId: '222222222222222222' },
    { level: 5, roleId: '111111111111111111' },
    { level: 5, roleId: '333333333333333333' },
    { level: 0, roleId: '444444444444444444' },
    { level: 7, roleId: 'abc' },
  ]);
  assert.deepEqual(r.map((x) => x.level), [5, 10]);
  assert.equal(r[0].roleId, '333333333333333333');
});

const REWARDS = [
  { level: 1, roleId: '100000000000000001' },
  { level: 5, roleId: '100000000000000005' },
  { level: 10, roleId: '100000000000000010' },
];

test('replace mode keeps only the highest earned reward', () => {
  const res = computeRoleChanges({
    level: 7, rewards: REWARDS, mode: 'replace',
    memberRoleIds: ['100000000000000001', '999999999999999999'],
  });
  assert.deepEqual(res.toAdd, ['100000000000000005']);
  assert.deepEqual(res.toRemove, ['100000000000000001']);
});

test('stack mode keeps every earned reward and never touches other roles', () => {
  const res = computeRoleChanges({
    level: 10, rewards: REWARDS, mode: 'stack', memberRoleIds: ['999999999999999999'],
  });
  assert.deepEqual(res.toAdd, ['100000000000000001', '100000000000000005', '100000000000000010']);
  assert.deepEqual(res.toRemove, []);
});

test('level 0 earns nothing and strips rewards', () => {
  const res = computeRoleChanges({ level: 0, rewards: REWARDS, mode: 'replace', memberRoleIds: ['100000000000000005'] });
  assert.deepEqual(res.toAdd, []);
  assert.deepEqual(res.toRemove, ['100000000000000005']);
});

test('default tiers match roles by name ignoring emoji', () => {
  const { matched, missing } = matchTierRoles([
    { id: '1', name: '🌾 Awakened' },
    { id: '2', name: 'Wanderer ✦' },
    { id: '3', name: 'Moderator' },
    { id: '4', name: '🔥 Eternal' },
  ]);
  assert.deepEqual(matched.map((m) => [m.level, m.roleId]), [[1, '1'], [5, '2'], [45, '4']]);
  assert.equal(missing.length, 4);
});

test('parses Arcane level-up announcements', () => {
  const ok = parseArcaneLevelUp({
    text: '๑ ~ <@123456789012345678> is now level 13 ♡',
    mentionedUserIds: ['123456789012345678'],
  });
  assert.deepEqual(ok, { userId: '123456789012345678', level: 13 });

  const bold = parseArcaneLevelUp({ text: '<@123456789012345678> is now level **30**', mentionedUserIds: [] });
  assert.equal(bold.level, 30);

  assert.equal(parseArcaneLevelUp({ text: 'hello world', mentionedUserIds: ['1'] }), null);
  assert.equal(parseArcaneLevelUp({ text: 'is now level 5', mentionedUserIds: [] }), null);
});

test('import parser handles csv, json object and json array', () => {
  const csv = parseLevelImportText('userId,level,xp\n123456789012345678,10\n223456789012345678;5;99999\nbad,row');
  assert.equal(csv.entries.length, 2);
  assert.equal(csv.errors.length, 1);
  assert.equal(csv.entries[1].xp, 99999);

  const obj = parseLevelImportText('{"123456789012345678": 4, "223456789012345678": {"level": 9}}');
  assert.deepEqual(obj.entries.map((e) => e.level), [4, 9]);

  const arr = parseLevelImportText('[{"id":"123456789012345678","level":3}]');
  assert.equal(arr.entries[0].level, 3);
});

test('template placeholders are replaced', () => {
  assert.equal(renderTemplate('{user} hit {level} in {server}', { user: '@a', level: '3', server: 'S' }), '@a hit 3 in S');
});
