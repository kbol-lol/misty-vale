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
    PermissionFlagsBits,
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
    MAX_LEVEL_IMAGES,
    MAX_LEVEL_MESSAGES,
    DEFAULT_ROLE_TIERS,
    matchTierRoles,
    normalizeRewards,
    resolveLevelUpAnnouncement,
    sanitizeImageUrl,
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
    buildLevelUpMessage,
} from '../../../services/levelingService.js';
import { createSearchButton, openDashboardSearch } from '../../../utils/dashboardSearch.js';
import { getDashboardLocale, tr } from '../../../utils/dashboardLocale.js';

const ANNOUNCE_MODES = ['same', 'channel', 'off'];
const ANNOUNCE_LABELS = {
    en: {
        same: 'Same channel as the message',
        channel: 'A fixed channel',
        off: 'Off',
    },
    de: {
        same: 'Gleicher Kanal wie die Nachricht',
        channel: 'Ein fester Kanal',
        off: 'Aus',
    },
};
const ANNOUNCE_SHORT = {
    en: { same: 'Same', channel: 'Channel', off: 'Off' },
    de: { same: 'Gleich', channel: 'Kanal', off: 'Aus' },
};

function announceLabel(mode, L) {
    return (ANNOUNCE_LABELS[L] || ANNOUNCE_LABELS.en)[mode];
}

// ---------------------------------------------------------------- views

function onOff(value, L) {
    return value ? tr(L, 'On', 'An') : tr(L, 'Off', 'Aus');
}

function mentionList(ids, prefix, L) {
    if (!ids.length) return tr(L, '`None`', '`Keine`');
    const text = ids.map((id) => `<${prefix}${id}>`).join(' ');
    return text.length > 1000 ? `${text.slice(0, 990)}…` : text;
}

async function buildMainView(guild, client, L = 'en') {
    const cfg = await getLevelingConfig(client, guild.id);
    const id = (action) => `lvl_${guild.id}_${action}`;

    const announceValue = cfg.announce.mode === 'channel'
        ? `${announceLabel('channel', L)}${cfg.announce.channelId
            ? ` (<#${cfg.announce.channelId}>)`
            : tr(L, ' (not set — falls back to same channel)', ' (nicht gesetzt — nutzt den gleichen Kanal)')}`
        : announceLabel(cfg.announce.mode, L);

    const embed = new EmbedBuilder()
        .setTitle(tr(L, 'Leveling Dashboard', 'Level-Dashboard'))
        .setDescription(tr(L,
            `Configure XP, level-up messages and level reward roles for **${guild.name}**.`,
            `Stelle XP, Level-up-Nachrichten und Level-Belohnungsrollen für **${guild.name}** ein.`))
        .setColor(cfg.enabled ? getColor('success') : getColor('warning'))
        .addFields(
            { name: tr(L, 'Leveling', 'Leveling'), value: onOff(cfg.enabled, L), inline: true },
            {
                name: tr(L, 'XP per message', 'XP pro Nachricht'),
                value: `\`${cfg.xpMin}–${cfg.xpMax}\` × \`${cfg.xpMultiplier}\``,
                inline: true,
            },
            { name: tr(L, 'XP cooldown', 'XP-Abklingzeit'), value: `\`${cfg.cooldownSeconds}s\``, inline: true },
            { name: tr(L, 'Auto-apply roles', 'Rollen automatisch vergeben'), value: onOff(cfg.autoApplyRoles, L), inline: true },
            { name: tr(L, 'Reward roles', 'Belohnungsrollen'), value: tr(L, `\`${cfg.roleRewards.length}\` configured`, `\`${cfg.roleRewards.length}\` eingerichtet`), inline: true },
            { name: tr(L, 'Level-up message', 'Level-up-Nachricht'), value: announceValue, inline: false },
            { name: tr(L, 'Message text', 'Nachrichtentext'), value: `\`${cfg.announce.message}\``.slice(0, 1024), inline: false },
            { name: tr(L, 'Ignored channels', 'Ignorierte Kanäle'), value: mentionList(cfg.ignoredChannels, '#', L), inline: false },
            { name: tr(L, 'Ignored roles', 'Ignorierte Rollen'), value: mentionList(cfg.ignoredRoles, '@&', L), inline: false },
        )
        .setFooter({ text: tr(L, 'Dashboard closes after 10 minutes of inactivity', 'Das Dashboard schließt nach 10 Minuten Inaktivität') })
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(id('toggle_enabled'))
            .setLabel(cfg.enabled ? tr(L, 'Disable Leveling', 'Leveling ausschalten') : tr(L, 'Enable Leveling', 'Leveling einschalten'))
            .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(id('toggle_roles'))
            .setLabel(cfg.autoApplyRoles ? tr(L, 'Auto Roles: On', 'Auto-Rollen: An') : tr(L, 'Auto Roles: Off', 'Auto-Rollen: Aus'))
            .setStyle(cfg.autoApplyRoles ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(id('open_announce'))
            .setLabel(tr(L, 'Level Log Channel & Message', 'Level-Kanal & Nachricht'))
            .setStyle(ButtonStyle.Primary),
        createSearchButton(id('search'), { locale: L }),
    );

    const menu = new StringSelectMenuBuilder()
        .setCustomId(id('menu'))
        .setPlaceholder(tr(L, 'Choose a setting to change...', 'Einstellung zum Ändern wählen...'))
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Level Reward Roles', 'Level-Belohnungsrollen')).setDescription(tr(L, 'Choose which role is given at which level', 'Welche Rolle bei welchem Level vergeben wird')).setValue('rewards'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'XP Speed', 'XP-Tempo')).setDescription(tr(L, 'Min/max XP, multiplier and cooldown', 'Min./max. XP, Multiplikator und Abklingzeit')).setValue('xp'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Level Log Channel & Message', 'Level-Kanal & Nachricht')).setDescription(tr(L, 'Channel, message text, embed, images, preview', 'Kanal, Text, Embed, Bilder, Vorschau')).setValue('announce'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Set a User\'s Level', 'Level eines Mitglieds setzen')).setDescription(tr(L, 'Set the level of any member', 'Das Level eines beliebigen Mitglieds setzen')).setValue('setlevel'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Import Levels from Arcane', 'Level aus Arcane importieren')).setDescription(tr(L, 'Scan the Arcane level-up channel and import everyone', 'Arcane-Level-up-Kanal lesen und alle importieren')).setValue('scan'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Ignored Channels', 'Ignorierte Kanäle')).setDescription(tr(L, 'Channels that never give XP', 'Kanäle, die nie XP geben')).setValue('ignored_channels'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Ignored Roles', 'Ignorierte Rollen')).setDescription(tr(L, 'Roles that never gain XP', 'Rollen, die nie XP bekommen')).setValue('ignored_roles'),
            new StringSelectMenuOptionBuilder().setLabel(tr(L, 'Sync All Roles Now', 'Alle Rollen jetzt abgleichen')).setDescription(tr(L, 'Re-apply reward roles for every stored user', 'Belohnungsrollen für alle gespeicherten Nutzer neu vergeben')).setValue('sync'),
        );

    return {
        embeds: [embed],
        components: [buttons, new ActionRowBuilder().addComponents(menu)],
    };
}

async function buildRewardsView(guild, client, L = 'en') {
    const cfg = await getLevelingConfig(client, guild.id);
    const id = (action) => `lvl_${guild.id}_${action}`;

    const lines = cfg.roleRewards.length
        ? cfg.roleRewards.map((r) => `Level **${r.level}** → <@&${r.roleId}>`).join('\n')
        : tr(L,
            '*No reward roles yet. Use **Auto-detect Default Roles** or **Add / Edit Reward**.*',
            '*Noch keine Belohnungsrollen. Nutze **Standardrollen erkennen** oder **Belohnung hinzufügen**.*');

    const embed = new EmbedBuilder()
        .setTitle(tr(L, 'Level Reward Roles', 'Level-Belohnungsrollen'))
        .setDescription(lines.slice(0, 4000))
        .setColor(getColor('info'))
        .addFields(
            { name: tr(L, 'Auto-apply on level up', 'Automatisch beim Level-up'), value: onOff(cfg.autoApplyRoles, L), inline: true },
            { name: tr(L, 'Role rule', 'Rollenregel'), value: tr(L, 'One level role only', 'Nur eine Level-Rolle'), inline: true },
            { name: tr(L, 'Slots used', 'Belegte Plätze'), value: `\`${cfg.roleRewards.length}/${MAX_REWARDS}\``, inline: true },
        )
        .setFooter({ text: tr(L,
            'A member only keeps the highest level role they earned; older level roles are removed. Other roles are never touched.',
            'Ein Mitglied behält nur die höchste verdiente Level-Rolle; ältere Level-Rollen werden entfernt. Andere Rollen bleiben unberührt.') })
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('rw_add')).setLabel(tr(L, 'Add / Edit Reward', 'Belohnung hinzufügen')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('rw_detect')).setLabel(tr(L, 'Auto-detect Default Roles', 'Standardrollen erkennen')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('rw_sync')).setLabel(tr(L, 'Sync All Roles Now', 'Alle Rollen abgleichen')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('rw_back')).setLabel(tr(L, 'Back', 'Zurück')).setStyle(ButtonStyle.Secondary),
    );

    const components = [buttons];

    if (cfg.roleRewards.length) {
        const options = cfg.roleRewards.map((r) => {
            const role = guild.roles.cache.get(r.roleId);
            return new StringSelectMenuOptionBuilder()
                .setLabel(`Level ${r.level}`)
                .setDescription(role ? role.name.slice(0, 90) : tr(L, `Missing role (${r.roleId})`, `Fehlende Rolle (${r.roleId})`))
                .setValue(String(r.level));
        });
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id('rw_remove'))
                .setPlaceholder(tr(L, 'Remove a reward...', 'Belohnung entfernen...'))
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
    return submitted.reply({ content: text, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral }).catch(() => {});
}

