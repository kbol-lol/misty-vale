import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags, ComponentType, EmbedBuilder, LabelBuilder, CheckboxBuilder, TextDisplayBuilder } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { createError, TitanBotError, ErrorTypes, replyUserError, handleInteractionError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    addReactionRoleMapping,
    createReactionRoleMessage,
    createReactionRolePanel,
    hasDangerousPermissions,
    getAllReactionRoleMessages,
    deleteReactionRoleMessage,
    removeReactionRoleMapping,
} from '../../services/reactionRoleService.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import {
    getReactionRolePanelStatus,
    formatPanelStatusField,
} from '../../utils/panelStatus.js';
import { startDashboardSession } from '../../utils/dashboardSession.js';
import { getReactionRoleKey } from '../../utils/database/keys.js';
import {
    getReactionRoleEmojiKey,
    MAX_REACTION_ROLES_PER_MESSAGE,
    parseReactionRoleEmoji,
} from '../../utils/reactionRoleMappings.js';

const DASHBOARD_EPHEMERAL = MessageFlags.Ephemeral;
const SELECT_OPTION_LABEL_LIMIT = 100;
const SELECT_OPTION_DESCRIPTION_LIMIT = 100;

function truncateText(value, maxLength) {
    const text = String(value ?? '');
    return text.length > maxLength ? text.substring(0, maxLength) : text;
}

export default {
    data: new SlashCommandBuilder()
        .setName('reactroles')
        .setDescription('Manage reaction role assignments')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up a new reaction role panel')
                .addChannelOption(option => 
                    option.setName('channel')
                        .setDescription('The channel to send the reaction role message to')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('Title for the reaction role panel')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Description for the reaction role panel')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role1')
                        .setDescription('First role to add')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role2')
                        .setDescription('Second role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role3')
                        .setDescription('Third role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role4')
                        .setDescription('Fourth role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role5')
                        .setDescription('Fifth role to add')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reaction-setup')
                .setDescription('Create a native reaction-role panel with an optional image')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to send the reaction-role message to')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('Title for the reaction-role message')
                        .setMaxLength(256)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Instructions shown above the reaction roles')
                        .setMaxLength(2048)
                        .setRequired(true)
                )
                .addAttachmentOption(option =>
                    option.setName('image')
                        .setDescription('Optional image for this reaction-role message')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Manage and configure your reaction role panels')
                .addStringOption(option =>
                    option
                        .setName('panel')
                        .setDescription('Select a reaction role panel to manage')
                        .setRequired(false)
                        .setAutocomplete(true)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'setup') {
            await handleSetup(interaction);
        } else if (subcommand === 'reaction-setup') {
            await handleReactionSetup(interaction);
        } else if (subcommand === 'dashboard') {
            const selectedPanelId = interaction.options.getString('panel');
            await handleDashboard(interaction, selectedPanelId);
        }
    },

    async autocomplete(interaction) {
        if (interaction.commandName !== 'reactroles') return;
        if (interaction.options.getSubcommand() !== 'dashboard') return;

        // Autocomplete must respond within 3s. Build choices from stored panel data and
        // cached channels/messages only — no network fetches — to avoid DiscordAPIError 10062.
        try {
            const guildId = interaction.guild.id;
            const client = interaction.client;
            const guild = interaction.guild;

            let panels;
            try {
                panels = await getAllReactionRoleMessages(client, guildId);
            } catch {
                await interaction.respond([]).catch(() => {});
                return;
            }

            if (!panels?.length) {
                await interaction.respond([]).catch(() => {});
                return;
            }

            const choices = [];
            for (const panel of panels) {
                if (!panel.messageId || !panel.channelId) continue;

                const channel = guild.channels.cache.get(panel.channelId);
                if (!channel) continue;

                const cachedTitle = channel.messages?.cache?.get(panel.messageId)?.embeds?.[0]?.title;
                const roleCount = Array.isArray(panel.roles) ? panel.roles.length : 0;
                const label = cachedTitle
                    ? `${cachedTitle} (#${channel.name})`
                    : `#${channel.name} · ${roleCount} role${roleCount === 1 ? '' : 's'}`;

                choices.push({ name: label.substring(0, 100), value: panel.messageId });
                if (choices.length >= 25) break;
            }

            await interaction.respond(choices).catch(() => {});
        } catch {
            await interaction.respond([]).catch(() => {});
        }
    }
};

