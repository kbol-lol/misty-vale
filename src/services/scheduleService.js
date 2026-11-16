import { randomBytes } from 'node:crypto';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { getScheduleActivityKey, getScheduleTasksKey } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { advanceInterval, formatDuration, inactivityDeadline } from '../utils/scheduleTime.js';

const MAX_TASKS_PER_GUILD = 50;
const MAX_HISTORY = 10;
const PUNISHMENT_TICK_MS = 5 * 60_000;
const MESSAGE_MAX_LATE_MS = 60 * 60_000;
const ACTIVITY_RETENTION_MS = 365 * 86_400_000;
const PROCESS_STARTED_AT = Date.now();

const taskCache = new Map();
const activityCache = new Map();
const pendingLoads = new Map();
const dirtyActivityGuilds = new Set();
const runningTasks = new Set();
const startedClients = new WeakSet();
let tickRunning = false;
let lastActivityPruneAt = 0;

const ACTION_LABELS = {
  ban: 'ban',
  kick: 'kick',
  timeout: 'time out',
  remove_role: 'remove a role',
};

function assertStorage(client) {
  if (!client?.db || typeof client.db.get !== 'function' || typeof client.db.set !== 'function') {
    throw new Error('Persistent database storage is unavailable for the schedule module.');
  }
}

function normalizeActivity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { activity: {}, warned: {} };
  }
  return {
    activity: value.activity && typeof value.activity === 'object' ? value.activity : {},
    warned: value.warned && typeof value.warned === 'object' ? value.warned : {},
    previewed: value.previewed && typeof value.previewed === 'object' ? value.previewed : {},
    previewedWarnings: value.previewedWarnings && typeof value.previewedWarnings === 'object' ? value.previewedWarnings : {},
    monitoringStartedAt: Number.isFinite(value.monitoringStartedAt) ? value.monitoringStartedAt : 0,
  };
}

async function loadGuild(client, guildId) {
  assertStorage(client);
  if (taskCache.has(guildId)) return;
  if (pendingLoads.has(guildId)) return pendingLoads.get(guildId);

  const pending = (async () => {
    const [tasks, activity] = await Promise.all([
      client.db.get(getScheduleTasksKey(guildId), []),
      client.db.get(getScheduleActivityKey(guildId), {}),
    ]);
    if (!Array.isArray(tasks)) {
      throw new Error(`Stored schedule tasks for guild ${guildId} are not a list.`);
    }

    const validTasks = tasks.filter((task) => {
      const valid = task
        && task.guildId === guildId
        && typeof task.id === 'string'
        && ['message', 'punish'].includes(task.type)
        && task.schedule
        && task.state;
      if (!valid) logger.error(`Ignoring malformed schedule task in guild ${guildId}.`);
      return valid;
    });

    taskCache.set(guildId, validTasks);
    const normalizedActivity = normalizeActivity(activity);
    if (normalizedActivity.monitoringStartedAt < PROCESS_STARTED_AT) {
      normalizedActivity.monitoringStartedAt = PROCESS_STARTED_AT;
      dirtyActivityGuilds.add(guildId);
    }
    activityCache.set(guildId, normalizedActivity);
  })();

  pendingLoads.set(guildId, pending);
  try {
    await pending;
  } finally {
    pendingLoads.delete(guildId);
  }
}

async function persistTasks(client, guildId) {
  assertStorage(client);
  const saved = await client.db.set(getScheduleTasksKey(guildId), taskCache.get(guildId) || []);
  if (saved === false) throw new Error(`Could not save schedule tasks for guild ${guildId}.`);
}

async function persistActivity(client, guildId) {
  assertStorage(client);
  const saved = await client.db.set(getScheduleActivityKey(guildId), activityCache.get(guildId) || { activity: {}, warned: {} });
  if (saved === false) throw new Error(`Could not save schedule activity for guild ${guildId}.`);
}

export async function listScheduledTasks(client, guildId) {
  await loadGuild(client, guildId);
  return [...taskCache.get(guildId)];
}

