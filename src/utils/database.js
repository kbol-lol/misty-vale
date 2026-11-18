// database.js — facade re-exporting split modules for backward compatibility

import { pgDb } from './postgresDatabase.js';
import { logger } from './logger.js';
import { BotConfig } from '../config/bot.js';

export {
    db,
    initializeDatabase,
    getFromDb,
    setInDb,
    deleteFromDb,
} from './database/wrapper.js';

export {
    getGuildConfigKey,
    getScheduleTasksKey,
    getScheduleActivityKey,
    getTicketKey,
    getTicketCounterKey,
    getInviteTrackingKey,
    getMemberInvitesKey,
    getInviteUsesKey,
    getFakeAccountKey,
    getEconomyKey,
    getEconomyPrefix,
    getAFKKey,
    getWelcomeConfigKey,
    getJoinToCreateConfigKey,
    getJoinToCreateChannelsKey,
    getWarningsKey,
    getWarningsPrefix,
    getUserNotesKey,
    getUserNotesListKey,
    getReactionRoleKey,
    getReactionRolesPrefix,
    getServerCountersKey,
    getGiveawayEntryKey,
    getGiveawayLockKey,
    canonicalizeKey,
    getLegacyVariantsForCanonical,
} from './database/keys.js';

export {
    getTicketData,
    getOpenTicketCountForUser,
    saveTicketData,
    deleteTicketData,
    getTicketCounter,
    incrementTicketCounter,
    getGuildTicketStats,
} from './database/tickets.js';

import { db, getFromDb, setInDb } from './database/wrapper.js';
import {
    getGuildConfigKey,
    getJoinToCreateConfigKey,
    getJoinToCreateChannelsKey,
    getWelcomeConfigKey,
    getEconomyKey,
    getAFKKey,
} from './database/keys.js';

export async function insertVerificationAudit(record) {
    try {
        if (!db.initialized) {
            await db.initialize();
        }

        if (db.isAvailable() && typeof pgDb.insertVerificationAudit === 'function') {
            return await pgDb.insertVerificationAudit(record);
        }

        const key = `verification:audit:${record.guildId}`;
        const existing = await getFromDb(key, []);
        const auditEntries = Array.isArray(existing) ? existing : [];
        const maxInMemoryAuditEntries = BotConfig?.verification?.maxInMemoryAuditEntries ?? 1000;

        auditEntries.push({
            ...record,
            createdAt: record.createdAt || new Date().toISOString()
        });

        if (auditEntries.length > maxInMemoryAuditEntries) {
            auditEntries.splice(0, auditEntries.length - maxInMemoryAuditEntries);
        }

        await setInDb(key, auditEntries);
        return true;
    } catch (error) {
        logger.error('Error storing verification audit:', error);
        return false;
    }
}

export function unwrapReplitData(data) {
    if (
        typeof data === "object" &&
        data !== null &&
        data.ok !== undefined &&
        data.value !== undefined
    ) {
        return unwrapReplitData(data.value);
    }
    return data;
}

// Guild config access: import from services/config/guildConfig.js only.
// Low-level storage lives in ./database/guildConfigStorage.js

export { pgDb };

