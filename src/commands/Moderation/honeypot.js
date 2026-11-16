import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { getColor } from '../../config/bot.js';
import { MAX_HONEYPOT_TIMEOUT_MINUTES } from '../../config/guild/honeypotDefaults.js';
import { getGuildConfig, patchGuildConfig } from '../../services/config/guildConfig.js';
import { handleInteractionError, ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const ACTION_OPTIONS = [
    { name: 'Ban', value: 'ban' },
    { name: 'Kick', value: 'kick' },
    { name: 'Timeout (Mute)', value: 'timeout' },
];

const REQUIRED_PERMISSIONS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Moderate Members'],
};

function settingIds(guildId) {
    return {
        channel: `honeypot_channel_${guildId}`,
        action: `honeypot_action_${guildId}`,
        toggle: `honeypot_toggle_${guildId}`,
        toggleDm: `honeypot_toggle_dm_${guildId}`,
        editDm: `honeypot_edit_dm_${guildId}`,
        editTimeout: `honeypot_edit_timeout_${guildId}`,
        clearChannel: `honeypot_clear_channel_${guildId}`,
        logChannel: `honeypot_log_channel_${guildId}`,
        clearLogChannel: `honeypot_clear_log_channel_${guildId}`,
    };
}

function truncate(value, limit = 900) {
    return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function buildDashboardEmbed(guild, settings) {
    const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : null;
    const logChannel = settings.logChannelId ? guild.channels.cache.get(settings.logChannelId) : null;
    const action = ACTION_OPTIONS.find(option => option.value === settings.action)?.name || 'Ban';
    const dmPreview = settings.dmMessage ? truncate(settings.dmMessage) : '`(leer)`';

    return new EmbedBuilder()
        .setTitle('Honeypot Dashboard')
        .setDescription(
            'Lege einen verbotenen Kanal fest und wähle, wie der Bot auf Nachrichten dort reagiert. ' +
            'Serverbesitzer, Administratoren, Server-Manager und Bots werden ausgenommen. ' +
            'DM-Platzhalter: `{server}`, `{user}`, `{action}`.',
        )
        .setColor(getColor('info'))
        .addFields(
            { name: 'Status', value: settings.enabled ? '🟢 Aktiv' : '⚫ Aus', inline: true },
            { name: 'Honeypot-Kanal', value: channel ? `<#${channel.id}>` : '`Nicht gesetzt`', inline: true },
            { name: 'Protokoll-Kanal', value: logChannel ? `<#${logChannel.id}>` : '`Nicht gesetzt`', inline: true },
            { name: 'Aktion', value: action, inline: true },
            {
                name: 'Timeout-Dauer',
                value: settings.action === 'timeout' ? `${settings.timeoutMinutes} Minuten` : '`Nicht verwendet`',
                inline: true,
            },
            { name: 'Direktnachricht', value: settings.dmEnabled ? '🟢 Aktiv' : '⚫ Aus', inline: true },
            { name: 'DM-Text', value: dmPreview, inline: false },
        )
        .setFooter({ text: 'Nur Server-Manager können dieses Menü verwenden. Es schließt sich nach 10 Minuten.' })
        .setTimestamp();
}

function buildDashboardComponents(guildId, settings) {
    const ids = settingIds(guildId);
    const actionMenu = new StringSelectMenuBuilder()
        .setCustomId(ids.action)
        .setPlaceholder('Aktion auswählen...')
        .addOptions(
            ACTION_OPTIONS.map(option => ({
                label: option.name,
                value: option.value,
                default: settings.action === option.value,
            })),
        );

    const channelMenu = new ChannelSelectMenuBuilder()
        .setCustomId(ids.channel)
        .setPlaceholder('Honeypot-Kanal auswählen...')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const logChannelMenu = new ChannelSelectMenuBuilder()
        .setCustomId(ids.logChannel)
        .setPlaceholder('Protokoll-Kanal auswählen...')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(ids.toggle)
            .setLabel(settings.enabled ? 'Honeypot ausschalten' : 'Honeypot einschalten')
            .setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(ids.toggleDm)
            .setLabel(settings.dmEnabled ? 'DM ausschalten' : 'DM einschalten')
            .setStyle(settings.dmEnabled ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(ids.editDm)
            .setLabel('DM-Text bearbeiten')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(ids.editTimeout)
            .setLabel('Timeout-Dauer')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(settings.action !== 'timeout'),
        new ButtonBuilder()
            .setCustomId(ids.clearChannel)
            .setLabel('Kanal entfernen')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!settings.channelId),
    );

    return [
        new ActionRowBuilder().addComponents(actionMenu),
        new ActionRowBuilder().addComponents(channelMenu),
        new ActionRowBuilder().addComponents(logChannelMenu),
        buttons,
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(ids.clearLogChannel)
                .setLabel('Protokoll-Kanal entfernen')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!settings.logChannelId),
        ),
    ];
}

