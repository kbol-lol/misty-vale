import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    ComponentType,
    EmbedBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import {
    MAX_LEVEL,
    MAX_REWARDS,
    DEFAULT_ROLE_TIERS,
    matchTierRoles,
    normalizeRewards,
} from '../../../utils/levelMath.js';
import {
    getLevelingConfig,
    updateLevelingConfig,
    setRoleReward,
    removeRoleReward,
    replaceRoleRewards,
    setUserLevel,
    syncAllRoles,
    importLevels,
    scanArcaneAnnouncements,
} from '../../../services/levelingService.js';

const ANNOUNCE_MODES = ['same', 'channel', 'off'];
const ANNOUNCE_LABELS = {
    same: 'Same channel as the message',
    channel: 'A fixed channel',
    off: 'Off',
};

// ---------------------------------------------------------------- views

function onOff(value) {
    return value ? 'On' : 'Off';
}

function mentionList(ids, prefix) {
    if (!ids.length) return '`None`';
    const text = ids.map((id) => `<${prefix}${id}>`).join(' ');
    return text.length > 1000 ? `${text.slice(0, 990)}…` : text;
}

async function buildMainView(guild, client) {
    const cfg = await getLevelingConfig(client, guild.id);
    const id = (action) => `lvl_${guild.id}_${action}`;

    const announceValue = cfg.announce.mode === 'channel'
        ? `${ANNOUNCE_LABELS.channel}${cfg.announce.channelId ? ` (<#${cfg.announce.channelId}>)` : ' (not set — falls back to same channel)'}`
        : ANNOUNCE_LABELS[cfg.announce.mode];

    const embed = new EmbedBuilder()
        .setTitle('Leveling Dashboard')
        .setDescription(`Configure XP, level-up messages and level reward roles for **${guild.name}**.`)
        .setColor(cfg.enabled ? getColor('success') : getColor('warning'))
        .addFields(
            { name: 'Leveling', value: onOff(cfg.enabled), inline: true },
            {
                name: 'XP per message',
                value: `\`${cfg.xpMin}–${cfg.xpMax}\` × \`${cfg.xpMultiplier}\``,
                inline: true,
            },
            { name: 'XP cooldown', value: `\`${cfg.cooldownSeconds}s\``, inline: true },
            { name: 'Auto-apply roles', value: onOff(cfg.autoApplyRoles), inline: true },
            {
                name: 'Role mode',
                value: cfg.roleMode === 'stack' ? 'Stack (keep every earned role)' : 'Replace (only highest earned role)',
                inline: true,
            },
            { name: 'Reward roles', value: `\`${cfg.roleRewards.length}\` configured`, inline: true },
            { name: 'Level-up message', value: announceValue, inline: false },
            { name: 'Message text', value: `\`${cfg.announce.message}\``.slice(0, 1024), inline: false },
            { name: 'Ignored channels', value: mentionList(cfg.ignoredChannels, '#'), inline: false },
            { name: 'Ignored roles', value: mentionList(cfg.ignoredRoles, '@&'), inline: false },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(id('toggle_enabled'))
            .setLabel(cfg.enabled ? 'Disable Leveling' : 'Enable Leveling')
            .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(id('toggle_roles'))
            .setLabel(cfg.autoApplyRoles ? 'Auto Roles: On' : 'Auto Roles: Off')
            .setStyle(cfg.autoApplyRoles ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(id('toggle_mode'))
            .setLabel(cfg.roleMode === 'stack' ? 'Role Mode: Stack' : 'Role Mode: Replace')
            .setStyle(ButtonStyle.Primary),
    );

    const menu = new StringSelectMenuBuilder()
        .setCustomId(id('menu'))
        .setPlaceholder('Choose a setting to change...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Level Reward Roles').setDescription('Choose which role is given at which level').setValue('rewards'),
            new StringSelectMenuOptionBuilder().setLabel('XP Speed').setDescription('Min/max XP, multiplier and cooldown').setValue('xp'),
            new StringSelectMenuOptionBuilder().setLabel('Level-up Message Mode').setDescription('Cycle: same channel / fixed channel / off').setValue('announce_mode'),
            new StringSelectMenuOptionBuilder().setLabel('Level-up Message Text & Channel').setDescription('Placeholders: {user} {username} {level} {server}').setValue('announce_text'),
            new StringSelectMenuOptionBuilder().setLabel('Set a User\'s Level').setDescription('Set the level of any member').setValue('setlevel'),
            new StringSelectMenuOptionBuilder().setLabel('Import Levels from Arcane').setDescription('Scan the Arcane level-up channel and import everyone').setValue('scan'),
            new StringSelectMenuOptionBuilder().setLabel('Ignored Channels').setDescription('Channels that never give XP').setValue('ignored_channels'),
            new StringSelectMenuOptionBuilder().setLabel('Ignored Roles').setDescription('Roles that never gain XP').setValue('ignored_roles'),
            new StringSelectMenuOptionBuilder().setLabel('Sync All Roles Now').setDescription('Re-apply reward roles for every stored user').setValue('sync'),
        );

    return {
        embeds: [embed],
        components: [buttons, new ActionRowBuilder().addComponents(menu)],
    };
}

async function buildRewardsView(guild, client) {
    const cfg = await getLevelingConfig(client, guild.id);
    const id = (action) => `lvl_${guild.id}_${action}`;

    const lines = cfg.roleRewards.length
        ? cfg.roleRewards.map((r) => `Level **${r.level}** → <@&${r.roleId}>`).join('\n')
        : '*No reward roles yet. Use **Auto-detect Default Roles** or **Add / Edit Reward**.*';

    const embed = new EmbedBuilder()
        .setTitle('Level Reward Roles')
        .setDescription(lines.slice(0, 4000))
        .setColor(getColor('info'))
        .addFields(
            { name: 'Auto-apply on level up', value: onOff(cfg.autoApplyRoles), inline: true },
            { name: 'Role mode', value: cfg.roleMode === 'stack' ? 'Stack' : 'Replace', inline: true },
            { name: 'Slots used', value: `\`${cfg.roleRewards.length}/${MAX_REWARDS}\``, inline: true },
        )
        .setFooter({ text: 'Only roles listed here are ever added or removed by the level system' })
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('rw_add')).setLabel('Add / Edit Reward').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('rw_detect')).setLabel('Auto-detect Default Roles').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('rw_sync')).setLabel('Sync All Roles Now').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('rw_back')).setLabel('Back').setStyle(ButtonStyle.Secondary),
    );

    const components = [buttons];

    if (cfg.roleRewards.length) {
        const options = cfg.roleRewards.map((r) => {
            const role = guild.roles.cache.get(r.roleId);
            return new StringSelectMenuOptionBuilder()
                .setLabel(`Level ${r.level}`)
                .setDescription(role ? role.name.slice(0, 90) : `Missing role (${r.roleId})`)
                .setValue(String(r.level));
        });
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id('rw_remove'))
                .setPlaceholder('Remove a reward...')
                .addOptions(options),
        ));
    }

    return { embeds: [embed], components };
}

