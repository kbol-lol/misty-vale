// dashboardSearch.js
// Shared "Search" feature for admin dashboards.
//
// A dashboard adds a Search button (createSearchButton). When it is pressed the
// dashboard calls openDashboardSearch(), which asks for a search term in a modal
// and replies (ephemeral) with every matching setting / item of that dashboard.
// If the dashboard passes onPick, the results also get a "jump to" menu that
// opens the chosen setting directly.
//
// Entries are plain objects:
//   { title, description?, location?, keywords?: string[], action?: string }
// `action` is handed back to onPick; entries without an action are info-only.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { getColor } from '../config/bot.js';
import { logger } from './logger.js';

/** Custom IDs created by this helper start with this prefix (no ':' so global handlers ignore them). */
export const SEARCH_ID_PREFIX = 'dsearch_';

const MAX_LISTED = 10;
const MAX_PICKS = 25;
const MODAL_TIMEOUT_MS = 300_000;
const PICK_TIMEOUT_MS = 300_000;

const TEXT = {
    en: {
        button: 'Search',
        modalTitle: (name) => `Search: ${name}`,
        inputLabel: 'What are you looking for?',
        placeholder: 'e.g. channel, role, message, a name...',
        resultsTitle: (name) => `🔍 Search — ${name}`,
        resultsFor: (q) => `Results for ${q}:`,
        partial: 'No result matched every word, so partial matches are shown.',
        none: (q) => `Nothing matched ${q}.`,
        tryOther: 'Try a shorter or different word.',
        footer: (n, total, pickable) => `${n === total ? `${total}` : `${n} of ${total}`} result${total === 1 ? '' : 's'}`
            + (pickable ? ' · pick one below to open it' : ''),
        pickPlaceholder: 'Open a result...',
        pickFailed: 'That result could not be opened. Please use the dashboard directly.',
    },
    de: {
        button: 'Suchen',
        modalTitle: (name) => `Suche: ${name}`,
        inputLabel: 'Wonach suchst du?',
        placeholder: 'z. B. Kanal, Rolle, Nachricht, Name...',
        resultsTitle: (name) => `🔍 Suche — ${name}`,
        resultsFor: (q) => `Ergebnisse für ${q}:`,
        partial: 'Kein Ergebnis enthielt alle Wörter, daher werden Teiltreffer angezeigt.',
        none: (q) => `Keine Treffer für ${q}.`,
        tryOther: 'Versuche ein kürzeres oder anderes Wort.',
        footer: (n, total, pickable) => `${n === total ? `${total}` : `${n} von ${total}`} Treffer`
            + (pickable ? ' · unten einen Treffer öffnen' : ''),
        pickPlaceholder: 'Treffer öffnen...',
        pickFailed: 'Dieser Treffer konnte nicht geöffnet werden. Bitte nutze das Dashboard direkt.',
    },
};

function texts(locale) {
    return TEXT[locale] || TEXT.en;
}

// ---------------------------------------------------------------- matching (pure)

/** Lower-case, strip accents and symbols so "Level-Up!" matches "level up". */
export function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function scoreTerm(term, title, rest) {
    if (title === term) return 12;
    if (title.startsWith(term)) return 8;
    if (` ${title}`.includes(` ${term}`)) return 6;
    if (title.includes(term)) return 4;
    if (` ${rest}`.includes(` ${term}`)) return 2;
    if (rest.includes(term)) return 1;
    return 0;
}

/**
 * Rank entries against a query. Every word must match (title, description, location
 * or keywords). If nothing matches every word, entries matching some words are returned
 * and `exact` is false.
 * @returns {{ results: object[], exact: boolean }}
 */
export function searchEntries(entries, query, { limit = 50 } = {}) {
    const terms = [...new Set(normalizeSearchText(query).split(' ').filter(Boolean))];
    if (!terms.length || !Array.isArray(entries)) return { results: [], exact: true };

    const scored = [];
    entries.forEach((entry, index) => {
        if (!entry?.title) return;
        const title = normalizeSearchText(entry.title);
        const rest = normalizeSearchText([
            entry.description,
            entry.location,
            ...(Array.isArray(entry.keywords) ? entry.keywords : []),
        ].filter(Boolean).join(' '));

        let score = 0;
        let matched = 0;
        for (const term of terms) {
            const s = scoreTerm(term, title, rest);
            if (s > 0) {
                matched++;
                score += s;
            }
        }
        if (matched) scored.push({ entry, score, matched, index });
    });

    const full = scored.filter((s) => s.matched === terms.length);
    const exact = full.length > 0 || scored.length === 0;
    const pool = full.length ? full : scored;
    pool.sort((a, b) => b.matched - a.matched || b.score - a.score || a.index - b.index);
    return { results: pool.slice(0, limit).map((s) => s.entry), exact };
}

function quoteQuery(query) {
    return `\`${String(query).replace(/`/g, 'ˋ').slice(0, 100)}\``;
}

