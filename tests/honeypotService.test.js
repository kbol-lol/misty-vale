import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
    formatHoneypotMessage,
    isHoneypotExempt,
    performHoneypotAction,
} from '../src/services/honeypotService.js';

test('honeypot DM templates replace supported placeholders and cap message length', () => {
    assert.equal(
        formatHoneypotMessage('{user} was {action} in {server}', {
            user: 'Ada',
            action: 'gekickt',
            server: 'Misty Vale',
        }),
        'Ada was gekickt in Misty Vale',
    );
    assert.equal(formatHoneypotMessage('x'.repeat(2100), {}).length, 2000);
});

test('honeypot exempts server owners, administrators, and server managers independently', () => {
    const guild = { ownerId: 'owner' };
    const member = (id, permissions) => ({
        id,
        permissions: new PermissionsBitField(permissions),
    });

    assert.equal(isHoneypotExempt(member('owner', []), guild), true);
    assert.equal(isHoneypotExempt(member('admin', [PermissionFlagsBits.Administrator]), guild), true);
    assert.equal(isHoneypotExempt(member('manager', [PermissionFlagsBits.ManageGuild]), guild), true);
    assert.equal(isHoneypotExempt(member('user', []), guild), false);
});

test('honeypot timeout uses configured duration and sends the configured DM', async () => {
    const sentMessages = [];
    const moderationCalls = [];
    const botMember = { permissions: new PermissionsBitField([PermissionFlagsBits.ModerateMembers]) };
    const guild = {
        id: 'guild-id',
        name: 'Misty Vale',
        members: { me: botMember },
        channels: { cache: { get: () => ({ name: 'honeypot' }) } },
    };
    const member = {
        id: 'user-id',
        user: {
            username: 'Ada',
            send: async payload => sentMessages.push(payload),
        },
        guild,
        moderatable: true,
    };

    const result = await performHoneypotAction({
        guild,
        member,
        settings: {
            action: 'timeout',
            channelId: 'channel-id',
            timeoutMinutes: 30,
            dmEnabled: true,
            dmMessage: 'Hello {user}, action: {action} in {server}.',
        },
        moderationService: {
            timeoutUser: async details => moderationCalls.push(details),
        },
    });

    assert.equal(result, true);
    assert.equal(sentMessages[0].content, 'Hello Ada, action: stummgeschaltet in Misty Vale.');
    assert.equal(moderationCalls[0].durationMs, 30 * 60_000);
});

test('honeypot leaves the user without a DM when DMs are disabled', async () => {
    let dmSent = false;
    const botMember = { permissions: new PermissionsBitField([PermissionFlagsBits.KickMembers]) };
    const guild = {
        id: 'guild-id',
        name: 'Misty Vale',
        members: { me: botMember },
        channels: { cache: { get: () => null } },
    };
    const member = {
        id: 'user-id',
        user: { username: 'Ada', send: async () => { dmSent = true; } },
        guild,
        kickable: true,
    };

    await performHoneypotAction({
        guild,
        member,
        settings: {
            action: 'kick',
            channelId: 'channel-id',
            dmEnabled: false,
            dmMessage: 'No DM',
        },
        moderationService: { kickUser: async () => {} },
    });

    assert.equal(dmSent, false);
});
