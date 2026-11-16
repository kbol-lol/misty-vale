import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addScheduleTask,
  executeScheduledTask,
  listScheduledTasks,
  parseMentionTargets,
  runScheduleTick,
  setScheduleTaskEnabled,
  updateScheduleTask,
} from '../src/services/scheduleService.js';
import { advanceInterval, durationMilliseconds, formatDuration, inactivityDeadline } from '../src/utils/scheduleTime.js';
import { isTempBackedType, parseKey } from '../src/utils/database/keyParser.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { ResponseCoordinator } from '../src/utils/responseCoordinator.js';
import scheduleCommand from '../src/commands/Moderation/schedule.js';
import {
  buildScheduleDashboard,
  buildScheduleLiveConfirmation,
} from '../src/commands/Moderation/modules/schedule_dashboard.js';

let guildNumber = 100;
const uniqueGuildId = () => `schedule-test-guild-${guildNumber++}`;

function createClient(guild, overrides = {}) {
  const data = new Map();
  const db = {
    async get(key, fallback) {
      return data.has(key) ? structuredClone(data.get(key)) : fallback;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
      return true;
    },
  };
  return {
    db,
    guilds: { cache: new Map([[guild.id, guild]]) },
    user: { id: 'bot-id' },
    ...overrides,
  };
}

function makeMember({ id = 'user-id', joinedTimestamp = 0, roles = [] } = {}) {
  const member = {
    id,
    user: { id, username: id, bot: false },
    joinedTimestamp,
    permissions: { has: () => false },
    roles: { cache: new Map(roles.map((roleId) => [roleId, { id: roleId }])) },
    bannable: true,
    kickable: true,
    moderatable: true,
    ban: async () => { member.banned = true; },
    kick: async () => { member.kicked = true; },
    timeout: async () => { member.timedOut = true; },
  };
  return member;
}

function makeGuild(id, members = []) {
  const memberMap = new Map(members.map((member) => [member.id, member]));
  return {
    id,
    ownerId: 'owner-id',
    channels: { cache: new Map(), fetch: async () => null },
    roles: { cache: new Map() },
    members: {
      me: { roles: { highest: { position: 100 } } },
      fetch: async () => memberMap,
    },
  };
}

function addLogChannel(guild) {
  const sent = [];
  const channel = {
    id: 'schedule-log',
    name: 'schedule-log',
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: `log-${sent.length}` };
    },
  };
  guild.channels.cache.set(channel.id, channel);
  return sent;
}

function punishmentValues({ dryRun = true, maxPerRun = 10 } = {}) {
  return {
    type: 'punish',
    name: 'Inactive members',
    punish: {
      targetRoleId: '',
      exemptRoleIds: [],
      activity: { message: true, reaction: false },
      activityChannelId: '',
      deadlineMs: durationMilliseconds(7, 'days'),
      action: 'ban',
      timeoutMs: durationMilliseconds(24, 'hours'),
      punishRoleId: '',
      warnBeforeMs: 0,
      warnChannelId: '',
      warningText: '{users} inactive for {remaining}',
      logChannelId: '',
      dryRun,
      maxPerRun,
    },
  };
}

test('schedule time helpers calculate intervals and inactivity from the latest baseline', () => {
  assert.equal(durationMilliseconds(3, 'days'), 259_200_000);
  assert.equal(advanceInterval(1_000, 100, 1_250), 1_300);
  assert.equal(formatDuration(15 * 60_000), '15 minutes');
  assert.equal(formatDuration(7 * 86_400_000), '7 days');
  assert.equal(inactivityDeadline({
    createdAt: 10,
    armedAt: 20,
    joinedAt: 15,
    lastActivityAt: 30,
    deadlineMs: 100,
  }), 130);
});

test('schedule keys use permanent key-value storage and are included in guild key listings', () => {
  assert.equal(parseKey('guild:123:schedule:tasks').type, 'schedule_tasks');
  assert.equal(parseKey('guild:123:schedule:activity').type, 'schedule_activity');
  assert.equal(isTempBackedType('schedule_tasks'), true);
  assert.equal(isTempBackedType('schedule_activity'), true);
});

