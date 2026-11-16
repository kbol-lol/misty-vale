import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { verifyUser } from '../src/services/verificationService.js';

test('verification assigns the verified role and removes the configured role', async () => {
    const roleIds = new Set(['unverified-role']);
    const removedRoles = [];
    const member = {
        id: 'user-id',
        roles: {
            cache: roleIds,
            add: async roleId => roleIds.add(roleId),
            remove: async roleId => {
                removedRoles.push(roleId);
                roleIds.delete(roleId);
            },
        },
    };
    const verifiedRole = { id: 'verified-role', name: 'Member', position: 1 };
    const unverifiedRole = { id: 'unverified-role', position: 2 };
    const botMember = {
        permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
        roles: { highest: { position: 10 } },
    };
    const guild = {
        id: 'guild-id',
        members: {
            me: botMember,
            fetch: async () => member,
        },
        roles: { cache: new Map([
            [verifiedRole.id, verifiedRole],
            [unverifiedRole.id, unverifiedRole],
        ]) },
        channels: { cache: new Map() },
    };
    const client = { guilds: { cache: new Map([[guild.id, guild]]) } };

    const result = await verifyUser(client, guild.id, member.id, {
        loadGuildConfig: async () => ({
            verification: {
                enabled: true,
                roleId: verifiedRole.id,
                removeRoleId: unverifiedRole.id,
            },
        }),
        recordAction: () => {},
    });

    assert.equal(result.status, 'verified');
    assert.ok(roleIds.has(verifiedRole.id));
    assert.equal(roleIds.has(unverifiedRole.id), false);
    assert.deepEqual(removedRoles, [unverifiedRole.id]);
});
