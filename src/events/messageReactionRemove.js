import { Events } from 'discord.js';
import { handleReactionRoleAssignment } from '../services/reactionRoleAssignment.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    if (user.bot) return;

    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const message = reaction.message;
      if (!message.guild) return;

      await handleReactionRoleAssignment(reaction, user, false);
    } catch (error) {
      logger.error('Failed to remove reaction role:', {
        error,
        guildId: reaction.message?.guild?.id,
        messageId: reaction.message?.id,
        userId: user.id,
      });
    }
  },
};