function describeSync(summary, L) {
    return [
        tr(L, `Checked **${summary.processed}** members.`, `**${summary.processed}** Mitglieder geprüft.`),
        tr(L, `Roles added: **${summary.added}**, removed: **${summary.removed}**.`, `Rollen vergeben: **${summary.added}**, entfernt: **${summary.removed}**.`),
        summary.skipped ? tr(L,
            `Skipped **${summary.skipped}** role changes (role missing, managed, or above my highest role).`,
            `**${summary.skipped}** Rollenänderungen übersprungen (Rolle fehlt, ist verwaltet oder über meiner höchsten Rolle).`) : null,
        summary.missingMembers ? tr(L,
            `${summary.missingMembers} stored users are no longer in the server.`,
            `${summary.missingMembers} gespeicherte Nutzer sind nicht mehr auf dem Server.`) : null,
    ].filter(Boolean).join('\n');
}

function levelRangeError(L, min = 1) {
    return tr(L,
        `The level must be a whole number between ${min} and ${MAX_LEVEL}.`,
        `Das Level muss eine ganze Zahl zwischen ${min} und ${MAX_LEVEL} sein.`);
}

// ---------------------------------------------------------------- actions

async function handleXpModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const cfg = await getLevelingConfig(client, guild.id);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_xp_${guild.id}`).setTitle(tr(L, 'XP Speed', 'XP-Tempo'));
    modal.addComponents(
        textInput('xp_min', tr(L, 'Minimum XP per message', 'Minimale XP pro Nachricht'), { value: cfg.xpMin, maxLength: 4 }),
        textInput('xp_max', tr(L, 'Maximum XP per message', 'Maximale XP pro Nachricht'), { value: cfg.xpMax, maxLength: 4 }),
        textInput('xp_mult', tr(L, 'XP multiplier (0.1 – 50, e.g. 2 = double)', 'XP-Multiplikator (0.1 – 50, 2 = doppelt)'), { value: cfg.xpMultiplier, maxLength: 6 }),
        textInput('xp_cd', tr(L, 'Cooldown between XP gains (seconds)', 'Abklingzeit zwischen XP (Sekunden)'), { value: cfg.cooldownSeconds, maxLength: 4 }),
    );
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const xpMin = Number(submitted.fields.getTextInputValue('xp_min').trim());
    const xpMax = Number(submitted.fields.getTextInputValue('xp_max').trim());
    const mult = Number(submitted.fields.getTextInputValue('xp_mult').trim().replace(',', '.'));
    const cd = Number(submitted.fields.getTextInputValue('xp_cd').trim());

    if (![xpMin, xpMax, mult, cd].every(Number.isFinite)) {
        await validationError(submitted, tr(L, 'All values must be numbers.', 'Alle Werte müssen Zahlen sein.'));
        return false;
    }
    if (xpMin < 1 || xpMax < xpMin || xpMax > 1000) {
        await validationError(submitted, tr(L,
            'Minimum must be at least 1 and no larger than the maximum (max 1000).',
            'Das Minimum muss mindestens 1 und nicht größer als das Maximum sein (max. 1000).'));
        return false;
    }
    if (mult < 0.1 || mult > 50) {
        await validationError(submitted, tr(L, 'The multiplier must be between 0.1 and 50.', 'Der Multiplikator muss zwischen 0.1 und 50 liegen.'));
        return false;
    }
    if (cd < 0 || cd > 3600) {
        await validationError(submitted, tr(L, 'The cooldown must be between 0 and 3600 seconds.', 'Die Abklingzeit muss zwischen 0 und 3600 Sekunden liegen.'));
        return false;
    }

    const updated = await updateLevelingConfig(client, guild.id, {
        xpMin, xpMax, xpMultiplier: mult, cooldownSeconds: cd,
    });
    await ephemeralReply(submitted, tr(L,
        `XP speed updated: ${updated.xpMin}–${updated.xpMax} XP × ${updated.xpMultiplier}, ${updated.cooldownSeconds}s cooldown.`,
        `XP-Tempo gespeichert: ${updated.xpMin}–${updated.xpMax} XP × ${updated.xpMultiplier}, ${updated.cooldownSeconds}s Abklingzeit.`));
    return true;
}

function colorOrNull(value) {
    const text = String(value ?? '').trim();
    return /^#?[0-9a-fA-F]{6}$/.test(text) ? `#${text.replace('#', '').toUpperCase()}` : null;
}

