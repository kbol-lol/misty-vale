// levelMath.js
// Pure, dependency-free helpers for the leveling system (XP curve, role diffing,
// Arcane message parsing, import parsing). Kept separate so it can be unit tested.

export const MAX_LEVEL = 1000;
export const MAX_REWARDS = 25;

export const DEFAULT_ROLE_TIERS = [
    { level: 1, name: 'Awakened' },
    { level: 5, name: 'Wanderer' },
    { level: 10, name: 'Familiar' },
    { level: 15, name: 'Connected' },
    { level: 25, name: 'Established' },
    { level: 35, name: 'Ascendant' },
    { level: 45, name: 'Eternal' },
];

export const LEVELING_DEFAULTS = {
    enabled: true,
    xpMin: 15,
    xpMax: 25,
    xpMultiplier: 1,
    cooldownSeconds: 60,
    announce: {
        mode: 'same', // 'same' | 'channel' | 'off'
        channelId: null,
        message: '{user} is now level **{level}**!',
        useEmbed: false,
        title: 'Level Up!',
        color: '#5865F2',
        imageUrl: null, // default image shown with every level-up message
        levelImages: [], // [{ level, url }] - image for a level (used from that level until the next entry)
    },
    autoApplyRoles: true,
    roleRewards: [], // [{ level, roleId }]
    ignoredChannels: [],
    ignoredRoles: [],
};

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

export function clampLevel(level) {
    return Math.floor(clampNumber(level, 0, MAX_LEVEL, 0));
}

// ---------- XP curve (xp needed to go from level L to L+1 = 5L^2 + 50L + 100) ----------

export function xpToNextLevel(level) {
    const l = clampLevel(level);
    return 5 * l * l + 50 * l + 100;
}

export function totalXpForLevel(level) {
    const L = clampLevel(level);
    if (L <= 0) return 0;
    const sumSquares = ((L - 1) * L * (2 * L - 1)) / 6;
    const sumLinear = (L * (L - 1)) / 2;
    return Math.round(5 * sumSquares + 50 * sumLinear + 100 * L);
}

export function levelFromTotalXp(xp) {
    const total = Math.max(0, Number(xp) || 0);
    let lo = 0;
    let hi = MAX_LEVEL;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (totalXpForLevel(mid) <= total) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

export function getLevelProgress(totalXp) {
    const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
    const level = levelFromTotalXp(xp);
    return {
        level,
        totalXp: xp,
        currentXp: xp - totalXpForLevel(level),
        neededXp: level >= MAX_LEVEL ? 0 : xpToNextLevel(level),
    };
}

// ---------- Config normalisation ----------

export function normalizeRewards(rewards) {
    const byRole = new Map();
    for (const entry of Array.isArray(rewards) ? rewards : []) {
        const level = Math.floor(Number(entry?.level));
        const roleId = String(entry?.roleId || '');
        if (!Number.isFinite(level) || level < 1 || level > MAX_LEVEL || !/^\d{15,25}$/.test(roleId)) continue;
        byRole.set(roleId, { level, roleId });
    }
    // one role per level: the later entry wins
    const byLevel = new Map();
    for (const entry of byRole.values()) byLevel.set(entry.level, entry);
    return [...byLevel.values()].sort((a, b) => a.level - b.level).slice(0, MAX_REWARDS);
}

function idList(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(String).filter((id) => /^\d{15,25}$/.test(id)))];
}

export const MAX_LEVEL_IMAGES = 25;