// ---------------------------------------------------------------- helpers

async function openModal(sourceInteraction, modal, timeMs = 300_000) {
    await sourceInteraction.showModal(modal);
    return sourceInteraction
        .awaitModalSubmit({
            filter: (i) => i.customId === modal.data.custom_id && i.user.id === sourceInteraction.user.id,
            time: timeMs,
        })
        .catch(() => null);
}

function textInput(customId, label, { placeholder, value, maxLength = 20, required = true, style = TextInputStyle.Short } = {}) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(maxLength);
    if (placeholder) input.setPlaceholder(placeholder);
    if (value !== undefined && value !== null && String(value).length) input.setValue(String(value));
    return new ActionRowBuilder().addComponents(input);
}

function validationError(submitted, message) {
    return replyUserError(submitted, { type: ErrorTypes.VALIDATION, message });
}

function ephemeralReply(submitted, text) {
    return submitted.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
}

function describeSync(summary) {
    return [
        `Checked **${summary.processed}** members.`,
        `Roles added: **${summary.added}**, removed: **${summary.removed}**.`,
        summary.skipped ? `Skipped **${summary.skipped}** role changes (role missing, managed, or above my highest role).` : null,
        summary.missingMembers ? `${summary.missingMembers} stored users are no longer in the server.` : null,
    ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- actions

async function handleXpModal(sel, guild, client) {
    const cfg = await getLevelingConfig(client, guild.id);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_xp_${guild.id}`).setTitle('XP Speed');
    modal.addComponents(
        textInput('xp_min', 'Minimum XP per message', { value: cfg.xpMin, maxLength: 4 }),
        textInput('xp_max', 'Maximum XP per message', { value: cfg.xpMax, maxLength: 4 }),
        textInput('xp_mult', 'XP multiplier (0.1 – 50, e.g. 2 = double)', { value: cfg.xpMultiplier, maxLength: 6 }),
        textInput('xp_cd', 'Cooldown between XP gains (seconds)', { value: cfg.cooldownSeconds, maxLength: 4 }),
    );
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const xpMin = Number(submitted.fields.getTextInputValue('xp_min').trim());
    const xpMax = Number(submitted.fields.getTextInputValue('xp_max').trim());
    const mult = Number(submitted.fields.getTextInputValue('xp_mult').trim().replace(',', '.'));
    const cd = Number(submitted.fields.getTextInputValue('xp_cd').trim());

    if (![xpMin, xpMax, mult, cd].every(Number.isFinite)) {
        await validationError(submitted, 'All values must be numbers.');
        return false;
    }
    if (xpMin < 1 || xpMax < xpMin || xpMax > 1000) {
        await validationError(submitted, 'Minimum must be at least 1 and no larger than the maximum (max 1000).');
        return false;
    }
    if (mult < 0.1 || mult > 50) {
        await validationError(submitted, 'The multiplier must be between 0.1 and 50.');
        return false;
    }
    if (cd < 0 || cd > 3600) {
        await validationError(submitted, 'The cooldown must be between 0 and 3600 seconds.');
        return false;
    }

    const updated = await updateLevelingConfig(client, guild.id, {
        xpMin, xpMax, xpMultiplier: mult, cooldownSeconds: cd,
    });
    await ephemeralReply(submitted, `XP speed updated: ${updated.xpMin}–${updated.xpMax} XP × ${updated.xpMultiplier}, ${updated.cooldownSeconds}s cooldown.`);
    return true;
}

async function handleAnnounceModal(sel, guild, client) {
    const cfg = await getLevelingConfig(client, guild.id);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_announce_${guild.id}`).setTitle('Level-up Message');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('announce_channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(0)
        .setMaxValues(1)
        .setRequired(false)
        .setPlaceholder('Fixed channel (optional)');
    if (cfg.announce.channelId) channelSelect.setDefaultChannels(cfg.announce.channelId);

    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel('Announcement channel')
            .setDescription('Used when the mode is "A fixed channel". Leave empty to keep the current one.')
            .setChannelSelectMenuComponent(channelSelect),
    );
    modal.addComponents(
        textInput('announce_text', 'Message ({user} {username} {level} {server})', {
            value: cfg.announce.message,
            maxLength: 500,
            style: TextInputStyle.Paragraph,
        }),
    );

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const text = submitted.fields.getTextInputValue('announce_text').trim();
    if (!text) {
        await validationError(submitted, 'The message cannot be empty.');
        return false;
    }

    const picked = submitted.fields.getField('announce_channel')?.values?.[0] ?? null;
    const patch = { announce: { message: text } };
    if (picked) {
        patch.announce.channelId = picked;
        patch.announce.mode = 'channel';
    }
    await updateLevelingConfig(client, guild.id, patch);
    await ephemeralReply(submitted, picked ? `Level-up message saved and set to post in <#${picked}>.` : 'Level-up message saved.');
    return true;
}

async function handleIgnoredModal(sel, guild, client, kind) {
    const isChannels = kind === 'channels';
    const modal = new ModalBuilder()
        .setCustomId(`lvl_modal_ignore_${kind}_${guild.id}`)
        .setTitle(isChannels ? 'Ignored Channels' : 'Ignored Roles');

    const cfg = await getLevelingConfig(client, guild.id);

    const select = isChannels
        ? new ChannelSelectMenuBuilder()
            .setCustomId('ignored')
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildCategory)
        : new RoleSelectMenuBuilder().setCustomId('ignored');

    select.setMinValues(0).setMaxValues(10).setRequired(false).setPlaceholder('Select up to 10 (empty = clear list)');
    const current = (isChannels ? cfg.ignoredChannels : cfg.ignoredRoles).slice(0, 10);
    if (current.length) {
        if (isChannels) select.setDefaultChannels(current);
        else select.setDefaultRoles(current);
    }

    const label = new LabelBuilder()
        .setLabel(isChannels ? 'Channels that give no XP' : 'Roles that gain no XP')
        .setDescription('This replaces the current list. Submit with nothing selected to clear it.');
    if (isChannels) label.setChannelSelectMenuComponent(select);
    else label.setRoleSelectMenuComponent(select);
    modal.addLabelComponents(label);

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const values = submitted.fields.getField('ignored')?.values ?? [];
    await updateLevelingConfig(client, guild.id, isChannels ? { ignoredChannels: values } : { ignoredRoles: values });
    await ephemeralReply(submitted, `${isChannels ? 'Ignored channels' : 'Ignored roles'} updated (${values.length}).`);
    return true;
}