async function buildAnnounceView(guild, client, L = 'en') {
    const cfg = await getLevelingConfig(client, guild.id);
    const a = cfg.announce;
    const id = (action) => `lvl_${guild.id}_${action}`;
    const none = tr(L, '`None`', '`Keine`');

    const specific = a.imageMode === 'specific';
    const levelImages = a.levelImages.length
        ? a.levelImages.map((i) => `Level **${i.level}${specific ? '' : '+'}** → [${tr(L, 'image', 'Bild')}](${i.url})`).join('\n').slice(0, 1000)
        : none;

    const rm = a.rewardMessage;
    const rewardValue = [
        rm.enabled
            ? tr(L, '**On** — used when a level-up gives a new level role', '**An** — wird genutzt, wenn ein Level-up eine neue Level-Rolle gibt')
            : tr(L, '**Off** — role level-ups use the normal message', '**Aus** — Rollen-Level-ups nutzen die normale Nachricht'),
        `\`${rm.message}\``.slice(0, 500),
        rm.imageUrl ? `[${tr(L, 'Image / GIF', 'Bild / GIF')}](${rm.imageUrl})` : tr(L, 'No own image', 'Kein eigenes Bild'),
        !cfg.autoApplyRoles
            ? tr(L, '⚠️ Auto Roles is off, so no role is given and this message is not used.', '⚠️ Auto-Rollen ist aus, daher wird keine Rolle vergeben und diese Nachricht nicht genutzt.')
            : null,
    ].filter(Boolean).join('\n').slice(0, 1024);

    const levelMsgValue = a.levelMessages.length
        ? a.levelMessages.map((m) => `Level **${m.level}**${m.message ? '' : tr(L, ' (image only)', ' (nur Bild)')}${m.imageUrl ? ' 🖼️' : ''}`).join(' · ').slice(0, 1024)
        : tr(L, '`None` — add one to give a level its own text and image/GIF', '`Keine` — füge eine hinzu, um einem Level eigenen Text und Bild/GIF zu geben');

    const imageModeValue = specific
        ? tr(L,
            '**Specific levels only** — only levels with their own image (per-level image, role reward image or custom level message) show an image.',
            '**Nur bestimmte Level** — nur Level mit eigenem Bild (Bild pro Level, Rollenbelohnungs-Bild oder eigene Level-Nachricht) zeigen ein Bild.')
        : tr(L,
            '**Every level-up** — the default image is shown every time; an image per level is used from that level on.',
            '**Jedes Level-up** — das Standardbild wird immer gezeigt; ein Bild pro Level gilt ab diesem Level.');

    const embed = new EmbedBuilder()
        .setTitle(tr(L, 'Level Log Channel & Message', 'Level-Kanal & Nachricht'))
        .setDescription(tr(L,
            'Choose where level-ups are posted and how the message looks.\nPlaceholders: `{user}` `{username}` `{level}` `{server}` `{role}`\nPriority: **custom level message** › **role reward message** › **normal message**.',
            'Wähle, wo Level-ups gepostet werden und wie die Nachricht aussieht.\nPlatzhalter: `{user}` `{username}` `{level}` `{server}` `{role}`\nReihenfolge: **eigene Level-Nachricht** › **Rollenbelohnungs-Nachricht** › **normale Nachricht**.'))
        .setColor(getColor('info'))
        .addFields(
            { name: tr(L, 'Posting', 'Posten'), value: announceLabel(a.mode, L), inline: true },
            { name: tr(L, 'Log channel', 'Level-Kanal'), value: a.channelId ? `<#${a.channelId}>` : tr(L, '`Not set`', '`Nicht gesetzt`'), inline: true },
            { name: tr(L, 'Style', 'Stil'), value: a.useEmbed ? 'Embed' : tr(L, 'Plain text', 'Nur Text'), inline: true },
            { name: tr(L, 'Normal message', 'Normale Nachricht'), value: `\`${a.message}\``.slice(0, 1024), inline: false },
            { name: tr(L, 'Embed title / colour', 'Embed-Titel / Farbe'), value: `${a.title ? `\`${a.title}\`` : tr(L, '`No title`', '`Kein Titel`')} · \`${a.color}\``, inline: true },
            {
                name: tr(L, 'Default image', 'Standardbild'),
                value: a.imageUrl
                    ? `[${tr(L, 'Open image', 'Bild öffnen')}](${a.imageUrl})${specific ? tr(L, ' (not used in "specific" mode)', ' (im Modus „bestimmte Level“ nicht genutzt)') : ''}`
                    : none,
                inline: true,
            },
            { name: tr(L, 'Images shown on', 'Bilder werden gezeigt bei'), value: imageModeValue, inline: false },
            { name: specific ? tr(L, 'Image for exact level', 'Bild für genaues Level') : tr(L, 'Images per level', 'Bilder pro Level'), value: levelImages, inline: false },
            { name: tr(L, 'Role reward message', 'Rollenbelohnungs-Nachricht'), value: rewardValue, inline: false },
            { name: tr(L, 'Custom level messages', 'Eigene Level-Nachrichten'), value: levelMsgValue, inline: false },
        )
        .setFooter({ text: tr(L,
            'Tip: use a permanent image/GIF link. Discord attachment links can expire.',
            'Tipp: Nutze einen dauerhaften Bild-/GIF-Link. Discord-Anhang-Links können ablaufen.') })
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('ann_mode')).setLabel(`${tr(L, 'Posting', 'Posten')}: ${(ANNOUNCE_SHORT[L] || ANNOUNCE_SHORT.en)[a.mode]}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('ann_embed')).setLabel(a.useEmbed ? tr(L, 'Style: Embed', 'Stil: Embed') : tr(L, 'Style: Text', 'Stil: Text')).setStyle(a.useEmbed ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('ann_message')).setLabel(tr(L, 'Edit Message', 'Nachricht bearbeiten')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('ann_image')).setLabel(tr(L, 'Default Image', 'Standardbild')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('ann_levelimg')).setLabel(tr(L, 'Image per Level', 'Bild pro Level')).setStyle(ButtonStyle.Primary),
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('ann_reward'))
            .setLabel(rm.enabled ? tr(L, 'Role Reward Message: On', 'Rollen-Nachricht: An') : tr(L, 'Role Reward Message: Off', 'Rollen-Nachricht: Aus'))
            .setStyle(rm.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('ann_lvlmsgs'))
            .setLabel(tr(L, `Custom Level Messages (${a.levelMessages.length})`, `Eigene Level-Nachrichten (${a.levelMessages.length})`))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('ann_imgmode'))
            .setLabel(specific ? tr(L, 'Images: Specific Levels', 'Bilder: Bestimmte Level') : tr(L, 'Images: Every Level-up', 'Bilder: Jedes Level-up'))
            .setStyle(specific ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(id('ann_channel'))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setPlaceholder(tr(L, 'Choose the level log channel...', 'Level-Kanal wählen...'))
        .setMinValues(1)
        .setMaxValues(1);
    if (a.channelId) channelSelect.setDefaultChannels(a.channelId);

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('ann_create')).setLabel(tr(L, 'Create New Channel', 'Neuen Kanal erstellen')).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id('ann_preview')).setLabel(tr(L, 'Preview', 'Vorschau')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('ann_back')).setLabel(tr(L, 'Back', 'Zurück')).setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row1, new ActionRowBuilder().addComponents(channelSelect), row3, row4] };
}

async function buildLevelMessagesView(guild, client, L = 'en') {
    const cfg = await getLevelingConfig(client, guild.id);
    const id = (action) => `lvl_${guild.id}_${action}`;
    const list = cfg.announce.levelMessages;

    const rewardLevels = new Map(cfg.roleRewards.map((r) => [r.level, r.roleId]));
    const lines = list.length
        ? list.map((m) => {
            const role = rewardLevels.has(m.level) ? tr(L, ` · gives <@&${rewardLevels.get(m.level)}>`, ` · gibt <@&${rewardLevels.get(m.level)}>`) : '';
            const text = m.message
                ? `\`${m.message.length > 80 ? `${m.message.slice(0, 80)}…` : m.message}\``
                : tr(L, '*normal message*', '*normale Nachricht*');
            const img = m.imageUrl ? ` · [${tr(L, 'image', 'Bild')}](${m.imageUrl})` : '';
            return `**Level ${m.level}**${role}\n${text}${img}`;
        }).join('\n\n')
        : tr(L,
            '*No custom level messages yet.*\nUse **Add / Edit** to give a level its own message and image or GIF — for example the levels that give a role.',
            '*Noch keine eigenen Level-Nachrichten.*\nNutze **Hinzufügen / Bearbeiten**, um einem Level eigene Nachricht und Bild oder GIF zu geben — z. B. den Leveln, die eine Rolle geben.');

    const missingRewardLevels = cfg.roleRewards
        .filter((r) => !list.some((m) => m.level === r.level))
        .map((r) => `\`${r.level}\``);

    const embed = new EmbedBuilder()
        .setTitle(tr(L, 'Custom Level Messages', 'Eigene Level-Nachrichten'))
        .setDescription(lines.slice(0, 4000))
        .setColor(getColor('info'))
        .addFields(
            { name: tr(L, 'Slots used', 'Belegte Plätze'), value: `\`${list.length}/${MAX_LEVEL_MESSAGES}\``, inline: true },
            {
                name: tr(L, 'Reward levels without own message', 'Belohnungs-Level ohne eigene Nachricht'),
                value: missingRewardLevels.join(' ').slice(0, 1024) || tr(L, '`None`', '`Keine`'),
                inline: true,
            },
        )
        .setFooter({ text: tr(L,
            'A custom level message is used only for that exact level. Leave the text empty to keep the normal text and only change the image.',
            'Eine eigene Level-Nachricht gilt nur für genau dieses Level. Lass den Text leer, um den normalen Text zu behalten und nur das Bild zu ändern.') })
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('lm_add')).setLabel(tr(L, 'Add / Edit', 'Hinzufügen / Bearbeiten')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('ann_preview')).setLabel(tr(L, 'Preview', 'Vorschau')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('lm_back')).setLabel(tr(L, 'Back', 'Zurück')).setStyle(ButtonStyle.Secondary),
    );
    const components = [buttons];

    if (list.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id('lm_remove'))
                .setPlaceholder(tr(L, 'Remove a custom level message...', 'Eigene Level-Nachricht entfernen...'))
                .addOptions(list.map((m) => new StringSelectMenuOptionBuilder()
                    .setLabel(`Level ${m.level}`)
                    .setDescription((m.message || tr(L, 'Image only', 'Nur Bild')).slice(0, 100))
                    .setValue(String(m.level)))),
        ));
    }

    return { embeds: [embed], components };
}

async function handleAnnounceMessageModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const cfg = await getLevelingConfig(client, guild.id);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_annmsg_${guild.id}`).setTitle(tr(L, 'Level-up Message', 'Level-up-Nachricht'));
    modal.addComponents(
        textInput('message', tr(L, 'Message ({user} {username} {level} {server})', 'Text ({user} {username} {level} {server})'), {
            value: cfg.announce.message, maxLength: 500, style: TextInputStyle.Paragraph,
        }),
        textInput('title', tr(L, 'Embed title (empty = no title)', 'Embed-Titel (leer = kein Titel)'), {
            value: cfg.announce.title, maxLength: 100, required: false,
        }),
        textInput('color', tr(L, 'Embed colour (hex, e.g. #5865F2)', 'Embed-Farbe (Hex, z. B. #5865F2)'), {
            value: cfg.announce.color, maxLength: 7, required: false,
        }),
    );
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const message = submitted.fields.getTextInputValue('message').trim();
    const title = submitted.fields.getTextInputValue('title').trim();
    const colorRaw = submitted.fields.getTextInputValue('color').trim();
    if (!message) {
        await validationError(submitted, tr(L, 'The message cannot be empty.', 'Die Nachricht darf nicht leer sein.'));
        return false;
    }
    const color = colorRaw ? colorOrNull(colorRaw) : cfg.announce.color;
    if (!color) {
        await validationError(submitted, tr(L, 'The colour must be a hex code like `#5865F2`.', 'Die Farbe muss ein Hex-Code wie `#5865F2` sein.'));
        return false;
    }

    await updateLevelingConfig(client, guild.id, { announce: { message, title, color } });
    await ephemeralReply(submitted, tr(L, 'Level-up message saved. Use **Preview** to see it.', 'Level-up-Nachricht gespeichert. Nutze **Vorschau**, um sie zu sehen.'));
    return true;
}

async function handleAnnounceImageModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const cfg = await getLevelingConfig(client, guild.id);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_annimg_${guild.id}`).setTitle(tr(L, 'Level-up Image', 'Level-up-Bild'));
    modal.addComponents(
        textInput('url', tr(L, 'Image link (https://...) - empty removes it', 'Bild-Link (https://...) - leer = entfernen'), {
            value: cfg.announce.imageUrl, maxLength: 500, required: false, placeholder: 'https://example.com/levelup.png',
        }),
    );
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const raw = submitted.fields.getTextInputValue('url').trim();
    const url = raw ? sanitizeImageUrl(raw) : null;
    if (raw && !url) {
        await validationError(submitted, tr(L, 'Please enter a valid image link starting with `https://`.', 'Bitte gib einen gültigen Bild-Link ein, der mit `https://` beginnt.'));
        return false;
    }
    await updateLevelingConfig(client, guild.id, { announce: { imageUrl: url } });
    await ephemeralReply(submitted, url
        ? tr(L, 'Default level-up image saved.', 'Standard-Level-up-Bild gespeichert.')
        : tr(L, 'Default level-up image removed.', 'Standard-Level-up-Bild entfernt.'));
    return true;
}

