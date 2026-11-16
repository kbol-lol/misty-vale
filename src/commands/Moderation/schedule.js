import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { durationMilliseconds, formatDuration } from '../../utils/scheduleTime.js';
import {
  addScheduleTask,
  parseMentionTargets,
  updateScheduleTask,
} from '../../services/scheduleService.js';
import { buildScheduleDashboard } from './modules/schedule_dashboard.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const ACTION_PERMISSIONS = {
  ban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  remove_role: PermissionFlagsBits.ManageRoles,
};

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export default {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Configure recurring announcements and inactivity rules.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dashboard')
        .setDescription('Open the scheduled tasks dashboard.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('announcement')
        .setDescription('Schedule a recurring announcement.')
        .addStringOption((option) =>
          option.setName('name').setDescription('Task name').setMinLength(1).setMaxLength(60).setRequired(true),
        )
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Announcement destination')
            .addChannelTypes(...TEXT_CHANNEL_TYPES).setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('message').setDescription('Message to send (up to 1800 characters)')
            .setMinLength(1).setMaxLength(1800).setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('interval').setDescription('Repeat every this many units')
            .setMinValue(1).setMaxValue(9999).setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('unit').setDescription('Announcement interval unit').setRequired(true)
            .addChoices(
              { name: 'Minutes', value: 'minutes' },
              { name: 'Hours', value: 'hours' },
              { name: 'Days', value: 'days' },
            ),
        )
        .addStringOption((option) =>
          option.setName('mentions').setDescription('Optional role/user mentions, separated by spaces or commas')
            .setMaxLength(1000).setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('everyone').setDescription('Optional @everyone or @here ping')
            .addChoices(
              { name: 'No server-wide ping', value: 'none' },
              { name: '@here', value: 'here' },
              { name: '@everyone', value: 'everyone' },
            ).setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('delete_previous').setDescription('Delete the previous announcement from this task').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('task_id').setDescription('Optional: edit an existing announcement task from the dashboard')
            .setMinLength(10).setMaxLength(10).setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('inactivity')
        .setDescription('Create a rule for members inactive for a chosen period.')
        .addStringOption((option) =>
          option.setName('name').setDescription('Rule name').setMinLength(1).setMaxLength(60).setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('period').setDescription('Inactivity period').setMinValue(1).setMaxValue(8760).setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('unit').setDescription('Inactivity period unit').setRequired(true)
            .addChoices(
              { name: 'Hours', value: 'hours' },
              { name: 'Days', value: 'days' },
            ),
        )
        .addStringOption((option) =>
          option.setName('action').setDescription('Action after the inactivity period').setRequired(true)
            .addChoices(
              { name: 'Ban', value: 'ban' },
              { name: 'Kick', value: 'kick' },
              { name: 'Timeout', value: 'timeout' },
              { name: 'Remove a role', value: 'remove_role' },
            ),
        )
        .addRoleOption((option) =>
          option.setName('target_role').setDescription('Only check members with this role').setRequired(false),
        )
        .addChannelOption((option) =>
          option.setName('activity_channel').setDescription('Only count activity in this channel')
            .addChannelTypes(...TEXT_CHANNEL_TYPES).setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('track_reactions').setDescription('Count reactions as activity (messages are counted by default)')
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('track_messages').setDescription('Count messages as activity (default: true)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('exempt_roles').setDescription('Role mentions to exempt, separated by spaces or commas')
            .setMaxLength(1000).setRequired(false),
        )
        .addRoleOption((option) =>
          option.setName('punish_role').setDescription('Role to remove when action is "Remove a role"').setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('timeout_hours').setDescription('Timeout length (default: 24 hours)')
            .setMinValue(1).setMaxValue(336).setRequired(false),
        )
        .addChannelOption((option) =>
          option.setName('log_channel').setDescription('Optional channel for action and test logs')
            .addChannelTypes(...TEXT_CHANNEL_TYPES).setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('warning_hours').setDescription('Warn this many hours before the action (optional)')
            .setMinValue(1).setMaxValue(8759).setRequired(false),
        )
        .addChannelOption((option) =>
          option.setName('warning_channel').setDescription('Required when warning_hours is set')
            .addChannelTypes(...TEXT_CHANNEL_TYPES).setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('warning_message').setDescription('Optional warning text; supports {users}, {remaining}, {action}, {server}')
            .setMaxLength(800).setRequired(false),
        )
        .addIntegerOption((option) =>
          option.setName('max_per_run').setDescription('Maximum members affected in one run (default: 10)')
            .setMinValue(1).setMaxValue(50).setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('live').setDescription('Actually apply punishments; when omitted, the rule only simulates actions')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('task_id').setDescription('Optional: edit an existing inactivity task from the dashboard')
            .setMinLength(10).setMaxLength(10).setRequired(false),
        ),
    ),

  async execute(interaction, _config, client) {
    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need **Manage Server** permission to manage scheduled tasks.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'dashboard') {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        const view = await buildScheduleDashboard(client, interaction.guildId);
        return InteractionHelper.safeEditReply(interaction, { embeds: [view.embed], components: view.components });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (subcommand === 'announcement') {
        return await createAnnouncement(interaction, client);
      }
      if (subcommand === 'inactivity') {
        return await createInactivityRule(interaction, client);
      }
      return interaction.editReply('Unknown schedule action.');
    } catch (error) {
      logger.error('Schedule command failed:', error);
      const content = `Could not complete the schedule action: ${error.message}`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
      }
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  },
};

