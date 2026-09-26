import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const CUSTOM_EMOJI_PATTERN = /^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/;

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
    ),
  category: 'Utility',

  async execute(interaction, _config, client) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to manage reaction limits.', flags: MessageFlags.Ephemeral });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(client, interaction.guildId);
    const limiterConfig = {
      enabled: guildConfig.reactionLimiter?.enabled !== false,
      limits: { ...(guildConfig.reactionLimiter?.limits || {}) },
    };

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
