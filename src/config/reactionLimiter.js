/**
 * Per-message reaction limits.
 *
 * Each entry limits one emoji on each message in enabled channels.
 * Set `enabled` to false or remove an emoji entry to stop limiting it.
 * `channelOverrides` can enable or disable the limiter for individual channels.
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
  channelOverrides: {},
};

export function isReactionLimiterEnabledForChannel(config, channelId) {
  if (!config || !channelId) return false;
  const override = config.channelOverrides?.[channelId];
  return typeof override === 'boolean' ? override : config.enabled !== false;
}

export function withoutCustomEmojiLimit(config, emojiId) {
  if (!config?.limits || !Object.hasOwn(config.limits, emojiId)) return null;

  const updated = { ...config, limits: { ...config.limits } };
  delete updated.limits[emojiId];
  return updated;
}

export default reactionLimiterConfig;
