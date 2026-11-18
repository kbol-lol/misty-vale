// levelingService.js
// Message-based XP, levels, level-reward roles, imports and Arcane migration.
// Storage uses client.db with its own key namespace (no changes to the shared key registry).

import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import {
    LEVELING_DEFAULTS,
    MAX_LEVEL,
    clampLevel,
    computeRoleChanges,
    getLevelProgress,
    levelFromTotalXp,
    normalizeLevelingConfig,
    normalizeRewards,
    parseArcaneLevelUp,
    buildLevelUpPayload,
    totalXpForLevel,
} from '../utils/levelMath.js';

export const getLevelingConfigKey = (guildId) => `guild:${guildId}:leveling:config`;
export const getLevelingUserKey = (guildId, userId) => `guild:${guildId}:leveling:user:${userId}`;
export const getLevelingUserPrefix = (guildId) => `guild:${guildId}:leveling:user:`;

const cooldowns = new Map(); // `${guildId}:${userId}` -> last xp timestamp (ms)
const configCache = new Map(); // guildId -> { config, expires }
const CONFIG_CACHE_MS = 15_000;

// ---------------------------------------------------------------- config

export async function getLevelingConfig(client, guildId) {
    const cached = configCache.get(guildId);
    if (cached && cached.expires > Date.now()) return cached.config;

    const raw = await client.db.get(getLevelingConfigKey(guildId), null);
    const config = normalizeLevelingConfig(raw ?? LEVELING_DEFAULTS);
    configCache.set(guildId, { config, expires: Date.now() + CONFIG_CACHE_MS });
    return config;
}

export async function updateLevelingConfig(client, guildId, patch) {
    return Mutex.runExclusive(`leveling-config:${guildId}`, async () => {
        const current = await getLevelingConfig(client, guildId);
        const merged = normalizeLevelingConfig({
            ...current,
            ...patch,
            announce: { ...current.announce, ...(patch.announce || {}) },
        });
        await client.db.set(getLevelingConfigKey(guildId), merged);
        configCache.set(guildId, { config: merged, expires: Date.now() + CONFIG_CACHE_MS });
        return merged;
    });
}

export async function setRoleReward(client, guildId, level, roleId) {
    return Mutex.runExclusive(`leveling-config:${guildId}`, async () => {
        const current = await getLevelingConfig(client, guildId);
        const rewards = current.roleRewards.filter((r) => r.level !== level && r.roleId !== roleId);
        rewards.push({ level, roleId });
        const merged = normalizeLevelingConfig({ ...current, roleRewards: normalizeRewards(rewards) });
        await client.db.set(getLevelingConfigKey(guildId), merged);
        configCache.set(guildId, { config: merged, expires: Date.now() + CONFIG_CACHE_MS });
        return merged;
    });
}

export async function removeRoleReward(client, guildId, level) {
    return Mutex.runExclusive(`leveling-config:${guildId}`, async () => {
        const current = await getLevelingConfig(client, guildId);
        const merged = normalizeLevelingConfig({
            ...current,
            roleRewards: current.roleRewards.filter((r) => r.level !== level),
        });
        await client.db.set(getLevelingConfigKey(guildId), merged);
        configCache.set(guildId, { config: merged, expires: Date.now() + CONFIG_CACHE_MS });
        return merged;
    });
}

export async function replaceRoleRewards(client, guildId, rewards) {
    return updateLevelingConfig(client, guildId, { roleRewards: normalizeRewards(rewards) });
}

// ---------------------------------------------------------------- user data

function normalizeUserData(raw) {
    const xp = Math.max(0, Math.floor(Number(raw?.xp) || 0));
    return {
        xp,
        level: levelFromTotalXp(xp),
        messages: Math.max(0, Math.floor(Number(raw?.messages) || 0)),
    };
}

export async function getUserLevelData(client, guildId, userId) {
    const raw = await client.db.get(getLevelingUserKey(guildId, userId), null);
    return normalizeUserData(raw);
}

