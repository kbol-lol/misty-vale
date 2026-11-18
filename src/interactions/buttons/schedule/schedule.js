import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  deleteScheduleTask,
  executeScheduledTask,
  listScheduledTasks,
  setScheduleTaskEnabled,
} from '../../../services/scheduleService.js';
import {
  buildScheduleDashboard,
  buildScheduleDeleteConfirmation,
  buildScheduleLiveConfirmation,
} from '../../../commands/Moderation/modules/schedule_dashboard.js';
import { logger } from '../../../utils/logger.js';
import { getDashboardLocale, tr } from '../../../utils/dashboardLocale.js';

const TASK_ID = /^[0-9a-f]{10}$/;
const ACTION_PERMISSIONS = {
  ban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  remove_role: PermissionFlagsBits.ManageRoles,
};

export default {
  name: 'schedule',

  async execute(interaction, client, [action, ...args]) {
    const L = getDashboardLocale(interaction);
    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: tr(L,
            'You need **Manage Server** permission to manage scheduled tasks.',
            'Du brauchst die Berechtigung **Server verwalten**, um geplante Aufgaben zu verwalten.'),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === 'page') {
        const view = await buildScheduleDashboard(client, interaction.guildId, { page: Number(args[0]) || 0, locale: L });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (action === 'refresh') {
        const page = Number(args[0]) || 0;
        const selectedId = args[1] === 'none' ? null : args[1];
        const view = await buildScheduleDashboard(client, interaction.guildId, { page, selectedId, locale: L });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      const taskId = args[0];
      if (!TASK_ID.test(taskId || '')) {
        return interaction.reply({ content: tr(L, 'This scheduled task ID is invalid.', 'Diese Aufgaben-ID ist ungültig.'), flags: MessageFlags.Ephemeral });
      }
      const tasks = await listScheduledTasks(client, interaction.guildId);
      const task = tasks.find((item) => item.id === taskId);
      if (!task) {
        return interaction.reply({ content: tr(L, 'This scheduled task no longer exists.', 'Diese geplante Aufgabe existiert nicht mehr.'), flags: MessageFlags.Ephemeral });
      }

      if (action === 'toggle') {
        const page = Number(args[1]) || 0;
        if (!task.enabled && task.type === 'punish' && !task.punish.dryRun) {
          const permissionError = await liveEnablePermissionError(interaction, task, L);
          if (permissionError) {
            return interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
          }
          const confirmation = buildScheduleLiveConfirmation(task, page, L);
          return interaction.update({ embeds: [confirmation.embed], components: confirmation.components });
        }
        await setScheduleTaskEnabled(client, interaction.guildId, task.id, !task.enabled);
        const view = await buildScheduleDashboard(client, interaction.guildId, {
          page,
          selectedId: task.id,
          locale: L,
        });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (action === 'confirm-enable') {
        if (task.type !== 'punish' || task.punish.dryRun || task.enabled) {
          return interaction.reply({
            content: tr(L,
              'This live-rule confirmation is no longer valid. Refresh the dashboard and try again.',
              'Diese Live-Bestätigung ist nicht mehr gültig. Aktualisiere das Dashboard und versuche es erneut.'),
            flags: MessageFlags.Ephemeral,
          });
        }
        const permissionError = await liveEnablePermissionError(interaction, task, L);
        if (permissionError) {
          return interaction.reply({ content: permissionError, flags: MessageFlags.Ephemeral });
        }
        await setScheduleTaskEnabled(client, interaction.guildId, task.id, true);
        const view = await buildScheduleDashboard(client, interaction.guildId, {
          page: Number(args[1]) || 0,
          selectedId: task.id,
          locale: L,
        });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (action === 'cancel-enable') {
        const view = await buildScheduleDashboard(client, interaction.guildId, {
          page: Number(args[1]) || 0,
          selectedId: task.id,
          locale: L,
        });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (action === 'preview') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await executeScheduledTask(client, interaction.guildId, task.id, {
          manual: true,
          forceDryRun: task.type === 'punish',
        });
        return interaction.editReply(result.text);
      }

      if (action === 'delete') {
        const page = Number(args[1]) || 0;
        const confirmation = buildScheduleDeleteConfirmation(task, page, L);
        return interaction.update({ embeds: [confirmation.embed], components: confirmation.components });
      }

      if (action === 'confirm-delete') {
        await deleteScheduleTask(client, interaction.guildId, task.id);
        const view = await buildScheduleDashboard(client, interaction.guildId, {
          page: Number(args[1]) || 0,
          locale: L,
        });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (action === 'cancel-delete') {
        const view = await buildScheduleDashboard(client, interaction.guildId, {
          page: Number(args[1]) || 0,
          selectedId: task.id,
          locale: L,
        });
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      return interaction.reply({ content: tr(L, 'This schedule action is not supported.', 'Diese Zeitplan-Aktion wird nicht unterstützt.'), flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.error(`Schedule dashboard button ${interaction.customId} failed:`, error);
      const content = tr(L, `Could not update the schedule dashboard: ${error.message}`, `Das Zeitplan-Dashboard konnte nicht aktualisiert werden: ${error.message}`);
      if (interaction.deferred || interaction.replied) {
        return interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  },
};

async function liveEnablePermissionError(interaction, task, L = 'en') {
  const actionPermission = ACTION_PERMISSIONS[task.punish.action];
  if (!actionPermission || !interaction.memberPermissions?.has(actionPermission)) {
    return tr(L,
      'You need the permission for this action to enable a live inactivity rule.',
      'Du brauchst die Berechtigung für diese Aktion, um eine Live-Inaktivitätsregel zu aktivieren.');
  }

  const guild = interaction.guild;
  const botMember = guild?.members.me || await guild?.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(actionPermission)) {
    return tr(L, 'The bot no longer has the permission required for this live rule.', 'Der Bot hat die nötige Berechtigung für diese Live-Regel nicht mehr.');
  }

  if (!task.punish.logChannelId) {
    return tr(L,
      'This live rule has no log channel. Edit it with `/schedule inactivity` before enabling it.',
      'Diese Live-Regel hat keinen Log-Kanal. Bearbeite sie mit `/schedule inactivity`, bevor du sie aktivierst.');
  }
  const channel = guild.channels.cache.get(task.punish.logChannelId)
    || await guild.channels.fetch(task.punish.logChannelId).catch(() => null);
  if (!channel || !channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return tr(L,
      'The bot cannot send logs to the configured channel. Fix that channel or edit the rule before enabling it.',
      'Der Bot kann keine Logs in den eingestellten Kanal senden. Korrigiere den Kanal oder bearbeite die Regel, bevor du sie aktivierst.');
  }

  if (task.punish.action === 'remove_role') {
    const role = guild.roles.cache.get(task.punish.punishRoleId);
    if (!role || role.managed || role.position >= botMember.roles.highest.position) {
      return tr(L, 'The role to remove is no longer manageable by the bot.', 'Die zu entfernende Rolle kann der Bot nicht mehr verwalten.');
    }
  }

  return null;
}
