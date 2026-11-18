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
import { handleInteractionError, ErrorTypes, KbolsBotError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { createSearchButton, openDashboardSearch } from '../../utils/dashboardSearch.js';
import { getDashboardLocale, tr } from '../../utils/dashboardLocale.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const ACTION_OPTIONS = [
    { name: 'Ban', value: 'ban' },
    { name: 'Kick', value: 'kick' },
    { name: 'Timeout (Mute)', value: 'timeout' },
];

const REQUIRED_PERMISSIONS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members', 'Mitglieder bannen'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members', 'Mitglieder kicken'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Moderate Members', 'Mitglieder im Timeout'],
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
        search: `honeypot_search_${guildId}`,
    };
}

function truncate(value, limit = 900) {
    return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function buildDashboardEmbed(guild, settings, L = 'en') {
    const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : null;
    const logChannel = settings.logChannelId ? guild.channels.cache.get(settings.logChannelId) : null;
    const action = ACTION_OPTIONS.find(option => option.value === settings.action)?.name || 'Ban';
    const dmPreview = settings.dmMessage ? truncate(settings.dmMessage) : tr(L, '`(empty)`', '`(leer)`');
    const notSet = tr(L, '`Not set`', '`Nicht gesetzt`');
    const active = tr(L, '🟢 Active', '🟢 Aktiv');
    const off = tr(L, '⚫ Off', '⚫ Aus');

    return new EmbedBuilder()
        .setTitle('Honeypot Dashboard')
        .setDescription(tr(L,
            'Set a forbidden channel and choose how the bot reacts to messages there. ' +
            'Server owners, administrators, server managers and bots are exempt. ' +
            'DM placeholders: `{server}`, `{user}`, `{action}`.',
            'Lege einen verbotenen Kanal fest und wähle, wie der Bot auf Nachrichten dort reagiert. ' +
            'Serverbesitzer, Administratoren, Server-Manager und Bots werden ausgenommen. ' +
            'DM-Platzhalter: `{server}`, `{user}`, `{action}`.'))
        .setColor(getColor('info'))
        .addFields(
            { name: 'Status', value: settings.enabled ? active : off, inline: true },
            { name: tr(L, 'Honeypot channel', 'Honeypot-Kanal'), value: channel ? `<#${channel.id}>` : notSet, inline: true },
            { name: tr(L, 'Log channel', 'Protokoll-Kanal'), value: logChannel ? `<#${logChannel.id}>` : notSet, inline: true },
            { name: tr(L, 'Action', 'Aktion'), value: action, inline: true },
            {
                name: tr(L, 'Timeout duration', 'Timeout-Dauer'),
                value: settings.action === 'timeout'
                    ? tr(L, `${settings.timeoutMinutes} minutes`, `${settings.timeoutMinutes} Minuten`)
                    : tr(L, '`Not used`', '`Nicht verwendet`'),
                inline: true,
            },
            { name: tr(L, 'Direct message', 'Direktnachricht'), value: settings.dmEnabled ? active : off, inline: true },
            { name: tr(L, 'DM text', 'DM-Text'), value: dmPreview, inline: false },
        )
        .setFooter({ text: tr(L,
            'Only server managers can use this menu. It closes after 10 minutes.',
            'Nur Server-Manager können dieses Menü verwenden. Es schließt sich nach 10 Minuten.') })
        .setTimestamp();
}

function buildDashboardComponents(guildId, settings, L = 'en') {
    const ids = settingIds(guildId);
    const actionMenu = new StringSelectMenuBuilder()
        .setCustomId(ids.action)
        .setPlaceholder(tr(L, 'Choose action...', 'Aktion auswählen...'))
        .addOptions(
            ACTION_OPTIONS.map(option => ({
                label: option.name,
                value: option.value,
                default: settings.action === option.value,
            })),
        );

    const channelMenu = new ChannelSelectMenuBuilder()
        .setCustomId(ids.channel)
        .setPlaceholder(tr(L, 'Choose honeypot channel...', 'Honeypot-Kanal auswählen...'))
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const logChannelMenu = new ChannelSelectMenuBuilder()
        .setCustomId(ids.logChannel)
        .setPlaceholder(tr(L, 'Choose log channel...', 'Protokoll-Kanal auswählen...'))
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(ids.toggle)
            .setLabel(settings.enabled ? tr(L, 'Turn honeypot off', 'Honeypot ausschalten') : tr(L, 'Turn honeypot on', 'Honeypot einschalten'))
            .setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(ids.toggleDm)
            .setLabel(settings.dmEnabled ? tr(L, 'Turn DM off', 'DM ausschalten') : tr(L, 'Turn DM on', 'DM einschalten'))
            .setStyle(settings.dmEnabled ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(ids.editDm)
            .setLabel(tr(L, 'Edit DM text', 'DM-Text bearbeiten'))
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(ids.editTimeout)
            .setLabel(tr(L, 'Timeout duration', 'Timeout-Dauer'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(settings.action !== 'timeout'),
        new ButtonBuilder()
            .setCustomId(ids.clearChannel)
            .setLabel(tr(L, 'Remove channel', 'Kanal entfernen'))
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
                .setLabel(tr(L, 'Remove log channel', 'Protokoll-Kanal entfernen'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!settings.logChannelId),
            createSearchButton(ids.search, { locale: L }),
        ),
    ];
}

async function saveSettings(client, guildId, updates) {
    const config = await patchGuildConfig(client, guildId, { honeypot: updates });
    return config.honeypot;
}

async function validateCanEnable(guild, settings, L = 'en') {
    const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : null;
    const botMember = guild.members.me || await guild.members.fetchMe();

    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        throw new KbolsBotError(
            'Honeypot channel missing',
            ErrorTypes.VALIDATION,
            tr(L, 'First choose a text or announcement channel as the honeypot channel.', 'Wähle zuerst einen Text- oder Ankündigungskanal als Honeypot-Kanal.'),
        );
    }

    if (!botMember?.permissions.has(REQUIRED_PERMISSIONS[settings.action][0])) {
        throw new KbolsBotError(
            'Bot is missing the moderation permission',
            ErrorTypes.PERMISSION,
            tr(L,
                `The bot is missing the "${REQUIRED_PERMISSIONS[settings.action][1]}" permission.`,
                `Dem Bot fehlt die Berechtigung „${REQUIRED_PERMISSIONS[settings.action][2]}“.`),
        );
    }

    if (!channel.permissionsFor(botMember)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageMessages,
    ])) {
        throw new KbolsBotError(
            'Bot cannot delete honeypot messages',
            ErrorTypes.PERMISSION,
            tr(L,
                'The bot needs the "View Channel" and "Manage Messages" permissions in the honeypot channel so it can delete messages.',
                'Der Bot benötigt im ausgewählten Honeypot-Kanal die Berechtigungen „Kanal ansehen“ und „Nachrichten verwalten“, damit Nachrichten gelöscht werden können.'),
        );
    }
}