export async function addScheduleTask(client, guildId, values) {
  await loadGuild(client, guildId);
  if (!['message', 'punish'].includes(values.type) || !values.name?.trim()) {
    throw new Error('A valid task type and non-empty name are required.');
  }
  const tasks = taskCache.get(guildId);
  if (tasks.length >= MAX_TASKS_PER_GUILD) {
    throw new Error(`A server can have at most ${MAX_TASKS_PER_GUILD} scheduled tasks.`);
  }

  const now = Date.now();
  const intervalMs = values.type === 'message' ? values.intervalMs : PUNISHMENT_TICK_MS;
  const task = {
    id: randomBytes(5).toString('hex'),
    guildId,
    type: values.type,
    name: values.name,
    enabled: values.enabled !== false,
    finished: false,
    createdAt: now,
    armedAt: now,
    schedule: { intervalMs, nextRunAt: now + intervalMs },
    state: { runCount: 0, lastRunAt: null, lastResult: null },
    history: [],
    ...(values.type === 'message' ? { message: values.message } : { punish: values.punish }),
  };
  taskCache.set(guildId, [...tasks, task]);
  try {
    await persistTasks(client, guildId);
  } catch (error) {
    taskCache.set(guildId, tasks);
    throw error;
  }
  return task;
}

export async function updateScheduleTask(client, guildId, taskId, values) {
  await loadGuild(client, guildId);
  const tasks = taskCache.get(guildId);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error('Scheduled task not found.');
  const existing = tasks[index];
  if (existing.type !== values.type) throw new Error('The task type cannot be changed; delete it and create a new task instead.');

  const now = Date.now();
  const updated = {
    ...existing,
    name: values.name,
    finished: false,
    armedAt: now,
    schedule: {
      intervalMs: values.type === 'message' ? values.intervalMs : PUNISHMENT_TICK_MS,
      nextRunAt: now + (values.type === 'message' ? values.intervalMs : PUNISHMENT_TICK_MS),
    },
    state: { ...existing.state },
    ...(values.type === 'message' ? { message: values.message } : { punish: values.punish }),
  };
  tasks[index] = updated;
  const state = activityCache.get(guildId);
  const priorWarnings = state?.warned?.[taskId];
  const priorPreviewed = state?.previewed?.[taskId];
  const priorPreviewedWarnings = state?.previewedWarnings?.[taskId];
  if (state?.warned?.[taskId]) delete state.warned[taskId];
  if (state?.previewed?.[taskId]) delete state.previewed[taskId];
  if (state?.previewedWarnings?.[taskId]) delete state.previewedWarnings[taskId];
  try {
    await persistTasks(client, guildId);
  } catch (error) {
    tasks[index] = existing;
    if (state && priorWarnings) state.warned[taskId] = priorWarnings;
    if (state && priorPreviewed) state.previewed[taskId] = priorPreviewed;
    if (state && priorPreviewedWarnings) state.previewedWarnings[taskId] = priorPreviewedWarnings;
    throw error;
  }
  if (state && (priorWarnings || priorPreviewed || priorPreviewedWarnings)) dirtyActivityGuilds.add(guildId);
  return updated;
}

export async function setScheduleTaskEnabled(client, guildId, taskId, enabled) {
  await loadGuild(client, guildId);
  const tasks = taskCache.get(guildId);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return null;

  const previous = {
    enabled: task.enabled,
    armedAt: task.armedAt,
    finished: task.finished,
    nextRunAt: task.schedule.nextRunAt,
  };
  const state = activityCache.get(guildId);
  const previousWarnings = state?.warned?.[task.id];
  const previousPreviewed = state?.previewed?.[task.id];
  const previousPreviewedWarnings = state?.previewedWarnings?.[task.id];
  task.enabled = Boolean(enabled);
  if (task.enabled) {
    task.armedAt = Date.now();
    task.finished = false;
    task.schedule.nextRunAt = task.armedAt + task.schedule.intervalMs;
    if (state?.warned?.[task.id]) delete state.warned[task.id];
    if (state?.previewed?.[task.id]) delete state.previewed[task.id];
    if (state?.previewedWarnings?.[task.id]) delete state.previewedWarnings[task.id];
  }
  try {
    await persistTasks(client, guildId);
  } catch (error) {
    Object.assign(task, {
      enabled: previous.enabled,
      armedAt: previous.armedAt,
      finished: previous.finished,
    });
    task.schedule.nextRunAt = previous.nextRunAt;
    if (state && previousWarnings) state.warned[task.id] = previousWarnings;
    if (state && previousPreviewed) state.previewed[task.id] = previousPreviewed;
    if (state && previousPreviewedWarnings) state.previewedWarnings[task.id] = previousPreviewedWarnings;
    throw error;
  }
  if (state && task.enabled && (previousWarnings || previousPreviewed || previousPreviewedWarnings)) {
    dirtyActivityGuilds.add(guildId);
  }
  return task;
}

