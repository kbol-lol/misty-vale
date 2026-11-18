import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { isReactionLimiterEnabledForChannel } from '../../config/reactionLimiter.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { createSearchButton, openDashboardSearch } from '../../utils/dashboardSearch.js';

const CUSTOM_EMOJI_PATTERN = /^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/;
const LIMITS_PER_PAGE = 15;

export default {
  data: new SlashCommandBuilder()
    .setName('reactionlimit')
    .setDescription('Manage per-message emoji reaction limits')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add an emoji reaction limit')
        .addStringOption((option) =>
          option
            .setName('emoji')
            .setDescription('Unicode emoji or custom emoji, e.g. <:check:1490994864790175884>')
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('limit').setDescription('Maximum number of people').setRequired(true).setMinValue(0).setMaxValue(100000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('Change an existing emoji reaction limit')
        .addStringOption((option) =>
          option
            .setName('emoji')
            .setDescription('Unicode emoji or custom emoji, e.g. <:check:1490994864790175884>')
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('limit').setDescription('Maximum number of people').setRequired(true).setMinValue(0).setMaxValue(100000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Stop limiting an emoji')
        .addStringOption((option) =>
          option
            .setName('emoji')
            .setDescription('Unicode emoji or custom emoji, e.g. <:check:1490994864790175884>')
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('Show all configured reaction limits'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('dashboard').setDescription('Open the reaction limiter dashboard'),
    ),
  category: 'Utility',

  async execute(interaction, _config, client) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to manage reaction limits.', flags: MessageFlags.Ephemeral });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'dashboard') {
      await openReactionLimiterDashboard(interaction, client);
      return;
    }

    const guildConfig = await getGuildConfig(client, interaction.guildId);
    const limiterConfig = await pruneDeletedServerEmojiLimits(
      client,
      interaction.guild,
      copyLimiterConfig(guildConfig.reactionLimiter),
    );

    if (subcommand === 'list') {
      const entries = Object.entries(limiterConfig.limits);
      const description = entries.length
        ? entries.map(([key, limit]) => `${formatEmojiKey(key, interaction.guild)} — **${limit}**`).join('\n')
        : 'No emoji reaction limits are configured.';
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Reaction Limits').setDescription(description)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const parsedEmoji = parseEmoji(interaction.options.getString('emoji', true));
    if (!parsedEmoji) {
      await interaction.reply({
        content: 'Use one Unicode emoji (such as `✅`) or a custom emoji in the format `<:emoji_name:1490994864790175884>`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'remove') {
      if (!(parsedEmoji.key in limiterConfig.limits)) {
        await interaction.reply({ content: `${parsedEmoji.display} does not have a configured reaction limit.`, flags: MessageFlags.Ephemeral });
        return;
      }

      delete limiterConfig.limits[parsedEmoji.key];
      await updateGuildConfig(client, interaction.guildId, { reactionLimiter: limiterConfig });
      await interaction.reply({ content: `Removed the reaction limit for ${parsedEmoji.display}. This takes effect immediately.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const limit = interaction.options.getInteger('limit', true);
    const exists = parsedEmoji.key in limiterConfig.limits;
    if (subcommand === 'add' && exists) {
      await interaction.reply({ content: `${parsedEmoji.display} already has a limit of **${limiterConfig.limits[parsedEmoji.key]}**. Use \`/reactionlimit set\` to change it.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'set' && !exists) {
      await interaction.reply({ content: `${parsedEmoji.display} does not have a configured limit. Use \`/reactionlimit add\` first.`, flags: MessageFlags.Ephemeral });
      return;
    }

    limiterConfig.limits[parsedEmoji.key] = limit;
    await updateGuildConfig(client, interaction.guildId, { reactionLimiter: limiterConfig });
    const action = exists ? 'Updated' : 'Added';
    await InteractionHelper.safeReply(interaction, {
      content: `${action} ${parsedEmoji.display} with a limit of **${limit}** people per message. This takes effect immediately.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export function buildReactionLimiterDashboardPayload(guild, limiterConfig, state = {}) {
  const channelId = state.channelId || null;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  const limits = Object.entries(limiterConfig.limits || {}).sort(([a], [b]) => a.localeCompare(b));
  const pageCount = Math.max(1, Math.ceil(limits.length / LIMITS_PER_PAGE));
  const page = Math.min(Math.max(0, state.page || 0), pageCount - 1);
  const pageEntries = limits.slice(page * LIMITS_PER_PAGE, (page + 1) * LIMITS_PER_PAGE);
  const channelEnabled = channel
    ? isReactionLimiterEnabledForChannel(limiterConfig, channel.id)
    : null;
  const list = pageEntries.length
    ? pageEntries.map(([key, limit]) => `${formatEmojiKey(key, guild)} — **${limit}**`).join('\n')
    : 'No emoji reaction limits are configured.';

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('Reaction Limiter Dashboard')
    .setDescription(
      'Choose a channel to enable or disable limits there. Emoji limits are shared across channels where the limiter is enabled.' +
        (state.notice ? `\n\n${state.notice}` : ''),
    )
    .addFields(
      { name: 'Selected channel', value: channel ? `<#${channel.id}>` : 'Select a channel below.', inline: true },
      {
        name: 'Limiter in channel',
        value: channelEnabled === null ? 'Not selected' : channelEnabled ? 'Enabled' : 'Disabled',
        inline: true,
      },
      {
        name: 'Emoji limits',
        value: `${list}\n\nPage ${page + 1} of ${pageCount}`,
        inline: false,
      },
    )
    .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' });

  const prefix = `rl_${guild.id}`;
  const components = [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`${prefix}_channel`)
        .setPlaceholder(channel ? `Selected: #${channel.name}`.slice(0, 100) : 'Choose a channel to configure')
        .setChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread,
        )
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];

  if (pageEntries.length > 0) {
    const emojiMenu = new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_emoji`)
      .setPlaceholder('Select an emoji limit to edit or remove')
      .addOptions(
        pageEntries.map(([key, limit]) => buildEmojiLimitOption(key, limit, guild, key === state.selectedEmojiKey)),
      );
    components.push(new ActionRowBuilder().addComponents(emojiMenu));
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}_add`)
        .setLabel('Add limit')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('➕'),
      new ButtonBuilder()
        .setCustomId(`${prefix}_edit`)
        .setLabel('Edit selected')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✏️')
        .setDisabled(!state.selectedEmojiKey),
      new ButtonBuilder()
        .setCustomId(`${prefix}_remove`)
        .setLabel('Remove selected')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
        .setDisabled(!state.selectedEmojiKey),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}_toggle`)
        .setLabel(channelEnabled ? 'Disable in channel' : 'Enable in channel')
        .setStyle(channelEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setEmoji(channelEnabled ? '⏸️' : '▶️')
        .setDisabled(!channel),
      new ButtonBuilder()
        .setCustomId(`${prefix}_previous`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`${prefix}_next`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
      createSearchButton(`${prefix}_search`),
    ),
  );

  return { embeds: [embed], components };
}

async function openReactionLimiterDashboard(interaction, client) {
  if (!await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral })) return;

  const guildConfig = await getGuildConfig(client, interaction.guildId);
  const limiterConfig = await pruneDeletedServerEmojiLimits(
    client,
    interaction.guild,
    copyLimiterConfig(guildConfig.reactionLimiter),
  );
  const state = {
    limiterConfig,
    channelId: null,
    selectedEmojiKey: null,
    page: 0,
    notice: null,
  };
  const render = () =>
    buildReactionLimiterDashboardPayload(interaction.guild, state.limiterConfig, state);

  await interaction.editReply(render());
  const dashboardMessage = await interaction.fetchReply();
  const idPrefix = `rl_${interaction.guildId}_`;
  const collector = interaction.channel.createMessageComponentCollector({
    filter: (component) =>
      component.user.id === interaction.user.id &&
      component.message.id === dashboardMessage.id &&
      component.customId.startsWith(idPrefix),
    time: 600_000,
  });

  const buildSearchEntries = () => {
    const guild = interaction.guild;
    const limits = Object.entries(state.limiterConfig.limits || {}).sort(([a], [b]) => a.localeCompare(b));
    const entries = [
      { title: 'Add limit', description: 'Add a new emoji reaction limit', location: 'Button', keywords: ['new', 'create', 'emoji', 'limit'], action: 'add' },
    ];
    limits.forEach(([key, limit], index) => {
      entries.push({
        title: `${formatEmojiKey(key, guild)} — ${limit} people`,
        description: 'Emoji reaction limit',
        location: `Emoji limits, page ${Math.floor(index / LIMITS_PER_PAGE) + 1} — opening it selects it for Edit / Remove`,
        keywords: [key, 'emoji', 'limit'],
        action: `emoji:${key}`.slice(0, 100),
      });
    });
    for (const [channelId, enabled] of Object.entries(state.limiterConfig.channelOverrides || {})) {
      const channel = guild.channels.cache.get(channelId);
      entries.push({
        title: `#${channel?.name ?? channelId}`,
        description: `Limiter ${enabled ? 'enabled' : 'disabled'} in this channel`,
        location: 'Channel — opening it selects the channel',
        keywords: [channelId, 'channel'],
        action: `channel:${channelId}`,
      });
    }
    return entries;
  };

  const openPicked = async (pick, action) => {
    if (action === 'add') {
      await handleLimitModal(pick, interaction, client, state, render);
      return;
    }
    await pick.deferUpdate();
    if (action.startsWith('emoji:')) {
      const key = Object.keys(state.limiterConfig.limits || {})
        .sort((a, b) => a.localeCompare(b))
        .find((k) => `emoji:${k}`.slice(0, 100) === action);
      if (!key) return;
      const index = Object.keys(state.limiterConfig.limits).sort((a, b) => a.localeCompare(b)).indexOf(key);
      state.page = Math.floor(index / LIMITS_PER_PAGE);
      state.selectedEmojiKey = key;
    } else if (action.startsWith('channel:')) {
      state.channelId = action.slice('channel:'.length);
    }
    state.notice = null;
    await interaction.editReply(render());
  };

  collector.on('collect', (component) => {
    void (async () => {
      if (component.customId === `${idPrefix}search`) {
        await openDashboardSearch(component, {
          dashboardName: 'Reaction Limiter',
          placeholder: 'e.g. an emoji name, a channel name, add',
          getEntries: buildSearchEntries,
          onPick: openPicked,
        });
        return;
      }

      if (component.customId === `${idPrefix}channel`) {
        state.channelId = component.values[0];
        state.notice = null;
        await component.update(render());
        return;
      }

      if (component.customId === `${idPrefix}emoji`) {
        state.selectedEmojiKey = component.values[0];
        state.notice = null;
        await component.update(render());
        return;
      }

      if (component.customId === `${idPrefix}previous` || component.customId === `${idPrefix}next`) {
        const pageCount = Math.max(1, Math.ceil(Object.keys(state.limiterConfig.limits).length / LIMITS_PER_PAGE));
        state.page = Math.min(
          Math.max(0, state.page + (component.customId === `${idPrefix}next` ? 1 : -1)),
          pageCount - 1,
        );
        state.selectedEmojiKey = null;
        state.notice = null;
        await component.update(render());
        return;
      }

      if (component.customId === `${idPrefix}add` || component.customId === `${idPrefix}edit`) {
        await handleLimitModal(component, interaction, client, state, render);
        return;
      }

      if (component.customId === `${idPrefix}remove`) {
        if (!state.selectedEmojiKey) return;
        await component.deferUpdate();
        const latest = await getGuildConfig(client, interaction.guildId);
        const limiterConfig = copyLimiterConfig(latest.reactionLimiter);
        if (!Object.hasOwn(limiterConfig.limits, state.selectedEmojiKey)) {
          state.notice = 'That emoji limit no longer exists. Refresh the dashboard and try again.';
          await interaction.editReply(render());
          return;
        }
        delete limiterConfig.limits[state.selectedEmojiKey];
        const saved = await updateGuildConfig(client, interaction.guildId, { reactionLimiter: limiterConfig });
        state.limiterConfig = copyLimiterConfig(saved.reactionLimiter);
        state.selectedEmojiKey = null;
        state.page = Math.min(state.page, Math.max(0, Math.ceil(Object.keys(state.limiterConfig.limits).length / LIMITS_PER_PAGE) - 1));
        state.notice = 'The selected emoji limit was removed.';
        await interaction.editReply(render());
        return;
      }

      if (component.customId === `${idPrefix}toggle`) {
        if (!state.channelId) return;
        await component.deferUpdate();
        const latest = await getGuildConfig(client, interaction.guildId);
        const limiterConfig = copyLimiterConfig(latest.reactionLimiter);
        const wasEnabled = isReactionLimiterEnabledForChannel(limiterConfig, state.channelId);
        limiterConfig.channelOverrides[state.channelId] = !wasEnabled;
        const saved = await updateGuildConfig(client, interaction.guildId, { reactionLimiter: limiterConfig });
        state.limiterConfig = copyLimiterConfig(saved.reactionLimiter);
        state.notice = `Reaction limits are now ${!wasEnabled ? 'enabled' : 'disabled'} in <#${state.channelId}>.`;
        await interaction.editReply(render());
      }
    })().catch(async (error) => {
      logger.error('Reaction limiter dashboard interaction failed:', error);
      state.notice = 'Could not save that change. Please try again.';
      if (!component.replied && !component.deferred) {
        await component.reply({ content: state.notice, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.editReply(render()).catch(() => {});
      }
    });
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'time') {
      await interaction.editReply({ components: [] }).catch((error) =>
        logger.debug('Could not close reaction limiter dashboard:', error.message),
      );
    }
  });
}

async function handleLimitModal(component, rootInteraction, client, state, render) {
  const isEdit = component.customId.endsWith('_edit');
  if (isEdit && (!state.selectedEmojiKey || !Object.hasOwn(state.limiterConfig.limits, state.selectedEmojiKey))) {
    await component.deferUpdate();
    state.notice = 'That emoji limit no longer exists. Refresh the dashboard and try again.';
    await rootInteraction.editReply(render());
    return;
  }

  const selectedLimit = isEdit ? state.limiterConfig.limits[state.selectedEmojiKey] : null;
  const modal = new ModalBuilder()
    .setCustomId(`rl_${rootInteraction.guildId}_${isEdit ? 'edit' : 'add'}_modal`)
    .setTitle(isEdit ? 'Edit reaction limit' : 'Add reaction limit');

  if (!isEdit) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('emoji')
          .setLabel('Unicode emoji or custom emoji markup')
          .setPlaceholder('✅ or <:name:123456789012345678>')
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
  }
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('limit')
        .setLabel('Maximum human reactions per message')
        .setPlaceholder('For example: 25')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(6)
        .setValue(isEdit ? String(selectedLimit) : '25')
        .setRequired(true),
    ),
  );

  await component.showModal(modal);
  const modalId = modal.data.custom_id;
  const submitted = await component.awaitModalSubmit({
    filter: (entry) => entry.customId === modalId && entry.user.id === component.user.id,
    time: 120_000,
  }).catch((error) => {
    if (error.code === 'InteractionCollectorError') return null;
    throw error;
  });
  if (!submitted) return;

  await submitted.deferUpdate();
  const limitInput = submitted.fields.getTextInputValue('limit').trim();
  const limit = Number(limitInput);
  if (!/^\d+$/.test(limitInput) || !Number.isSafeInteger(limit) || limit > 100000) {
    state.notice = 'Enter a whole-number limit between 0 and 100000.';
    await rootInteraction.editReply(render());
    return;
  }

  const latest = await getGuildConfig(client, rootInteraction.guildId);
  const limiterConfig = copyLimiterConfig(latest.reactionLimiter);
  let emojiKey = state.selectedEmojiKey;
  if (!isEdit) {
    const parsedEmoji = parseEmoji(submitted.fields.getTextInputValue('emoji'));
    if (!parsedEmoji) {
      state.notice = 'Enter one Unicode emoji or a custom emoji in the format <:name:id>.';
      await rootInteraction.editReply(render());
      return;
    }
    emojiKey = parsedEmoji.key;
    if (Object.hasOwn(limiterConfig.limits, emojiKey)) {
      state.notice = `${parsedEmoji.display} already has a limit. Select it and use Edit selected.`;
      await rootInteraction.editReply(render());
      return;
    }
  } else if (!Object.hasOwn(limiterConfig.limits, emojiKey)) {
    state.notice = 'That emoji limit no longer exists. Refresh the dashboard and try again.';
    await rootInteraction.editReply(render());
    return;
  }

  limiterConfig.limits[emojiKey] = limit;
  const saved = await updateGuildConfig(client, rootInteraction.guildId, { reactionLimiter: limiterConfig });
  state.limiterConfig = copyLimiterConfig(saved.reactionLimiter);
  state.selectedEmojiKey = emojiKey;
  const sortedKeys = Object.keys(state.limiterConfig.limits).sort((a, b) => a.localeCompare(b));
  state.page = Math.floor(sortedKeys.indexOf(emojiKey) / LIMITS_PER_PAGE);
  state.notice = `Saved the limit of ${limit} for ${formatEmojiKey(emojiKey, rootInteraction.guild)}.`;
  await rootInteraction.editReply(render());
}

function copyLimiterConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    limits: { ...(config.limits || {}) },
    channelOverrides: { ...(config.channelOverrides || {}) },
  };
}

export async function pruneDeletedServerEmojiLimits(client, guild, limiterConfig) {
  const emojiCache = guild?.emojis?.cache;
  if (!emojiCache) return limiterConfig;

  const limits = { ...limiterConfig.limits };
  const deletedEmojiIds = Object.keys(limits).filter(
    (key) => /^\d{17,20}$/.test(key) && !emojiCache.has(key),
  );
  if (deletedEmojiIds.length === 0) return limiterConfig;

  for (const emojiId of deletedEmojiIds) {
    delete limits[emojiId];
  }
  const saved = await updateGuildConfig(client, guild.id, {
    reactionLimiter: { ...limiterConfig, limits },
  });
  logger.info(`Removed ${deletedEmojiIds.length} stale server emoji reaction limit(s) in guild ${guild.id}`);
  return copyLimiterConfig(saved.reactionLimiter);
}

function buildEmojiLimitOption(key, limit, guild, selected) {
  const isCustomEmoji = /^\d{17,20}$/.test(key);
  const customEmoji = isCustomEmoji ? guild.emojis.cache.get(key) : null;
  const label = customEmoji
    ? `${customEmoji.name} — ${limit}`
    : `${isCustomEmoji ? `Custom emoji ${key}` : key} — ${limit}`;
  const option = new StringSelectMenuOptionBuilder()
    .setLabel(label.slice(0, 100))
    .setValue(key)
    .setDefault(selected);

  if (customEmoji) {
    option.setEmoji({ id: customEmoji.id, name: customEmoji.name, animated: customEmoji.animated });
  } else if (!isCustomEmoji) {
    option.setEmoji(key);
  }
  return option;
}

function parseEmoji(value) {
  const trimmed = value.trim();
  const customMatch = CUSTOM_EMOJI_PATTERN.exec(trimmed);
  if (customMatch) {
    const [, animated, name, id] = customMatch;
    return {
      key: id,
      display: `<${animated ? 'a' : ''}:${name}:${id}>`,
    };
  }

  if (!trimmed || /[\s<>]/.test(trimmed)) {
    return null;
  }

  return { key: trimmed, display: trimmed };
}

function formatEmojiKey(key, guild) {
  if (/^\d{17,20}$/.test(key)) {
    const emoji = guild.emojis.cache.get(key);
    return emoji ? emoji.toString() : `<:unknown:${key}>`;
  }
  return key;
}
