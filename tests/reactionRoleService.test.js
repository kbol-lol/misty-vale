import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReactionRolePanel,
  updateReactionRolePanelImage,
} from '../src/services/reactionRoleService.js';
import {
  addPanelReactions,
  buildEmojiPickerPayload,
  buildUnicodeEmojiPickerPayload,
  buildReactionPanelEmbed,
  buildReactionRoleDashboardPayload,
  buildReactionRoleImageEditPayload,
} from '../src/commands/Reaction_roles/reactroles.js';

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

test('updating or removing a reaction panel image persists both image fields together', async () => {
  const guildId = '12345678901234567';
  const messageId = '32345678901234567';
  const key = `guild:${guildId}:reaction_roles:${messageId}`;
  const data = new Map([[key, {
    guildId,
    channelId: '22345678901234567',
    messageId,
    mode: 'reaction',
    title: 'Color Roles',
    description: 'Choose a color.',
    roles: [],
    reactionRoles: [],
    imageUrl: null,
    imageName: null,
  }]]);
  const client = {
    db: {
      get: async storageKey => data.get(storageKey) ?? null,
      set: async (storageKey, value) => {
        data.set(storageKey, value);
        return true;
      },
    },
  };

  const withImage = await updateReactionRolePanelImage(client, guildId, messageId, {
    imageUrl: 'https://cdn.example.com/banner.png',
    imageName: 'banner.png',
  });
  assert.equal(withImage.imageUrl, 'https://cdn.example.com/banner.png');
  assert.equal(withImage.imageName, 'banner.png');

  const withoutImage = await updateReactionRolePanelImage(client, guildId, messageId, {
    imageUrl: null,
    imageName: null,
  });
  assert.equal(withoutImage.imageUrl, null);
  assert.equal(withoutImage.imageName, null);
  assert.deepEqual(data.get(key), withoutImage);
});

test('reaction role dashboard exposes image management and renders image removal', () => {
  const guildId = '12345678901234567';
  const panelData = {
    guildId,
    channelId: '22345678901234567',
    messageId: '32345678901234567',
    mode: 'reaction',
    title: 'Color Roles',
    description: 'Choose a color.',
    roles: [],
    reactionRoles: [],
    imageUrl: null,
    imageName: null,
  };
  const payload = buildReactionRoleDashboardPayload(
    panelData,
    null,
    guildId,
    { channels: { cache: new Map([[panelData.channelId, { id: panelData.channelId }]]) } },
    { exists: true },
  );
  const menu = payload.components[1].components[0].toJSON();
  assert.ok(menu.options.some(option => option.value === 'panel_image'));

  const imageEmbed = buildReactionPanelEmbed({ ...panelData, imageName: 'banner.png' }).toJSON();
  const clearedEmbed = buildReactionPanelEmbed(panelData).toJSON();
  assert.equal(imageEmbed.image.url, 'attachment://banner.png');
  assert.equal(clearedEmbed.image, undefined);

  const message = {
    attachments: [
      { id: 'old-image', name: 'old.png' },
      { id: 'other-file', name: 'other.txt' },
    ],
  };
  const replacement = buildReactionRoleImageEditPayload(
    message,
    { ...panelData, imageName: 'old.png' },
    { url: 'https://cdn.example.com/new.png', name: 'new.png' },
  );
  assert.deepEqual(replacement.messagePayload.attachments, [{ id: 'other-file' }]);
  assert.deepEqual(replacement.messagePayload.files, [{
    attachment: 'https://cdn.example.com/new.png',
    name: 'new.png',
  }]);

  const removal = buildReactionRoleImageEditPayload(
    message,
    { ...panelData, imageName: 'old.png' },
    null,
  );
  assert.deepEqual(removal.messagePayload.attachments, [{ id: 'other-file' }]);
  assert.deepEqual(removal.messagePayload.files, []);
  assert.equal(removal.panelData.imageUrl, null);
});

test('reaction-role panel displays the selected emoji next to its assigned role', () => {
  const embed = buildReactionPanelEmbed({
    title: 'Color Roles',
    description: 'Choose a color.',
    reactionRoles: [{
      emojiKey: '❤️',
      emojiDisplay: '❤️',
      roleId: '42345678901234567',
    }],
  }).toJSON();

  assert.match(embed.description, /❤️ — <@&42345678901234567>/);
});

test('emoji picker provides paginated server emojis and a manual Unicode option', () => {
  const emojis = Array.from({ length: 26 }, (_, index) => ({
    id: String(10000000000000000 + index),
    name: `emoji_${index}`,
    animated: false,
  }));
  const firstPage = buildEmojiPickerPayload(emojis, 0, 'emoji-picker').components;
  const firstOptions = firstPage[0].components[0].toJSON().options;
  const pageButtons = firstPage[1].components.map(button => button.toJSON());

  assert.equal(firstOptions.length, 25);
  assert.equal(firstOptions.at(-2).value, 'manual');
  assert.equal(firstOptions.at(-1).value, 'unicode');
  assert.equal(pageButtons[0].disabled, true);
  assert.equal(pageButtons[1].disabled, false);

  const secondPage = buildEmojiPickerPayload(emojis, 1, 'emoji-picker').components;
  const secondOptions = secondPage[0].components[0].toJSON().options;
  assert.equal(secondOptions.length, 5);
  assert.equal(secondOptions[0].value, emojis[23].id);
  assert.equal(secondOptions.at(-2).value, 'manual');
  assert.equal(secondOptions.at(-1).value, 'unicode');
});

test('Unicode emoji picker searches by name and includes skin-tone variants', () => {
  const payload = buildUnicodeEmojiPickerPayload({
    category: 'People & Body',
    query: 'waving hand light skin tone',
    page: 0,
  }, 'unicode-picker');
  const categoryOptions = payload.components[0].components[0].toJSON().options;
  const emojiOptions = payload.components[1].components[0].toJSON().options;

  assert.ok(categoryOptions.some(option => option.value === 'People & Body' && option.default));
  assert.equal(emojiOptions.length, 1);
  assert.equal(emojiOptions[0].value, '👋🏻');
});

test('panel reposts use stored emoji markup for pasted custom emojis', async () => {
  const reactions = [];
  await addPanelReactions({ react: async emoji => reactions.push(emoji) }, [
    { emojiKey: '12345678901234567', emojiDisplay: '<a:external_emoji:12345678901234567>' },
    { emojiKey: '🎨', emojiDisplay: '🎨' },
  ]);
  assert.deepEqual(reactions, ['<a:external_emoji:12345678901234567>', '🎨']);
});
