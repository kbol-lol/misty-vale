import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getLevelingConfig, getUserLevelProgress, getUserRank } from '../../services/levelingService.js';

function progressBar(current, needed, size = 14) {
    const ratio = needed > 0 ? Math.min(1, current / needed) : 1;
    const filled = Math.round(ratio * size);
    return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}`;
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('level')
        .setDescription('Show your level and XP progress (or another member\'s).')
        .setDMPermission(false)
        .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(false)),
    category: 'Leveling',

    async execute(interaction, config, client) {
        try {
            await InteractionHelper.safeDefer(interaction);
            const user = interaction.options.getUser('user') ?? interaction.user;

            if (user.bot) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Bots do not have levels.' });
            }

            const cfg = await getLevelingConfig(client, interaction.guildId);
            const progress = await getUserLevelProgress(client, interaction.guildId, user.id);
            const rank = await getUserRank(client, interaction.guildId, user.id);

            const nextReward = cfg.roleRewards.find((r) => r.level > progress.level);
            const embed = new EmbedBuilder()
                .setTitle(`${user.displayName ?? user.username}'s Level`)
                .setThumbnail(user.displayAvatarURL())
                .setColor(getColor('primary'))
                .addFields(
                    { name: 'Level', value: `\`${progress.level}\``, inline: true },
                    { name: 'Rank', value: rank ? `\`#${rank.rank}\` of ${rank.total}` : '`Unranked`', inline: true },
                    { name: 'Total XP', value: `\`${progress.totalXp.toLocaleString()}\``, inline: true },
                    {
                        name: 'Progress',
                        value: progress.neededXp
                            ? `${progressBar(progress.currentXp, progress.neededXp)}\n\`${progress.currentXp.toLocaleString()} / ${progress.neededXp.toLocaleString()} XP\``
                            : 'Max level reached',
                    },
                );

            if (nextReward) {
                embed.addFields({ name: 'Next reward', value: `<@&${nextReward.roleId}> at level **${nextReward.level}**` });
            }

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
        } catch (error) {
            logger.error('level command error:', error);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not load level data.' }).catch(() => {});
        }
    },
};