async function validateLogChannel(guild, channel, L = 'en') {
    const botMember = guild.members.me || await guild.members.fetchMe();
    const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
    ];
    if (!channel.permissionsFor(botMember)?.has(requiredPermissions)) {
        throw new KbolsBotError(
            'Bot cannot write honeypot logs',
            ErrorTypes.PERMISSION,
            tr(L,
                'The bot needs the "View Channel", "Send Messages" and "Embed Links" permissions in the log channel.',
                'Der Bot benötigt im Protokoll-Kanal die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“.'),
        );
    }
}

async function renderDashboard(interaction, settings) {
    const L = getDashboardLocale(interaction);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildDashboardEmbed(interaction.guild, settings, L)],
        components: buildDashboardComponents(interaction.guildId, settings, L),
        flags: EPHEMERAL,
    });
}

async function handleModal(buttonInteraction, rootInteraction, settings, client, guildId, field) {
    const L = getDashboardLocale(buttonInteraction);
    const isMessage = field === 'dmMessage';
    const modalId = `honeypot_modal_${field}_${buttonInteraction.id}`;
    const input = new TextInputBuilder()
        .setCustomId(field)
        .setLabel(isMessage ? tr(L, 'Message to punished users', 'Nachricht an sanktionierte Nutzer') : tr(L, 'Timeout in minutes', 'Timeout in Minuten'))
        .setStyle(isMessage ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(isMessage ? false : true)
        .setMaxLength(isMessage ? 2000 : 5);

    if (isMessage && settings.dmMessage) {
        input.setValue(settings.dmMessage);
    } else if (!isMessage) {
        input
            .setMinLength(1)
            .setPlaceholder(tr(L, `1 to ${MAX_HONEYPOT_TIMEOUT_MINUTES} minutes`, `1 bis ${MAX_HONEYPOT_TIMEOUT_MINUTES} Minuten`))
            .setValue(String(settings.timeoutMinutes));
    }

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(isMessage ? tr(L, 'Edit honeypot DM', 'Honeypot-DM bearbeiten') : tr(L, 'Set timeout duration', 'Timeout-Dauer einstellen'))
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
                throw new KbolsBotError(
                    'Invalid timeout duration',
                    ErrorTypes.VALIDATION,
                    tr(L,
                        `Enter a whole number between 1 and ${MAX_HONEYPOT_TIMEOUT_MINUTES} minutes.`,
                        `Gib eine ganze Zahl zwischen 1 und ${MAX_HONEYPOT_TIMEOUT_MINUTES} Minuten ein.`),
                );
            }
            update = { timeoutMinutes };
        }

        settings = await saveSettings(client, guildId, update);
        await submitted.editReply({ content: tr(L, 'Honeypot setting saved.', 'Honeypot-Einstellung gespeichert.') });
        await renderDashboard(rootInteraction, settings);
        return settings;
    } catch (error) {
        await handleInteractionError(submitted, error, {
            type: 'modal',
            command: 'honeypot',
        });
    }
}

