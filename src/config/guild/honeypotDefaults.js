export const MAX_HONEYPOT_TIMEOUT_MINUTES = 28 * 24 * 60;

export const DEFAULT_HONEYPOT_SETTINGS = Object.freeze({
    enabled: false,
    channelId: null,
    action: 'ban',
    timeoutMinutes: 60,
    dmEnabled: false,
    dmMessage: 'Du wurdest auf {server} wegen einer Nachricht im Honeypot-Kanal sanktioniert.',
});
