import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildScheduleDashboard } from '../../../commands/Moderation/modules/schedule_dashboard.js';
import { logger } from '../../../utils/logger.js';

export default {
  name: 'schedule',

  async execute(interaction, client, [action, pageArg]) {
    if (action !== 'select') {
      return interaction.reply({ content: 'This schedule menu is not supported.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need **Manage Server** permission to manage scheduled tasks.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      const view = await buildScheduleDashboard(client, interaction.guildId, {
        page: Number(pageArg) || 0,
        selectedId: interaction.values[0],
      });
      return interaction.update({ embeds: [view.embed], components: view.components });
    } catch (error) {
      logger.error('Schedule dashboard selection failed:', error);
      return interaction.reply({
        content: `Could not load this scheduled task: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
