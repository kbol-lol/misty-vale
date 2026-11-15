import { getReactionRoleMessage, hasDangerousPermissions } from './reactionRoleService.js';
import { getReactionRoleEmojiKey } from '../utils/reactionRoleMappings.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';

export async function handleReactionRoleAssignment(reaction, user, addRole) {
  const { message } = reaction;
  const guild = message.guild;
  if (!guild) return false;

  const emojiKey = getReactionRoleEmojiKey(reaction.emoji);
  const lockKey = `reaction-role:${guild.id}:${message.id}:${user.id}:${emojiKey}`;
  return Mutex.runExclusive(lockKey, () => applyReactionRoleAssignment(reaction, user, addRole, emojiKey));
}

async function applyReactionRoleAssignment(reaction, user, addRole, emojiKey) {
  const { message } = reaction;
  const guild = message.guild;
  const panelData = await getReactionRoleMessage(message.client, guild.id, message.id);
  if (panelData?.mode !== 'reaction') return false;

  const mapping = panelData.reactionRoles?.find((entry) => entry.emojiKey === emojiKey);
  if (!mapping) return false;

  const role = guild.roles.cache.get(mapping.roleId) || await guild.roles.fetch(mapping.roleId).catch(() => null);
  if (!role) {
    logger.warn(`Reaction role ${mapping.roleId} no longer exists in guild ${guild.id}`);
    return false;
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (
    !botMember
    || !botMember.permissions.has('ManageRoles')
    || role.managed
    || role.position >= botMember.roles.highest.position
  ) {
    logger.warn(`Cannot assign reaction role ${role.id} in guild ${guild.id} due to permissions or role hierarchy`);
    return false;
  }
  if (addRole && hasDangerousPermissions(role)) {
    logger.warn(`Cannot assign protected reaction role ${role.id} in guild ${guild.id}`);
    return false;
  }

  const member = guild.members.cache.get(user.id) || await guild.members.fetch(user.id).catch((error) => {
    logger.warn(`Could not fetch member ${user.id} for reaction role in guild ${guild.id}:`, error);
    return null;
  });
  if (!member) return false;

  if (addRole && !member.roles.cache.has(role.id)) {
    await member.roles.add(role, 'Reaction role added');
    logger.info(`Added reaction role ${role.id} to member ${user.id} in guild ${guild.id}`);
  } else if (!addRole && member.roles.cache.has(role.id)) {
    await member.roles.remove(role, 'Reaction role removed');
    logger.info(`Removed reaction role ${role.id} from member ${user.id} in guild ${guild.id}`);
  }

  return true;
}