/** Only plain https image links are accepted (max 500 chars). Returns null if invalid. */
export function sanitizeImageUrl(value) {
    const text = String(value ?? '').trim();
    if (!text || text.length > 500) return null;
    try {
        const url = new URL(text);
        return url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

export function normalizeLevelImages(list) {
    const byLevel = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
        const level = Math.floor(Number(entry?.level));
        const url = sanitizeImageUrl(entry?.url);
        if (!Number.isFinite(level) || level < 1 || level > MAX_LEVEL || !url) continue;
        byLevel.set(level, { level, url });
    }
    return [...byLevel.values()].sort((a, b) => a.level - b.level).slice(0, MAX_LEVEL_IMAGES);
}

function normalizeColor(value, fallback) {
    const text = String(value ?? '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : fallback;
}

export function normalizeLevelingConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const d = LEVELING_DEFAULTS;

    const xpMin = Math.round(clampNumber(src.xpMin, 1, 1000, d.xpMin));
    const xpMax = Math.max(xpMin, Math.round(clampNumber(src.xpMax, 1, 1000, d.xpMax)));
    const announceSrc = src.announce && typeof src.announce === 'object' ? src.announce : {};
    const mode = ['same', 'channel', 'off'].includes(announceSrc.mode) ? announceSrc.mode : d.announce.mode;
    const message = typeof announceSrc.message === 'string' && announceSrc.message.trim()
        ? announceSrc.message.slice(0, 500)
        : d.announce.message;

    return {
        enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
        xpMin,
        xpMax,
        xpMultiplier: Math.round(clampNumber(src.xpMultiplier, 0.1, 50, d.xpMultiplier) * 100) / 100,
        cooldownSeconds: Math.round(clampNumber(src.cooldownSeconds, 0, 3600, d.cooldownSeconds)),
        announce: {
            mode,
            channelId: /^\d{15,25}$/.test(String(announceSrc.channelId || '')) ? String(announceSrc.channelId) : null,
            message,
            useEmbed: announceSrc.useEmbed === undefined ? d.announce.useEmbed : Boolean(announceSrc.useEmbed),
            title: typeof announceSrc.title === 'string' ? announceSrc.title.slice(0, 100) : d.announce.title,
            color: normalizeColor(announceSrc.color, d.announce.color),
            imageUrl: sanitizeImageUrl(announceSrc.imageUrl),
            levelImages: normalizeLevelImages(announceSrc.levelImages),
        },
        autoApplyRoles: src.autoApplyRoles === undefined ? d.autoApplyRoles : Boolean(src.autoApplyRoles),
        roleRewards: normalizeRewards(src.roleRewards),
        ignoredChannels: idList(src.ignoredChannels),
        ignoredRoles: idList(src.ignoredRoles),
    };
}

// ---------- Role reward diffing ----------

/**
 * Work out which reward roles a member should gain / lose for a level.
 * A member only ever holds ONE level role: the highest one they have earned.
 * Every other configured level role is removed. Roles that are not configured
 * as level rewards are never touched.
 */
export function computeRoleChanges({ level, rewards, memberRoleIds }) {
    const owned = memberRoleIds instanceof Set ? memberRoleIds : new Set(memberRoleIds || []);
    const sorted = normalizeRewards(rewards);
    const earned = sorted.filter((r) => r.level <= level);

    const shouldHave = earned.length ? [earned[earned.length - 1].roleId] : [];
    const shouldHaveSet = new Set(shouldHave);

    return {
        shouldHave,
        toAdd: shouldHave.filter((id) => !owned.has(id)),
        toRemove: sorted.map((r) => r.roleId).filter((id) => !shouldHaveSet.has(id) && owned.has(id)),
    };
}

// ---------- Default tier matching ----------

function normalizeRoleName(name) {
    return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Match guild roles to the default tier names by name (emoji and symbols ignored).
 * @param {{id:string,name:string}[]} roles
 */
export function matchTierRoles(roles, tiers = DEFAULT_ROLE_TIERS) {
    const candidates = roles.map((r) => ({ id: r.id, norm: normalizeRoleName(r.name) }));
    const matched = [];
    const missing = [];
    for (const tier of tiers) {
        const wanted = normalizeRoleName(tier.name);
        const hit = candidates.find((c) => c.norm === wanted)
            || candidates.find((c) => ` ${c.norm} `.includes(` ${wanted} `));
        if (hit) matched.push({ level: tier.level, roleId: hit.id });
        else missing.push(tier);
    }
    return { matched, missing };
}

// ---------- Arcane message parsing ----------

const ARCANE_LEVEL_REGEX = /(?:is\s+now|has\s+reached|reached|advanced\s+to)\s+level\s+\**\s*(\d{1,4})/i;

/**
 * Parse an Arcane level-up announcement such as "@User is now level 10".
 * @returns {{userId:string, level:number}|null}
 */
export function parseArcaneLevelUp({ text, mentionedUserIds = [] }) {
    const body = String(text || '');
    const levelMatch = body.match(ARCANE_LEVEL_REGEX);
    if (!levelMatch) return null;

    const level = Number(levelMatch[1]);
    if (!Number.isFinite(level) || level < 0 || level > MAX_LEVEL) return null;

    const userId = mentionedUserIds[0] || body.match(/<@!?(\d{15,25})>/)?.[1];
    if (!userId) return null;
    return { userId: String(userId), level };
}

// ---------- Import file parsing ----------

/**
 * Parse an import file. Accepts JSON (array or {id: level|{level,xp}}) or
 * CSV/TSV/space separated lines: userId,level[,xp]
 */
export function parseLevelImportText(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '').trim();
    const entries = [];
    const errors = [];
    const isId = (v) => /^\d{15,25}$/.test(String(v));
    const push = (userId, level, xp, source) => {
        const lvl = Math.floor(Number(level));
        if (!isId(userId) || !Number.isFinite(lvl) || lvl < 0 || lvl > MAX_LEVEL) {
            errors.push(source);
            return;
        }
        const entry = { userId: String(userId), level: lvl };
        if (xp !== undefined && xp !== null && xp !== '' && Number.isFinite(Number(xp))) entry.xp = Math.max(0, Math.floor(Number(xp)));
        entries.push(entry);
    };

    if (text.startsWith('[') || text.startsWith('{')) {
        try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
                data.forEach((row, i) => push(row?.userId ?? row?.user_id ?? row?.id, row?.level, row?.xp, `item ${i + 1}`));
            } else if (data && typeof data === 'object') {
                for (const [id, value] of Object.entries(data)) {
                    if (value && typeof value === 'object') push(id, value.level, value.xp, id);
                    else push(id, value, undefined, id);
                }
            }
            return { entries, errors };
        } catch {
            // fall through to line parsing
        }
    }

    text.split(/\r?\n/).forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const parts = trimmed.split(/[\s,;\t]+/).map((p) => p.replace(/^["']|["']$/g, ''));
        if (i === 0 && !isId(parts[0])) return; // header row
        push(parts[0], parts[1], parts[2], `line ${i + 1}`);
    });

    return { entries, errors };
}