async function getBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

function assertUserPermission(interaction, permission, label) {
  if (!interaction.memberPermissions?.has(permission)) {
    throw new Error(`You need the **${label}** permission to configure this task.`);
  }
}

function assertBotChannelAccess(channel, botMember, mentionEveryone = false) {
  const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (mentionEveryone) permissions.push(PermissionFlagsBits.MentionEveryone);
  if (!channel.permissionsFor(botMember)?.has(permissions)) {
    throw new Error(`The bot is missing a required permission in #${channel.name}.`);
  }
}

function assertManageableRole(role, guild, botMember) {
  if (!role || role.id === guild.id || role.managed) {
    throw new Error('Choose a normal, non-managed server role.');
  }
  if (role.position >= botMember.roles.highest.position) {
    throw new Error(`The role ${role.name} must be below the bot's highest role.`);
  }
}

function parseExemptRoles(guild, raw = '') {
  const roles = new Set();
  for (const token of String(raw).split(/[\s,;]+/).filter(Boolean)) {
    const match = /^<@&(\d{17,20})>$/.exec(token);
    if (!match || !guild.roles.cache.has(match[1]) || match[1] === guild.id) {
      throw new Error(`Invalid exempt role ${token}. Use a role mention from this server.`);
    }
    roles.add(match[1]);
  }
  if (roles.size > 20) throw new Error('At most 20 exempt roles can be configured.');
  return [...roles];
}

async function createAnnouncement(interaction, client) {
  const guild = interaction.guild;
  const name = interaction.options.getString('name', true).trim();
  if (!name) throw new Error('Task name cannot be empty.');
  const channel = interaction.options.getChannel('channel', true);
  const intervalMs = durationMilliseconds(
    interaction.options.getInteger('interval', true),
    interaction.options.getString('unit', true),
  );
  if (intervalMs < 15 * 60_000) throw new Error('Announcement intervals must be at least 15 minutes.');

  const botMember = await getBotMember(guild);
  const everyone = interaction.options.getString('everyone') || 'none';
  if (everyone !== 'none') assertUserPermission(interaction, PermissionFlagsBits.MentionEveryone, 'Mention Everyone');
  assertBotChannelAccess(channel, botMember, everyone !== 'none');

  const mentions = parseMentionTargets(guild, interaction.options.getString('mentions') || '');
  if (
    mentions.roleIds.some((id) => !guild.roles.cache.get(id)?.mentionable)
    && !botMember.permissions.has(PermissionFlagsBits.MentionEveryone)
  ) {
    throw new Error('The bot needs **Mention Everyone** permission to ping a non-mentionable role.');
  }
  const message = interaction.options.getString('message', true).trim();
  if (!message) throw new Error('The announcement message cannot be empty.');
  const pingText = [
    everyone === 'everyone' ? '@everyone' : everyone === 'here' ? '@here' : '',
    ...mentions.roleIds.map((id) => `<@&${id}>`),
    ...mentions.userIds.map((id) => `<@${id}>`),
  ].filter(Boolean).join(' ');
  if (pingText.length + message.length + 1 > 2000) throw new Error('The message and configured mentions exceed Discord’s 2000-character limit.');

  const taskValues = {
    type: 'message',
    name,
    intervalMs,
    message: {
      channelId: channel.id,
      content: message,
      ...mentions,
      everyone,
      deletePrevious: interaction.options.getBoolean('delete_previous') || false,
    },
  };
  const taskId = interaction.options.getString('task_id');
  const task = taskId
    ? await updateScheduleTask(client, guild.id, taskId, taskValues)
    : await addScheduleTask(client, guild.id, taskValues);
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(taskId ? 'Announcement updated' : 'Announcement scheduled')
        .setColor(0x57f287)
        .setDescription(`**${task.name}** will post in ${channel} every ${formatDuration(task.schedule.intervalMs)} (first run <t:${Math.floor(task.schedule.nextRunAt / 1000)}:R>).`)
        .addFields({ name: 'Task ID', value: `\`${task.id}\`` })
        .setFooter({ text: 'Manage, pause, test, or delete it with /schedule dashboard.' }),
    ],
  });
}