async function saveSettings(client, guildId, updates) {
    const config = await patchGuildConfig(client, guildId, { honeypot: updates });
    return config.honeypot;
}

async function validateCanEnable(guild, settings) {
    const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : null;
    const botMember = guild.members.me || await guild.members.fetchMe();

    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        throw new TitanBotError(
            'Honeypot channel missing',
            ErrorTypes.VALIDATION,
            'Wähle zuerst einen Text- oder Ankündigungskanal als Honeypot-Kanal.',
        );
    }

    if (!botMember?.permissions.has(REQUIRED_PERMISSIONS[settings.action][0])) {
        throw new TitanBotError(
            'Bot is missing the moderation permission',
            ErrorTypes.PERMISSION,
            `Dem Bot fehlt die Berechtigung „${REQUIRED_PERMISSIONS[settings.action][1]}“.`,
        );
    }

    if (!channel.permissionsFor(botMember)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageMessages,
    ])) {
        throw new TitanBotError(
            'Bot cannot delete honeypot messages',
            ErrorTypes.PERMISSION,
            'Der Bot benötigt im ausgewählten Honeypot-Kanal die Berechtigungen „Kanal ansehen“ und „Nachrichten verwalten“, damit Nachrichten gelöscht werden können.',
        );
    }
}

async function validateLogChannel(guild, channel) {
    const botMember = guild.members.me || await guild.members.fetchMe();
    const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
    ];
    if (!channel.permissionsFor(botMember)?.has(requiredPermissions)) {
        throw new TitanBotError(
            'Bot cannot write honeypot logs',
            ErrorTypes.PERMISSION,
            'Der Bot benötigt im Protokoll-Kanal die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“.',
        );
    }
}

async function renderDashboard(interaction, settings) {
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildDashboardEmbed(interaction.guild, settings)],
        components: buildDashboardComponents(interaction.guildId, settings),
        flags: EPHEMERAL,
    });
}

