import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { ModerationService } from './moderation/moderationService.js';
import { logger } from '../utils/logger.js';

const ACTION_LABELS = {
    ban: 'gebannt',
    kick: 'gekickt',
    timeout: 'stummgeschaltet',
};

const REQUIRED_PERMISSIONS = {
    ban: PermissionFlagsBits.BanMembers,
    kick: PermissionFlagsBits.KickMembers,
    timeout: PermissionFlagsBits.ModerateMembers,
};

const TARGET_CAPABILITIES = {
    ban: 'bannable',
    kick: 'kickable',
    timeout: 'moderatable',
};

const recentTriggers = new Set();
const TRIGGER_COOLDOWN_MS = 10_000;

export function formatHoneypotMessage(template, { server, user, action }) {
    const replacements = { server, user, action };
    return String(template ?? '')
        .replace(/\{(server|user|action)\}/g, (_match, key) => replacements[key] ?? '')
        .slice(0, 2000);
}

export function isHoneypotExempt(member, guild) {
    return (
        member.id === guild.ownerId
        || member.permissions.has(PermissionFlagsBits.Administrator)
        || member.permissions.has(PermissionFlagsBits.ManageGuild)
    );
}

export async function performHoneypotAction({
    guild,
    member,
    settings,
    moderationService = ModerationService,
}) {
    const action = settings.action;
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember || !REQUIRED_PERMISSIONS[action]) {
        logger.warn(`Honeypot action ${action} unavailable in guild ${guild.id}`);
        return false;
    }

    if (
        !botMember.permissions.has(REQUIRED_PERMISSIONS[action])
        || !member[TARGET_CAPABILITIES[action]]
    ) {
        logger.warn(`Bot cannot ${action} honeypot target ${member.id} in guild ${guild.id}`);
        return false;
    }

    const reason = `Honeypot: Nachricht im verbotenen Kanal #${member.guild.channels.cache.get(settings.channelId)?.name || 'unknown'}`;
    if (settings.dmEnabled && settings.dmMessage.trim()) {
        const content = formatHoneypotMessage(settings.dmMessage, {
            server: guild.name,
            user: member.user.username,
            action: ACTION_LABELS[action],
        });
        try {
            await member.user.send({ content, allowedMentions: { parse: [] } });
        } catch (error) {
            logger.warn(`Could not send honeypot DM to ${member.id} in guild ${guild.id}:`, error.message);
        }
    }

    const moderator = botMember;
    if (action === 'ban') {
        await moderationService.banUser({
            guild,
            user: member.user,
            moderator,
            reason,
            deleteDays: 0,
        });
    } else if (action === 'kick') {
        await moderationService.kickUser({ guild, member, moderator, reason });
    } else {
        await moderationService.timeoutUser({
            guild,
            member,
            moderator,
            durationMs: settings.timeoutMinutes * 60_000,
            reason,
        });
    }

    return true;
}

export async function handleHoneypotMessage(message) {
    if (
        !message?.guild
        || message.author?.bot
        || message.webhookId
        || message.system
    ) {
        return false;
    }

    const config = await getGuildConfig(message.client, message.guild.id);
    const settings = config.honeypot;
    if (!settings?.enabled || settings.channelId !== message.channelId) {
        return false;
    }

    const triggerKey = `${message.guild.id}:${message.author.id}`;
    if (recentTriggers.has(triggerKey)) return true;
    recentTriggers.add(triggerKey);

    try {
        const member = message.member
            || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member || isHoneypotExempt(member, message.guild)) return true;

        await performHoneypotAction({
            guild: message.guild,
            member,
            settings,
        });
    } catch (error) {
        logger.error(`Failed to process honeypot message from ${message.author.id} in guild ${message.guild.id}:`, error);
    } finally {
        const timer = setTimeout(() => recentTriggers.delete(triggerKey), TRIGGER_COOLDOWN_MS);
        timer.unref?.();
    }

    return true;
}