async function handleLevelImageModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_annlvlimg_${guild.id}`).setTitle(tr(L, 'Image per Level', 'Bild pro Level'));
    modal.addComponents(
        textInput('level', tr(L, `From which level on (1 - ${MAX_LEVEL})`, `Ab welchem Level (1 - ${MAX_LEVEL})`), { placeholder: '10', maxLength: 4 }),
        textInput('url', tr(L, 'Image link (https://...) - empty = remove', 'Bild-Link (https://...) - leer = entfernen'), {
            maxLength: 500, required: false, placeholder: 'https://example.com/level10.png',
        }),
    );
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const level = Number(submitted.fields.getTextInputValue('level').trim());
    const raw = submitted.fields.getTextInputValue('url').trim();
    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        await validationError(submitted, levelRangeError(L));
        return false;
    }

    const cfg = await getLevelingConfig(client, guild.id);
    const rest = cfg.announce.levelImages.filter((i) => i.level !== level);
    if (raw) {
        const url = sanitizeImageUrl(raw);
        if (!url) {
            await validationError(submitted, tr(L, 'Please enter a valid image link starting with `https://`.', 'Bitte gib einen gültigen Bild-Link ein, der mit `https://` beginnt.'));
            return false;
        }
        if (rest.length >= MAX_LEVEL_IMAGES) {
            await validationError(submitted, tr(L, `You can set at most ${MAX_LEVEL_IMAGES} level images.`, `Du kannst höchstens ${MAX_LEVEL_IMAGES} Level-Bilder festlegen.`));
            return false;
        }
        rest.push({ level, url });
    }
    await updateLevelingConfig(client, guild.id, { announce: { levelImages: rest } });
    await ephemeralReply(submitted, raw
        ? tr(L, `Image saved for level **${level}** and above.`, `Bild für Level **${level}** und höher gespeichert.`)
        : tr(L, `Image for level **${level}** removed.`, `Bild für Level **${level}** entfernt.`));
    return true;
}

async function handleCreateChannelModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_anncreate_${guild.id}`).setTitle(tr(L, 'Create Level Log Channel', 'Level-Kanal erstellen'));
    modal.addComponents(textInput('name', tr(L, 'Channel name', 'Kanalname'), { value: 'level-logs', maxLength: 90 }));
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const name = submitted.fields.getTextInputValue('name').trim().toLowerCase()
        .replace(/[^a-z0-9À-ɏ_\- ]/g, '').replace(/\s+/g, '-').slice(0, 90) || 'level-logs';

    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await replyUserError(submitted, {
            type: ErrorTypes.PERMISSION,
            message: tr(L,
                'I need the **Manage Channels** permission to create a channel. You can also pick an existing channel in the dashboard.',
                'Ich brauche die Berechtigung **Kanäle verwalten**, um einen Kanal zu erstellen. Du kannst auch einen bestehenden Kanal im Dashboard wählen.'),
        });
        return false;
    }

    try {
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            topic: tr(L, 'Level-up announcements', 'Level-up-Meldungen'),
            permissionOverwrites: [
                { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
                { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
            ],
            reason: `Level log channel created by ${submitted.user.tag}`,
        });
        await updateLevelingConfig(client, guild.id, { announce: { channelId: channel.id, mode: 'channel' } });
        await ephemeralReply(submitted, tr(L,
            `Created ${channel} (read-only for members) and set it as the level log channel.`,
            `${channel} erstellt (für Mitglieder nur lesbar) und als Level-Kanal festgelegt.`));
        return true;
    } catch (error) {
        logger.error('[LEVELING_DASHBOARD] Could not create channel:', error);
        await replyUserError(submitted, {
            type: ErrorTypes.UNKNOWN,
            message: tr(L,
                'I could not create the channel. Check my permissions and the server channel limit.',
                'Ich konnte den Kanal nicht erstellen. Prüfe meine Berechtigungen und das Kanal-Limit des Servers.'),
        });
        return false;
    }
}

const PREVIEW_KIND_LABELS = {
    en: { level: 'custom level message', reward: 'role reward message', default: 'normal message' },
    de: { level: 'eigene Level-Nachricht', reward: 'Rollenbelohnungs-Nachricht', default: 'normale Nachricht' },
};

async function sendAnnouncePreview(i, guild, client) {
    const L = getDashboardLocale(i);
    const cfg = await getLevelingConfig(client, guild.id);
    const suggested = cfg.announce.levelMessages[0]?.level
        ?? cfg.roleRewards[0]?.level
        ?? cfg.announce.levelImages[0]?.level
        ?? 10;

    const modal = new ModalBuilder().setCustomId(`lvl_modal_preview_${guild.id}_${i.id}`).setTitle(tr(L, 'Preview Level-up', 'Level-up-Vorschau'));
    modal.addComponents(textInput('level', tr(L, `Preview reaching which level? (1 - ${MAX_LEVEL})`, `Vorschau für welches Level? (1 - ${MAX_LEVEL})`), {
        value: suggested, maxLength: 4,
    }));
    const submitted = await openModal(i, modal);
    if (!submitted) return false;

    const level = Number(submitted.fields.getTextInputValue('level').trim());
    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        await validationError(submitted, levelRangeError(L));
        return false;
    }

    const context = { level, previousLevel: level - 1 };
    const payload = buildLevelUpMessage(guild, submitted.user, cfg, context);
    const resolved = resolveLevelUpAnnouncement(cfg.announce, {
        ...context,
        rewards: cfg.roleRewards,
        rolesEnabled: cfg.autoApplyRoles,
    });
    const kindLabel = (PREVIEW_KIND_LABELS[L] || PREVIEW_KIND_LABELS.en)[resolved.kind];
    const where = cfg.announce.mode === 'off'
        ? tr(L, 'Level-up messages are **off**, so nothing would be posted.', 'Level-up-Nachrichten sind **aus**, es würde also nichts gepostet.')
        : tr(L, `Uses the **${kindLabel}**.`, `Nutzt die **${kindLabel}**.`);

    await submitted.reply({
        ...payload,
        content: `${tr(L, `**Preview** (reaching level ${level})`, `**Vorschau** (Level ${level} erreicht)`)} — ${where}\n${payload.content ?? ''}`.slice(0, 2000),
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
    });
    return false;
}

async function handleRewardMessageModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const cfg = await getLevelingConfig(client, guild.id);
    const rm = cfg.announce.rewardMessage;
    const modal = new ModalBuilder().setCustomId(`lvl_modal_rewardmsg_${guild.id}`).setTitle(tr(L, 'Role Reward Message', 'Rollenbelohnungs-Nachricht'));
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel(tr(L, 'Use a different message for role level-ups?', 'Eigene Nachricht für Rollen-Level-ups?'))
            .setDescription(tr(L,
                'Sent instead of the normal message when the level-up gives a new level role',
                'Wird statt der normalen Nachricht gesendet, wenn das Level-up eine neue Level-Rolle gibt'))
            .setStringSelectMenuComponent(
                new StringSelectMenuBuilder()
                    .setCustomId('enabled')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .setRequired(true)
                    .addOptions(
                        { label: tr(L, 'On', 'An'), value: 'on', default: rm.enabled },
                        { label: tr(L, 'Off', 'Aus'), value: 'off', default: !rm.enabled },
                    ),
            ),
    );
    modal.addComponents(
        textInput('message', tr(L, 'Message ({user} {level} {role} {server})', 'Nachricht ({user} {level} {role} {server})'), {
            value: rm.message, maxLength: 500, style: TextInputStyle.Paragraph,
        }),
        textInput('title', tr(L, 'Embed title (empty = normal title)', 'Embed-Titel (leer = normaler Titel)'), {
            value: rm.title, maxLength: 100, required: false,
        }),
        textInput('url', tr(L, 'Image or GIF link (https://...) - optional', 'Bild- oder GIF-Link (https://...) - optional'), {
            value: rm.imageUrl, maxLength: 500, required: false, placeholder: 'https://example.com/new-role.gif',
        }),
    );

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const enabled = (submitted.fields.getStringSelectValues('enabled')[0] ?? 'off') === 'on';
    const message = submitted.fields.getTextInputValue('message').trim();
    const title = submitted.fields.getTextInputValue('title').trim();
    const rawUrl = submitted.fields.getTextInputValue('url').trim();
    const imageUrl = rawUrl ? sanitizeImageUrl(rawUrl) : null;

    if (!message) {
        await validationError(submitted, tr(L, 'The message cannot be empty.', 'Die Nachricht darf nicht leer sein.'));
        return false;
    }
    if (rawUrl && !imageUrl) {
        await validationError(submitted, tr(L,
            'Please enter a valid image or GIF link starting with `https://`.',
            'Bitte gib einen gültigen Bild- oder GIF-Link ein, der mit `https://` beginnt.'));
        return false;
    }

    await updateLevelingConfig(client, guild.id, {
        announce: { rewardMessage: { enabled, message, title, imageUrl } },
    });
    const note = enabled && !cfg.autoApplyRoles
        ? tr(L,
            '\nNote: **Auto Roles** is off, so level-ups give no role and this message is not used until you turn it on.',
            '\nHinweis: **Auto-Rollen** ist aus, daher geben Level-ups keine Rolle und diese Nachricht wird erst genutzt, wenn du es einschaltest.')
        : enabled && !cfg.roleRewards.length
            ? tr(L,
                '\nNote: no level reward roles are set yet. Add them under **Level Reward Roles**.',
                '\nHinweis: Es sind noch keine Level-Belohnungsrollen gesetzt. Füge sie unter **Level-Belohnungsrollen** hinzu.')
            : '';
    await ephemeralReply(submitted, tr(L,
        `Role reward message ${enabled ? 'turned **on**' : 'saved (currently **off**)'}. Use **Preview** with a reward level to see it.${note}`,
        `Rollenbelohnungs-Nachricht ${enabled ? '**eingeschaltet**' : 'gespeichert (derzeit **aus**)'}. Nutze **Vorschau** mit einem Belohnungs-Level, um sie zu sehen.${note}`));
    return true;
}