function clip(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Build the ephemeral results message (pure; exported for tests).
 */
export function buildSearchResultsPayload({ dashboardName, query, results, exact, pickId = null, locale = 'en' }) {
    const t = texts(locale);
    const listed = results.slice(0, MAX_LISTED);

    const lines = listed.map((entry, i) => {
        const head = `**${i + 1}. ${clip(entry.title, 120)}**`;
        const desc = entry.description ? ` — ${clip(entry.description, 200)}` : '';
        const where = entry.location ? `\n-# ↳ ${clip(entry.location, 150)}` : '';
        return `${head}${desc}${where}`;
    });

    let description;
    if (!results.length) {
        description = `${t.none(quoteQuery(query))}\n${t.tryOther}`;
    } else {
        description = [
            t.resultsFor(quoteQuery(query)),
            exact ? null : `-# ${t.partial}`,
            '',
            ...lines,
        ].filter((line) => line !== null).join('\n');
    }

    // one select option per distinct action
    const seen = new Set();
    const pickable = [];
    for (const entry of results) {
        if (!entry.action || seen.has(entry.action) || String(entry.action).length > 100) continue;
        seen.add(entry.action);
        pickable.push(entry);
        if (pickable.length >= MAX_PICKS) break;
    }

    const embed = new EmbedBuilder()
        .setTitle(clip(t.resultsTitle(dashboardName), 256))
        .setDescription(clip(description, 4000))
        .setColor(results.length ? getColor('info') : getColor('warning'));
    if (results.length) embed.setFooter({ text: t.footer(listed.length, results.length, Boolean(pickId && pickable.length)) });

    const components = [];
    if (pickId && pickable.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(pickId)
                .setPlaceholder(t.pickPlaceholder)
                .addOptions(pickable.map((entry) => {
                    const option = {
                        label: clip(entry.title, 100),
                        value: String(entry.action),
                    };
                    const desc = entry.location || entry.description;
                    if (desc) option.description = clip(desc, 100);
                    return option;
                })),
        ));
    }

    return { payload: { embeds: [embed], components, allowedMentions: { parse: [] } }, pickable };
}

// ---------------------------------------------------------------- discord flow

/** The 🔍 Search button used by every dashboard. */
export function createSearchButton(customId, { label, locale = 'en', disabled = false } = {}) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label || texts(locale).button)
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
}

/**
 * Ask for a search term and show the matching entries.
 *
 * @param {import('discord.js').MessageComponentInteraction} interaction  un-acknowledged button/select interaction
 * @param {object} options
 * @param {string} options.dashboardName
 * @param {(query:string) => Promise<object[]>|object[]} options.getEntries
 * @param {(pick:import('discord.js').StringSelectMenuInteraction, action:string, entry:object) => Promise<{keepComponents?:boolean}|void>} [options.onPick]
 * @param {'en'|'de'} [options.locale]
 * @param {string} [options.placeholder]
 */
export async function openDashboardSearch(interaction, {
    dashboardName,
    getEntries,
    onPick = null,
    locale = 'en',
    placeholder,
}) {
    const t = texts(locale);
    const modalId = `${SEARCH_ID_PREFIX}modal_${interaction.id}`;
    const pickId = `${SEARCH_ID_PREFIX}pick_${interaction.id}`;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(clip(t.modalTitle(dashboardName), 45))
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('query')
                .setLabel(t.inputLabel)
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(100)
                .setRequired(true)
                .setPlaceholder(clip(placeholder || t.placeholder, 100)),
        ));

    await interaction.showModal(modal);
    const submitted = await interaction.awaitModalSubmit({
        filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
        time: MODAL_TIMEOUT_MS,
    }).catch(() => null);
    if (!submitted) return null;

    const query = submitted.fields.getTextInputValue('query').trim();
    await submitted.deferReply({ flags: MessageFlags.Ephemeral });

    let entries = [];
    try {
        entries = (await getEntries(query)) || [];
    } catch (error) {
        logger.warn(`[DashboardSearch] Could not collect entries for ${dashboardName}: ${error.message}`);
    }

    const { results, exact } = searchEntries(entries, query);
    const { payload, pickable } = buildSearchResultsPayload({
        dashboardName,
        query,
        results,
        exact,
        pickId: onPick ? pickId : null,
        locale,
    });

    const message = await submitted.editReply(payload);
    if (!onPick || !pickable.length || !message?.createMessageComponentCollector) {
        return { query, results };
    }

    let keepComponents = false;
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === pickId && i.user.id === interaction.user.id,
        time: PICK_TIMEOUT_MS,
    });

    collector.on('collect', async (pick) => {
        const entry = pickable.find((e) => String(e.action) === pick.values[0]);
        if (!entry) {
            await pick.deferUpdate().catch(() => {});
            return;
        }
        try {
            const outcome = await onPick(pick, entry.action, entry);
            if (outcome?.keepComponents) {
                // the results message was turned into a live dashboard view; leave it alone
                keepComponents = true;
                collector.stop('handed_off');
            }
            if (!pick.replied && !pick.deferred) await pick.deferUpdate().catch(() => {});
        } catch (error) {
            logger.error(`[DashboardSearch] Opening "${entry.action}" in ${dashboardName} failed:`, error);
            if (!pick.replied && !pick.deferred) await pick.deferUpdate().catch(() => {});
            await pick.followUp({ content: t.pickFailed, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    });

    collector.on('end', () => {
        if (keepComponents) return;
        submitted.editReply({ components: [] }).catch(() => {});
    });

    return { query, results };
}
