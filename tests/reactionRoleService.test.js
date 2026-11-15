import assert from 'node:assert/strict';
import test from 'node:test';
import { createReactionRolePanel } from '../src/services/reactionRoleService.js';

test('creating a reaction panel persists its image metadata and starts empty', async () => {
  let savedKey;
  let savedPanel;
  const client = {
    db: {
      set: async (key, value) => {
        savedKey = key;
        savedPanel = value;
      },
    },
  };

  const panel = await createReactionRolePanel(
    client,
    '12345678901234567',
    '22345678901234567',
    '32345678901234567',
    {
      title: 'Color Roles',
      description: 'React to choose a color.',
      imageUrl: 'https://cdn.example.com/image.png',
      imageName: 'colors.png',
    },
  );

  assert.equal(savedKey, 'guild:12345678901234567:reaction_roles:32345678901234567');
  assert.equal(savedPanel, panel);
  assert.equal(panel.mode, 'reaction');
  assert.equal(panel.imageUrl, 'https://cdn.example.com/image.png');
  assert.equal(panel.imageName, 'colors.png');
  assert.deepEqual(panel.roles, []);
  assert.deepEqual(panel.reactionRoles, []);
});
