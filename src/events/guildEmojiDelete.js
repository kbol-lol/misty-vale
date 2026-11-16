import { Events } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { withoutCustomEmojiLimit } from '../config/reactionLimiter.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildEmojiDelete,
  async execute(emoji, client) {
    const guildId = emoji.guild?.id;
    if (!guildId || !emoji.id) return;

    const guildConfig = await getGuildConfig(client, guildId);
    const reactionLimiter = withoutCustomEmojiLimit(guildConfig.reactionLimiter, emoji.id);
    if (!reactionLimiter) return;

    await updateGuildConfig(client, guildId, { reactionLimiter });
    logger.info(`Removed reaction limit for deleted emoji ${emoji.id} in guild ${guildId}`);
  },
};