async function handleLevelMessageModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const cfg = await getLevelingConfig(client, guild.id);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_levelmsg_${guild.id}`).setTitle(tr(L, 'Custom Level Message', 'Eigene Level-Nachricht'));
    modal.addComponents(
        textInput('level', `Level (1 - ${MAX_LEVEL})`, { placeholder: '10', maxLength: 4 }),
        textInput('message', tr(L, 'Message (empty = keep the normal text)', 'Nachricht (leer = normaler Text)'), {
            maxLength: 500, required: false, style: TextInputStyle.Paragraph,
            placeholder: tr(L, '{user} hit level {level} and unlocked {role}! 🎉', '{user} hat Level {level} erreicht und {role} freigeschaltet! 🎉'),
        }),
        textInput('title', tr(L, 'Embed title (empty = normal title)', 'Embed-Titel (leer = normaler Titel)'), { maxLength: 100, required: false }),
        textInput('url', tr(L, 'Image or GIF link (https://...) - optional', 'Bild- oder GIF-Link (https://...) - optional'), {
            maxLength: 500, required: false, placeholder: 'https://example.com/level10.gif',
        }),
    );
    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const level = Number(submitted.fields.getTextInputValue('level').trim());
    const message = submitted.fields.getTextInputValue('message').trim();
    const title = submitted.fields.getTextInputValue('title').trim();
    const rawUrl = submitted.fields.getTextInputValue('url').trim();
    const imageUrl = rawUrl ? sanitizeImageUrl(rawUrl) : null;

    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        await validationError(submitted, levelRangeError(L));
        return false;
    }
    if (rawUrl && !imageUrl) {
        await validationError(submitted, tr(L,
            'Please enter a valid image or GIF link starting with `https://`.',
            'Bitte gib einen gültigen Bild- oder GIF-Link ein, der mit `https://` beginnt.'));
        return false;
    }
    if (!message && !imageUrl) {
        await validationError(submitted, tr(L,
            'Enter a message, an image link, or both. (To delete a level message use the remove menu.)',
            'Gib eine Nachricht, einen Bild-Link oder beides ein. (Zum Löschen einer Level-Nachricht nutze das Entfernen-Menü.)'));
        return false;
    }

    const rest = cfg.announce.levelMessages.filter((m) => m.level !== level);
    if (rest.length >= MAX_LEVEL_MESSAGES) {
        await validationError(submitted, tr(L,
            `You can set at most ${MAX_LEVEL_MESSAGES} custom level messages.`,
            `Du kannst höchstens ${MAX_LEVEL_MESSAGES} eigene Level-Nachrichten festlegen.`));
        return false;
    }
    rest.push({ level, message, title, imageUrl });
    await updateLevelingConfig(client, guild.id, { announce: { levelMessages: rest } });

    const reward = cfg.roleRewards.find((r) => r.level === level);
    await ephemeralReply(submitted, tr(L,
        `Custom message saved for level **${level}**${reward ? ` (this level gives <@&${reward.roleId}>)` : ''}.`,
        `Eigene Nachricht für Level **${level}** gespeichert${reward ? ` (dieses Level gibt <@&${reward.roleId}>)` : ''}.`));
    return true;
}

async function handleIgnoredModal(sel, guild, client, kind) {
    const L = getDashboardLocale(sel);
    const isChannels = kind === 'channels';
    const modal = new ModalBuilder()
        .setCustomId(`lvl_modal_ignore_${kind}_${guild.id}`)
        .setTitle(isChannels ? tr(L, 'Ignored Channels', 'Ignorierte Kanäle') : tr(L, 'Ignored Roles', 'Ignorierte Rollen'));

    const cfg = await getLevelingConfig(client, guild.id);

    const select = isChannels
        ? new ChannelSelectMenuBuilder()
            .setCustomId('ignored')
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildCategory)
        : new RoleSelectMenuBuilder().setCustomId('ignored');

    select.setMinValues(0).setMaxValues(10).setRequired(false)
        .setPlaceholder(tr(L, 'Select up to 10 (empty = clear list)', 'Bis zu 10 wählen (leer = Liste leeren)'));
    const current = (isChannels ? cfg.ignoredChannels : cfg.ignoredRoles).slice(0, 10);
    if (current.length) {
        if (isChannels) select.setDefaultChannels(current);
        else select.setDefaultRoles(current);
    }

    const label = new LabelBuilder()
        .setLabel(isChannels ? tr(L, 'Channels that give no XP', 'Kanäle ohne XP') : tr(L, 'Roles that gain no XP', 'Rollen ohne XP'))
        .setDescription(tr(L,
            'This replaces the current list. Submit with nothing selected to clear it.',
            'Ersetzt die aktuelle Liste. Ohne Auswahl absenden, um sie zu leeren.'));
    if (isChannels) label.setChannelSelectMenuComponent(select);
    else label.setRoleSelectMenuComponent(select);
    modal.addLabelComponents(label);

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const values = submitted.fields.getField('ignored')?.values ?? [];
    await updateLevelingConfig(client, guild.id, isChannels ? { ignoredChannels: values } : { ignoredRoles: values });
    await ephemeralReply(submitted, isChannels
        ? tr(L, `Ignored channels updated (${values.length}).`, `Ignorierte Kanäle aktualisiert (${values.length}).`)
        : tr(L, `Ignored roles updated (${values.length}).`, `Ignorierte Rollen aktualisiert (${values.length}).`));
    return true;
}