export async function deleteScheduleTask(client, guildId, taskId) {
  await loadGuild(client, guildId);
  const tasks = taskCache.get(guildId);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return false;
  const [removed] = tasks.splice(index, 1);
  const activity = activityCache.get(guildId);
  const priorWarnings = activity?.warned?.[removed.id];
  const priorPreviewed = activity?.previewed?.[removed.id];
  const priorPreviewedWarnings = activity?.previewedWarnings?.[removed.id];
  if (activity?.warned?.[removed.id]) {
    delete activity.warned[removed.id];
  }
  if (activity?.previewed?.[removed.id]) delete activity.previewed[removed.id];
  if (activity?.previewedWarnings?.[removed.id]) delete activity.previewedWarnings[removed.id];
  try {
    await persistTasks(client, guildId);
  } catch (error) {
    tasks.splice(index, 0, removed);
    if (activity && priorWarnings) activity.warned[removed.id] = priorWarnings;
    if (activity && priorPreviewed) activity.previewed[removed.id] = priorPreviewed;
    if (activity && priorPreviewedWarnings) activity.previewedWarnings[removed.id] = priorPreviewedWarnings;
    throw error;
  }
  if (activity && (priorWarnings || priorPreviewed || priorPreviewedWarnings)) dirtyActivityGuilds.add(guildId);
  return true;
}

export function parseMentionTargets(guild, raw = '') {
  const roles = new Set();
  const users = new Set();
  const tokens = String(raw).split(/[\s,;]+/).filter(Boolean);

  for (const token of tokens) {
    const roleMention = /^<@&(\d{17,20})>$/.exec(token);
    if (roleMention) {
      if (!guild.roles.cache.has(roleMention[1])) throw new Error(`Role ${token} does not exist in this server.`);
      roles.add(roleMention[1]);
      continue;
    }
    const userMention = /^<@!?(\d{17,20})>$/.exec(token);
    if (userMention) {
      users.add(userMention[1]);
      continue;
    }
    throw new Error(`Invalid mention ${token}. Use a role mention or user mention.`);
  }

  if (roles.size + users.size > 20) throw new Error('At most 20 role/user mentions can be scheduled.');
  return { roleIds: [...roles], userIds: [...users] };
}

function getActivityTimestamp(activity, userId, kind, channelId) {
  const userActivity = activity?.activity?.[userId];
  if (!userActivity) return 0;
  const kindActivity = userActivity[kind];
  if (!kindActivity) return 0;
  return channelId ? kindActivity[channelId] || 0 : kindActivity['*'] || 0;
}

function trackActivity(client, guildId, userId, kind, channelIds) {
  const tasks = taskCache.get(guildId) || [];
  const matching = tasks.filter((task) =>
    task.type === 'punish'
    && task.enabled
    && task.punish.activity[kind]
    && (!task.punish.activityChannelId || channelIds.includes(task.punish.activityChannelId)),
  );
  if (!matching.length) return;

  const state = activityCache.get(guildId);
  if (!state) return;
  const now = Date.now();
  const userState = state.activity[userId] || (state.activity[userId] = {});
  const kindState = userState[kind] || (userState[kind] = {});
  kindState['*'] = now;
  for (const channelId of channelIds) {
    if (channelId) kindState[channelId] = now;
  }
  for (const task of matching) {
    const warned = state.warned[task.id];
    if (warned?.[userId]) delete warned[userId];
    if (state.previewed[task.id]?.[userId]) delete state.previewed[task.id][userId];
    if (state.previewedWarnings[task.id]?.[userId]) delete state.previewedWarnings[task.id][userId];
  }
  if (now - lastActivityPruneAt >= 60 * 60_000) {
    pruneOldActivity(state, now);
    lastActivityPruneAt = now;
  }
  dirtyActivityGuilds.add(guildId);
}