async function handleSetup(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;
    
    logger.info(`Reaction role setup initiated by ${interaction.user.tag} in guild ${interaction.guild.name}`);
    
    const channel = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        throw createError(
            `Invalid channel type: ${channel.type}`,
            ErrorTypes.VALIDATION,
            'Please select a text or announcement channel.',
            { channelType: channel.type }
        );
    }

    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw createError(
            'Bot missing ManageRoles permission',
            ErrorTypes.PERMISSION,
            'I need the "Manage Roles" permission to set up reaction roles.',
            { permission: 'ManageRoles' }
        );
    }
    
    if (!channel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.SendMessages)) {
        throw createError(
            `Bot cannot send messages in ${channel.name}`,
            ErrorTypes.PERMISSION,
            `I don't have permission to send messages in ${channel}.`,
            { channelId: channel.id }
        );
    }

    const existingPanels = await getAllReactionRoleMessages(interaction.client, interaction.guildId);
    const existingDropdownPanels = existingPanels.filter(panel => panel.mode !== 'reaction');
    if (existingDropdownPanels.length >= 5) {
        throw createError(
            'Panel limit reached',
            ErrorTypes.VALIDATION,
            'Your guild has reached the maximum of 5 role dropdown panels. Delete an existing panel to create a new one.',
            { maxPanels: 5, currentPanels: existingDropdownPanels.length }
        );
    }

    const roles = [];
    const roleValidationErrors = [];
    const seenRoleIds = new Set();
    
    for (let i = 1; i <= 5; i++) {
        const role = interaction.options.getRole(`role${i}`);
        if (role) {
            if (seenRoleIds.has(role.id)) {
                roleValidationErrors.push(`**${role.name}** - This role was selected more than once`);
                continue;
            }

            if (role.position >= interaction.guild.members.me.roles.highest.position) {
                roleValidationErrors.push(`**${role.name}** - My bot's role is positioned lower than this role in your server's role hierarchy and cannot assign it`);
                continue;
            }
            
            if (hasDangerousPermissions(role)) {
                roleValidationErrors.push(`**${role.name}** - This role has dangerous permissions (Administrator, Manage Server, etc.)`);
                continue;
            }
            
            if (role.managed) {
                roleValidationErrors.push(`**${role.name}** - This is a managed role (integration/bot role)`);
                continue;
            }
            
            if (role.id === interaction.guild.id) {
                roleValidationErrors.push(`**${role.name}** - Cannot use the @everyone role`);
                continue;
            }
            
            seenRoleIds.add(role.id);
            roles.push(role);
        }
    }
    
    if (roleValidationErrors.length > 0) {
        const errorMsg = `The following roles cannot be added:\n${roleValidationErrors.join('\n')}`;
        
        if (roles.length === 0) {
            throw createError(
                'No valid roles provided',
                ErrorTypes.VALIDATION,
                errorMsg,
                { errors: roleValidationErrors }
            );
        }
        
        await interaction.followUp({
            embeds: [warningEmbed('Role Validation Warning', errorMsg)],
            flags: MessageFlags.Ephemeral
        });
    }

    if (roles.length < 1) {
        throw createError(
            'No roles provided',
            ErrorTypes.VALIDATION,
            'You must provide at least one valid role.',
            {}
        );
    }

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('reaction_roles')
            .setPlaceholder('Select your roles')
            .setMinValues(0)
            .setMaxValues(roles.length)
            .addOptions(
                roles.map(role => ({
                    label: truncateText(role.name, SELECT_OPTION_LABEL_LIMIT),
                    description: truncateText(`Add/remove the ${role.name} role`, SELECT_OPTION_DESCRIPTION_LIMIT),
                    value: role.id,
                    emoji: '🎭'
                }))
            )
    );

    const panelEmbed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(getColor('info'))
        .addFields({
            name: 'Available Roles',
            value: roles.map(role => `• ${role}`).join('\n')
        })
        .setFooter({ text: 'Select roles from the dropdown menu below' });

    const message = await channel.send({
        embeds: [panelEmbed],
        components: [row]
    });

    const roleIds = roles.map(role => role.id);
    try {
        await createReactionRoleMessage(
            interaction.client,
            interaction.guildId,
            channel.id,
            message.id,
            roleIds
        );
    } catch (saveError) {
        // The panel is already posted but its data failed to persist, so the dropdown
        // would not work. Remove the orphaned message before surfacing the error.
        await message.delete().catch(() => {});
        throw saveError;
    }

    logger.info(`Reaction role message created: ${message.id} with ${roles.length} roles by ${interaction.user.tag}`);

    try {
        await logEvent({
            client: interaction.client,
            guildId: interaction.guildId,
            eventType: EVENT_TYPES.REACTION_ROLE_CREATE,
            data: {
                description: `Reaction role panel created by ${interaction.user.tag}`,
                userId: interaction.user.id,
                channelId: channel.id,
                fields: [
                    {
                        name: 'Title',
                        value: title,
                        inline: false
                    },
                    {
                        name: 'Channel',
                        value: channel.toString(),
                        inline: true
                    },
                    {
                        name: 'Roles',
                        value: `${roles.length} roles`,
                        inline: true
                    },
                    {
                        name: 'Role List',
                        value: roles.map(r => r.toString()).join(','),
                        inline: false
                    },
                    {
                        name: 'Message Link',
                        value: message.url,
                        inline: false
                    }
                ]
            }
        });
    } catch (logError) {
        logger.warn('Failed to log reaction role creation:', logError);
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Success', `✅ Reaction role panel created in ${channel}!\n\n${message.url}`)]
    });
}