async function handleSetLevelModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_setlevel_${guild.id}`).setTitle(tr(L, 'Set User Level', 'Level setzen'));
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel(tr(L, 'Member', 'Mitglied'))
            .setDescription(tr(L, 'The member whose level you want to set', 'Das Mitglied, dessen Level du setzen willst'))
            .setUserSelectMenuComponent(
                new UserSelectMenuBuilder().setCustomId('target_user').setMinValues(1).setMaxValues(1).setRequired(true),
            ),
    );
    modal.addComponents(textInput('level', tr(L, `New level (0 – ${MAX_LEVEL})`, `Neues Level (0 – ${MAX_LEVEL})`), { placeholder: '10', maxLength: 4 }));

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const userId = submitted.fields.getField('target_user').values[0];
    const level = Number(submitted.fields.getTextInputValue('level').trim());
    if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) {
        await validationError(submitted, levelRangeError(L, 0));
        return false;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: tr(L, 'That user is not in this server.', 'Dieser Nutzer ist nicht auf diesem Server.') });
        return false;
    }
    if (member.user.bot) {
        await validationError(submitted, tr(L, 'Bots do not have levels.', 'Bots haben keine Level.'));
        return false;
    }

    await submitted.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await setUserLevel(client, guild, userId, level);
    await submitted.editReply({
        content: tr(L,
            `${member} is now level **${result.level}** (was ${result.previousLevel}).`,
            `${member} ist jetzt Level **${result.level}** (vorher ${result.previousLevel}).`)
            + (result.roles.added.length || result.roles.removed.length
                ? `\n${tr(L, 'Roles', 'Rollen')}: +${result.roles.added.length} / -${result.roles.removed.length}`
                : ''),
        allowedMentions: { parse: [] },
    });
    logger.info('[LEVELING_DASHBOARD] Level set', { adminId: submitted.user.id, targetUserId: userId, level });
    return true;
}

async function handleScanModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_scan_${guild.id}`).setTitle(tr(L, 'Import from Arcane', 'Aus Arcane importieren'));
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel(tr(L, 'Arcane level-up channel', 'Arcane-Level-up-Kanal'))
            .setDescription(tr(L,
                'The channel where Arcane posts "@user is now level N". Its full history is read.',
                'Der Kanal, in dem Arcane „@user is now level N“ postet. Der gesamte Verlauf wird gelesen.'))
            .setChannelSelectMenuComponent(
                new ChannelSelectMenuBuilder()
                    .setCustomId('scan_channel')
                    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(1)
                    .setMaxValues(1)
                    .setRequired(true),
            ),
    );
    modal.addComponents(textInput('scan_limit', tr(L, 'Max messages to read (default 50000)', 'Max. Nachrichten lesen (Standard 50000)'), {
        value: '50000', maxLength: 6, required: false,
    }));

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const channelId = submitted.fields.getField('scan_channel').values[0];
    const limit = Math.min(200_000, Math.max(100, Number(submitted.fields.getTextInputValue('scan_limit').trim()) || 50_000));
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
        await validationError(submitted, tr(L, 'That channel cannot be read.', 'Dieser Kanal kann nicht gelesen werden.'));
        return false;
    }

    const perms = channel.permissionsFor(guild.members.me);
    if (!perms?.has(['ViewChannel', 'ReadMessageHistory'])) {
        await replyUserError(submitted, {
            type: ErrorTypes.PERMISSION,
            message: tr(L,
                'I need **View Channel** and **Read Message History** in that channel.',
                'Ich brauche **Kanal ansehen** und **Nachrichtenverlauf lesen** in diesem Kanal.'),
        });
        return false;
    }

    await submitted.deferReply({ flags: MessageFlags.Ephemeral });
    await submitted.editReply({ content: tr(L,
        `Reading <#${channelId}>... this can take a few minutes for big channels.`,
        `Lese <#${channelId}>... bei großen Kanälen kann das einige Minuten dauern.`) });

    let lastEdit = 0;
    const scan = await scanArcaneAnnouncements(channel, {
        maxMessages: limit,
        onProgress: async (p) => {
            if (Date.now() - lastEdit < 5000) return;
            lastEdit = Date.now();
            await submitted.editReply({ content: tr(L,
                `Reading... scanned ${p.scanned} messages, found ${p.users} users so far.`,
                `Lese... ${p.scanned} Nachrichten gelesen, bisher ${p.users} Nutzer gefunden.`) });
        },
    });

    if (!scan.entries.length) {
        await submitted.editReply({
            content: tr(L,
                `Scanned ${scan.scanned} messages but found no level-up announcements. Make sure this is the channel Arcane posts level-ups in.`,
                `${scan.scanned} Nachrichten gelesen, aber keine Level-up-Meldungen gefunden. Prüfe, ob Arcane in diesem Kanal Level-ups postet.`),
        });
        return false;
    }

    await submitted.editReply({ content: tr(L,
        `Found **${scan.entries.length}** users. Importing levels and applying roles...`,
        `**${scan.entries.length}** Nutzer gefunden. Importiere Level und vergebe Rollen...`) });
    const summary = await importLevels(client, guild, scan.entries, { mode: 'max', applyRoles: true });
    await submitted.editReply({
        content: (L === 'de'
            ? [
                `**${scan.scanned}** Nachrichten gelesen, **${scan.matched}** Level-ups für **${scan.entries.length}** Nutzer gefunden.`,
                `**${summary.raised}** Nutzer erhöht, **${summary.unchanged}** waren bereits auf oder über diesem Level.`,
                `Rollen-Updates für **${summary.roleChanges}** Mitglieder.`,
                'Wer in diesem Kanal nie eine Level-up-Meldung ausgelöst hat, ist nicht enthalten. Nutze dafür `/levelconfig import` mit einer Datei.',
            ]
            : [
                `Scanned **${scan.scanned}** messages, found **${scan.matched}** level-ups for **${scan.entries.length}** users.`,
                `Raised **${summary.raised}** users, **${summary.unchanged}** were already at or above that level.`,
                `Role updates for **${summary.roleChanges}** members.`,
                'Anyone who never triggered a level-up message in this channel is not included. Use `/levelconfig import` with a file for those.',
            ]).join('\n'),
    });
    logger.info('[LEVELING_DASHBOARD] Arcane import', { adminId: submitted.user.id, users: scan.entries.length });
    return true;
}

async function handleRewardModal(sel, guild, client) {
    const L = getDashboardLocale(sel);
    const modal = new ModalBuilder().setCustomId(`lvl_modal_reward_${guild.id}`).setTitle(tr(L, 'Add / Edit Reward', 'Belohnung hinzufügen'));
    modal.addComponents(textInput('level', tr(L, `Level that grants the role (1 – ${MAX_LEVEL})`, `Level, das die Rolle gibt (1 – ${MAX_LEVEL})`), { placeholder: '5', maxLength: 4 }));
    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel(tr(L, 'Role', 'Rolle'))
            .setDescription(tr(L, 'Setting an existing level replaces its role', 'Ein bestehendes Level ersetzt seine Rolle'))
            .setRoleSelectMenuComponent(
                new RoleSelectMenuBuilder().setCustomId('reward_role').setMinValues(1).setMaxValues(1).setRequired(true),
            ),
    );

    const submitted = await openModal(sel, modal);
    if (!submitted) return false;

    const level = Number(submitted.fields.getTextInputValue('level').trim());
    const roleId = submitted.fields.getField('reward_role').values[0];
    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        await validationError(submitted, levelRangeError(L));
        return false;
    }

    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.id === guild.id || role.managed) {
        await validationError(submitted, tr(L,
            'That role cannot be used (everyone/managed roles are not allowed).',
            'Diese Rolle kann nicht genutzt werden (@everyone und verwaltete Rollen sind nicht erlaubt).'));
        return false;
    }
    const cfg = await getLevelingConfig(client, guild.id);
    const isNewLevel = !cfg.roleRewards.some((r) => r.level === level && r.roleId !== roleId);
    if (cfg.roleRewards.length >= MAX_REWARDS && isNewLevel && !cfg.roleRewards.some((r) => r.roleId === roleId)) {
        await validationError(submitted, tr(L,
            `You can configure at most ${MAX_REWARDS} reward roles.`,
            `Du kannst höchstens ${MAX_REWARDS} Belohnungsrollen einrichten.`));
        return false;
    }

    await setRoleReward(client, guild.id, level, roleId);
    const warn = role.position >= guild.members.me.roles.highest.position
        ? tr(L,
            '\nWarning: this role is above my highest role, so I cannot assign it. Move my role higher.',
            '\nWarnung: Diese Rolle ist über meiner höchsten Rolle, daher kann ich sie nicht vergeben. Schiebe meine Rolle höher.')
        : '';
    await ephemeralReply(submitted, tr(L, `Level **${level}** now gives ${role}.${warn}`, `Level **${level}** gibt jetzt ${role}.${warn}`));
    return true;
}

async function handleDetectDefaults(guild, client, L = 'en') {
    await guild.roles.fetch().catch(() => {});
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed);
    const { matched, missing } = matchTierRoles(roles, DEFAULT_ROLE_TIERS);

    if (matched.length) {
        const cfg = await getLevelingConfig(client, guild.id);
        const merged = new Map(cfg.roleRewards.map((r) => [r.level, r]));
        for (const m of matched) merged.set(m.level, m);
        await replaceRoleRewards(client, guild.id, normalizeRewards([...merged.values()]));
    }

    const matchedText = matched.map((m) => `Level ${m.level} → <@&${m.roleId}>`).join('\n') || tr(L, 'None', 'Keine');
    const missingList = missing.map((t) => `${t.name} (${t.level})`).join(', ');
    const missingText = missing.length ? tr(L, `\nNo role found for: ${missingList}`, `\nKeine Rolle gefunden für: ${missingList}`) : '';
    return tr(L,
        `Matched ${matched.length}/${DEFAULT_ROLE_TIERS.length} default roles by name:\n${matchedText}${missingText}`,
        `${matched.length}/${DEFAULT_ROLE_TIERS.length} Standardrollen per Name zugeordnet:\n${matchedText}${missingText}`);
}

async function runSync(followUpTarget, guild, client) {
    const L = getDashboardLocale(followUpTarget);
    const summary = await syncAllRoles(client, guild);
    await followUpTarget.followUp({
        content: `${tr(L, 'Role sync finished.', 'Rollenabgleich fertig.')}\n${describeSync(summary, L)}`,
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});
}

// ---------------------------------------------------------------- search