async function createInactivityRule(interaction, client) {
  const guild = interaction.guild;
  const name = interaction.options.getString('name', true).trim();
  if (!name) throw new Error('Rule name cannot be empty.');
  const action = interaction.options.getString('action', true);
  const permission = ACTION_PERMISSIONS[action];
  if (!permission) throw new Error('Choose a supported punishment action.');
  assertUserPermission(interaction, permission, action === 'remove_role' ? 'Manage Roles' : action);

  const botMember = await getBotMember(guild);
  if (!botMember.permissions.has(permission)) {
    throw new Error(`The bot needs the **${action}** permission to execute this rule.`);
  }

  const targetRole = interaction.options.getRole('target_role');
  const punishRole = interaction.options.getRole('punish_role');
  if (targetRole) assertManageableRole(targetRole, guild, botMember);
  if (action === 'remove_role') {
    assertManageableRole(punishRole, guild, botMember);
  }

  const periodMs = durationMilliseconds(
    interaction.options.getInteger('period', true),
    interaction.options.getString('unit', true),
  );
  if (interaction.options.getString('unit', true) === 'days' && periodMs > 365 * 86_400_000) {
    throw new Error('The inactivity period cannot exceed 365 days.');
  }
  const trackReactions = interaction.options.getBoolean('track_reactions') || false;
  const trackMessages = interaction.options.getBoolean('track_messages') ?? true;
  if (!trackMessages && !trackReactions) throw new Error('Enable message tracking, reaction tracking, or both.');

  const timeoutHours = interaction.options.getInteger('timeout_hours') || 24;
  if (action === 'timeout' && !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new Error('The bot needs **Moderate Members** permission to apply timeouts.');
  }

  const warningHours = interaction.options.getInteger('warning_hours');
  const warningChannel = interaction.options.getChannel('warning_channel');
  if (warningHours && !warningChannel) throw new Error('Choose a warning channel when warning_hours is set.');
  if (warningHours && warningHours * 3_600_000 >= periodMs) {
    throw new Error('The warning must be scheduled before the inactivity period ends.');
  }

  const logChannel = interaction.options.getChannel('log_channel');
  for (const channel of [warningChannel, logChannel]) {
    if (channel) assertBotChannelAccess(channel, botMember);
  }
  const activityChannel = interaction.options.getChannel('activity_channel');
  if (activityChannel && !activityChannel.permissionsFor(botMember)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error(`The bot must be able to view ${activityChannel}.`);
  }

  const live = interaction.options.getBoolean('live') || false;
  if (live && client.db?.isDegraded?.()) {
    throw new Error('Live inactivity rules require PostgreSQL so task and activity data survive restarts.');
  }
  if (live && !logChannel) throw new Error('Choose a log_channel before enabling live punishments.');
  if (live) assertUserPermission(interaction, permission, action === 'remove_role' ? 'Manage Roles' : action);

  const punish = {
    targetRoleId: targetRole?.id || '',
    exemptRoleIds: parseExemptRoles(guild, interaction.options.getString('exempt_roles') || ''),
    activity: { message: trackMessages, reaction: trackReactions },
    activityChannelId: activityChannel?.id || '',
    deadlineMs: periodMs,
    action,
    timeoutMs: timeoutHours * 3_600_000,
    punishRoleId: punishRole?.id || '',
    warnBeforeMs: warningHours ? warningHours * 3_600_000 : 0,
    warnChannelId: warningChannel?.id || '',
    warningText: interaction.options.getString('warning_message')
      || '{users} You have been inactive. If you do not participate within {remaining}, the configured action will be applied: {action}.',
    logChannelId: logChannel?.id || '',
    dryRun: !live,
    maxPerRun: interaction.options.getInteger('max_per_run') || 10,
  };
  if (action === 'remove_role' && punishRole.id === targetRole?.id) {
    throw new Error('Choose a punishment role different from the monitored target role.');
  }

  const taskValues = {
    type: 'punish',
    name,
    punish,
  };
  const taskId = interaction.options.getString('task_id');
  const task = taskId
    ? await updateScheduleTask(client, guild.id, taskId, taskValues)
    : await addScheduleTask(client, guild.id, taskValues);
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(taskId ? 'Inactivity rule updated' : 'Inactivity rule created')
        .setColor(live ? 0xed4245 : 0xfee75c)
        .setDescription(`**${task.name}** will check for ${formatPeriod(periodMs)} of inactivity. The first check is <t:${Math.floor(task.schedule.nextRunAt / 1000)}:R>.`)
        .addFields(
          { name: 'Action', value: `${ACTION_LABELS[action]}${live ? ' — LIVE' : ' — simulation only'}`, inline: true },
          { name: 'Task ID', value: `\`${task.id}\``, inline: true },
        )
        .setFooter({ text: live ? 'Live punishments are enabled. Use /schedule dashboard to pause or preview.' : 'Simulation mode is enabled. Use live:true to enable actual actions.' }),
    ],
  });
}

function formatPeriod(milliseconds) {
  const days = milliseconds / 86_400_000;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = milliseconds / 3_600_000;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

const ACTION_LABELS = {
  ban: 'Ban',
  kick: 'Kick',
  timeout: 'Timeout',
  remove_role: 'Remove role',
};