function buildHoneypotSearchEntries(guild, settings, ids, L = 'en') {
    const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : null;
    const logChannel = settings.logChannelId ? guild.channels.cache.get(settings.logChannelId) : null;
    const action = ACTION_OPTIONS.find(option => option.value === settings.action)?.name || 'Ban';

    const activeText = tr(L, 'Active', 'Aktiv');
    const offText = tr(L, 'Off', 'Aus');
    const notSet = tr(L, 'Not set', 'Nicht gesetzt');

    const entries = [
        { title: settings.enabled ? tr(L, 'Turn honeypot off', 'Honeypot ausschalten') : tr(L, 'Turn honeypot on', 'Honeypot einschalten'), description: `Status: ${settings.enabled ? activeText : offText}`, location: 'Button', keywords: ['status', 'an', 'aus', 'aktivieren', 'enable', 'disable', 'on', 'off'], action: ids.toggle },
        { title: tr(L, 'Honeypot channel', 'Honeypot-Kanal'), description: channel ? `#${channel.name}` : notSet, location: tr(L, 'Menu "Choose honeypot channel"', 'Menü „Honeypot-Kanal auswählen“'), keywords: ['kanal', 'channel', 'verboten', 'falle', 'trap', 'forbidden'] },
        { title: tr(L, 'Log channel', 'Protokoll-Kanal'), description: logChannel ? `#${logChannel.name}` : notSet, location: tr(L, 'Menu "Choose log channel"', 'Menü „Protokoll-Kanal auswählen“'), keywords: ['log', 'protokoll', 'kanal', 'channel'] },
        { title: tr(L, 'Action', 'Aktion'), description: action, location: tr(L, 'Menu "Choose action"', 'Menü „Aktion auswählen“'), keywords: ['ban', 'kick', 'timeout', 'mute', 'strafe', 'action', 'punishment'] },
        { title: settings.dmEnabled ? tr(L, 'Turn DM off', 'DM ausschalten') : tr(L, 'Turn DM on', 'DM einschalten'), description: `${tr(L, 'Direct message', 'Direktnachricht')}: ${settings.dmEnabled ? activeText : offText}`, location: 'Button', keywords: ['dm', 'direktnachricht', 'nachricht', 'message', 'direct'], action: ids.toggleDm },
        { title: tr(L, 'Edit DM text', 'DM-Text bearbeiten'), description: settings.dmMessage || tr(L, '(empty)', '(leer)'), location: 'Button', keywords: ['dm', 'text', 'nachricht', 'message'], action: ids.editDm },
    ];

    if (settings.action === 'timeout') {
        entries.push({ title: tr(L, 'Timeout duration', 'Timeout-Dauer'), description: tr(L, `${settings.timeoutMinutes} minutes`, `${settings.timeoutMinutes} Minuten`), location: 'Button', keywords: ['timeout', 'dauer', 'minuten', 'minutes', 'duration', 'mute'], action: ids.editTimeout });
    }
    if (settings.channelId) {
        entries.push({ title: tr(L, 'Remove channel', 'Kanal entfernen'), description: tr(L, 'Remove the honeypot channel (turns the honeypot off)', 'Honeypot-Kanal entfernen (schaltet den Honeypot aus)'), location: 'Button', keywords: ['kanal', 'entfernen', 'löschen', 'remove', 'channel', 'delete'], action: ids.clearChannel });
    }
    if (settings.logChannelId) {
        entries.push({ title: tr(L, 'Remove log channel', 'Protokoll-Kanal entfernen'), description: tr(L, 'Reset the log channel', 'Protokoll-Kanal zurücksetzen'), location: 'Button', keywords: ['log', 'protokoll', 'entfernen', 'remove', 'channel'], action: ids.clearLogChannel });
    }
    return entries;
}