async function handleModal(buttonInteraction, rootInteraction, settings, client, guildId, field) {
    const isMessage = field === 'dmMessage';
    const modalId = `honeypot_modal_${field}_${buttonInteraction.id}`;
    const input = new TextInputBuilder()
        .setCustomId(field)
        .setLabel(isMessage ? 'Nachricht an sanktionierte Nutzer' : 'Timeout in Minuten')
        .setStyle(isMessage ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(isMessage ? false : true)
        .setMaxLength(isMessage ? 2000 : 5);

    if (isMessage && settings.dmMessage) {
        input.setValue(settings.dmMessage);
    } else if (!isMessage) {
        input
            .setMinLength(1)
            .setPlaceholder(`1 bis ${MAX_HONEYPOT_TIMEOUT_MINUTES} Minuten`)
            .setValue(String(settings.timeoutMinutes));
    }

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(isMessage ? 'Honeypot-DM bearbeiten' : 'Timeout-Dauer einstellen')
        .addComponents(new ActionRowBuilder().addComponents(input));

    await buttonInteraction.showModal(modal);
    const submitted = await buttonInteraction.awaitModalSubmit({
        filter: candidate =>
            candidate.customId === modalId && candidate.user.id === buttonInteraction.user.id,
        time: 120_000,
    }).catch(error => {
        logger.debug('Honeypot modal was not submitted:', error.message);
        return null;
    });
    if (!submitted) return;

    try {
        await submitted.deferReply({ flags: EPHEMERAL });
        const value = submitted.fields.getTextInputValue(field);
        let update;

        if (isMessage) {
            update = { dmMessage: value.trim().slice(0, 2000) };
        } else {
            const timeoutMinutes = Number(value);
            if (
                !Number.isInteger(timeoutMinutes)
                || timeoutMinutes < 1
                || timeoutMinutes > MAX_HONEYPOT_TIMEOUT_MINUTES
            ) {
                throw new TitanBotError(
                    'Invalid timeout duration',
                    ErrorTypes.VALIDATION,
                    `Gib eine ganze Zahl zwischen 1 und ${MAX_HONEYPOT_TIMEOUT_MINUTES} Minuten ein.`,
                );
            }
            update = { timeoutMinutes };
        }

        settings = await saveSettings(client, guildId, update);
        await submitted.editReply({ content: 'Honeypot-Einstellung gespeichert.' });
        await renderDashboard(rootInteraction, settings);
        return settings;
    } catch (error) {
        await handleInteractionError(submitted, error, {
            type: 'modal',
            command: 'honeypot',
        });
    }
}

async function handleDashboardComponent(component, rootInteraction, settings, client, guildId) {
    const ids = settingIds(guildId);

    if (component.customId === ids.editDm || component.customId === ids.editTimeout) {
        return handleModal(
            component,
            rootInteraction,
            settings,
            client,
            guildId,
            component.customId === ids.editDm ? 'dmMessage' : 'timeoutMinutes',
        );
    }

    await component.deferUpdate();

    if (component.customId === ids.channel) {
        const channel = component.channels.first();
        if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
            throw new TitanBotError(
                'Invalid honeypot channel',
                ErrorTypes.VALIDATION,
                'Wähle einen Text- oder Ankündigungskanal aus.',
            );
        }
        if (settings.enabled) {
            await validateCanEnable(component.guild, { ...settings, channelId: channel.id });
        }
        settings = await saveSettings(client, guildId, { channelId: channel.id });
    } else if (component.customId === ids.logChannel) {
        const channel = component.channels.first();
        if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
            throw new TitanBotError(
                'Invalid honeypot log channel',
                ErrorTypes.VALIDATION,
                'Wähle einen Text- oder Ankündigungskanal als Protokoll-Kanal aus.',
            );
        }
        await validateLogChannel(component.guild, channel);
        settings = await saveSettings(client, guildId, { logChannelId: channel.id });
    } else if (component.customId === ids.action) {
        const action = component.values[0];
        if (!ACTION_OPTIONS.some(option => option.value === action)) {
            throw new TitanBotError('Invalid honeypot action', ErrorTypes.VALIDATION, 'Diese Aktion ist nicht verfügbar.');
        }
        if (settings.enabled) {
            await validateCanEnable(component.guild, { ...settings, action });
        }
        settings = await saveSettings(client, guildId, { action });
    } else if (component.customId === ids.toggle) {
        const enabled = !settings.enabled;
        if (enabled) {
            await validateCanEnable(component.guild, settings);
        }
        settings = await saveSettings(client, guildId, { enabled });
    } else if (component.customId === ids.toggleDm) {
        settings = await saveSettings(client, guildId, { dmEnabled: !settings.dmEnabled });
    } else if (component.customId === ids.clearChannel) {
        settings = await saveSettings(client, guildId, { channelId: null, enabled: false });
    } else if (component.customId === ids.clearLogChannel) {
        settings = await saveSettings(client, guildId, { logChannelId: null });
    } else {
        return;
    }

    await renderDashboard(rootInteraction, settings);
    return settings;
}

export default {
    slashOnly: true,
    category: 'moderation',
    data: new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription('Configure the server honeypot')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the honeypot settings dashboard'),
        ),

    async execute(interaction, _config, client) {
        try {
            if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                throw new TitanBotError(
                    'Manage Server permission required',
                    ErrorTypes.PERMISSION,
                    'Du brauchst die Berechtigung „Server verwalten“, um das Honeypot-Menü zu nutzen.',
                );
            }

            const guildConfig = await getGuildConfig(client, interaction.guildId);
            let settings = guildConfig.honeypot;
            if (!await InteractionHelper.safeDefer(interaction, { flags: EPHEMERAL })) return;
            await renderDashboard(interaction, settings);

            const reply = await interaction.fetchReply();
            const collector = reply.createMessageComponentCollector({
                filter: component =>
                    component.user.id === interaction.user.id
                    && component.message.id === reply.id
                    && Object.values(settingIds(interaction.guildId)).includes(component.customId),
                time: 600_000,
            });

            collector.on('collect', async component => {
                try {
                    const nextSettings = await handleDashboardComponent(
                        component,
                        interaction,
                        settings,
                        client,
                        interaction.guildId,
                    );
                    if (nextSettings) settings = nextSettings;
                } catch (error) {
                    await handleInteractionError(component, error, {
                        type: 'honeypot_dashboard',
                        guildId: interaction.guildId,
                    });
                }
            });

            collector.on('end', async (_collected, reason) => {
                if (reason !== 'time') return;
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setTitle('Honeypot Dashboard geschlossen')
                        .setDescription('Öffne `/honeypot dashboard` erneut, um Einstellungen zu ändern.')
                        .setColor(getColor('info'))],
                    components: [],
                    flags: EPHEMERAL,
                }).catch(error => logger.debug('Could not close honeypot dashboard:', error.message));
            });
        } catch (error) {
            await handleInteractionError(interaction, error, {
                type: 'command',
                command: 'honeypot',
            });
        }
    },
};
