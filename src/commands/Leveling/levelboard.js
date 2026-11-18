import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getLeaderboard } from '../../services/levelingService.js';
import { getLevelProgress } from '../../utils/levelMath.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('levelboard')
        .setDescription('Show the server level leaderboard.')
        .setDMPermission(false)
        .addIntegerOption((o) =>
            o.setName('page').setDescription('Page number').setMinValue(1).setRequired(false)),
    category: 'Leveling',

    async execute(interaction, config, client) {
        try {
            await InteractionHelper.safeDefer(interaction);
            const page = interaction.options.getInteger('page') ?? 1;
            const perPage = 10;
            const { total, rows } = await getLeaderboard(client, interaction.guildId, {
                limit: perPage,
                offset: (page - 1) * perPage,
            });

            if (!rows.length) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.USER_INPUT,
                    message: page > 1 ? 'There is nothing on that page.' : 'Nobody has any XP yet.',
                });
            }

            const lines = rows.map((row, i) => {
                const place = (page - 1) * perPage + i + 1;
                const { level } = getLevelProgress(row.xp);
                return `**${place}.** <@${row.userId}> — level **${level}** · ${row.xp.toLocaleString()} XP`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.guild.name} Leaderboard`)
                .setDescription(lines.join('\n'))
                .setColor(getColor('primary'))
                .setFooter({ text: `Page ${page} of ${Math.max(1, Math.ceil(total / perPage))} · ${total} ranked members` });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
        } catch (error) {
            logger.error('levelboard command error:', error);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not load the leaderboard.' }).catch(() => {});
        }
    },
};