async function handleReactionSetup(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;

    const guild = interaction.guild;
    const channel = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title').trim();
    const description = interaction.options.getString('description').trim();
    const image = interaction.options.getAttachment('image');
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);

    if (!title || !description) {
        throw createError(
            'Empty reaction-role panel text',
            ErrorTypes.VALIDATION,
            'The panel title and description cannot be empty.',
        );
    }

    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw createError(
            'Bot missing ManageRoles permission',
            ErrorTypes.PERMISSION,
            'I need the Manage Roles permission to create reaction roles.',
        );
    }

    const channelPermissions = channel.permissionsFor(botMember);
    const requiredPermissions = [
        [PermissionFlagsBits.SendMessages, 'Send Messages'],
        [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
        [PermissionFlagsBits.AddReactions, 'Add Reactions'],
        [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
    ];
    const missingPermissions = requiredPermissions
        .filter(([permission]) => !channelPermissions?.has(permission))
        .map(([, name]) => name);
    if (missingPermissions.length > 0) {
        throw createError(
            'Bot missing reaction-role channel permissions',
            ErrorTypes.PERMISSION,
            `I need these permissions in ${channel}: ${missingPermissions.join(', ')}.`,
            { channelId: channel.id, missingPermissions },
        );
    }

    if (
        image
        && !image.contentType?.startsWith('image/')
        && !/\.(png|jpe?g|gif|webp|avif)$/i.test(image.name)
    ) {
        throw createError(
            'Invalid reaction-role image',
            ErrorTypes.VALIDATION,
            'The optional attachment must be an image.',
            { attachmentName: image.name, contentType: image.contentType },
        );
    }

    const existingPanels = await getAllReactionRoleMessages(interaction.client, interaction.guildId);
    const existingReactionPanels = existingPanels.filter(panel => panel.mode === 'reaction');
    if (existingReactionPanels.length >= 5) {
        throw createError(
            'Reaction-role panel limit reached',
            ErrorTypes.VALIDATION,
            'This server can have up to 5 native reaction-role messages. Discord allows up to 20 reactions per message, for up to 100 roles across 5 messages.',
            { maxPanels: 5, currentPanels: existingReactionPanels.length },
        );
    }

    const panelData = {
        mode: 'reaction',
        title,
        description,
        imageUrl: image?.url ?? null,
        imageName: image?.name ?? null,
        reactionRoles: [],
        roles: [],
    };
    const message = await channel.send({
        embeds: [buildReactionPanelEmbed(panelData)],
        files: image ? [{ attachment: image.url, name: image.name }] : [],
    });

    try {
        await createReactionRolePanel(
            interaction.client,
            interaction.guildId,
            channel.id,
            message.id,
            panelData,
        );
    } catch (error) {
        await message.delete().catch(() => {});
        throw error;
    }

    logger.info(`Reaction-role panel created: ${message.id} by ${interaction.user.tag}`);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [
            successEmbed(
                'Reaction Panel Created',
                `Created the panel in ${channel}: ${message.url}\n\nUse \`/reactroles dashboard\` to add up to ${MAX_REACTION_ROLES_PER_MESSAGE} emoji/role pairs.`,
            ),
        ],
    });
}

async function fetchPanelDiscordMessage(guild, panelData) {
    try {
        const channel = guild.channels.cache.get(panelData.channelId);
        if (!channel) return null;
        return await channel.messages.fetch(panelData.messageId).catch(() => null);
    } catch {
        return null;
    }
}

async function rebuildLivePanelMessage(guild, panelData) {
    try {
        const channel = guild.channels.cache.get(panelData.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(panelData.messageId).catch(() => null);
        if (!msg || !msg.embeds[0]) return;

        if (panelData.mode === 'reaction') {
            await msg.edit({
                embeds: [buildReactionPanelEmbed(panelData)],
                components: [],
                attachments: msg.attachments.map(({ id }) => ({ id })),
            });
            return;
        }

        const roleObjects = panelData.roles
            .map(id => guild.roles.cache.get(id))
            .filter(Boolean);

        if (roleObjects.length === 0) return;

        const currentEmbed = msg.embeds[0];
        const updatedEmbed = EmbedBuilder.from(currentEmbed);
        const fields = currentEmbed.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline }));
        const roleFieldIdx = fields.findIndex(f => f.name === 'Available Roles');
        const newRoleValue = roleObjects.map(r => `• ${r}`).join('\n');
        if (roleFieldIdx !== -1) {
            fields[roleFieldIdx] = { name: 'Available Roles', value: newRoleValue, inline: false };
        } else {
            fields.push({ name: 'Available Roles', value: newRoleValue, inline: false });
        }
        updatedEmbed.setFields(fields);

        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('reaction_roles')
                .setPlaceholder('Select your roles')
                .setMinValues(0)
                .setMaxValues(roleObjects.length)
                .addOptions(
                    roleObjects.map(r => ({
                        label: r.name.substring(0, 100),
                        description: `Add/remove the ${r.name} role`.substring(0, 100),
                        value: r.id,
                        emoji: '🎭',
                    })),
                ),
        );

        await msg.edit({ embeds: [updatedEmbed], components: [selectRow] });
    } catch (error) {
        logger.warn('Could not rebuild live reaction role panel:', error.message);
    }
}

function buildReactionPanelEmbed(panelData) {
    const mappings = Array.isArray(panelData.reactionRoles) ? panelData.reactionRoles : [];
    const roleLines = mappings.map(({ emojiDisplay, roleId }) => `${emojiDisplay} — <@&${roleId}>`);
    const description = [
        panelData.description,
        roleLines.length > 0
            ? roleLines.join('\n')
            : 'No roles are configured yet. An administrator can add them from `/reactroles dashboard`.',
    ].join('\n\n');

    const embed = new EmbedBuilder()
        .setTitle(panelData.title || 'Reaction Roles')
        .setDescription(description)
        .setColor(getColor('info'))
        .setFooter({ text: 'React to get the role. Remove your reaction to remove the role. | Reaction Role Panel' });

    if (panelData.imageName) {
        embed.setImage(`attachment://${panelData.imageName}`);
    } else if (panelData.imageUrl) {
        embed.setImage(panelData.imageUrl);
    }
    return embed;
}

