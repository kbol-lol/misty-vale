import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildScheduleDashboard } from '../../../commands/Moderation/modules/schedule_dashboard.js';
import { logger } from '../../../utils/logger.js';
import { getDashboardLocale, tr } from '../../../utils/dashboardLocale.js';

export default {
  name: 'schedule',

  async execute(interaction, client, [action, pageArg]) {
    const L = getDashboardLocale(interaction);
    if (action !== 'select') {
      return interaction.reply({ content: tr(L, 'This schedule menu is not supported.', 'Dieses Zeitplan-Menü wird nicht unterstützt.'), flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: tr(L,
          'You need **Manage Server** permission to manage scheduled tasks.',
          'Du brauchst die Berechtigung **Server verwalten**, um geplante Aufgaben zu verwalten.'),
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      const view = await buildScheduleDashboard(client, interaction.guildId, {
        page: Number(pageArg) || 0,
        selectedId: interaction.values[0],
        locale: L,
      });
      return interaction.update({ embeds: [view.embed], components: view.components });
    } catch (error) {
      logger.error('Schedule dashboard selection failed:', error);
      return interaction.reply({
        content: tr(L, `Could not load this scheduled task: ${error.message}`, `Diese geplante Aufgabe konnte nicht geladen werden: ${error.message}`),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