async function handleSetLevelModal(sel, guild, client) {
    const modal = new ModalBuilder().setCustomId(`lvl_modal_setlevel_${guild.id}`).setTitle('Set User Level');
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel('Member')
            .setDescription('The member whose level you want to set')
            .setUserSelectMenuComponent(
                new UserSelectMenuBuilder().setCustomId('target_user').setMinValues(1).setMaxValues(1).setRequired(true),
            ),
    );
    modal.addComponents(textInput('level', `New level (0 – ${MAX_LEVEL})`, { placeholder: '10', maxLength: 4 }));

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const userId = submitted.fields.getField('target_user').values[0];
    const level = Number(submitted.fields.getTextInputValue('level').trim());
    if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) {
        await validationError(submitted, `The level must be a whole number between 0 and ${MAX_LEVEL}.`);
        return false;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'That user is not in this server.' });
        return false;
    }
    if (member.user.bot) {
        await validationError(submitted, 'Bots do not have levels.');
        return false;
    }

    await submitted.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await setUserLevel(client, guild, userId, level);
    await submitted.editReply({
        content: `${member} is now level **${result.level}** (was ${result.previousLevel}).`
            + (result.roles.added.length || result.roles.removed.length
                ? `\nRoles: +${result.roles.added.length} / -${result.roles.removed.length}`
                : ''),
        allowedMentions: { parse: [] },
    });
    logger.info('[LEVELING_DASHBOARD] Level set', { adminId: submitted.user.id, targetUserId: userId, level });
    return true;
}

