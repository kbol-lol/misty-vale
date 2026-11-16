import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { listScheduledTasks } from '../../../services/scheduleService.js';
import { formatDuration } from '../../../utils/scheduleTime.js';

const PAGE_SIZE = 25;

function taskSummary(task) {
  if (task.type === 'message') {
    return `Every ${formatDuration(task.schedule.intervalMs)} · <#${task.message.channelId}>`;
  }

  const action = task.punish.dryRun ? `simulation: ${task.punish.action}` : `LIVE: ${task.punish.action}`;
  return `${action} after ${formatDuration(task.punish.deadlineMs)} of inactivity`;
}

function selectedTaskDetails(task) {
  const lines = [
    `**ID:** \`${task.id}\``,
    `**Type:** ${task.type === 'message' ? 'Scheduled announcement' : 'Inactivity rule'}`,
    `**Status:** ${task.enabled ? 'Enabled' : 'Paused'}${task.punish?.dryRun ? ' · Test mode' : task.type === 'punish' ? ' · LIVE' : ''}`,
    `**Next run:** ${task.schedule.nextRunAt ? `<t:${Math.floor(task.schedule.nextRunAt / 1000)}:R>` : 'not scheduled'}`,
    `**Runs:** ${task.state.runCount || 0}`,
  ];

  if (task.type === 'message') {
    lines.push(`**Destination:** <#${task.message.channelId}>`);
    lines.push(`**Message:** ${task.message.content.slice(0, 500)}`);
  } else {
    const activity = Object.entries(task.punish.activity)
      .filter(([, enabled]) => enabled)
      .map(([kind]) => kind)
      .join(' and ');
    lines.push(`**Action:** ${task.punish.action}${task.punish.dryRun ? ' (simulation only)' : ''}`);
    lines.push(`**Monitor:** ${activity || 'none'}${task.punish.activityChannelId ? ` in <#${task.punish.activityChannelId}>` : ' in any channel'}`);
    lines.push(`**Target role:** ${task.punish.targetRoleId ? `<@&${task.punish.targetRoleId}>` : 'all eligible members'}`);
    lines.push(`**Limit per run:** ${task.punish.maxPerRun}`);
  }

  if (task.state.lastRunAt) {
    lines.push(`**Last result:** ${task.state.lastResult?.text || 'No details'} (<t:${Math.floor(task.state.lastRunAt / 1000)}:R>)`);
  }
  return lines.join('\n').slice(0, 3900);
}

export async function buildScheduleDashboard(client, guildId, { page = 0, selectedId = null } = {}) {
  const tasks = await listScheduledTasks(client, guildId);
  const pageCount = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageTasks = tasks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = pageTasks.find((task) => task.id === selectedId) || null;

  const embed = new EmbedBuilder()
    .setTitle('🗓️ Schedule Dashboard')
    .setColor(tasks.length ? 0x5865f2 : 0x99aab5)
    .setDescription([
      `Manage recurring announcements and inactivity rules for this server.`,
      '',
      `**Tasks:** ${tasks.length}/50 · **Page:** ${currentPage + 1}/${pageCount}`,
      tasks.length
        ? pageTasks.map((task) => `${task.enabled ? '🟢' : '⏸️'} **${task.name}** — ${taskSummary(task)}`).join('\n').slice(0, 2500)
        : '*No scheduled tasks yet.*',
      '',
      'Create or edit with `/schedule announcement` or `/schedule inactivity`; use the selected task ID in `task_id` to edit. Inactivity rules default to simulation mode. A bot restart restarts the inactivity observation window.',
    ].join('\n'))
    .setTimestamp();

  if (selected) {
    embed.addFields({ name: `Selected: ${selected.name}`, value: selectedTaskDetails(selected) });
  }

  const components = [];
  if (pageTasks.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`schedule:select:${currentPage}`)
          .setPlaceholder('Select a task to manage')
          .addOptions(...pageTasks.map((task) => ({
            label: task.name.slice(0, 100),
            description: taskSummary(task).slice(0, 100),
            value: task.id,
            default: task.id === selected?.id,
          }))),
      ),
    );
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`schedule:page:${Math.max(0, currentPage - 1)}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`schedule:page:${Math.min(pageCount - 1, currentPage + 1)}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1),
      new ButtonBuilder()
        .setCustomId(`schedule:refresh:${currentPage}:${selected?.id || 'none'}`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Primary),
    ),
  );

  if (selected) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`schedule:toggle:${selected.id}:${currentPage}`)
          .setLabel(selected.enabled ? 'Pause' : selected.type === 'punish' && !selected.punish.dryRun ? 'Enable LIVE' : 'Enable')
          .setStyle(selected.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`schedule:preview:${selected.id}`)
          .setLabel(selected.type === 'message' ? 'Run now' : 'Preview')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`schedule:delete:${selected.id}:${currentPage}`)
          .setLabel('Delete')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  return { embed, components, page: currentPage, selectedId: selected?.id || null };
}

export function buildScheduleDeleteConfirmation(task, page) {
  const embed = new EmbedBuilder()
    .setTitle('Delete scheduled task?')
    .setDescription(`Delete **${task.name}**? This removes the task and its activity history. This cannot be undone.`)
    .setColor(0xed4245);
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`schedule:confirm-delete:${task.id}:${page}`)
        .setLabel('Confirm delete')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`schedule:cancel-delete:${task.id}:${page}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embed, components };
}

export function buildScheduleLiveConfirmation(task, page) {
  const embed = new EmbedBuilder()
    .setTitle('Enable live inactivity rule?')
    .setDescription(`**${task.name}** will perform **${task.punish.action}** actions for qualifying members. The bot checks every few minutes and uses the configured per-run safety limit. Confirm only if the target role, activity tracking, action, and log channel are correct.`)
    .setColor(0xed4245);
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`schedule:confirm-enable:${task.id}:${page}`)
        .setLabel('Confirm live enable')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`schedule:cancel-enable:${task.id}:${page}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embed, components };
}
