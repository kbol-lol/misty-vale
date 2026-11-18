// dashboardLocale.js
// Dashboards are shown in German to users whose Discord client language is German,
// and in English to everyone else.

/** @returns {'de'|'en'} */
export function getDashboardLocale(interaction) {
    const locale = String(interaction?.locale ?? '').toLowerCase();
    return locale.startsWith('de') ? 'de' : 'en';
}

/** Pick the English or German text for a locale. */
export function tr(locale, en, de) {
    return locale === 'de' ? de : en;
}