async function handleScanModal(sel, guild, client) {
    const modal = new ModalBuilder().setCustomId(`lvl_modal_scan_${guild.id}`).setTitle('Import from Arcane');
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel('Arcane level-up channel')
            .setDescription('The channel where Arcane posts "@user is now level N". Its full history is read.')
            .setChannelSelectMenuComponent(
                new ChannelSelectMenuBuilder()
                    .setCustomId('scan_channel')
                    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(1)
                    .setMaxValues(1)
                    .setRequired(true),
            ),
    );
    modal.addComponents(textInput('scan_limit', 'Max messages to read (default 50000)', {
        value: '50000', maxLength: 6, required: false,
    }));

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const channelId = submitted.fields.getField('scan_channel').values[0];
    const limit = Math.min(200_000, Math.max(100, Number(submitted.fields.getTextInputValue('scan_limit').trim()) || 50_000));
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
        await validationError(submitted, 'That channel cannot be read.');
        return false;
    }

    const perms = channel.permissionsFor(guild.members.me);
    if (!perms?.has(['ViewChannel', 'ReadMessageHistory'])) {
        await replyUserError(submitted, {
            type: ErrorTypes.PERMISSION,
            message: 'I need **View Channel** and **Read Message History** in that channel.',
        });
        return false;
    }

    await submitted.deferReply({ flags: MessageFlags.Ephemeral });
    await submitted.editReply({ content: `Reading <#${channelId}>... this can take a few minutes for big channels.` });

    let lastEdit = 0;
    const scan = await scanArcaneAnnouncements(channel, {
        maxMessages: limit,
        onProgress: async (p) => {
            if (Date.now() - lastEdit < 5000) return;
            lastEdit = Date.now();
            await submitted.editReply({ content: `Reading... scanned ${p.scanned} messages, found ${p.users} users so far.` });
        },
    });

    if (!scan.entries.length) {
        await submitted.editReply({
            content: `Scanned ${scan.scanned} messages but found no level-up announcements.`
                + ' Make sure this is the channel Arcane posts level-ups in.',
        });
        return false;
    }

    await submitted.editReply({ content: `Found **${scan.entries.length}** users. Importing levels and applying roles...` });
    const summary = await importLevels(client, guild, scan.entries, { mode: 'max', applyRoles: true });
    await submitted.editReply({
        content: [
            `Scanned **${scan.scanned}** messages, found **${scan.matched}** level-ups for **${scan.entries.length}** users.`,
            `Raised **${summary.raised}** users, **${summary.unchanged}** were already at or above that level.`,
            `Role updates for **${summary.roleChanges}** members.`,
            'Anyone who never triggered a level-up message in this channel is not included. Use `/levelconfig import` with a file for those.',
        ].join('\n'),
    });
    logger.info('[LEVELING_DASHBOARD] Arcane import', { adminId: submitted.user.id, users: scan.entries.length });
    return true;
}