/** The image for a level: the entry with the highest level <= `level`, else the default image. */
export function pickLevelImage(announce, level) {
    const match = [...(announce?.levelImages || [])].filter((i) => i.level <= level).pop();
    return match?.url || announce?.imageUrl || null;
}

/**
 * Build the level-up message (plain object, ready for channel.send).
 * Plain text by default, optional embed with title, colour and image.
 */
export function buildLevelUpPayload(announce, { userId, username, level, serverName }) {
    const text = renderTemplate(announce.message, {
        user: `<@${userId}>`,
        username,
        level: String(level),
        server: serverName,
    });
    const image = pickLevelImage(announce, level);
    const allowedMentions = { users: [userId] };

    if (announce.useEmbed) {
        const embed = {
            description: text.slice(0, 4000),
            color: parseInt(String(announce.color || '#5865F2').replace('#', ''), 16),
        };
        const title = renderTemplate(announce.title, { user: username, username, level: String(level), server: serverName }).trim();
        if (title) embed.title = title.slice(0, 256);
        if (image) embed.image = { url: image };
        // mentions inside embeds do not ping, so the ping goes in the message content
        return { content: `<@${userId}>`, embeds: [embed], allowedMentions };
    }

    const payload = { content: text.slice(0, 2000), allowedMentions };
    if (image) payload.embeds = [{ image: { url: image }, color: parseInt(String(announce.color || '#5865F2').replace('#', ''), 16) }];
    return payload;
}

export function renderTemplate(template, values) {
    return String(template || '').replace(/\{(user|username|level|server|role)\}/g, (_, key) => values[key] ?? '');
}
