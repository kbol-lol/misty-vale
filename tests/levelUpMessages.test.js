import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLevelingConfig,
  pickLevelImage,
  findEarnedReward,
  resolveLevelUpAnnouncement,
  buildLevelUpPayload,
} from '../src/utils/levelMath.js';

const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';
const USER = '123456789012345678';
const rewards = [{ level: 5, roleId: ROLE_A }, { level: 10, roleId: ROLE_B }];

function config(announce = {}) {
  return normalizeLevelingConfig({ roleRewards: rewards, announce }).announce;
}

test('new announce settings have safe defaults and are validated', () => {
  const a = config();
  assert.equal(a.imageMode, 'every');
  assert.equal(a.rewardMessage.enabled, false);
  assert.deepEqual(a.levelMessages, []);

  const b = config({
    imageMode: 'weird',
    rewardMessage: { enabled: 1, message: '', imageUrl: 'http://insecure.example/x.gif' },
    levelMessages: [
      { level: 10, message: 'ten', imageUrl: 'https://a.example/10.gif' },
      { level: 10, message: 'ten again' }, // same level: later wins
      { level: 0, message: 'bad level' },
      { level: 3 }, // no message and no image: dropped
      { level: 7, imageUrl: 'https://a.example/7.png' },
    ],
  });
  assert.equal(b.imageMode, 'every');
  assert.equal(b.rewardMessage.enabled, true);
  assert.ok(b.rewardMessage.message.length > 0, 'empty reward message falls back to the default');
  assert.equal(b.rewardMessage.imageUrl, null, 'only https links are kept');
  assert.deepEqual(b.levelMessages.map((m) => [m.level, m.message]), [[7, ''], [10, 'ten again']]);
});

test('existing saved configs without the new fields still load', () => {
  const old = normalizeLevelingConfig({
    enabled: true,
    announce: { mode: 'channel', channelId: '333333333333333333', message: 'old {level}', imageUrl: 'https://a.example/d.png' },
  });
  assert.equal(old.announce.message, 'old {level}');
  assert.equal(old.announce.imageMode, 'every');
  assert.equal(pickLevelImage(old.announce, 3), 'https://a.example/d.png');
});

test('specific image mode only shows images on exact levels', () => {
  const a = config({
    imageMode: 'specific',
    imageUrl: 'https://a.example/default.png',
    levelImages: [{ level: 5, url: 'https://a.example/5.png' }],
  });
  assert.equal(pickLevelImage(a, 5), 'https://a.example/5.png');
  assert.equal(pickLevelImage(a, 6), null);
  assert.equal(pickLevelImage(a, 2), null, 'the default image is not used in specific mode');
});

test('findEarnedReward returns the highest reward crossed by a level-up', () => {
  assert.equal(findEarnedReward(rewards, 4, 5)?.roleId, ROLE_A);
  assert.equal(findEarnedReward(rewards, 5, 6), null);
  assert.equal(findEarnedReward(rewards, 4, 12)?.roleId, ROLE_B, 'skipping levels still earns the top role');
  assert.equal(findEarnedReward([], 4, 5), null);
});

test('role reward message is used only when a role is earned and it is enabled', () => {
  const a = config({
    message: 'normal {level}',
    rewardMessage: { enabled: true, message: '{user} got {role}', title: 'Role!', imageUrl: 'https://a.example/role.gif' },
  });
  const reward = resolveLevelUpAnnouncement(a, { level: 5, previousLevel: 4, rewards });
  assert.equal(reward.kind, 'reward');
  assert.equal(reward.imageUrl, 'https://a.example/role.gif');

  const normal = resolveLevelUpAnnouncement(a, { level: 6, previousLevel: 5, rewards });
  assert.equal(normal.kind, 'default');

  const rolesOff = resolveLevelUpAnnouncement(a, { level: 5, previousLevel: 4, rewards, rolesEnabled: false });
  assert.equal(rolesOff.kind, 'default', 'no role is given when auto roles is off');

  const disabled = resolveLevelUpAnnouncement(config({ rewardMessage: { enabled: false } }), { level: 5, previousLevel: 4, rewards });
  assert.equal(disabled.kind, 'default');
});

test('a custom level message beats the role reward message and fills gaps from it', () => {
  const a = config({
    message: 'normal',
    rewardMessage: { enabled: true, message: 'reward msg', imageUrl: 'https://a.example/role.gif' },
    levelMessages: [
      { level: 10, message: 'level ten!' },
      { level: 5, imageUrl: 'https://a.example/five.gif' },
    ],
  });
  const ten = resolveLevelUpAnnouncement(a, { level: 10, previousLevel: 9, rewards });
  assert.equal(ten.kind, 'level');
  assert.equal(ten.message, 'level ten!');
  assert.equal(ten.imageUrl, 'https://a.example/role.gif', 'no own image: falls back to the reward image');

  const five = resolveLevelUpAnnouncement(a, { level: 5, previousLevel: 4, rewards });
  assert.equal(five.message, 'reward msg', 'image-only entry keeps the reward text');
  assert.equal(five.imageUrl, 'https://a.example/five.gif');
});

test('payload renders {role} as a mention without pinging the role', () => {
  const a = config({
    useEmbed: true,
    title: 'Level {level}',
    rewardMessage: { enabled: true, message: '{user} earned {role}', title: 'You are now {role}' },
  });
  const out = buildLevelUpPayload(a, {
    userId: USER, username: 'Bear', level: 5, previousLevel: 4, serverName: 'S', rewards, roleName: 'Wanderer',
  });
  assert.equal(out.embeds[0].description, `<@${USER}> earned <@&${ROLE_A}>`);
  assert.equal(out.embeds[0].title, 'You are now Wanderer');
  assert.deepEqual(out.allowedMentions, { users: [USER] });
  assert.equal(out.content, `<@${USER}>`);
  assert.equal('kind' in out, false, 'payload only has fields Discord understands');
});

test('payload without the new context still behaves like before', () => {
  const a = config({ message: '{user} is now level **{level}**!' });
  const out = buildLevelUpPayload(a, { userId: USER, username: 'Bear', level: 5, serverName: 'S' });
  assert.equal(out.content, `<@${USER}> is now level **5**!`);
});