async function handleRewardModal(sel, guild, client) {
    const modal = new ModalBuilder().setCustomId(`lvl_modal_reward_${guild.id}`).setTitle('Add / Edit Reward');
    modal.addComponents(textInput('level', `Level that grants the role (1 – ${MAX_LEVEL})`, { placeholder: '5', maxLength: 4 }));
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel('Role')
            .setDescription('Setting an existing level replaces its role')
            .setRoleSelectMenuComponent(
                new RoleSelectMenuBuilder().setCustomId('reward_role').setMinValues(1).setMaxValues(1).setRequired(true),
            ),
    );

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const level = Number(submitted.fields.getTextInputValue('level').trim());
    const roleId = submitted.fields.getField('reward_role').values[0];
    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        await validationError(submitted, `The level must be a whole number between 1 and ${MAX_LEVEL}.`);
        return false;
    }

    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.id === guild.id || role.managed) {
        await validationError(submitted, 'That role cannot be used (everyone/managed roles are not allowed).');
        return false;
    }
    const cfg = await getLevelingConfig(client, guild.id);
    const isNewLevel = !cfg.roleRewards.some((r) => r.level === level && r.roleId !== roleId);
    if (cfg.roleRewards.length >= MAX_REWARDS && isNewLevel && !cfg.roleRewards.some((r) => r.roleId === roleId)) {
        await validationError(submitted, `You can configure at most ${MAX_REWARDS} reward roles.`);
        return false;
    }

    await setRoleReward(client, guild.id, level, roleId);
    const warn = role.position >= guild.members.me.roles.highest.position
        ? '\nWarning: this role is above my highest role, so I cannot assign it. Move my role higher.'
        : '';
    await ephemeralReply(submitted, `Level **${level}** now gives ${role}.${warn}`);
    return true;
}

async function handleDetectDefaults(guild, client) {
    await guild.roles.fetch().catch(() => {});
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed);
    const { matched, missing } = matchTierRoles(roles, DEFAULT_ROLE_TIERS);

    if (matched.length) {
        const cfg = await getLevelingConfig(client, guild.id);
        const merged = new Map(cfg.roleRewards.map((r) => [r.level, r]));
        for (const m of matched) merged.set(m.level, m);
        await replaceRoleRewards(client, guild.id, normalizeRewards([...merged.values()]));
    }

    const matchedText = matched.map((m) => `Level ${m.level} → <@&${m.roleId}>`).join('\n') || 'None';
    const missingText = missing.length ? `\nNo role found for: ${missing.map((t) => `${t.name} (${t.level})`).join(', ')}` : '';
    return `Matched ${matched.length}/${DEFAULT_ROLE_TIERS.length} default roles by name:\n${matchedText}${missingText}`;
}

async function runSync(followUpTarget, guild, client) {
    const summary = await syncAllRoles(client, guild);
    await followUpTarget.followUp({
        content: `Role sync finished.\n${describeSync(summary)}`,
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});
}

