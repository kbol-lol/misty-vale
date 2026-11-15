import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReactionRoleAssignment } from '../src/services/reactionRoleAssignment.js';

function createHarness() {
  const guildId = '12345678901234567';
  const messageId = '22345678901234567';
  const userId = '32345678901234567';
  const roleId = '42345678901234567';
  const emojiId = '52345678901234567';
  const assignedRoles = new Set();
  const role = {
    id: roleId,
    managed: false,
    position: 1,
    permissions: { has: () => false },
  };
  const member = {
    user: { id: userId },
    roles: {
      cache: { has: (id) => assignedRoles.has(id) },
      add: async (assignedRole) => assignedRoles.add(assignedRole.id),
      remove: async (assignedRole) => assignedRoles.delete(assignedRole.id),
    },
  };
  const panelData = {
    mode: 'reaction',
    reactionRoles: [{ emojiKey: emojiId, emojiDisplay: '<:custom:52345678901234567>', roleId }],
  };
  const client = {
    db: { get: async () => panelData },
  };
  const guild = {
    id: guildId,
    roles: {
      cache: { get: (id) => (id === roleId ? role : null) },
    },
    members: {
      me: {
        permissions: { has: () => true },
        roles: { highest: { position: 10 } },
      },
      cache: { get: (id) => (id === userId ? member : null) },
    },
  };
  const reaction = {
    emoji: { id: emojiId, name: 'custom' },
    message: { id: messageId, guild, client },
  };

  return { reaction, user: { id: userId }, roleId, assignedRoles };
}

test('adding and removing a mapped reaction adds and removes its role', async () => {
  const harness = createHarness();

  await handleReactionRoleAssignment(harness.reaction, harness.user, true);
  assert.equal(harness.assignedRoles.has(harness.roleId), true);

  await handleReactionRoleAssignment(harness.reaction, harness.user, false);
  assert.equal(harness.assignedRoles.has(harness.roleId), false);
});

test('rapid react then unreact events leave the role removed', async () => {
  const harness = createHarness();

  await Promise.all([
    handleReactionRoleAssignment(harness.reaction, harness.user, true),
    handleReactionRoleAssignment(harness.reaction, harness.user, false),
  ]);

  assert.equal(harness.assignedRoles.has(harness.roleId), false);
});