export async function getUserLevelProgress(client, guildId, userId) {
    const data = await getUserLevelData(client, guildId, userId);
    return { ...getLevelProgress(data.xp), messages: data.messages };
}

async function writeUserData(client, guildId, userId, data) {
    await client.db.set(getLevelingUserKey(guildId, userId), {
        xp: data.xp,
        messages: data.messages ?? 0,
        updatedAt: Date.now(),
    });
}

export async function getLeaderboard(client, guildId, { limit = 10, offset = 0 } = {}) {
    const keys = await client.db.list(getLevelingUserPrefix(guildId));
    const rows = [];
    for (const key of keys) {
        const userId = key.split(':').pop();
        const data = normalizeUserData(await client.db.get(key, null));
        if (data.xp > 0) rows.push({ userId, ...data });
    }
    rows.sort((a, b) => b.xp - a.xp);
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

export async function getUserRank(client, guildId, userId) {
    const { rows } = await getLeaderboard(client, guildId, { limit: Number.MAX_SAFE_INTEGER });
    const index = rows.findIndex((r) => r.userId === userId);
    return index === -1 ? null : { rank: index + 1, total: rows.length };
}

// ---------------------------------------------------------------- roles

/**
 * Apply level reward roles for a member. Only roles configured as rewards are touched.
 * @returns {{added:string[], removed:string[], skipped:string[]}}
 */
export async function applyLevelRoles(guild, member, level, config) {
    const result = { added: [], removed: [], skipped: [] };
    if (!config.autoApplyRoles || !config.roleRewards.length) return result;

    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has('ManageRoles')) {
        logger.warn(`[Leveling] Missing Manage Roles permission in guild ${guild.id}`);
        return result;
    }

    const { toAdd, toRemove } = computeRoleChanges({
        level,
        rewards: config.roleRewards,
        memberRoleIds: new Set(member.roles.cache.keys()),
    });

    const assignable = async (roleId) => {
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (!role || role.managed || role.position >= me.roles.highest.position) {
            result.skipped.push(roleId);
            return null;
        }
        return role;
    };

    for (const roleId of toAdd) {
        const role = await assignable(roleId);
        if (!role) continue;
        try {
            await member.roles.add(role, `Level reward (level ${level})`);
            result.added.push(roleId);
        } catch (error) {
            result.skipped.push(roleId);
            logger.warn(`[Leveling] Could not add role ${roleId} to ${member.id}: ${error.message}`);
        }
    }

    for (const roleId of toRemove) {
        const role = await assignable(roleId);
        if (!role) continue;
        try {
            await member.roles.remove(role, `Level reward replaced (level ${level})`);
            result.removed.push(roleId);
        } catch (error) {
            result.skipped.push(roleId);
            logger.warn(`[Leveling] Could not remove role ${roleId} from ${member.id}: ${error.message}`);
        }
    }

    return result;
}

export async function syncMemberRoles(client, guild, member) {
    const config = await getLevelingConfig(client, guild.id);
    const data = await getUserLevelData(client, guild.id, member.id);
    if (data.xp <= 0) return { added: [], removed: [], skipped: [] };
    return applyLevelRoles(guild, member, data.level, config);
}

/**
 * Re-apply reward roles for every stored user (e.g. after changing rewards, or after an import).
 */
export async function syncAllRoles(client, guild, { onProgress } = {}) {
    const config = await getLevelingConfig(client, guild.id);
    const keys = await client.db.list(getLevelingUserPrefix(guild.id));
    const summary = { processed: 0, changed: 0, added: 0, removed: 0, skipped: 0, missingMembers: 0 };

    for (const key of keys) {
        const userId = key.split(':').pop();
        const data = normalizeUserData(await client.db.get(key, null));
        if (data.xp <= 0) continue;

        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        if (!member) {
            summary.missingMembers++;
            continue;
        }

        const res = await applyLevelRoles(guild, member, data.level, config);
        summary.processed++;
        summary.added += res.added.length;
        summary.removed += res.removed.length;
        summary.skipped += res.skipped.length;
        if (res.added.length || res.removed.length) summary.changed++;

        if (onProgress && summary.processed % 25 === 0) await onProgress(summary).catch(() => {});
        // be gentle with the rate limiter
        if (res.added.length || res.removed.length) await new Promise((r) => setTimeout(r, 250));
    }
    return summary;
}