// ---------------------------------------------------------------- entry point

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        try {
            const guild = interaction.guild;
            const state = { view: 'main' };
            const prefix = `lvl_${guild.id}_`;

            const render = async () => {
                const view = state.view === 'rewards'
                    ? await buildRewardsView(guild, client)
                    : await buildMainView(guild, client);
                await InteractionHelper.safeEditReply(interaction, view).catch(() => {});
            };

            await InteractionHelper.safeEditReply(interaction, await buildMainView(guild, client));

            const source = interaction.channel ?? await interaction.fetchReply();
            const collector = source.createMessageComponentCollector({
                filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(prefix),
                time: 600_000,
            });

            collector.on('collect', async (i) => {
                const action = i.customId.slice(prefix.length);
                try {
                    if (i.componentType === ComponentType.Button) {
                        switch (action) {
                            case 'toggle_enabled': {
                                await i.deferUpdate();
                                const cfg = await getLevelingConfig(client, guild.id);
                                await updateLevelingConfig(client, guild.id, { enabled: !cfg.enabled });
                                break;
                            }
                            case 'toggle_roles': {
                                await i.deferUpdate();
                                const cfg = await getLevelingConfig(client, guild.id);
                                await updateLevelingConfig(client, guild.id, { autoApplyRoles: !cfg.autoApplyRoles });
                                break;
                            }
                            case 'toggle_mode': {
                                await i.deferUpdate();
                                const cfg = await getLevelingConfig(client, guild.id);
                                await updateLevelingConfig(client, guild.id, { roleMode: cfg.roleMode === 'stack' ? 'replace' : 'stack' });
                                break;
                            }
                            case 'rw_add':
                                await handleRewardModal(i, guild, client);
                                break;
                            case 'rw_detect': {
                                await i.deferReply({ flags: MessageFlags.Ephemeral });
                                const text = await handleDetectDefaults(guild, client);
                                await i.editReply({ content: text, allowedMentions: { parse: [] } });
                                break;
                            }
                            case 'rw_sync': {
                                await i.deferReply({ flags: MessageFlags.Ephemeral });
                                await i.editReply({ content: 'Syncing roles... I will post the result here when it is done.' });
                                await runSync(i, guild, client);
                                break;
                            }
                            case 'rw_back':
                                await i.deferUpdate();
                                state.view = 'main';
                                break;
                            default:
                                await i.deferUpdate().catch(() => {});
                        }
                    } else if (i.componentType === ComponentType.StringSelect) {
                        const choice = i.values[0];
                        if (action === 'rw_remove') {
                            await i.deferUpdate();
                            await removeRoleReward(client, guild.id, Number(choice));
                        } else if (action === 'menu') {
                            switch (choice) {
                                case 'rewards':
                                    await i.deferUpdate();
                                    state.view = 'rewards';
                                    break;
                                case 'xp':
                                    await handleXpModal(i, guild, client);
                                    break;
                                case 'announce_mode': {
                                    await i.deferUpdate();
                                    const cfg = await getLevelingConfig(client, guild.id);
                                    const next = ANNOUNCE_MODES[(ANNOUNCE_MODES.indexOf(cfg.announce.mode) + 1) % ANNOUNCE_MODES.length];
                                    await updateLevelingConfig(client, guild.id, { announce: { mode: next } });
                                    break;
                                }
                                case 'announce_text':
                                    await handleAnnounceModal(i, guild, client);
                                    break;
                                case 'setlevel':
                                    await handleSetLevelModal(i, guild, client);
                                    break;
                                case 'scan':
                                    await handleScanModal(i, guild, client);
                                    break;
                                case 'ignored_channels':
                                    await handleIgnoredModal(i, guild, client, 'channels');
                                    break;
                                case 'ignored_roles':
                                    await handleIgnoredModal(i, guild, client, 'roles');
                                    break;
                                case 'sync':
                                    await i.deferReply({ flags: MessageFlags.Ephemeral });
                                    await i.editReply({ content: 'Syncing roles... I will post the result here when it is done.' });
                                    await runSync(i, guild, client);
                                    break;
                                default:
                                    await i.deferUpdate().catch(() => {});
                            }
                        }
                    }
                    await render();
                } catch (error) {
                    logger.error('Leveling dashboard error:', error);
                    if (!i.replied && !i.deferred) await i.deferUpdate().catch(() => {});
                    await replyUserError(i, {
                        type: ErrorTypes.UNKNOWN,
                        message: 'Something went wrong while processing that action.',
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_collected, reason) => {
                if (reason !== 'time') return;
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('Dashboard Timed Out')
                    .setDescription('This dashboard was closed due to inactivity. Run `/levelconfig dashboard` again to continue.')
                    .setColor(getColor('error'));
                await InteractionHelper.safeEditReply(interaction, { embeds: [timeoutEmbed], components: [] }).catch(() => {});
            });
        } catch (error) {
            logger.error('leveling_dashboard error:', error);
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to open the leveling dashboard.' });
        }
    },
};