async function showPanelDashboard(interaction, panelData, discordMsg, guildId, guild, client, panelStatus = null) {
    if (!panelStatus && client) {
        panelStatus = await getReactionRolePanelStatus(client, guild, panelData);
        if (panelStatus.recoveredId) {
            await migrateReactionRoleMessageId(client, guildId, panelData, panelStatus.recoveredId);
            discordMsg = panelStatus.message || discordMsg;
        }
    }

    const payload = buildReactionRoleDashboardPayload(panelData, discordMsg, guildId, guild, panelStatus);
    await InteractionHelper.safeEditReply(interaction, { ...payload, flags: DASHBOARD_EPHEMERAL });
}

function buildReactionRoleDashboardPayload(panelData, discordMsg, guildId, guild, panelStatus = null) {
    const channel = guild.channels.cache.get(panelData.channelId);
    const title = discordMsg?.embeds?.[0]?.title ?? 'Untitled Panel';
    const isReactionPanel = panelData.mode === 'reaction';
    const roleCount = isReactionPanel
        ? (panelData.reactionRoles?.length || 0)
        : panelData.roles.length;
    const roleLimit = isReactionPanel ? MAX_REACTION_ROLES_PER_MESSAGE : 25;
    const roleList = isReactionPanel
        ? (panelData.reactionRoles?.map(({ emojiDisplay, roleId }) => `${emojiDisplay} <@&${roleId}>`).join('\n') || '`None`')
        : (panelData.roles.length > 0 ? panelData.roles.map(id => `<@&${id}>`).join(',') : '`None`');
    const displayedRoleList = roleList.length > 1024
        ? `${roleList.slice(0, 1021)}...`
        : roleList;

    const showRepost = panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';

    const embed = new EmbedBuilder()
        .setTitle('Reaction Roles Dashboard')
        .setDescription(
            `**Title:** ${title}\n**Type:** ${isReactionPanel ? 'Native reactions' : 'Role dropdown'}\n\nSelect an option below to modify a setting.${discordMsg ? `\n[Click Here to View Panel](${discordMsg.url})` : ''}`,
        )
        .setColor(getColor('info'))
        .addFields(
            { name: 'Panel Status', value: formatPanelStatusField(panelStatus), inline: false },
            { name: 'Channel', value: channel ? `<#${channel.id}>` : '`Not found`', inline: true },
            { name: 'Roles', value: `\`${roleCount} / ${roleLimit}\``, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Role List', value: displayedRoleList, inline: false },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();

    const buttons = [];

    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`rr_repost_${guildId}`)
                .setLabel('Repost Panel')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📌'),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`rr_edit_text_${guildId}`)
            .setLabel('Edit Panel Text')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        new ButtonBuilder()
            .setCustomId(`rr_delete_${guildId}`)
            .setLabel('Delete Panel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
    );

    const optionsSelect = new StringSelectMenuBuilder()
        .setCustomId(`rr_opts_${guildId}`)
        .setPlaceholder('Select an action...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(isReactionPanel ? 'Add Reaction Role' : 'Add Role')
                .setDescription(isReactionPanel
                    ? `Add an emoji/role pair (up to ${MAX_REACTION_ROLES_PER_MESSAGE} total)`
                    : 'Add a role to this panel (up to 25 total)')
                .setValue('add_role')
                .setEmoji('➕'),
            ...(roleCount > 0
                ? [
                      new StringSelectMenuOptionBuilder()
                          .setLabel('Remove Role')
                          .setDescription('Remove a role from this panel')
                          .setValue('remove_role')
                          .setEmoji('➖'),
                  ]
                : []),
        );

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(buttons),
            new ActionRowBuilder().addComponents(optionsSelect),
        ],
    };
}

async function migrateReactionRoleMessageId(client, guildId, panelData, newMessageId) {
    if (!newMessageId || panelData.messageId === newMessageId) return;
    const oldKey = getReactionRoleKey(guildId, panelData.messageId);
    panelData.messageId = newMessageId;
    await client.db.set(getReactionRoleKey(guildId, newMessageId), panelData);
    await client.db.delete(oldKey).catch(() => {});
}

async function repostReactionRolePanel(guild, panelData, client, guildId, fallbackEmbed = null) {
    const channel = await guild.channels.fetch(panelData.channelId).catch(() => null);
    if (!channel) {
        throw createError(
            'Panel channel missing',
            ErrorTypes.CONFIGURATION,
            'The configured panel channel no longer exists.',
        );
    }

    if (panelData.mode === 'reaction') {
        const files = panelData.imageUrl && panelData.imageName
            ? [{ attachment: panelData.imageUrl, name: panelData.imageName }]
            : [];
        const sent = await channel.send({
            embeds: [buildReactionPanelEmbed(panelData)],
            files,
        });
        try {
            await addPanelReactions(sent, panelData.reactionRoles);
        } catch (error) {
            await sent.delete().catch(() => {});
            throw error;
        }
        await migrateReactionRoleMessageId(client, guildId, panelData, sent.id);
        return sent;
    }

    const roleObjects = panelData.roles.map(id => guild.roles.cache.get(id)).filter(Boolean);
    if (roleObjects.length === 0) {
        throw createError(
            'No valid roles',
            ErrorTypes.VALIDATION,
            'This panel has no valid roles left to repost.',
        );
    }

    const title = fallbackEmbed?.title || 'Reaction Roles';
    const description = fallbackEmbed?.description || 'Select your roles using the menu below.';

    const panelEmbed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(getColor('info'))
        .addFields({
            name: 'Available Roles',
            value: roleObjects.map(role => `• ${role}`).join('\n'),
        });

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('reaction_roles')
            .setPlaceholder('Select your roles')
            .setMinValues(0)
            .setMaxValues(roleObjects.length)
            .addOptions(
                roleObjects.map(role => ({
                    label: role.name.substring(0, 100),
                    description: `Add/remove the ${role.name} role`.substring(0, 100),
                    value: role.id,
                    emoji: '🎭',
                })),
            ),
    );

    const sent = await channel.send({ embeds: [panelEmbed], components: [row] });
    await migrateReactionRoleMessageId(client, guildId, panelData, sent.id);
    return sent;
}

