import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { successEmbed } from '../../utils/embeds.js';
import { MAX_LEVEL, parseLevelImportText } from '../../utils/levelMath.js';
import { setUserLevel, importLevels, syncAllRoles } from '../../services/levelingService.js';
import dashboard from './modules/leveling_dashboard.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('levelconfig')
        .setDescription('Manage the leveling system — XP, level roles and imports.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('dashboard')
                .setDescription('Open the leveling dashboard — XP speed, level roles, messages and imports.'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('setlevel')
                .setDescription('Set the level of any member.')
                .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
                .addIntegerOption((o) =>
                    o.setName('level').setDescription(`New level (0-${MAX_LEVEL})`).setMinValue(0).setMaxValue(MAX_LEVEL).setRequired(true))
                .addBooleanOption((o) =>
                    o.setName('apply_roles').setDescription('Apply level reward roles right away (default: true)').setRequired(false)),
        )
        .addSubcommand((sub) =>
            sub
                .setName('import')
                .setDescription('Import levels from a file (JSON or CSV: userId,level[,xp]).')
                .addAttachmentOption((o) => o.setName('file').setDescription('.json / .csv / .txt file').setRequired(true))
                .addStringOption((o) =>
                    o.setName('mode')
                        .setDescription('How to treat users that already have a level')
                        .addChoices(
                            { name: 'Only raise levels (safe, default)', value: 'max' },
                            { name: 'Overwrite exactly', value: 'overwrite' },
                        ))
                .addBooleanOption((o) =>
                    o.setName('apply_roles').setDescription('Apply level reward roles after importing (default: true)')),
        )
        .addSubcommand((sub) =>
            sub
                .setName('syncroles')
                .setDescription('Re-apply level reward roles for every stored member.'),
        ),
    category: 'Leveling',

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();

        try {
            const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferred) return;

            if (subcommand === 'dashboard') {
                return await dashboard.execute(interaction, config, client);
            }

            if (subcommand === 'setlevel') {
                const user = interaction.options.getUser('user', true);
                const level = interaction.options.getInteger('level', true);
                const applyRoles = interaction.options.getBoolean('apply_roles') ?? true;

                if (user.bot) {
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Bots do not have levels.' });
                }

                const result = await setUserLevel(client, interaction.guild, user.id, level, { applyRoles });
                logger.info('[LEVELING] setlevel', { adminId: interaction.user.id, targetUserId: user.id, level });

                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(
                        'Level Updated',
                        `${user} is now level **${result.level}** (was ${result.previousLevel}).`
                        + (applyRoles ? `\nRoles added: ${result.roles.added.length}, removed: ${result.roles.removed.length}.` : ''),
                    )],
                });
            }

            if (subcommand === 'import') {
                const file = interaction.options.getAttachment('file', true);
                const mode = interaction.options.getString('mode') ?? 'max';
                const applyRoles = interaction.options.getBoolean('apply_roles') ?? true;

                let host = '';
                try { host = new URL(file.url).hostname; } catch { /* handled below */ }
                if (!ALLOWED_ATTACHMENT_HOSTS.has(host)) {
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That attachment cannot be read.' });
                }
                if (file.size > MAX_IMPORT_BYTES) {
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'The file is too large (max 5 MB).' });
                }

                const response = await fetch(file.url);
                if (!response.ok) {
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'I could not download that file.' });
                }
                const text = await response.text();
                const { entries, errors } = parseLevelImportText(text);

                if (!entries.length) {
                    return await replyUserError(interaction, {
                        type: ErrorTypes.VALIDATION,
                        message: 'No valid rows found. Use `userId,level` per line, or JSON like `{"123456789012345678": 10}`.',
                    });
                }

                await InteractionHelper.safeEditReply(interaction, { content: `Importing ${entries.length} users...` });
                const summary = await importLevels(client, interaction.guild, entries, { mode, applyRoles });
                logger.info('[LEVELING] import', { adminId: interaction.user.id, users: entries.length, mode });

                return await InteractionHelper.safeEditReply(interaction, {
                    content: null,
                    embeds: [successEmbed(
                        'Levels Imported',
                        [
                            `Processed **${summary.imported}** users.`,
                            `Raised: **${summary.raised}**, unchanged: **${summary.unchanged}**, lowered: **${summary.lowered}**.`,
                            applyRoles ? `Role updates: **${summary.roleChanges}** members.` : null,
                            errors.length ? `Skipped **${errors.length}** invalid rows.` : null,
                        ].filter(Boolean).join('\n'),
                    )],
                });
            }

            if (subcommand === 'syncroles') {
                await InteractionHelper.safeEditReply(interaction, { content: 'Syncing roles...' });
                const summary = await syncAllRoles(client, interaction.guild);
                return await InteractionHelper.safeEditReply(interaction, {
                    content: null,
                    embeds: [successEmbed(
                        'Roles Synced',
                        `Checked **${summary.processed}** members. Added **${summary.added}**, removed **${summary.removed}** roles.`
                        + (summary.skipped ? `\nSkipped ${summary.skipped} changes (role missing, managed, or above my highest role).` : ''),
                    )],
                });
            }

            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This subcommand is not recognised.' });
        } catch (error) {
            logger.error('levelconfig command error:', error);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An unexpected error occurred.' }).catch(() => {});
        }
    },
};