function pruneOldActivity(state, now) {
  const cutoff = now - ACTIVITY_RETENTION_MS;
  for (const [userId, userActivity] of Object.entries(state.activity)) {
    for (const [kind, scopedActivity] of Object.entries(userActivity)) {
      for (const [scopeId, timestamp] of Object.entries(scopedActivity)) {
        if (timestamp < cutoff) delete scopedActivity[scopeId];
      }
      if (!Object.keys(scopedActivity).length) delete userActivity[kind];
    }
    if (!Object.keys(userActivity).length) delete state.activity[userId];
  }
}

export async function startScheduleTracking(client) {
  if (startedClients.has(client)) return;
  startedClients.add(client);

  const loadGuildTasks = async (guildId) => {
    try {
      await loadGuild(client, guildId);
    } catch (error) {
      logger.error(`Failed to load scheduled tasks for guild ${guildId}:`, error);
    }
  };

  await Promise.all([...client.guilds.cache.keys()].map(loadGuildTasks));
  const monitoringStartedAt = Date.now();
  for (const [guildId, tasks] of taskCache) {
    if (!tasks.some((task) => task.type === 'punish' && task.enabled)) continue;
    const state = activityCache.get(guildId);
    if (state) {
      state.monitoringStartedAt = monitoringStartedAt;
      dirtyActivityGuilds.add(guildId);
    }
  }
  client.on(Events.GuildCreate, (guild) => void loadGuildTasks(guild.id));
  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId || message.author?.bot || message.webhookId || message.system) return;
    void loadGuild(client, message.guildId)
      .then(() => trackActivity(client, message.guildId, message.author.id, 'message', [message.channelId, message.channel?.parentId]))
      .catch((error) => logger.error(`Failed to record schedule activity for guild ${message.guildId}:`, error));
  });
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (user?.bot) return;
    const message = reaction.message;
    const guildId = message.guildId || message.guild?.id;
    if (!guildId) return;
    void loadGuild(client, guildId)
      .then(() => trackActivity(client, guildId, user.id, 'reaction', [message.channelId, message.channel?.parentId]))
      .catch((error) => logger.error(`Failed to record schedule reaction for guild ${guildId}:`, error));
  });
}

export async function flushScheduleActivity(client) {
  for (const guildId of [...dirtyActivityGuilds]) {
    try {
      await persistActivity(client, guildId);
      dirtyActivityGuilds.delete(guildId);
    } catch (error) {
      logger.error(`Failed to persist schedule activity for guild ${guildId}:`, error);
    }
  }
}

function isEligibleMember(member, guild, punish) {
  if (!member || member.user?.bot || member.id === guild.ownerId) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return false;
  if (punish.targetRoleId && !member.roles.cache.has(punish.targetRoleId)) return false;
  if (punish.exemptRoleIds.some((roleId) => member.roles.cache.has(roleId))) return false;
  return true;
}

async function getTextChannel(guild, channelId) {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || typeof channel.send !== 'function') {
    throw new Error(`Configured text channel ${channelId} is unavailable.`);
  }
  return channel;
}

async function botMemberFor(guild) {
  return guild.members.me || await guild.members.fetchMe();
}

async function sendScheduleLog(guild, channelId, content) {
  if (!channelId) return true;
  const channel = await getTextChannel(guild, channelId);
  const botMember = await botMemberFor(guild);
  if (!channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new Error(`The bot cannot send schedule logs to #${channel.name}.`);
  }
  await channel.send({ content: content.slice(0, 2000), allowedMentions: { parse: [] } });
  return true;
}

async function assertScheduleLogAvailable(guild, channelId) {
  if (!channelId) throw new Error('A log channel is required before live punishments can run.');
  const channel = await getTextChannel(guild, channelId);
  const botMember = await botMemberFor(guild);
  if (!channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new Error(`The bot cannot send schedule logs to #${channel.name}.`);
  }
}