async function handleDashboard(interaction, selectedPanelId) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: DASHBOARD_EPHEMERAL });
    if (!deferSuccess) return;

    const client = interaction.client;
    const guildId = interaction.guild.id;
    const guild = interaction.guild;

    const panels = await getAllReactionRoleMessages(client, guildId);
    if (!panels?.length) {
        throw createError(
            'No panels',
            ErrorTypes.CONFIGURATION,
            'No reaction role panels found. Use `/reactroles setup` first.',
        );
    }

    let panelData = selectedPanelId ? panels.find(p => p.messageId === selectedPanelId) : null;
    if (!panelData) {
        if (panels.length === 1) {
            panelData = panels[0];
        } else {
            throw createError(
                'Panel required',
                ErrorTypes.VALIDATION,
                'Multiple panels exist. Choose one using the **panel** option.',
            );
        }
    }

    let panelStatus = await getReactionRolePanelStatus(client, guild, panelData);
    if (panelStatus.recoveredId) {
        await migrateReactionRoleMessageId(client, guildId, panelData, panelStatus.recoveredId);
        panelStatus = await getReactionRolePanelStatus(client, guild, panelData);
    }

    const discordMsg = panelStatus.message || (await fetchPanelDiscordMessage(guild, panelData));
    const payload = buildReactionRoleDashboardPayload(panelData, discordMsg, guildId, guild, panelStatus);

    await startDashboardSession({
        interaction,
        ...payload,
        flags: DASHBOARD_EPHEMERAL,
        selectMenuId: `rr_opts_${guildId}`,
        buttonMatcher: (customId) =>
            customId === `rr_edit_text_${guildId}` ||
            customId === `rr_delete_${guildId}` ||
            customId === `rr_repost_${guildId}`,
        onSelect: async (selectInteraction) => {
            const selectedOption = selectInteraction.values[0];
            if (selectedOption === 'add_role') {
                await handleAddRole(selectInteraction, interaction, panelData, guildId, guild, client);
            } else if (selectedOption === 'remove_role') {
                await handleRemoveRole(selectInteraction, interaction, panelData, panels, guildId, guild, client);
            }
        },
        onButton: async (btnInteraction) => {
            if (btnInteraction.customId === `rr_repost_${guildId}`) {
                await btnInteraction.deferUpdate();
                const fallbackEmbed = discordMsg?.embeds?.[0];
                const newMsg = await repostReactionRolePanel(
                    guild,
                    panelData,
                    client,
                    guildId,
                    fallbackEmbed,
                );
                await btnInteraction.followUp({
                    embeds: [successEmbed('Panel Reposted', `Reaction role panel restored in ${newMsg.channel}.`)],
                    flags: MessageFlags.Ephemeral,
                });
                await showPanelDashboard(
                    interaction,
                    panelData,
                    newMsg,
                    guildId,
                    guild,
                    client,
                    { exists: true, message: newMsg },
                );
                return;
            }

            if (btnInteraction.customId === `rr_edit_text_${guildId}`) {
                await handleEditText(btnInteraction, interaction, panelData, guildId, guild, client);
                return;
            }

            if (btnInteraction.customId === `rr_delete_${guildId}`) {
                await handleDeletePanel(btnInteraction, interaction, panelData, panels, guildId, guild, client);
            }
        },
    });
}