test('scheduled announcements are stored, editable, and sent with safe mention allow-lists', async () => {
  const guildId = uniqueGuildId();
  const sent = [];
  const channel = {
    id: 'text-channel',
    name: 'announcements',
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: `message-${sent.length}` };
    },
  };
  const guild = makeGuild(guildId);
  guild.channels.cache.set(channel.id, channel);
  const client = createClient(guild);
  const created = await addScheduleTask(client, guildId, {
    type: 'message',
    name: 'Weekly reminder',
    intervalMs: durationMilliseconds(3, 'days'),
    message: {
      channelId: channel.id,
      content: 'Please read the rules @everyone',
      roleIds: [],
      userIds: [],
      everyone: 'none',
      deletePrevious: false,
    },
  });

  const result = await executeScheduledTask(client, guildId, created.id, { manual: true });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].allowedMentions.parse.length, 0);
  assert.equal(sent[0].content.includes('@\u200beveryone'), true);

  const updated = await updateScheduleTask(client, guildId, created.id, {
    type: 'message',
    name: 'Updated reminder',
    intervalMs: durationMilliseconds(1, 'days'),
    message: { ...created.message, content: 'Updated text' },
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'Updated reminder');
  assert.equal(updated.schedule.intervalMs, durationMilliseconds(1, 'days'));
  assert.equal((await listScheduledTasks(client, guildId)).length, 1);
});

test('inactivity rules simulate by default and do not ban members in preview mode', async () => {
  const guildId = uniqueGuildId();
  const member = makeMember({ joinedTimestamp: Date.now() - durationMilliseconds(30, 'days') });
  const guild = makeGuild(guildId, [member]);
  const client = createClient(guild);
  const task = await addScheduleTask(client, guildId, punishmentValues());
  task.armedAt = 0;
  task.createdAt = 0;
  task.punish.deadlineMs = 1;
  task.schedule.nextRunAt = Date.now() - 1;

  await runScheduleTick(client);

  assert.equal(member.banned, undefined);
  assert.match(task.state.lastResult.text, /Preview only/);
});

test('scheduled simulation logs a member only once for the same inactivity deadline', async () => {
  const guildId = uniqueGuildId();
  const member = makeMember({ id: 'preview-user', joinedTimestamp: 0 });
  const guild = makeGuild(guildId, [member]);
  const logs = addLogChannel(guild);
  const client = createClient(guild);
  const values = punishmentValues();
  values.punish.logChannelId = 'schedule-log';
  const task = await addScheduleTask(client, guildId, values);
  task.armedAt = 0;
  task.createdAt = 0;
  task.punish.deadlineMs = 1;
  task.schedule.nextRunAt = Date.now() - 1;

  await runScheduleTick(client);
  task.schedule.nextRunAt = Date.now() - 1;
  await runScheduleTick(client);

  assert.equal(logs.length, 1);
  assert.equal(member.banned, undefined);
});

test('live inactivity rules enforce the per-run safety cap', async () => {
  const guildId = uniqueGuildId();
  const members = [
    makeMember({ id: 'first-user', joinedTimestamp: 0 }),
    makeMember({ id: 'second-user', joinedTimestamp: 0 }),
  ];
  const guild = makeGuild(guildId, members);
  addLogChannel(guild);
  const client = createClient(guild);
  const values = punishmentValues({ dryRun: false, maxPerRun: 1 });
  values.punish.logChannelId = 'schedule-log';
  const task = await addScheduleTask(client, guildId, values);
  task.armedAt = 0;
  task.createdAt = 0;
  task.punish.deadlineMs = 1;
  task.schedule.nextRunAt = Date.now() - 1;

  await runScheduleTick(client);

  assert.equal(members.some((member) => member.banned), false);
  assert.match(task.state.lastResult.text, /Safety stop/);
});

test('live inactivity rules punish eligible members and log their IDs', async () => {
  const guildId = uniqueGuildId();
  const member = makeMember({ id: 'inactive-user', joinedTimestamp: 0 });
  const guild = makeGuild(guildId, [member]);
  const logs = addLogChannel(guild);
  const client = createClient(guild);
  const values = punishmentValues({ dryRun: false });
  values.punish.logChannelId = 'schedule-log';
  const task = await addScheduleTask(client, guildId, values);
  task.armedAt = 0;
  task.createdAt = 0;
  task.punish.deadlineMs = 1;
  task.schedule.nextRunAt = Date.now() - 1;

  await runScheduleTick(client);

  assert.equal(member.banned, true);
  assert.match(logs[0].content, /<@inactive-user>/);
});

