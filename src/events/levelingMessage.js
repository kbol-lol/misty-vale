import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleLevelingMessage } from '../services/levelingService.js';

// Separate listener so the existing messageCreate event stays untouched.
export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild || message.author?.bot) return;
      await handleLevelingMessage(message, client);
    } catch (error) {
      logger.error('Error in levelingMessage event:', error);
    }
  },
};