async function handleEditText(buttonInteraction, rootInteraction, panelData, guildId, guild, client) {
    const channel = guild.channels.cache.get(panelData.channelId);
    const discordMsg = channel
        ? await channel.messages.fetch(panelData.messageId).catch(() => null)
        : null;

    const currentTitle = panelData.mode === 'reaction'
        ? panelData.title
        : (discordMsg?.embeds?.[0]?.title ?? '');
    const currentDesc = panelData.mode === 'reaction'
        ? panelData.description
        : (discordMsg?.embeds?.[0]?.description ?? '');

    const modal = new ModalBuilder()
        .setCustomId('rr_edit_text')
        .setTitle('Edit Panel Text')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_title')
                    .setLabel('Title')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentTitle)
                    .setMaxLength(256)
                    .setMinLength(1)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_description')
                    .setLabel('Description')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(currentDesc)
                    .setMaxLength(2048)
                    .setMinLength(1)
                    .setRequired(true),
            ),
        );

    try {
        await buttonInteraction.showModal(modal);
    } catch (error) {
        logger.error('Error showing edit text modal:', error);
        await replyUserError(buttonInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: 'Failed to show the edit panel text modal. Please try again.',
        }).catch(() => {});
        return;
    }

    const submitted = await buttonInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'rr_edit_text' && i.user.id === buttonInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newTitle = submitted.fields.getTextInputValue('panel_title').trim();
    const newDescription = submitted.fields.getTextInputValue('panel_description').trim();

    if (panelData.mode === 'reaction') {
        panelData.title = newTitle;
        panelData.description = newDescription;
        await client.db.set(getReactionRoleKey(guildId, panelData.messageId), panelData);
        if (discordMsg) {
            await discordMsg.edit({
                embeds: [buildReactionPanelEmbed(panelData)],
                components: [],
                attachments: discordMsg.attachments.map(({ id }) => ({ id })),
            });
        }
    } else if (discordMsg) {
        const roleObjects = panelData.roles
            .map(id => guild.roles.cache.get(id))
            .filter(Boolean);
        const updatedEmbed = EmbedBuilder.from(discordMsg.embeds[0])
            .setTitle(newTitle)
            .setDescription(newDescription);
        if (roleObjects.length > 0) {
            const fields = discordMsg.embeds[0].fields?.map(f => ({ name: f.name, value: f.value, inline: f.inline })) || [];
            const roleFieldIdx = fields.findIndex(f => f.name === 'Available Roles');
            const newRoleValue = roleObjects.map(r => `• ${r}`).join('\n');
            if (roleFieldIdx !== -1) {
                fields[roleFieldIdx] = { name: 'Available Roles', value: newRoleValue, inline: false };
            } else {
                fields.push({ name: 'Available Roles', value: newRoleValue, inline: false });
            }
            updatedEmbed.setFields(fields);
        }
        await discordMsg.edit({ embeds: [updatedEmbed] }).catch(() => {});
    }

    await submitted.reply({
        embeds: [successEmbed('Panel Updated', 'The title and description have been updated.')],
        flags: MessageFlags.Ephemeral,
    });

    const refreshedMsg = channel
        ? await channel.messages.fetch(panelData.messageId).catch(() => null)
        : null;
    await showPanelDashboard(rootInteraction, panelData, refreshedMsg, guildId, guild, client);
}

async function handleAddRole(selectInteraction, rootInteraction, panelData, guildId, guild, client) {
    await selectInteraction.deferUpdate();

    const isReactionPanel = panelData.mode === 'reaction';
    const roleLimit = isReactionPanel ? MAX_REACTION_ROLES_PER_MESSAGE : 25;
    if (panelData.roles.length >= roleLimit) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: `This panel already has the maximum of ${roleLimit} roles.`,
        });
        return;
    }

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('rr_add_role_pick')
        .setPlaceholder('Select a role to add...')
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(isReactionPanel ? 'Add Reaction Role' : 'Add Role')
                .setDescription(
                    `**Current roles:** ${panelData.roles.length}/${roleLimit}\n\nSelect a role to add to this panel.`,
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(roleSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'rr_add_role_pick',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        const role = roleInteraction.roles.first();
        let validationMessage = null;

        if (!role) {
            validationMessage = 'Select a role to continue.';
        } else if (panelData.roles.includes(role.id)) {
            validationMessage = `${role} is already in this panel.`;
        } else if (role.id === guild.id) {
            validationMessage = 'You cannot use @everyone.';
        } else if (role.managed) {
            validationMessage = 'Managed/bot roles cannot be used.';
        } else if (hasDangerousPermissions(role)) {
            validationMessage = 'That role has sensitive permissions (Administrator, Manage Server, etc.) and cannot be used.';
        } else if (role.position >= guild.members.me.roles.highest.position) {
            validationMessage = "That role is above my highest role in the hierarchy. Move my role above it first.";
        }

        if (validationMessage) {
            await roleInteraction.deferUpdate();
            await replyUserError(roleInteraction, {
                type: ErrorTypes.VALIDATION,
                message: validationMessage,
            });
            return;
        }

        if (isReactionPanel) {
            try {
                await handleAddReactionRole(
                    roleInteraction,
                    role,
                    rootInteraction,
                    panelData,
                    guildId,
                    guild,
                    client,
                );
            } catch (error) {
                await handleInteractionError(roleInteraction, error, {
                    type: 'role_select',
                    customId: 'rr_add_role_pick',
                });
            }
            return;
        }

        await roleInteraction.deferUpdate();
        panelData.roles.push(role.id);
        const key = getReactionRoleKey(guildId, panelData.messageId);
        await client.db.set(key, panelData);

        await rebuildLivePanelMessage(guild, panelData);

        await roleInteraction.followUp({
            embeds: [successEmbed('Role Added', `${role} has been added to the panel.`)],
            flags: MessageFlags.Ephemeral,
        });

        const channel = guild.channels.cache.get(panelData.channelId);
        const discordMsg = channel
            ? await channel.messages.fetch(panelData.messageId).catch(() => null)
            : null;
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No role selected. Nothing was changed.',
            }).catch(() => {});
        }
    });
}