async function runMessageTask(client, task) {
  const guild = client.guilds.cache.get(task.guildId);
  if (!guild) throw new Error('The bot is no longer in this server.');
  const channel = await getTextChannel(guild, task.message.channelId);
  const botMember = await botMemberFor(guild);
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (task.message.everyone !== 'none') required.push(PermissionFlagsBits.MentionEveryone);
  if (task.message.roleIds.some((id) => !guild.roles.cache.get(id)?.mentionable)) {
    required.push(PermissionFlagsBits.MentionEveryone);
  }
  if (!channel.permissionsFor(botMember)?.has(required)) {
    throw new Error(`The bot is missing a required permission in #${channel.name}.`);
  }

  const safeText = task.message.content.replace(/@(everyone|here)/gi, '@\u200b$1');
  const pings = [
    task.message.everyone === 'everyone' ? '@everyone' : task.message.everyone === 'here' ? '@here' : null,
    ...task.message.roleIds.map((id) => `<@&${id}>`),
    ...task.message.userIds.map((id) => `<@${id}>`),
  ].filter(Boolean);
  const sent = await channel.send({
    content: [pings.join(' '), safeText].filter(Boolean).join('\n').slice(0, 2000),
    allowedMentions: {
      parse: task.message.everyone === 'none' ? [] : ['everyone'],
      roles: task.message.roleIds,
      users: task.message.userIds,
      repliedUser: false,
    },
  });

  if (task.message.deletePrevious && task.state.lastMessageId) {
    const previousChannel = await getTextChannel(guild, task.state.lastChannelId).catch(() => null);
    const previous = await previousChannel?.messages.fetch(task.state.lastMessageId).catch(() => null);
    if (previous?.author?.id === client.user.id) {
      await previous.delete().catch((error) => logger.warn(`Could not delete the previous scheduled message: ${error.message}`));
    }
  }
  task.state.lastMessageId = sent.id;
  task.state.lastChannelId = channel.id;
  return { ok: true, text: `Announcement sent in #${channel.name}.` };
}

function eligibleKinds(punish) {
  return ['message', 'reaction'].filter((kind) => punish.activity[kind]);
}

function lastActivityAt(state, task, userId) {
  return Math.max(
    ...eligibleKinds(task.punish).map((kind) =>
      getActivityTimestamp(state, userId, kind, task.punish.activityChannelId),
    ),
    0,
  );
}

