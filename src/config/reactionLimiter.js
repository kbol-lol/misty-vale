/**
 * Global per-message reaction limits.
 *
 * Each entry limits one emoji on every message in every server the bot is in.
 * Set `enabled` to false or remove an emoji entry to stop limiting it.
 *
 * Unicode emoji use the emoji itself as the key. For a custom emoji, use its
 * numeric Discord emoji ID as the key (for example: '123456789012345678').
 */
export const reactionLimiterConfig = {
  enabled: true,
  limits: {
    '✅': 25,
    '❌': 10,
  },
};

export default reactionLimiterConfig;
