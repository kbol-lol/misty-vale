import { Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';

export default {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    if (user.bot) {
      return;
    }

    try {
      if (reaction.partial) {
        await reaction.fetch();
      }

      if (reaction.message.partial) {
        await reaction.message.fetch();
      }

      const message = reaction.message;
      if (!message.guild) {
        return;
      }

      // Read per-server config for every event so /reactionlimit changes take
      // effect immediately without requiring a bot restart.
      const guildConfig = await getGuildConfig(message.client, message.guild.id);
      const limiterConfig = guildConfig.reactionLimiter;
      if (!limiterConfig?.enabled) {
        return;
      }

      const emojiKey = getEmojiConfigKey(reaction.emoji);
      const limit = limiterConfig.limits?.[emojiKey];
      if (!Number.isSafeInteger(limit) || limit < 0) {
        return;
      }

      const lockKey = `reaction-limiter:${message.guild.id}:${message.id}:${emojiKey}`;
      await Mutex.runExclusive(lockKey, async () => {
        // Refresh inside the lock so concurrent add events see the latest users.
        await reaction.fetch();
        const users = await reaction.users.fetch();
        const humanReactionCount = users.filter((reactingUser) => !reactingUser.bot).size;

        if (humanReactionCount <= limit) {
          return;
        }

        await reaction.users.remove(user.id);
        logger.info(
          `Removed reaction above configured limit (${emojiKey}, limit ${limit}) ` +
          `from user ${user.id} on message ${message.id} in guild ${message.guild.id}`,
        );
      });
    } catch (error) {
      logger.warn('Unable to enforce reaction limit:', {
        error: error.message,
        messageId: reaction.message?.id,
        userId: user.id,
      });
    }
  },
};

function getEmojiConfigKey(emoji) {
  // Custom emoji IDs are stable even if the emoji is renamed. Unicode emoji
  // have no ID, so Discord's emoji name is the configured key.
  return emoji.id || emoji.name;
}
