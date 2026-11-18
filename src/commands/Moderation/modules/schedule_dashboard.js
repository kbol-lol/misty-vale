import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { listScheduledTasks } from '../../../services/scheduleService.js';
import { formatDuration } from '../../../utils/scheduleTime.js';
import { tr } from '../../../utils/dashboardLocale.js';

const PAGE_SIZE = 25;

function taskSummary(task, L = 'en') {
  if (task.type === 'message') {
    return tr(L,
      `Every ${formatDuration(task.schedule.intervalMs)} · <#${task.message.channelId}>`,
      `Alle ${formatDuration(task.schedule.intervalMs)} · <#${task.message.channelId}>`);
  }

  const action = task.punish.dryRun
    ? tr(L, `simulation: ${task.punish.action}`, `Simulation: ${task.punish.action}`)
    : `LIVE: ${task.punish.action}`;
  return tr(L,
    `${action} after ${formatDuration(task.punish.deadlineMs)} of inactivity`,
    `${action} nach ${formatDuration(task.punish.deadlineMs)} Inaktivität`);
}

function selectedTaskDetails(task, L = 'en') {
  const lines = [
    `**ID:** \`${task.id}\``,
    `**${tr(L, 'Type', 'Typ')}:** ${task.type === 'message' ? tr(L, 'Scheduled announcement', 'Geplante Ankündigung') : tr(L, 'Inactivity rule', 'Inaktivitätsregel')}`,
    `**Status:** ${task.enabled ? tr(L, 'Enabled', 'Aktiv') : tr(L, 'Paused', 'Pausiert')}${task.punish?.dryRun ? tr(L, ' · Test mode', ' · Testmodus') : task.type === 'punish' ? ' · LIVE' : ''}`,
    `**${tr(L, 'Next run', 'Nächste Ausführung')}:** ${task.schedule.nextRunAt ? `<t:${Math.floor(task.schedule.nextRunAt / 1000)}:R>` : tr(L, 'not scheduled', 'nicht geplant')}`,
    `**${tr(L, 'Runs', 'Ausführungen')}:** ${task.state.runCount || 0}`,
  ];

  if (task.type === 'message') {
    lines.push(`**${tr(L, 'Destination', 'Ziel')}:** <#${task.message.channelId}>`);
    lines.push(`**${tr(L, 'Message', 'Nachricht')}:** ${task.message.content.slice(0, 500)}`);
  } else {
    const activity = Object.entries(task.punish.activity)
      .filter(([, enabled]) => enabled)
      .map(([kind]) => kind)
      .join(tr(L, ' and ', ' und '));
    lines.push(`**${tr(L, 'Action', 'Aktion')}:** ${task.punish.action}${task.punish.dryRun ? tr(L, ' (simulation only)', ' (nur Simulation)') : ''}`);
    lines.push(`**${tr(L, 'Monitor', 'Überwacht')}:** ${activity || tr(L, 'none', 'nichts')}${task.punish.activityChannelId ? tr(L, ` in <#${task.punish.activityChannelId}>`, ` in <#${task.punish.activityChannelId}>`) : tr(L, ' in any channel', ' in allen Kanälen')}`);
    lines.push(`**${tr(L, 'Target role', 'Zielrolle')}:** ${task.punish.targetRoleId ? `<@&${task.punish.targetRoleId}>` : tr(L, 'all eligible members', 'alle betroffenen Mitglieder')}`);
    lines.push(`**${tr(L, 'Limit per run', 'Limit pro Durchlauf')}:** ${task.punish.maxPerRun}`);
  }

  if (task.state.lastRunAt) {
    lines.push(`**${tr(L, 'Last result', 'Letztes Ergebnis')}:** ${task.state.lastResult?.text || tr(L, 'No details', 'Keine Details')} (<t:${Math.floor(task.state.lastRunAt / 1000)}:R>)`);
  }
  return lines.join('\n').slice(0, 3900);
}

export async function buildScheduleDashboard(client, guildId, { page = 0, selectedId = null, locale: L = 'en' } = {}) {
  const tasks = await listScheduledTasks(client, guildId);
  const pageCount = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageTasks = tasks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = pageTasks.find((task) => task.id === selectedId) || null;

  const embed = new EmbedBuilder()
    .setTitle(tr(L, '🗓️ Schedule Dashboard', '🗓️ Zeitplan-Dashboard'))
    .setColor(tasks.length ? 0x5865f2 : 0x99aab5)
    .setDescription([
      tr(L, `Manage recurring announcements and inactivity rules for this server.`, `Verwalte wiederkehrende Ankündigungen und Inaktivitätsregeln für diesen Server.`),
      '',
      tr(L, `**Tasks:** ${tasks.length}/50 · **Page:** ${currentPage + 1}/${pageCount}`, `**Aufgaben:** ${tasks.length}/50 · **Seite:** ${currentPage + 1}/${pageCount}`),
      tasks.length
        ? pageTasks.map((task) => `${task.enabled ? '🟢' : '⏸️'} **${task.name}** — ${taskSummary(task, L)}`).join('\n').slice(0, 2500)
        : tr(L, '*No scheduled tasks yet.*', '*Noch keine geplanten Aufgaben.*'),
      '',
      tr(L,
        'Create or edit with `/schedule announcement` or `/schedule inactivity`; use the selected task ID in `task_id` to edit. Inactivity rules default to simulation mode. A bot restart restarts the inactivity observation window.',
        'Erstellen oder bearbeiten mit `/schedule announcement` oder `/schedule inactivity`; zum Bearbeiten die ID der gewählten Aufgabe bei `task_id` angeben. Inaktivitätsregeln starten im Simulationsmodus. Ein Bot-Neustart startet das Inaktivitäts-Beobachtungsfenster neu.'),
    ].join('\n'))
    .setTimestamp();

  if (selected) {
    embed.addFields({ name: tr(L, `Selected: ${selected.name}`, `Ausgewählt: ${selected.name}`), value: selectedTaskDetails(selected, L) });
  }

  const components = [];
  if (pageTasks.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`schedule:select:${currentPage}`)
          .setPlaceholder(tr(L, 'Select a task to manage', 'Aufgabe zum Verwalten wählen'))
          .addOptions(...pageTasks.map((task) => ({
            label: task.name.slice(0, 100),
            description: taskSummary(task, L).slice(0, 100),
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
        .setLabel(tr(L, 'Previous', 'Zurück'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`schedule:page:${Math.min(pageCount - 1, currentPage + 1)}`)
        .setLabel(tr(L, 'Next', 'Weiter'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1),
      new ButtonBuilder()
        .setCustomId(`schedule:refresh:${currentPage}:${selected?.id || 'none'}`)
        .setLabel(tr(L, 'Refresh', 'Aktualisieren'))
        .setStyle(ButtonStyle.Primary),
    ),
  );

  if (selected) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`schedule:toggle:${selected.id}:${currentPage}`)
          .setLabel(selected.enabled
            ? tr(L, 'Pause', 'Pausieren')
            : selected.type === 'punish' && !selected.punish.dryRun ? tr(L, 'Enable LIVE', 'LIVE aktivieren') : tr(L, 'Enable', 'Aktivieren'))
          .setStyle(selected.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`schedule:preview:${selected.id}`)
          .setLabel(selected.type === 'message' ? tr(L, 'Run now', 'Jetzt ausführen') : tr(L, 'Preview', 'Vorschau'))
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`schedule:delete:${selected.id}:${currentPage}`)
          .setLabel(tr(L, 'Delete', 'Löschen'))
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  return { embed, components, page: currentPage, selectedId: selected?.id || null };
}

export function buildScheduleDeleteConfirmation(task, page, L = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(tr(L, 'Delete scheduled task?', 'Geplante Aufgabe löschen?'))
    .setDescription(tr(L,
      `Delete **${task.name}**? This removes the task and its activity history. This cannot be undone.`,
      `**${task.name}** löschen? Das entfernt die Aufgabe und ihren Aktivitätsverlauf. Das kann nicht rückgängig gemacht werden.`))
    .setColor(0xed4245);
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`schedule:confirm-delete:${task.id}:${page}`)
        .setLabel(tr(L, 'Confirm delete', 'Löschen bestätigen'))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`schedule:cancel-delete:${task.id}:${page}`)
        .setLabel(tr(L, 'Cancel', 'Abbrechen'))
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embed, components };
}

export function buildScheduleLiveConfirmation(task, page, L = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(tr(L, 'Enable live inactivity rule?', 'Live-Inaktivitätsregel aktivieren?'))
    .setDescription(tr(L,
      `**${task.name}** will perform **${task.punish.action}** actions for qualifying members. The bot checks every few minutes and uses the configured per-run safety limit. Confirm only if the target role, activity tracking, action, and log channel are correct.`,
      `**${task.name}** führt **${task.punish.action}** für betroffene Mitglieder aus. Der Bot prüft alle paar Minuten und nutzt das eingestellte Sicherheitslimit pro Durchlauf. Bestätige nur, wenn Zielrolle, Aktivitätsüberwachung, Aktion und Log-Kanal stimmen.`))
    .setColor(0xed4245);
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`schedule:confirm-enable:${task.id}:${page}`)
        .setLabel(tr(L, 'Confirm live enable', 'Live-Aktivierung bestätigen'))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`schedule:cancel-enable:${task.id}:${page}`)
        .setLabel(tr(L, 'Cancel', 'Abbrechen'))
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { embed, components };
}