async function handleAddReactionRole(roleInteraction, role, rootInteraction, panelData, guildId, guild, client) {
    const modalCustomId = `rr_addemoji_${roleInteraction.id}`;
    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle('Add Reaction Role')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reaction_emoji')
                    .setLabel('Emoji for this role')
                    .setPlaceholder('Paste a server emoji or one Unicode emoji')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(100)
                    .setRequired(true),
            ),
        );

    await roleInteraction.showModal(modal);
    const submitted = await roleInteraction.awaitModalSubmit({
        filter: (interaction) =>
            interaction.customId === modalCustomId && interaction.user.id === roleInteraction.user.id,
        time: 120_000,
    }).catch(() => null);
    if (!submitted) return;

    const deferred = await InteractionHelper.safeDefer(submitted, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    let addedReaction = null;
    let mappingSaved = false;
    try {
        const emoji = parseReactionRoleEmoji(guild, submitted.fields.getTextInputValue('reaction_emoji'));
        if (!emoji) {
            throw createError(
                'Invalid reaction emoji',
                ErrorTypes.VALIDATION,
                'Use an available custom emoji from this server, such as `<:name:id>`, or paste exactly one Unicode emoji.',
                { guildId: guild.id },
            );
        }
        const message = await fetchPanelDiscordMessage(guild, panelData);
        if (!message) {
            throw createError(
                'Reaction-role panel message is missing',
                ErrorTypes.CONFIGURATION,
                'The reaction-role message could not be found. Repost it from the dashboard and try again.',
                { messageId: panelData.messageId },
            );
        }

        const updatedPanel = await addReactionRoleMapping(client, guildId, panelData.messageId, {
            emojiKey: emoji.key,
            emojiDisplay: emoji.display,
            roleId: role.id,
        });
        mappingSaved = true;
        try {
            addedReaction = await message.react(emoji.reactValue);
        } catch (error) {
            await removeReactionRoleMapping(client, guildId, panelData.messageId, role.id)
                .then(() => { mappingSaved = false; })
                .catch((cleanupError) => logger.error('Failed to roll back reaction-role mapping:', cleanupError));
            throw error;
        }

        panelData.roles = updatedPanel.roles;
        panelData.reactionRoles = updatedPanel.reactionRoles;

        await rebuildLivePanelMessage(guild, panelData);
        await InteractionHelper.safeEditReply(submitted, {
            embeds: [successEmbed('Reaction Role Added', `${emoji.display} now grants ${role}. Remove the reaction to remove the role.`)],
        });

        const discordMsg = await fetchPanelDiscordMessage(guild, panelData);
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
    } catch (error) {
        if (addedReaction && !mappingSaved) {
            await addedReaction.users.remove(client.user.id).catch((cleanupError) => {
                logger.warn('Failed to remove reaction after reaction-role setup failed:', cleanupError);
            });
        }
        await handleInteractionError(submitted, error, {
            type: 'modal',
            customId: modalCustomId,
        });
    }
}