test('overdue announcements are skipped instead of sent late', async () => {
  const guildId = uniqueGuildId();
  const sent = [];
  const channel = {
    id: 'text-channel',
    name: 'announcements',
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: 'message-id' };
    },
  };
  const guild = makeGuild(guildId);
  guild.channels.cache.set(channel.id, channel);
  const client = createClient(guild);
  const task = await addScheduleTask(client, guildId, {
    type: 'message',
    name: 'Late reminder',
    intervalMs: durationMilliseconds(3, 'days'),
    message: { channelId: channel.id, content: 'Reminder', roleIds: [], userIds: [], everyone: 'none' },
  });
  task.schedule.nextRunAt = Date.now() - 2 * 60 * 60_000;

  await runScheduleTick(client);

  assert.equal(sent.length, 0);
  assert.match(task.state.lastResult.text, /Skipped an announcement/);
});

test('task toggles re-arm the inactivity window and mention inputs are validated', async () => {
  const guildId = uniqueGuildId();
  const guild = makeGuild(guildId);
  const roleId = '12345678901234567';
  guild.roles.cache.set(roleId, { id: roleId });
  const client = createClient(guild);
  const task = await addScheduleTask(client, guildId, punishmentValues());
  task.armedAt = 1;

  const enabled = await setScheduleTaskEnabled(client, guildId, task.id, true);
  assert.ok(enabled.armedAt > 1);
  assert.deepEqual(parseMentionTargets(guild, `<@&${roleId}> <@12345678901234568>`), {
    roleIds: [roleId],
    userIds: ['12345678901234568'],
  });
  assert.throws(() => parseMentionTargets(guild, '@everyone'), /Invalid mention/);
});

test('live inactivity dashboard shows an explicit confirmation before enabling', async () => {
  const guildId = uniqueGuildId();
  const guild = makeGuild(guildId);
  const client = createClient(guild);
  const task = await addScheduleTask(client, guildId, {
    ...punishmentValues({ dryRun: false }),
    enabled: false,
  });

  const view = await buildScheduleDashboard(client, guildId, { selectedId: task.id });
  const dashboard = view.embed.toJSON();
  const actionButtons = view.components[2].toJSON().components;
  const confirmation = buildScheduleLiveConfirmation(task, 0);

  assert.match(dashboard.fields[0].value, /LIVE/);
  assert.equal(actionButtons[0].label, 'Enable LIVE');
  assert.equal(confirmation.embed.toJSON().title, 'Enable live inactivity rule?');
  assert.equal(confirmation.components[0].toJSON().components[0].custom_id, `schedule:confirm-enable:${task.id}:0`);
});

test('schedule slash command exposes dashboard and both task creation workflows', () => {
  const command = scheduleCommand.data.toJSON();
  assert.equal(command.name, 'schedule');
  assert.deepEqual(command.options.map((option) => option.name), ['dashboard', 'announcement', 'inactivity']);
});

test('schedule dashboard command defers and then sends its dashboard response', async () => {
  const guildId = uniqueGuildId();
  const guild = makeGuild(guildId);
  const client = createClient(guild);
  await addScheduleTask(client, guildId, punishmentValues());
  let response = null;
  const interaction = {
    id: '12345678901234567',
    user: { id: 'user-id' },
    guildId,
    guild,
    memberPermissions: { has: () => true },
    options: { getSubcommand: () => 'dashboard' },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => {
      response = payload;
      return payload;
    },
  };
  InteractionHelper.patchInteractionResponses(interaction);
  ResponseCoordinator.attach(interaction);

  await scheduleCommand.execute(interaction, null, client);

  assert.equal(interaction.deferred, true);
  assert.equal(response.embeds[0].toJSON().title, 'Schedule Dashboard');
  assert.match(response.embeds[0].toJSON().description, /Inactive members/);
  assert.ok(Array.isArray(response.components));
});
