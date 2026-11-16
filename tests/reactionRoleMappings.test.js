import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addReactionRoleMappingToPanel,
  getReactionRoleEmojiKey,
  MAX_REACTION_ROLES_PER_MESSAGE,
  parseReactionRoleEmoji,
  ReactionRoleMappingError,
  removeReactionRoleMappingFromPanel,
} from '../src/utils/reactionRoleMappings.js';

function makePanel() {
  return {
    roles: [],
    reactionRoles: [],
  };
}

test('custom emoji IDs and Unicode emoji names have stable reaction keys', () => {
  assert.equal(getReactionRoleEmojiKey({ id: '12345678901234567', name: 'custom' }), '12345678901234567');
  assert.equal(getReactionRoleEmojiKey({ id: null, name: '🎨' }), '🎨');
});

test('reaction emoji input accepts server custom emoji and one Unicode emoji', () => {
  const customEmoji = {
    id: '12345678901234567',
    available: true,
    toString: () => '<:custom:12345678901234567>',
  };
  const guild = {
    emojis: {
      cache: {
        get: (id) => (id === customEmoji.id ? customEmoji : null),
        find: () => customEmoji,
      },
    },
  };

  assert.deepEqual(parseReactionRoleEmoji(guild, '<:custom:12345678901234567>'), {
    key: customEmoji.id,
    display: '<:custom:12345678901234567>',
    reactValue: customEmoji.id,
  });
  assert.deepEqual(parseReactionRoleEmoji(guild, '🎨'), {
    key: '🎨',
    display: '🎨',
    reactValue: '🎨',
  });
  assert.equal(parseReactionRoleEmoji(guild, 'not-an-emoji'), null);
});

test('reaction emoji input accepts pasted custom emoji from another server', () => {
  const guild = { emojis: { cache: { get: () => null, find: () => null } } };
  assert.deepEqual(parseReactionRoleEmoji(guild, '<a:external_emoji:12345678901234567>'), {
    key: '12345678901234567',
    display: '<a:external_emoji:12345678901234567>',
    reactValue: '<a:external_emoji:12345678901234567>',
    isExternal: true,
  });
});

test('reaction panels accept at most 20 unique emoji-role mappings', () => {
  const panel = makePanel();

  for (let index = 0; index < MAX_REACTION_ROLES_PER_MESSAGE; index += 1) {
    addReactionRoleMappingToPanel(panel, {
      emojiKey: `emoji-${index}`,
      emojiDisplay: `:emoji_${index}:`,
      roleId: `role-${index}`,
    });
  }

  assert.equal(panel.roles.length, 20);
  assert.equal(panel.reactionRoles.length, 20);
  assert.throws(
    () => addReactionRoleMappingToPanel(panel, {
      emojiKey: 'emoji-over-limit',
      emojiDisplay: ':emoji_over_limit:',
      roleId: 'role-over-limit',
    }),
    (error) => error instanceof ReactionRoleMappingError && error.code === 'LIMIT_REACHED',
  );
});

test('reaction panels reject duplicate emoji or role mappings', () => {
  const panel = makePanel();
  addReactionRoleMappingToPanel(panel, {
    emojiKey: 'emoji-one',
    emojiDisplay: ':emoji_one:',
    roleId: 'role-one',
  });

  assert.throws(
    () => addReactionRoleMappingToPanel(panel, {
      emojiKey: 'emoji-one',
      emojiDisplay: ':emoji_one:',
      roleId: 'role-two',
    }),
    (error) => error instanceof ReactionRoleMappingError && error.code === 'DUPLICATE_EMOJI',
  );
  assert.throws(
    () => addReactionRoleMappingToPanel(panel, {
      emojiKey: 'emoji-two',
      emojiDisplay: ':emoji_two:',
      roleId: 'role-one',
    }),
    (error) => error instanceof ReactionRoleMappingError && error.code === 'DUPLICATE_ROLE',
  );
});

test('removing a role also removes its reaction mapping', () => {
  const panel = makePanel();
  const mapping = {
    emojiKey: 'emoji-one',
    emojiDisplay: ':emoji_one:',
    roleId: 'role-one',
  };
  addReactionRoleMappingToPanel(panel, mapping);

  assert.deepEqual(removeReactionRoleMappingFromPanel(panel, 'role-one'), mapping);
  assert.deepEqual(panel.roles, []);
  assert.deepEqual(panel.reactionRoles, []);
  assert.equal(removeReactionRoleMappingFromPanel(panel, 'missing-role'), null);
});
