import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { syncMemberRoles } from '../services/levelingService.js';

// Gives returning members their level reward roles back when they rejoin.
export default {
  name: Events.GuildMemberAdd,
  async execute(member, client) {
    try {
      if (member.user?.bot) return;
      await syncMemberRoles(client, member.guild, member);
    } catch (error) {
      logger.error('Error in levelingMemberAdd event:', error);
    }
  },
};