// ---------------------------------------------------------------- level changes

/**
 * Set a user's level (xp is set to the start of that level) and apply roles.
 */
export async function setUserLevel(client, guild, userId, level, { applyRoles = true } = {}) {
    const target = clampLevel(level);
    return Mutex.runExclusive(`leveling-user:${guild.id}:${userId}`, async () => {
        const previous = await getUserLevelData(client, guild.id, userId);
        const xp = totalXpForLevel(target);
        await writeUserData(client, guild.id, userId, { xp, messages: previous.messages });

        let roles = { added: [], removed: [], skipped: [] };
        if (applyRoles) {
            const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
            if (member) {
                const config = await getLevelingConfig(client, guild.id);
                roles = await applyLevelRoles(guild, member, target, config);
            }
        }
        return { previousLevel: previous.level, level: target, xp, roles };
    });
}

export async function addUserXp(client, guild, userId, amount, { applyRoles = true } = {}) {
    return Mutex.runExclusive(`leveling-user:${guild.id}:${userId}`, async () => {
        const previous = await getUserLevelData(client, guild.id, userId);
        const xp = Math.max(0, previous.xp + Math.floor(amount));
        await writeUserData(client, guild.id, userId, { xp, messages: previous.messages });
        const level = levelFromTotalXp(xp);

        let roles = { added: [], removed: [], skipped: [] };
        if (applyRoles && level !== previous.level) {
            const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
            if (member) {
                const config = await getLevelingConfig(client, guild.id);
                roles = await applyLevelRoles(guild, member, level, config);
            }
        }
        return { previousLevel: previous.level, level, xp, roles };
    });
}

export async function resetUser(client, guildId, userId) {
    await client.db.delete(getLevelingUserKey(guildId, userId));
}

// ---------------------------------------------------------------- message XP

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function handleLevelingMessage(message, client) {
    const guild = message.guild;
    if (!guild || message.author.bot || message.webhookId) return null;

    const config = await getLevelingConfig(client, guild.id);
    if (!config.enabled) return null;
    if (config.ignoredChannels.includes(message.channelId)
        || (message.channel?.parentId && config.ignoredChannels.includes(message.channel.parentId))) return null;

    const member = message.member;
    if (member && config.ignoredRoles.some((id) => member.roles.cache.has(id))) return null;

    const cooldownKey = `${guild.id}:${message.author.id}`;
    const now = Date.now();
    const last = cooldowns.get(cooldownKey) || 0;
    if (now - last < config.cooldownSeconds * 1000) return null;
    cooldowns.set(cooldownKey, now);

    const gained = Math.max(1, Math.round(randomInt(config.xpMin, config.xpMax) * config.xpMultiplier));

    const outcome = await Mutex.runExclusive(`leveling-user:${guild.id}:${message.author.id}`, async () => {
        const previous = await getUserLevelData(client, guild.id, message.author.id);
        const xp = previous.xp + gained;
        const level = levelFromTotalXp(xp);
        await writeUserData(client, guild.id, message.author.id, { xp, messages: previous.messages + 1 });

        let roles = { added: [], removed: [], skipped: [] };
        if (level > previous.level && member) {
            roles = await applyLevelRoles(guild, member, level, config);
        }
        return { previousLevel: previous.level, level, xp, gained, roles };
    });

    if (outcome.level > outcome.previousLevel) {
        await announceLevelUp(message, config, outcome.level).catch((error) =>
            logger.debug(`[Leveling] Announce failed: ${error.message}`));
    }
    return outcome;
}