async function runPunishmentTask(client, task, {
  forceDryRun = false,
  manual = false,
  memberSnapshots = null,
} = {}) {
  const guild = client.guilds.cache.get(task.guildId);
  if (!guild) throw new Error('The bot is no longer in this server.');
  if (!forceDryRun && !task.punish.dryRun && client.db?.isDegraded?.()) {
    throw new Error('Live inactivity rules are paused because persistent database storage is degraded.');
  }
  const state = activityCache.get(task.guildId);
  if (!state) throw new Error(`Activity state for guild ${task.guildId} is not loaded.`);
  if (!['ban', 'kick', 'timeout', 'remove_role'].includes(task.punish.action)) {
    throw new Error('The stored inactivity rule has an unsupported action.');
  }

  let snapshot = memberSnapshots?.get(guild.id);
  if (!snapshot) {
    snapshot = { members: await guild.members.fetch(), acted: new Set() };
    memberSnapshots?.set(guild.id, snapshot);
  }
  const { members, acted } = snapshot;
  const now = Date.now();
  const deadlineMs = task.punish.deadlineMs;
  const warnBeforeMs = task.punish.warnBeforeMs || 0;
  const due = [];
  const toWarn = [];
  const memberIds = new Set();

  for (const member of members.values()) {
    memberIds.add(member.id);
    if (acted.has(member.id)) continue;
    if (!isEligibleMember(member, guild, task.punish)) continue;
    const lastAction = lastActivityAt(state, task, member.id);
    const deadlineAt = inactivityDeadline({
      armedAt: Math.max(task.armedAt || 0, state.monitoringStartedAt || 0),
      createdAt: task.createdAt,
      joinedAt: member.joinedTimestamp,
      lastActivityAt: lastAction,
      deadlineMs,
    });
    if (now >= deadlineAt) {
      due.push({ member, deadlineAt });
    } else if (warnBeforeMs && now >= deadlineAt - warnBeforeMs && state.warned[task.id]?.[member.id] !== deadlineAt) {
      toWarn.push({ member, deadlineAt });
    }
  }

  for (const userId of Object.keys(state.activity)) {
    if (!memberIds.has(userId)) delete state.activity[userId];
  }

  const dryRun = forceDryRun || task.punish.dryRun;
  if (!dryRun && due.length) await assertScheduleLogAvailable(guild, task.punish.logChannelId);
  if (!dryRun && due.length > task.punish.maxPerRun) {
    const text = `Safety stop: ${due.length} members are due, above the configured limit of ${task.punish.maxPerRun}. Nobody was punished.`;
    await sendScheduleLog(guild, task.punish.logChannelId, `[Schedule] **${task.name}**: ${text}`).catch((error) => {
      logger.error(`Could not log schedule safety stop for task ${task.id}:`, error);
    });
    return { ok: false, text };
  }

  if (dryRun) {
    const previewed = state.previewed[task.id] || (state.previewed[task.id] = {});
    const previewedWarnings = state.previewedWarnings[task.id] || (state.previewedWarnings[task.id] = {});
    const newDue = manual
      ? due
      : due.filter(({ member, deadlineAt }) => previewed[member.id] !== deadlineAt);
    const newWarnings = manual
      ? toWarn
      : toWarn.filter(({ member, deadlineAt }) => previewedWarnings[member.id] !== deadlineAt);
    if (!manual) {
      for (const { member, deadlineAt } of newDue) previewed[member.id] = deadlineAt;
      for (const { member, deadlineAt } of newWarnings) previewedWarnings[member.id] = deadlineAt;
      if (newDue.length || newWarnings.length) dirtyActivityGuilds.add(task.guildId);
    }

    const text = `Preview only: ${due.length} member(s) would ${ACTION_LABELS[task.punish.action]}; ${toWarn.length} would be warned. No action was taken.`;
    if (newDue.length || newWarnings.length) {
      const membersText = newDue.slice(0, 20).map(({ member }) => `<@${member.id}>`).join(', ');
      const suffix = newDue.length > 20 ? `, and ${newDue.length - 20} more` : '';
      const warningText = newWarnings.length ? ` ${newWarnings.length} member(s) would receive a warning.` : '';
      await sendScheduleLog(guild, task.punish.logChannelId, `[Schedule] **${task.name}** — ${text}${warningText}${membersText ? `\nWould affect: ${membersText}${suffix}` : ''}`).catch((error) => {
        logger.error(`Could not log dry-run schedule task ${task.id}:`, error);
      });
    }
    return { ok: true, text, record: manual || newDue.length > 0 || newWarnings.length > 0 };
  }

  if (toWarn.length && task.punish.warnChannelId) {
    const channel = await getTextChannel(guild, task.punish.warnChannelId);
    const botMember = await botMemberFor(guild);
    if (!channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new Error(`The bot cannot send warnings to #${channel.name}.`);
    }
    const ids = toWarn.map(({ member }) => member.id);
    const text = task.punish.warningText
      .replaceAll('{users}', ids.map((id) => `<@${id}>`).join(' '))
      .replaceAll('{remaining}', formatDuration(warnBeforeMs))
      .replaceAll('{action}', ACTION_LABELS[task.punish.action])
      .replaceAll('{server}', guild.name);
    await channel.send({
      content: text.slice(0, 2000),
      allowedMentions: { users: ids, parse: [] },
    });
    state.warned[task.id] ||= {};
    for (const { member, deadlineAt } of toWarn) state.warned[task.id][member.id] = deadlineAt;
    dirtyActivityGuilds.add(task.guildId);
  }

  let successCount = 0;
  const affected = [];
  const failures = [];
  for (const { member } of due) {
    try {
      const reason = `Schedule "${task.name}": inactive for ${formatDuration(deadlineMs)}`.slice(0, 500);
      if (task.punish.action === 'ban') {
        if (!member.bannable) throw new Error('member is not bannable due to role hierarchy or permissions');
        await member.ban({ reason, deleteMessageSeconds: 0 });
      } else if (task.punish.action === 'kick') {
        if (!member.kickable) throw new Error('member is not kickable due to role hierarchy or permissions');
        await member.kick(reason);
      } else if (task.punish.action === 'timeout') {
        if (!member.moderatable) throw new Error('member cannot be timed out due to role hierarchy or permissions');
        await member.timeout(task.punish.timeoutMs, reason);
      } else if (task.punish.action === 'remove_role') {
        if (!member.roles.cache.has(task.punish.punishRoleId)) continue;
        await member.roles.remove(task.punish.punishRoleId, reason);
      }

      acted.add(member.id);
      const userActivity = state.activity[member.id] || (state.activity[member.id] = {});
      for (const kind of eligibleKinds(task.punish)) {
        const kindActivity = userActivity[kind] || (userActivity[kind] = {});
        kindActivity[task.punish.activityChannelId || '*'] = now;
      }
      if (state.warned[task.id]) delete state.warned[task.id][member.id];
      dirtyActivityGuilds.add(task.guildId);
      successCount++;
      affected.push(member);
    } catch (error) {
      failures.push(`${member.user?.username || member.id}: ${error.message}`);
    }
  }

  const summary = `${task.punish.action}: ${successCount} action(s), ${failures.length} failure(s), ${toWarn.length} warning(s).`;
  if (successCount || failures.length || toWarn.length) {
    const details = failures.length ? `\nFailures:\n${failures.slice(0, 10).join('\n')}` : '';
    const membersText = affected.slice(0, 20).map((member) => `<@${member.id}>`).join(', ');
    const suffix = affected.length > 20 ? `, and ${affected.length - 20} more` : '';
    const affectedText = membersText ? `\nAffected: ${membersText}${suffix}` : '';
    await sendScheduleLog(guild, task.punish.logChannelId, `[Schedule] **${task.name}** — ${summary}${affectedText}${details}`).catch((error) => {
      logger.error(`Could not log schedule execution for task ${task.id}:`, error);
    });
  }
  return { ok: failures.length === 0, text: summary };
}