async function handleRemoveRole(selectInteraction, rootInteraction, panelData, panels, guildId, guild, client) {
    await selectInteraction.deferUpdate();

    const roleOptions = panelData.roles
        .map(id => {
            const role = guild.roles.cache.get(id);
            return role ? { label: role.name.substring(0, 100), value: id } : null;
        })
        .filter(Boolean);

    if (roleOptions.length === 0) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.USER_INPUT,
            message: 'The roles on this panel no longer exist in the server.',
        });
        return;
    }

    const removeSelect = new StringSelectMenuBuilder()
        .setCustomId('rr_remove_role_pick')
        .setPlaceholder('Select a role to remove...')
        .setMaxValues(1)
        .addOptions(
            roleOptions.map(r =>
                new StringSelectMenuOptionBuilder().setLabel(r.label).setValue(r.value).setEmoji('🎭'),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Remove Role')
                .setDescription('Select the role you want to remove from this panel.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(removeSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const removeCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'rr_remove_role_pick',
        time: 60_000,
        max: 1,
    });

    removeCollector.on('collect', async removeInteraction => {
        await removeInteraction.deferUpdate();
        const roleId = removeInteraction.values[0];
        const role = guild.roles.cache.get(roleId);

        if (panelData.mode === 'reaction') {
            const mapping = await removeReactionRoleMapping(client, guildId, panelData.messageId, roleId);
            if (!mapping) {
                await replyUserError(removeInteraction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'That reaction-role mapping no longer exists.',
                });
                return;
            }

            panelData.roles = panelData.roles.filter(id => id !== roleId);
            panelData.reactionRoles = panelData.reactionRoles.filter(entry => entry.roleId !== roleId);

            const channel = guild.channels.cache.get(panelData.channelId);
            const message = channel
                ? await channel.messages.fetch(panelData.messageId).catch(() => null)
                : null;
            const reaction = message?.reactions.cache.find(
                item => getReactionRoleEmojiKey(item.emoji) === mapping.emojiKey,
            );
            if (reaction) {
                await reaction.users.remove(client.user.id).catch(error => {
                    logger.warn(`Failed to remove retired reaction ${mapping.emojiKey} from panel ${panelData.messageId}:`, error);
                });
            }

            await rebuildLivePanelMessage(guild, panelData);
            await removeInteraction.followUp({
                embeds: [
                    successEmbed(
                        'Reaction Role Removed',
                        `${mapping.emojiDisplay} no longer grants ${role ? role.toString() : `<@&${roleId}>`}.`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            const refreshedMessage = await fetchPanelDiscordMessage(guild, panelData);
            await showPanelDashboard(rootInteraction, panelData, refreshedMessage, guildId, guild, client);
            return;
        }

        panelData.roles = panelData.roles.filter(id => id !== roleId);

        if (panelData.roles.length === 0) {
            const channel = guild.channels.cache.get(panelData.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(panelData.messageId).catch(() => null);
                if (msg) await msg.delete().catch(() => {});
            }
            await deleteReactionRoleMessage(client, guildId, panelData.messageId);

            await removeInteraction.followUp({
                embeds: [
                    successEmbed(
                        '✅ Role Removed',
                        'That was the last role on the panel. The panel has been deleted.',
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            const panelIndex = panels.findIndex(p => p.messageId === panelData.messageId);
            if (panelIndex > -1) {
                panels.splice(panelIndex, 1);
            }

            if (panels.length === 0) {
                await InteractionHelper.safeEditReply(rootInteraction, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Reaction Roles Dashboard')
                            .setDescription('No panels remain. Use `/reactroles setup` to create one.')
                            .setColor(getColor('info')),
                    ],
                    components: [],
                    flags: DASHBOARD_EPHEMERAL,
                });
            } else {
                
                await InteractionHelper.safeEditReply(rootInteraction, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Reaction Roles Dashboard')
                            .setDescription('Panel deleted. Run `/reactroles dashboard` to manage another panel.')
                            .setColor(getColor('success')),
                    ],
                    components: [],
                    flags: DASHBOARD_EPHEMERAL,
                });
            }
        } else {
            const key = getReactionRoleKey(guildId, panelData.messageId);
            await client.db.set(key, panelData);
            await rebuildLivePanelMessage(guild, panelData);

            await removeInteraction.followUp({
                embeds: [
                    successEmbed(
                        '✅ Role Removed',
                        `${role ? role.toString() :`<@&${roleId}>`} has been removed from the panel.`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            const channel = guild.channels.cache.get(panelData.channelId);
            const discordMsg = channel
                ? await channel.messages.fetch(panelData.messageId).catch(() => null)
                : null;
            await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
        }
    });

    removeCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No role selected. Nothing was changed.',
            }).catch(() => {});
        }
    });
}

async function handleDeletePanel(btnInteraction, rootInteraction, panelData, panels, guildId, guild, client) {
    const channel = guild.channels.cache.get(panelData.channelId);
    const discordMsg = channel
        ? await channel.messages.fetch(panelData.messageId).catch(() => null)
        : null;
    const title = discordMsg?.embeds?.[0]?.title ?? 'this panel';

    const deleteModal = new ModalBuilder()
        .setCustomId('rr_delete_confirm_modal')
        .setTitle('Delete Reaction Role Panel');

    const deleteWarningText = new TextDisplayBuilder()
        .setContent(`⚠️ You are about to permanently delete the panel **${title}**. This will remove the Discord message and all associated reaction role assignments.`);

    const deleteCheckbox = new CheckboxBuilder()
        .setCustomId('delete_confirmation')
        .setDefault(false);

    const deleteCheckboxLabel = new LabelBuilder()
        .setLabel('I confirm — this cannot be undone')
        .setCheckboxComponent(deleteCheckbox);

    deleteModal
        .addTextDisplayComponents(deleteWarningText)
        .addLabelComponents(deleteCheckboxLabel);

    await btnInteraction.showModal(deleteModal);

    const submitted = await btnInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'rr_delete_confirm_modal' && i.user.id === btnInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) {
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
        return;
    }

    const confirmed = submitted.fields.getCheckbox('delete_confirmation');

    if (!confirmed) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'You must tick the confirmation checkbox to delete the panel.' });
        await showPanelDashboard(rootInteraction, panelData, discordMsg, guildId, guild, client);
        return;
    }

    await submitted.deferUpdate();

    if (discordMsg) {
        await discordMsg.delete().catch(() => {});
    }
    await deleteReactionRoleMessage(client, guildId, panelData.messageId);

    try {
        await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.REACTION_ROLE_DELETE,
            data: {
                description: `Reaction role panel deleted by ${submitted.user.tag}`,
                userId: submitted.user.id,
                channelId: panelData.channelId,
                fields: [
                    { name: 'Panel', value: title, inline: true },
                    { name: 'Channel', value: channel ? channel.toString() : 'Unknown', inline: true },
                ],
            },
        });
    } catch (logErr) {
        logger.warn('Failed to log reaction role deletion:', logErr);
    }

    await submitted.followUp({
        embeds: [successEmbed('Panel Deleted', `**${title}** has been deleted.`)],
        flags: MessageFlags.Ephemeral,
    });

    const panelIndex = panels.findIndex(p => p.messageId === panelData.messageId);
    if (panelIndex > -1) {
        panels.splice(panelIndex, 1);
    }

    if (panels.length === 0) {
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('Reaction Roles Dashboard')
                    .setDescription('No panels remain. Use `/reactroles setup` to create one.')
                    .setColor(getColor('info')),
            ],
            components: [],
            flags: DASHBOARD_EPHEMERAL,
        });
    } else {
        await InteractionHelper.safeEditReply(rootInteraction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('Reaction Roles Dashboard')
                    .setDescription('Panel deleted. Run `/reactroles dashboard` to manage another panel.')
                    .setColor(getColor('success')),
            ],
            components: [],
            flags: DASHBOARD_EPHEMERAL,
        });
    }
}

async function addPanelReactions(message, reactionRoles = []) {
    for (const mapping of reactionRoles) {
        await message.react(mapping.emojiKey);
    }
}