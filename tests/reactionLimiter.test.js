import assert from 'node:assert/strict';
import test from 'node:test';
import { isReactionLimiterEnabledForChannel } from '../src/config/reactionLimiter.js';
import { getGuildConfigKey } from '../src/utils/database/keys.js';
import reactionEmojiDeleteEvent from '../src/events/guildEmojiDelete.js';
import messageReactionAddEvent from '../src/events/messageReactionAdd.js';
import reactionLimiterCommand, {
  buildReactionLimiterDashboardPayload,
  pruneDeletedServerEmojiLimits,
} from '../src/commands/Utility/reactionlimit.js';

test('reaction limiter channel overrides inherit the global default and can override it', () => {
  assert.equal(isReactionLimiterEnabledForChannel({ enabled: true }, 'channel-a'), true);
  assert.equal(isReactionLimiterEnabledForChannel({ enabled: false }, 'channel-a'), false);
  assert.equal(
    isReactionLimiterEnabledForChannel({ enabled: true, channelOverrides: { 'channel-a': false } }, 'channel-a'),
    false,
  );
  assert.equal(
    isReactionLimiterEnabledForChannel({ enabled: false, channelOverrides: { 'channel-a': true } }, 'channel-a'),
    true,
  );
});

test('reaction limiter dashboard exposes channel selection, emoji management, and paging controls', () => {
  const channelId = '22345678901234567';
  const guild = {
    id: '12345678901234567',
    channels: { cache: new Map([[channelId, { id: channelId, name: 'roles' }]]) },
    emojis: { cache: new Map() },
  };
  const limits = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [String.fromCodePoint(0x1f600 + index), index + 1]),
  );
  const payload = buildReactionLimiterDashboardPayload(
    guild,
    { enabled: true, limits, channelOverrides: { [channelId]: false } },
    { channelId, selectedEmojiKey: '😀' },
  );
  const rows = payload.components.map((row) => row.toJSON());

  assert.equal(rows[0].components[0].type, 8);
  assert.equal(rows[1].components[0].options.length, 15);
  assert.equal(rows[2].components.length, 3);
  assert.equal(rows[3].components[2].disabled, false);
  assert.match(payload.embeds[0].toJSON().fields[1].value, /Disabled/);
  assert.ok(reactionLimiterCommand.data.toJSON().options.some((option) => option.name === 'dashboard'));
});

test('deleting a server emoji removes only its reaction limit', async () => {
  const guildId = '12345678901234567';
  const emojiId = '32345678901234567';
  const key = getGuildConfigKey(guildId);
  const stored = {
    [key]: {
      reactionLimiter: {
        enabled: true,
        limits: { [emojiId]: 4, '✅': 2 },
        channelOverrides: { '22345678901234567': false },
      },
    },
  };
  const client = {
    db: {
      get: async storageKey => stored[storageKey] ?? null,
      set: async (storageKey, value) => {
        stored[storageKey] = value;
        return true;
      },
    },
  };

  await reactionEmojiDeleteEvent.execute({ id: emojiId, guild: { id: guildId } }, client);

  assert.deepEqual(stored[key].reactionLimiter.limits, { '✅': 2 });
  assert.deepEqual(stored[key].reactionLimiter.channelOverrides, { '22345678901234567': false });
});

test('dashboard cleanup removes limits for deleted server emojis but preserves active ones', async () => {
  const guildId = '12345678901234567';
  const activeEmojiId = '32345678901234567';
  const deletedEmojiId = '42345678901234567';
  const key = getGuildConfigKey(guildId);
  const stored = {
    [key]: {
      reactionLimiter: {
        enabled: true,
        limits: { [activeEmojiId]: 4, [deletedEmojiId]: 3, '✅': 2 },
        channelOverrides: {},
      },
    },
  };
  const client = {
    db: {
      get: async storageKey => stored[storageKey] ?? null,
      set: async (storageKey, value) => {
        stored[storageKey] = value;
        return true;
      },
    },
  };

  const cleaned = await pruneDeletedServerEmojiLimits(
    client,
    { id: guildId, emojis: { cache: new Map([[activeEmojiId, {}]]) } },
    stored[key].reactionLimiter,
  );

  assert.deepEqual(cleaned.limits, { [activeEmojiId]: 4, '✅': 2 });
  assert.deepEqual(stored[key].reactionLimiter.limits, cleaned.limits);
});

test('message reaction enforcement skips channels disabled in the limiter dashboard', async () => {
  const guildId = '12345678901234567';
  const channelId = '22345678901234567';
  const configKey = getGuildConfigKey(guildId);
  let reactionUserFetches = 0;
  const client = {
    db: {
      get: async key => key === configKey
        ? {
            reactionLimiter: {
              enabled: true,
              limits: { '✅': 1 },
              channelOverrides: { [channelId]: false },
            },
          }
        : null,
    },
  };
  const reaction = {
    partial: false,
    emoji: { id: null, name: '✅' },
    fetch: async () => {},
    users: {
      fetch: async () => {
        reactionUserFetches += 1;
        return { filter: () => ({ size: 2 }) };
      },
      remove: async () => {},
    },
    message: {
      id: '32345678901234567',
      channelId,
      partial: false,
      guild: { id: guildId },
      client,
    },
  };

  await messageReactionAddEvent.execute(reaction, { id: '42345678901234567', bot: false });

  assert.equal(reactionUserFetches, 0);
});