export async function executeScheduledTask(client, guildId, taskId, {
  manual = false,
  forceDryRun = false,
  memberSnapshots = null,
} = {}) {
  await loadGuild(client, guildId);
  const task = taskCache.get(guildId).find((item) => item.id === taskId);
  if (!task) return { ok: false, text: 'Scheduled task not found.' };
  if (runningTasks.has(task.id)) return { ok: false, text: 'This scheduled task is already running.' };
  runningTasks.add(task.id);

  try {
    const now = Date.now();
    let result;
    const lateBy = task.type === 'message' && !manual
      ? Math.max(0, now - (task.schedule.nextRunAt || now))
      : 0;
    if (lateBy > MESSAGE_MAX_LATE_MS) {
      result = { ok: true, text: `Skipped an announcement that was ${Math.round(lateBy / 60_000)} minutes late.` };
    } else {
      try {
        result = task.type === 'message'
          ? await runMessageTask(client, task)
          : await runPunishmentTask(client, task, { forceDryRun, manual, memberSnapshots });
      } catch (error) {
        logger.error(`Schedule task "${task.name}" failed:`, error);
        result = { ok: false, text: error.message || String(error) };
      }
    }

    task.state.lastRunAt = now;
    task.state.lastResult = { ok: result.ok, text: String(result.text).slice(0, 500) };
    if (result.record !== false) {
      task.state.runCount = (task.state.runCount || 0) + 1;
      task.history = [
        { at: now, ok: result.ok, text: String(result.text).slice(0, 500), manual },
        ...(task.history || []),
      ].slice(0, MAX_HISTORY);
    }

    if (!manual) {
      if (task.type === 'message') {
        task.schedule.nextRunAt = advanceInterval(task.schedule.nextRunAt, task.schedule.intervalMs, now);
      } else {
        task.schedule.nextRunAt = now + task.schedule.intervalMs;
      }
    }

    await persistTasks(client, guildId);
    return result;
  } finally {
    runningTasks.delete(task.id);
  }
}

export async function runScheduleTick(client) {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const guilds = [...client.guilds.cache.values()];
    await Promise.all(guilds.map(async (guild) => {
      try {
        await loadGuild(client, guild.id);
      } catch (error) {
        logger.error(`Could not load schedules for guild ${guild.id}:`, error);
      }
    }));
    const due = guilds.flatMap((guild) =>
      (taskCache.get(guild.id) || []).filter((task) =>
        task.enabled && !task.finished && task.schedule.nextRunAt <= Date.now(),
      ),
    );
    const memberSnapshots = new Map();
    for (const task of due) {
      await executeScheduledTask(client, task.guildId, task.id, { memberSnapshots });
    }
  } finally {
    tickRunning = false;
  }
}
