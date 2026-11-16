export const MAX_REACTION_ROLES_PER_MESSAGE = 20;

export function getReactionRoleEmojiKey(emoji) {
  return emoji?.id || emoji?.name || null;
}

export function parseReactionRoleEmoji(guild, input) {
  const value = String(input ?? '').trim();
  const customMatch = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/.exec(value);
  const customId = customMatch?.[3] || (/^\d{17,20}$/.test(value) ? value : null);
  const shorthandName = /^:([A-Za-z0-9_]+):$/.exec(value)?.[1];

  if (customId) {
    const emoji = guild.emojis.cache.get(customId);
    if (emoji?.available) {
      return {
        key: emoji.id,
        display: emoji.toString(),
        reactValue: emoji.id,
      };
    }

    if (!customMatch) return null;

    return {
      key: customId,
      display: value,
      reactValue: value,
      isExternal: true,
    };
  }

  if (shorthandName) {
    const emoji = guild.emojis.cache.find((candidate) => candidate.name === shorthandName);
    if (!emoji?.available) return null;

    return {
      key: emoji.id,
      display: emoji.toString(),
      reactValue: emoji.id,
    };
  }

  const isUnicodeEmoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value);
  const graphemeCount = value
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)).length
    : 0;
  if (!isUnicodeEmoji || graphemeCount !== 1) return null;

  return { key: value, display: value, reactValue: value };
}

export class ReactionRoleMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReactionRoleMappingError';
    this.code = code;
  }
}

export function addReactionRoleMappingToPanel(panelData, mapping) {
  const mappings = Array.isArray(panelData.reactionRoles) ? panelData.reactionRoles : [];

  if (mappings.length >= MAX_REACTION_ROLES_PER_MESSAGE) {
    throw new ReactionRoleMappingError(
      'LIMIT_REACHED',
      `A message can have at most ${MAX_REACTION_ROLES_PER_MESSAGE} reaction roles.`,
    );
  }
  if (mappings.some((entry) => entry.emojiKey === mapping.emojiKey)) {
    throw new ReactionRoleMappingError('DUPLICATE_EMOJI', 'That emoji is already assigned on this panel.');
  }
  if (mappings.some((entry) => entry.roleId === mapping.roleId)) {
    throw new ReactionRoleMappingError('DUPLICATE_ROLE', 'That role is already assigned on this panel.');
  }

  panelData.reactionRoles = [...mappings, mapping];
  panelData.roles = Array.isArray(panelData.roles) ? panelData.roles : [];
  panelData.roles.push(mapping.roleId);
  return panelData;
}

export function removeReactionRoleMappingFromPanel(panelData, roleId) {
  const mappings = Array.isArray(panelData.reactionRoles) ? panelData.reactionRoles : [];
  const mapping = mappings.find((entry) => entry.roleId === roleId);
  if (!mapping) return null;

  panelData.reactionRoles = mappings.filter((entry) => entry.roleId !== roleId);
  panelData.roles = (Array.isArray(panelData.roles) ? panelData.roles : []).filter((id) => id !== roleId);
  return mapping;
}