export const getMessage = (key, replacements = {}) => {
    let message = BotConfig.messages[key] || key;
    for (const [k, v] of Object.entries(replacements)) {
        message = message.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
    return message;
};

export const getColor = (path, fallback = "#000000") => {
    const parts = path.split(".");
    let current = BotConfig.embeds.colors;

    for (const part of parts) {
        if (current[part] === undefined) {
            logger.warn(`Color path '${path}' not found in config, using fallback`);
            return fallback;
        }
        current = current[part];
    }

    return typeof current === "string" ? current : fallback;
};

function isPostgresSqlReady(dbWrapper) {
    return Boolean(
        dbWrapper?.db?.pool &&
        typeof dbWrapper.db.isAvailable === 'function' &&
        dbWrapper.db.isAvailable(),
    );
}

async function getEndedGiveawaysFromKv(client) {
    const wrapper = client?.db;
    if (!wrapper || typeof wrapper.list !== 'function' || typeof wrapper.get !== 'function') {
        return [];
    }

    const keys = await wrapper.list('guild:');
    const ended = [];
    const now = Date.now();

    for (const key of keys) {
        if (!key.endsWith(':giveaways')) {
            continue;
        }

        const guildId = key.split(':')[1];
        if (!guildId) {
            continue;
        }

        const rawGiveaways = await wrapper.get(key, {});
        const unwrapped = unwrapReplitData(rawGiveaways) || {};
        const giveaways = Array.isArray(unwrapped) ? unwrapped : Object.values(unwrapped);

        for (const giveaway of giveaways) {
            if (!giveaway?.messageId || giveaway.ended || giveaway.isEnded) {
                continue;
            }

            const endTime = giveaway.endsAt || giveaway.endTime;
            if (!endTime || now < Number(endTime)) {
                continue;
            }

            ended.push({
                id: giveaway.id || giveaway.messageId,
                guild_id: guildId,
                message_id: giveaway.messageId,
                data: giveaway,
                ends_at: new Date(Number(endTime)),
            });
        }
    }

    return ended.sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
}

export async function getEndedGiveaways(client) {
    try {
        const wrapper = client?.db;
        if (!wrapper || typeof wrapper.get !== 'function') {
            return [];
        }

        if (isPostgresSqlReady(wrapper)) {
            const { pgConfig } = await import('../config/database/postgres.js');

            const result = await wrapper.db.pool.query(
                `SELECT id, guild_id, message_id, data, ends_at 
                 FROM ${pgConfig.tables.giveaways} 
                 WHERE ends_at <= NOW() 
                 AND COALESCE((data->>'ended')::boolean, false) = false
                 ORDER BY ends_at ASC`,
            );

            return result.rows || [];
        }

        if (wrapper.isDegraded?.()) {
            logger.debug('Postgres SQL unavailable for ended giveaways; scanning key-value store');
        }

        return await getEndedGiveawaysFromKv(client);
    } catch (error) {
        logger.error('Error getting ended giveaways:', error);
        try {
            return await getEndedGiveawaysFromKv(client);
        } catch {
            return [];
        }
    }
}

export async function markGiveawayEnded(client, giveawayId, endedData) {
    try {
        const wrapper = client?.db;
        if (!wrapper || typeof wrapper.get !== 'function') {
            return false;
        }

        if (isPostgresSqlReady(wrapper)) {
            const { pgConfig } = await import('../config/database/postgres.js');

            await wrapper.db.pool.query(
                `UPDATE ${pgConfig.tables.giveaways} 
                 SET data = $1, updated_at = NOW() 
                 WHERE id = $2`,
                [endedData, giveawayId],
            );

            return true;
        }

        const guildId = endedData?.guildId;
        if (!guildId || !endedData?.messageId) {
            return false;
        }

        const { saveGiveaway } = await import('./giveaways.js');
        return saveGiveaway(client, guildId, endedData);
    } catch (error) {
        logger.error('Error marking giveaway as ended:', error);
        return false;
    }
}

function normalizeWelcomeConfig(raw = {}) {
    const base = typeof raw === "object" && raw !== null ? raw : {};

    const channelId = base.channelId ?? null;
    const goodbyeChannelId = base.goodbyeChannelId ?? null;

    const welcomeMessage = base.welcomeMessage ?? "Welcome {user} to {server}!";
    const leaveMessage = base.leaveMessage ?? "{user.tag} has left the server.";

    const welcomeEmbed = base.welcomeEmbed ?? {
        title: "🎉 Welcome!",
        description: "Welcome {user} to {server}!",
        color: getColor("success"),
        thumbnail: true,
        footer: "Welcome to {server}!"
    };

    const leaveEmbed = base.leaveEmbed ?? {
        title: "👋 Goodbye",
        description: "{user.tag} has left the server.",
        color: getColor("error"),
        thumbnail: true,
        footer: "Goodbye from {server}!"
    };

    const roleIds = Array.isArray(base.roleIds) ? base.roleIds : [];

    return {
        ...base,
        enabled: Boolean(base.enabled),
        channelId,
        welcomeMessage,
        welcomeEmbed,
        welcomePing: Boolean(base.welcomePing),
        welcomeImage: base.welcomeImage ?? null,
        goodbyeEnabled: Boolean(base.goodbyeEnabled),
        goodbyeChannelId,
        leaveMessage,
        leaveEmbed,
        dmMessage: base.dmMessage ?? "",
        goodbyePing: Boolean(base.goodbyePing),
        roleIds,
        autoRoleDelay: base.autoRoleDelay ?? 0,
        joinLogs: base.joinLogs ?? { enabled: false, channelId: null },
        leaveLogs: base.leaveLogs ?? { enabled: false, channelId: null }
    };
}

export async function getWelcomeConfig(client, guildId) {
    if (!client.db) {
        logger.warn('Database not available for getWelcomeConfig');
        return normalizeWelcomeConfig();
    }
    
    const key = getWelcomeConfigKey(guildId);
    try {
        const config = await client.db.get(key, {});
        const unwrapped = unwrapReplitData(config);
        return normalizeWelcomeConfig(unwrapped);
    } catch (error) {
        logger.error(`Error getting welcome config for guild ${guildId}:`, error);
        return normalizeWelcomeConfig();
    }
}

export async function saveWelcomeConfig(client, guildId, config) {
    const key = getWelcomeConfigKey(guildId);
    try {
        if (!client.db || typeof client.db.set !== 'function') {
            logger.error('Database client is not available for saveWelcomeConfig.');
            return false;
        }

        const existingConfig = await getWelcomeConfig(client, guildId);
        const mergedConfig = { ...existingConfig, ...config };
        
        await client.db.set(key, mergedConfig);
        return true;
    } catch (error) {
        logger.error(`Error saving welcome config for guild ${guildId}:`, error);
        return false;
    }
}

export async function updateWelcomeConfig(client, guildId, updates) {
    try {
        const currentConfig = await getWelcomeConfig(client, guildId);
        const updatedConfig = { ...currentConfig, ...updates };
        
        await saveWelcomeConfig(client, guildId, updatedConfig);
        return updatedConfig;
    } catch (error) {
        logger.error(`Error updating welcome config for guild ${guildId}:`, error);
        throw error;
    }
}

export async function getJoinToCreateConfig(client, guildId) {
    if (!client.db) {
        logger.warn('Database not available for getJoinToCreateConfig');
        return {
            enabled: false,
            triggerChannels: [],
            categoryId: null,
            channelNameTemplate: "{username}'s Room",
            userLimit: 0,
            bitrate: 64000,
            temporaryChannels: {}
        };
    }
    
    const key = getJoinToCreateConfigKey(guildId);
    try {
        const config = await client.db.get(key, {});
        const unwrapped = unwrapReplitData(config);
        
        return {
            enabled: unwrapped.enabled || false,
            triggerChannels: unwrapped.triggerChannels || [],
            categoryId: unwrapped.categoryId || null,
            channelNameTemplate: unwrapped.channelNameTemplate || "{username}'s Room",
            userLimit: unwrapped.userLimit || 0,
            bitrate: unwrapped.bitrate || 64000,
            temporaryChannels: unwrapped.temporaryChannels || {},
            ...unwrapped
        };
    } catch (error) {
        logger.error(`Error getting Join to Create config for guild ${guildId}:`, error);
        return {
            enabled: false,
            triggerChannels: [],
            categoryId: null,
            channelNameTemplate: "{username}'s Room",
            userLimit: 0,
            bitrate: 64000,
            temporaryChannels: {}
        };
    }
}

export async function saveJoinToCreateConfig(client, guildId, config) {
    const key = getJoinToCreateConfigKey(guildId);
    try {
        const existingConfig = await getJoinToCreateConfig(client, guildId);
        const mergedConfig = { ...existingConfig, ...config };
        
        await client.db.set(key, mergedConfig);
        return true;
    } catch (error) {
        logger.error(`Error saving Join to Create config for guild ${guildId}:`, error);
        return false;
    }
}

export async function updateJoinToCreateConfig(client, guildId, updates) {
    try {
        const currentConfig = await getJoinToCreateConfig(client, guildId);
        const updatedConfig = { ...currentConfig, ...updates };
        
        await saveJoinToCreateConfig(client, guildId, updatedConfig);
        return updatedConfig;
    } catch (error) {
        logger.error(`Error updating Join to Create config for guild ${guildId}:`, error);
        throw error;
    }
}

export async function addJoinToCreateTrigger(client, guildId, channelId, options = {}) {
    try {
        const config = await getJoinToCreateConfig(client, guildId);
        
        if (config.triggerChannels.includes(channelId)) {
            return false;
        }
        
        config.triggerChannels.push(channelId);
        config.enabled = config.triggerChannels.length > 0;
        
        if (Object.keys(options).length > 0) {
            if (!config.channelOptions) {
                config.channelOptions = {};
            }
            config.channelOptions[channelId] = {
                nameTemplate: options.nameTemplate || config.channelNameTemplate,
                userLimit: options.userLimit || config.userLimit,
                bitrate: options.bitrate || config.bitrate
            };
        }
        
        return await saveJoinToCreateConfig(client, guildId, config);
    } catch (error) {
        logger.error(`Error adding Join to Create trigger for guild ${guildId}:`, error);
        return false;
    }
}

export async function removeJoinToCreateTrigger(client, guildId, channelId) {
    try {
        const config = await getJoinToCreateConfig(client, guildId);
        
        const index = config.triggerChannels.indexOf(channelId);
        if (index === -1) {
            return false;
        }
        
        config.triggerChannels.splice(index, 1);
        config.enabled = config.triggerChannels.length > 0;
        
        if (config.channelOptions && config.channelOptions[channelId]) {
            delete config.channelOptions[channelId];
        }
        
        return await saveJoinToCreateConfig(client, guildId, config);
    } catch (error) {
        logger.error(`Error removing Join to Create trigger for guild ${guildId}:`, error);
        return false;
    }
}

export async function registerTemporaryChannel(client, guildId, channelId, ownerId, triggerChannelId) {
    try {
        const config = await getJoinToCreateConfig(client, guildId);
        
        config.temporaryChannels[channelId] = {
            ownerId,
            triggerChannelId,
            createdAt: Date.now()
        };
        
        return await saveJoinToCreateConfig(client, guildId, config);
    } catch (error) {
        logger.error(`Error registering temporary channel for guild ${guildId}:`, error);
        return false;
    }
}

export async function unregisterTemporaryChannel(client, guildId, channelId) {
    try {
        const config = await getJoinToCreateConfig(client, guildId);
        
        if (config.temporaryChannels[channelId]) {
            delete config.temporaryChannels[channelId];
            return await saveJoinToCreateConfig(client, guildId, config);
        }
        
        return false;
    } catch (error) {
        logger.error(`Error unregistering temporary channel for guild ${guildId}:`, error);
        return false;
    }
}

export async function getTemporaryChannelInfo(client, guildId, channelId) {
    try {
        const config = await getJoinToCreateConfig(client, guildId);
        return config.temporaryChannels[channelId] || null;
    } catch (error) {
        logger.error(`Error getting temporary channel info for guild ${guildId}:`, error);
        return null;
    }
}

export function formatChannelName(template, variables) {
    let formatted = template;
    
    const replacements = {
        '{username}': variables.username || 'User',
        '{user_tag}': variables.userTag || 'User#0000',
        '{display_name}': variables.displayName || 'User',
        '{guild_name}': variables.guildName || 'Server',
        '{channel_name}': variables.channelName || 'Voice Channel'
    };
    
    for (const [placeholder, value] of Object.entries(replacements)) {
        formatted = formatted.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
    }
    
    formatted = formatted.replace(/[^\w\s-]/g, '').trim();
formatted = formatted.substring(0, 100);
    
    return formatted || 'Voice Channel';
}

function generateCaseId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
}