async function buildSearchEntries(guild, client, L = 'en') {
    const cfg = await getLevelingConfig(client, guild.id);
    const a = cfg.announce;
    const MAIN = tr(L, 'Main dashboard', 'Haupt-Dashboard');
    const ANN = tr(L, 'Level Log Channel & Message', 'Level-Kanal & Nachricht');
    const MENU = tr(L, 'menu', 'Menü');
    const BTN = tr(L, 'button', 'Button');

    const entries = [
        { title: tr(L, 'Enable / Disable Leveling', 'Leveling an / aus'), description: tr(L, `Currently ${onOff(cfg.enabled, L)}`, `Derzeit ${onOff(cfg.enabled, L)}`), location: `${MAIN} → ${BTN}`, keywords: ['on', 'off', 'toggle', 'xp', 'an', 'aus'], action: 'btn:toggle_enabled' },
        { title: tr(L, 'Auto-apply Level Roles', 'Level-Rollen automatisch vergeben'), description: tr(L, `Currently ${onOff(cfg.autoApplyRoles, L)}`, `Derzeit ${onOff(cfg.autoApplyRoles, L)}`), location: `${MAIN} → ${tr(L, 'Auto Roles button', 'Auto-Rollen-Button')}`, keywords: ['roles', 'reward', 'automatic', 'rollen', 'automatisch'], action: 'btn:toggle_roles' },
        { title: tr(L, 'Level Reward Roles', 'Level-Belohnungsrollen'), description: tr(L, `${cfg.roleRewards.length} configured`, `${cfg.roleRewards.length} eingerichtet`), location: `${MAIN} → ${MENU}`, keywords: ['role', 'reward', 'tier', 'rank', 'rolle', 'belohnung'], action: 'menu:rewards' },
        { title: tr(L, 'XP Speed', 'XP-Tempo'), description: `${cfg.xpMin}–${cfg.xpMax} XP × ${cfg.xpMultiplier}, ${cfg.cooldownSeconds}s cooldown`, location: `${MAIN} → ${MENU}`, keywords: ['xp', 'min', 'max', 'multiplier', 'cooldown', 'speed', 'boost', 'multiplikator', 'abklingzeit'], action: 'menu:xp' },
        { title: ANN, description: `${announceLabel(a.mode, L)}${a.channelId ? ` · <#${a.channelId}>` : ''}`, location: `${MAIN} → ${MENU}`, keywords: ['announce', 'level up', 'log', 'channel', 'message', 'kanal', 'nachricht'], action: 'menu:announce' },
        { title: tr(L, 'Set a User\'s Level', 'Level eines Mitglieds setzen'), description: tr(L, 'Set the level of any member', 'Das Level eines Mitglieds setzen'), location: `${MAIN} → ${MENU}`, keywords: ['user', 'member', 'level', 'set', 'change', 'mitglied', 'nutzer'], action: 'menu:setlevel' },
        { title: tr(L, 'Import Levels from Arcane', 'Level aus Arcane importieren'), description: tr(L, 'Scan the Arcane level-up channel', 'Arcane-Level-up-Kanal lesen'), location: `${MAIN} → ${MENU}`, keywords: ['arcane', 'import', 'migrate', 'scan', 'importieren'], action: 'menu:scan' },
        { title: tr(L, 'Ignored Channels', 'Ignorierte Kanäle'), description: tr(L, `${cfg.ignoredChannels.length} channel(s)`, `${cfg.ignoredChannels.length} Kanal/Kanäle`), location: `${MAIN} → ${MENU}`, keywords: ['ignore', 'no xp', 'blacklist', 'channel', 'ignoriert', 'kanal'], action: 'menu:ignored_channels' },
        { title: tr(L, 'Ignored Roles', 'Ignorierte Rollen'), description: tr(L, `${cfg.ignoredRoles.length} role(s)`, `${cfg.ignoredRoles.length} Rolle(n)`), location: `${MAIN} → ${MENU}`, keywords: ['ignore', 'no xp', 'blacklist', 'role', 'ignoriert', 'rolle'], action: 'menu:ignored_roles' },
        { title: tr(L, 'Sync All Roles Now', 'Alle Rollen jetzt abgleichen'), description: tr(L, 'Re-apply reward roles for every stored user', 'Belohnungsrollen für alle gespeicherten Nutzer neu vergeben'), location: `${MAIN} → ${MENU}`, keywords: ['sync', 'fix', 'roles', 'refresh', 'abgleichen', 'rollen'], action: 'menu:sync' },
        { title: tr(L, 'Auto-detect Default Roles', 'Standardrollen erkennen'), description: DEFAULT_ROLE_TIERS.map((t) => t.name).join(', '), location: tr(L, 'Level Reward Roles → button', 'Level-Belohnungsrollen → Button'), keywords: ['detect', 'default', 'tier', 'erkennen', 'standard'], action: 'btn:rw_detect' },
        { title: tr(L, 'Posting Mode', 'Posting-Modus'), description: announceLabel(a.mode, L), location: `${ANN} → ${tr(L, 'Posting button', 'Posten-Button')}`, keywords: ['same', 'channel', 'off', 'where', 'gleich', 'kanal', 'wo'], action: 'btn:ann_mode' },
        { title: tr(L, 'Message Style (Text / Embed)', 'Nachrichtenstil (Text / Embed)'), description: a.useEmbed ? 'Embed' : tr(L, 'Plain text', 'Nur Text'), location: `${ANN} → ${tr(L, 'Style button', 'Stil-Button')}`, keywords: ['embed', 'text', 'style', 'stil'], action: 'btn:ann_embed' },
        { title: tr(L, 'Normal Level-up Message', 'Normale Level-up-Nachricht'), description: a.message, location: `${ANN} → ${tr(L, 'Edit Message', 'Nachricht bearbeiten')}`, keywords: ['text', 'title', 'colour', 'color', 'titel', 'farbe', 'nachricht'], action: 'btn:ann_message' },
        { title: tr(L, 'Default Level-up Image', 'Standard-Level-up-Bild'), description: a.imageUrl ? tr(L, 'Set', 'Gesetzt') : tr(L, 'None', 'Keins'), location: `${ANN} → ${tr(L, 'Default Image', 'Standardbild')}`, keywords: ['picture', 'gif', 'image', 'bild'], action: 'btn:ann_image' },
        { title: tr(L, 'Image per Level', 'Bild pro Level'), description: tr(L, `${a.levelImages.length} level image(s)`, `${a.levelImages.length} Level-Bild(er)`), location: `${ANN} → ${tr(L, 'Image per Level', 'Bild pro Level')}`, keywords: ['picture', 'gif', 'image', 'level', 'bild'], action: 'btn:ann_levelimg' },
        { title: tr(L, 'Images Shown On (Every / Specific Levels)', 'Bilder bei (jedem / bestimmten Level)'), description: a.imageMode === 'specific' ? tr(L, 'Specific levels only', 'Nur bestimmte Level') : tr(L, 'Every level-up', 'Jedes Level-up'), location: `${ANN} → ${tr(L, 'Images button', 'Bilder-Button')}`, keywords: ['image', 'gif', 'only', 'specific', 'every', 'mode', 'bild', 'nur', 'bestimmte', 'jedes'], action: 'btn:ann_imgmode' },
        { title: tr(L, 'Role Reward Message', 'Rollenbelohnungs-Nachricht'), description: `${onOff(a.rewardMessage.enabled, L)} · ${a.rewardMessage.message}`, location: `${ANN} → ${tr(L, 'Role Reward Message', 'Rollen-Nachricht')}`, keywords: ['role', 'reward', 'new role', 'gif', 'image', 'different', 'rolle', 'belohnung', 'bild'], action: 'btn:ann_reward' },
        { title: tr(L, 'Custom Level Messages', 'Eigene Level-Nachrichten'), description: tr(L, `${a.levelMessages.length} level(s)`, `${a.levelMessages.length} Level`), location: `${ANN} → ${tr(L, 'Custom Level Messages', 'Eigene Level-Nachrichten')}`, keywords: ['custom', 'specific', 'level', 'message', 'gif', 'image', 'milestone', 'eigene', 'nachricht', 'bild'], action: 'view:levelmsgs' },
        { title: tr(L, 'Create Level Log Channel', 'Level-Kanal erstellen'), description: tr(L, 'Create a new read-only channel for level-ups', 'Neuen schreibgeschützten Kanal für Level-ups erstellen'), location: `${ANN} → ${tr(L, 'Create New Channel', 'Neuen Kanal erstellen')}`, keywords: ['new', 'channel', 'create', 'log', 'neu', 'kanal', 'erstellen'], action: 'btn:ann_create' },
        { title: tr(L, 'Preview Level-up Message', 'Level-up-Vorschau'), description: tr(L, 'See what a level-up looks like', 'Sieh, wie ein Level-up aussieht'), location: `${ANN} → ${tr(L, 'Preview', 'Vorschau')}`, keywords: ['preview', 'test', 'example', 'vorschau', 'beispiel'], action: 'btn:ann_preview' },
    ];

    for (const r of cfg.roleRewards) {
        const role = guild.roles.cache.get(r.roleId);
        entries.push({
            title: `Level ${r.level} → ${role ? `@${role.name}` : tr(L, 'missing role', 'fehlende Rolle')}`,
            description: tr(L, 'Level reward role', 'Level-Belohnungsrolle'),
            location: tr(L, 'Level Reward Roles', 'Level-Belohnungsrollen'),
            keywords: ['reward', 'role', 'belohnung', 'rolle', String(r.level), r.roleId],
            action: 'menu:rewards',
        });
    }
    for (const m of a.levelMessages) {
        entries.push({
            title: tr(L, `Custom message for level ${m.level}`, `Eigene Nachricht für Level ${m.level}`),
            description: m.message || tr(L, 'Image only', 'Nur Bild'),
            location: `${ANN} → ${tr(L, 'Custom Level Messages', 'Eigene Level-Nachrichten')}`,
            keywords: ['custom', 'level', 'eigene', String(m.level), m.imageUrl ? 'image gif bild' : ''],
            action: 'view:levelmsgs',
        });
    }
    for (const img of a.levelImages) {
        entries.push({
            title: tr(L, `Image for level ${img.level}`, `Bild für Level ${img.level}`) + (a.imageMode === 'specific' ? '' : '+'),
            description: img.url,
            location: `${ANN} → ${tr(L, 'Image per Level', 'Bild pro Level')}`,
            keywords: ['image', 'gif', 'picture', 'bild', String(img.level)],
            action: 'menu:announce',
        });
    }
    for (const channelId of cfg.ignoredChannels) {
        const channel = guild.channels.cache.get(channelId);
        entries.push({ title: `#${channel?.name ?? channelId}`, description: tr(L, 'Ignored channel (gives no XP)', 'Ignorierter Kanal (gibt keine XP)'), location: tr(L, 'Ignored Channels', 'Ignorierte Kanäle'), keywords: ['ignored', 'ignoriert', channelId], action: 'menu:ignored_channels' });
    }
    for (const roleId of cfg.ignoredRoles) {
        const role = guild.roles.cache.get(roleId);
        entries.push({ title: `@${role?.name ?? roleId}`, description: tr(L, 'Ignored role (gains no XP)', 'Ignorierte Rolle (bekommt keine XP)'), location: tr(L, 'Ignored Roles', 'Ignorierte Rollen'), keywords: ['ignored', 'ignoriert', roleId], action: 'menu:ignored_roles' });
    }

    return entries;
}

// ---------------------------------------------------------------- entry point

const VIEW_BUILDERS = {
    main: buildMainView,
    rewards: buildRewardsView,
    announce: buildAnnounceView,
    levelmsgs: buildLevelMessagesView,
};

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        const L = getDashboardLocale(interaction);
        try {
            const guild = interaction.guild;
            const state = { view: 'main' };
            const prefix = `lvl_${guild.id}_`;

            const render = async () => {
                const build = VIEW_BUILDERS[state.view] ?? buildMainView;
                await InteractionHelper.safeEditReply(interaction, await build(guild, client, L)).catch(() => {});
            };

            await InteractionHelper.safeEditReply(interaction, await buildMainView(guild, client, L));

            /** Button actions. `i` may also be a pick from the search results. */
            const runButton = async (i, action) => {
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
                    case 'search':
                        await openDashboardSearch(i, {
                            dashboardName: 'Leveling',
                            locale: L,
                            placeholder: tr(L, 'e.g. role, gif, cooldown, arcane', 'z. B. Rolle, GIF, Abklingzeit, Arcane'),
                            getEntries: () => buildSearchEntries(guild, client, L),
                            onPick: (pick, picked) => runPicked(pick, picked),
                        });
                        return; // the search reply handles itself
                    case 'open_announce':
                        await i.deferUpdate();
                        state.view = 'announce';
                        break;
                    case 'ann_mode': {
                        await i.deferUpdate();
                        const cfg = await getLevelingConfig(client, guild.id);
                        const next = ANNOUNCE_MODES[(ANNOUNCE_MODES.indexOf(cfg.announce.mode) + 1) % ANNOUNCE_MODES.length];
                        await updateLevelingConfig(client, guild.id, { announce: { mode: next } });
                        break;
                    }
                    case 'ann_embed': {
                        await i.deferUpdate();
                        const cfg = await getLevelingConfig(client, guild.id);
                        await updateLevelingConfig(client, guild.id, { announce: { useEmbed: !cfg.announce.useEmbed } });
                        break;
                    }
                    case 'ann_imgmode': {
                        await i.deferUpdate();
                        const cfg = await getLevelingConfig(client, guild.id);
                        const next = cfg.announce.imageMode === 'specific' ? 'every' : 'specific';
                        await updateLevelingConfig(client, guild.id, { announce: { imageMode: next } });
                        break;
                    }
                    case 'ann_message':
                        await handleAnnounceMessageModal(i, guild, client);
                        break;
                    case 'ann_image':
                        await handleAnnounceImageModal(i, guild, client);
                        break;
                    case 'ann_levelimg':
                        await handleLevelImageModal(i, guild, client);
                        break;
                    case 'ann_reward':
                        await handleRewardMessageModal(i, guild, client);
                        break;
                    case 'ann_lvlmsgs':
                        await i.deferUpdate();
                        state.view = 'levelmsgs';
                        break;
                    case 'lm_add':
                        await handleLevelMessageModal(i, guild, client);
                        break;
                    case 'lm_back':
                        await i.deferUpdate();
                        state.view = 'announce';
                        break;
                    case 'ann_create':
                        await handleCreateChannelModal(i, guild, client);
                        break;
                    case 'ann_preview':
                        await sendAnnouncePreview(i, guild, client);
                        return; // nothing changed
                    case 'ann_back':
                        await i.deferUpdate();
                        state.view = 'main';
                        break;
                    case 'rw_add':
                        await handleRewardModal(i, guild, client);
                        break;
                    case 'rw_detect': {
                        await i.deferReply({ flags: MessageFlags.Ephemeral });
                        const text = await handleDetectDefaults(guild, client, getDashboardLocale(i));
                        await i.editReply({ content: text, allowedMentions: { parse: [] } });
                        break;
                    }
                    case 'rw_sync': {
                        await i.deferReply({ flags: MessageFlags.Ephemeral });
                        await i.editReply({ content: tr(getDashboardLocale(i),
                            'Syncing roles... I will post the result here when it is done.',
                            'Gleiche Rollen ab... Ich poste das Ergebnis hier, sobald ich fertig bin.') });
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
                await render();
            };

            /** Main menu choices. `i` may also be a pick from the search results. */
            const runMenu = async (i, choice) => {
                switch (choice) {
                    case 'rewards':
                        await i.deferUpdate();
                        state.view = 'rewards';
                        break;
                    case 'xp':
                        await handleXpModal(i, guild, client);
                        break;
                    case 'announce':
                        await i.deferUpdate();
                        state.view = 'announce';
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
                        await i.editReply({ content: tr(getDashboardLocale(i),
                            'Syncing roles... I will post the result here when it is done.',
                            'Gleiche Rollen ab... Ich poste das Ergebnis hier, sobald ich fertig bin.') });
                        await runSync(i, guild, client);
                        break;
                    default:
                        await i.deferUpdate().catch(() => {});
                }
                await render();
            };

            /** A result picked in the search reply: open that setting on the dashboard. */
            const runPicked = async (pick, picked) => {
                const [kind, value] = String(picked).split(':');
                if (kind === 'menu') return runMenu(pick, value);
                if (kind === 'btn') return runButton(pick, value);
                if (kind === 'view' && VIEW_BUILDERS[value]) {
                    await pick.deferUpdate();
                    state.view = value;
                    await render();
                }
                return undefined;
            };

            const source = interaction.channel ?? await interaction.fetchReply();
            const collector = source.createMessageComponentCollector({
                filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(prefix),
                time: 600_000,
            });

            collector.on('collect', async (i) => {
                const action = i.customId.slice(prefix.length);
                try {
                    if (i.componentType === ComponentType.Button) {
                        await runButton(i, action);
                        return;
                    }
                    if (i.componentType === ComponentType.StringSelect) {
                        const choice = i.values[0];
                        if (action === 'menu') {
                            await runMenu(i, choice);
                            return;
                        }
                        await i.deferUpdate();
                        if (action === 'rw_remove') {
                            await removeRoleReward(client, guild.id, Number(choice));
                        } else if (action === 'lm_remove') {
                            const cfg = await getLevelingConfig(client, guild.id);
                            await updateLevelingConfig(client, guild.id, {
                                announce: { levelMessages: cfg.announce.levelMessages.filter((m) => m.level !== Number(choice)) },
                            });
                        }
                    } else if (i.componentType === ComponentType.ChannelSelect) {
                        await i.deferUpdate();
                        if (action === 'ann_channel') {
                            await updateLevelingConfig(client, guild.id, { announce: { channelId: i.values[0], mode: 'channel' } });
                        }
                    } else {
                        await i.deferUpdate().catch(() => {});
                    }
                    await render();
                } catch (error) {
                    logger.error('Leveling dashboard error:', error);
                    if (!i.replied && !i.deferred) await i.deferUpdate().catch(() => {});
                    await replyUserError(i, {
                        type: ErrorTypes.UNKNOWN,
                        message: tr(getDashboardLocale(i),
                            'Something went wrong while processing that action.',
                            'Beim Ausführen dieser Aktion ist etwas schiefgelaufen.'),
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_collected, reason) => {
                if (reason !== 'time') return;
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle(tr(L, 'Dashboard Timed Out', 'Dashboard abgelaufen'))
                    .setDescription(tr(L,
                        'This dashboard was closed due to inactivity. Run `/levelconfig dashboard` again to continue.',
                        'Dieses Dashboard wurde wegen Inaktivität geschlossen. Führe `/levelconfig dashboard` erneut aus, um fortzufahren.'))
                    .setColor(getColor('error'));
                await InteractionHelper.safeEditReply(interaction, { embeds: [timeoutEmbed], components: [] }).catch(() => {});
            });
        } catch (error) {
            logger.error('leveling_dashboard error:', error);
            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: tr(L, 'Failed to open the leveling dashboard.', 'Das Level-Dashboard konnte nicht geöffnet werden.'),
            });
        }
    },
};