async function announceLevelUp(message, config, level) {
    if (config.announce.mode === 'off') return;

    const options = buildLevelUpPayload(config.announce, {
        userId: message.author.id,
        username: message.author.username,
        level,
        serverName: message.guild.name,
    });

    if (config.announce.mode === 'channel' && config.announce.channelId) {
        const channel = message.guild.channels.cache.get(config.announce.channelId)
            || await message.guild.channels.fetch(config.announce.channelId).catch(() => null);
        if (channel?.isTextBased()) {
            await channel.send(options);
            return;
        }
    }
    await message.channel.send(options);
}

// ---------------------------------------------------------------- imports / Arcane migration

/**
 * Bulk set levels. mode 'max' only raises levels (safe to re-run), 'overwrite' sets exactly.
 */
export async function importLevels(client, guild, entries, { mode = 'max', applyRoles = true, onProgress } = {}) {
    const summary = { imported: 0, raised: 0, unchanged: 0, lowered: 0, roleChanges: 0 };
    const config = applyRoles ? await getLevelingConfig(client, guild.id) : null;

    let index = 0;
    for (const entry of entries) {
        index++;
        await Mutex.runExclusive(`leveling-user:${guild.id}:${entry.userId}`, async () => {
            const previous = await getUserLevelData(client, guild.id, entry.userId);
            const targetXp = entry.xp !== undefined
                ? Math.max(entry.xp, totalXpForLevel(entry.level))
                : totalXpForLevel(entry.level);

            let nextXp = targetXp;
            if (mode === 'max' && previous.xp >= targetXp) {
                summary.unchanged++;
                nextXp = previous.xp;
            } else if (targetXp > previous.xp) {
                summary.raised++;
            } else if (targetXp < previous.xp) {
                summary.lowered++;
            } else {
                summary.unchanged++;
            }

            if (nextXp !== previous.xp || previous.xp === 0) {
                await writeUserData(client, guild.id, entry.userId, { xp: nextXp, messages: previous.messages });
            }
            summary.imported++;

            if (applyRoles && config) {
                const member = guild.members.cache.get(entry.userId)
                    || await guild.members.fetch(entry.userId).catch(() => null);
                if (member) {
                    const res = await applyLevelRoles(guild, member, levelFromTotalXp(nextXp), config);
                    if (res.added.length || res.removed.length) {
                        summary.roleChanges++;
                        await new Promise((r) => setTimeout(r, 250));
                    }
                }
            }
        });
        if (onProgress && index % 25 === 0) await onProgress({ ...summary, total: entries.length, done: index }).catch(() => {});
    }
    return summary;
}

/**
 * Read a channel's history and collect the highest level announced for each user
 * by Arcane (or any message in the same "@user is now level N" format).
 */
export async function scanArcaneAnnouncements(channel, { authorId = null, maxMessages = 50_000, onProgress } = {}) {
    const highest = new Map(); // userId -> level
    let before;
    let scanned = 0;
    let matched = 0;

    while (scanned < maxMessages) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;

        for (const msg of batch.values()) {
            scanned++;
            if (!msg.author.bot) continue;
            if (authorId && msg.author.id !== authorId) continue;

            const embedText = msg.embeds?.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ') || '';
            const parsed = parseArcaneLevelUp({
                text: `${msg.content || ''} ${embedText}`,
                mentionedUserIds: [...msg.mentions.users.keys()],
            });
            if (!parsed) continue;

            matched++;
            if ((highest.get(parsed.userId) ?? -1) < parsed.level) highest.set(parsed.userId, parsed.level);
        }

        before = batch.last().id;
        if (onProgress && scanned % 500 < 100) await onProgress({ scanned, matched, users: highest.size }).catch(() => {});
        if (batch.size < 100) break;
    }

    return {
        scanned,
        matched,
        entries: [...highest.entries()].map(([userId, level]) => ({ userId, level })),
    };
}

export { MAX_LEVEL };