async function handleDashboardComponent(component, rootInteraction, settings, client, guildId, customId = component.customId) {
    const ids = settingIds(guildId);
    const L = getDashboardLocale(component);

    if (customId === ids.editDm || customId === ids.editTimeout) {
        return handleModal(
            component,
            rootInteraction,
            settings,
            client,
            guildId,
            customId === ids.editDm ? 'dmMessage' : 'timeoutMinutes',
        );
    }

    await component.deferUpdate();

    if (customId === ids.channel) {
        const channel = component.channels.first();
        if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
            throw new KbolsBotError(
                'Invalid honeypot channel',
                ErrorTypes.VALIDATION,
                tr(L, 'Choose a text or announcement channel.', 'Wähle einen Text- oder Ankündigungskanal aus.'),
            );
        }
        if (settings.enabled) {
            await validateCanEnable(component.guild, { ...settings, channelId: channel.id }, L);
        }
        settings = await saveSettings(client, guildId, { channelId: channel.id });
    } else if (customId === ids.logChannel) {
        const channel = component.channels.first();
        if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
            throw new KbolsBotError(
                'Invalid honeypot log channel',
                ErrorTypes.VALIDATION,
                tr(L, 'Choose a text or announcement channel as the log channel.', 'Wähle einen Text- oder Ankündigungskanal als Protokoll-Kanal aus.'),
            );
        }
        await validateLogChannel(component.guild, channel, L);
        settings = await saveSettings(client, guildId, { logChannelId: channel.id });
    } else if (customId === ids.action) {
        const action = component.values[0];
        if (!ACTION_OPTIONS.some(option => option.value === action)) {
            throw new KbolsBotError('Invalid honeypot action', ErrorTypes.VALIDATION, tr(L, 'This action is not available.', 'Diese Aktion ist nicht verfügbar.'));
        }
        if (settings.enabled) {
            await validateCanEnable(component.guild, { ...settings, action }, L);
        }
        settings = await saveSettings(client, guildId, { action });
    } else if (customId === ids.toggle) {
        const enabled = !settings.enabled;
        if (enabled) {
            await validateCanEnable(component.guild, settings, L);
        }
        settings = await saveSettings(client, guildId, { enabled });
    } else if (customId === ids.toggleDm) {
        settings = await saveSettings(client, guildId, { dmEnabled: !settings.dmEnabled });
    } else if (customId === ids.clearChannel) {
        settings = await saveSettings(client, guildId, { channelId: null, enabled: false });
    } else if (customId === ids.clearLogChannel) {
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
        const L = getDashboardLocale(interaction);
        try {
            if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                throw new KbolsBotError(
                    'Manage Server permission required',
                    ErrorTypes.PERMISSION,
                    tr(L,
                        'You need the "Manage Server" permission to use the honeypot menu.',
                        'Du brauchst die Berechtigung „Server verwalten“, um das Honeypot-Menü zu nutzen.'),
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

            const ids = settingIds(interaction.guildId);

            collector.on('collect', async component => {
                try {
                    if (component.customId === ids.search) {
                        await openDashboardSearch(component, {
                            dashboardName: 'Honeypot',
                            locale: L,
                            placeholder: tr(L, 'e.g. channel, action, DM, timeout, log', 'z. B. Kanal, Aktion, DM, Timeout, Protokoll'),
                            getEntries: () => buildHoneypotSearchEntries(interaction.guild, settings, ids, L),
                            onPick: async (pick, actionId) => {
                                const nextSettings = await handleDashboardComponent(
                                    pick,
                                    interaction,
                                    settings,
                                    client,
                                    interaction.guildId,
                                    actionId,
                                );
                                if (nextSettings) settings = nextSettings;
                            },
                        });
                        return;
                    }

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
                        .setTitle(tr(L, 'Honeypot dashboard closed', 'Honeypot Dashboard geschlossen'))
                        .setDescription(tr(L,
                            'Open `/honeypot dashboard` again to change settings.',
                            'Öffne `/honeypot dashboard` erneut, um Einstellungen zu ändern.'))
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
