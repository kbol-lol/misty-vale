import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCommands } from '../src/handlers/loaders/commandLoader.js';

function createClient(registeredGuildCommands = []) {
    const calls = [];
    const commandData = {
        name: 'honeypot',
        description: 'Configure the server honeypot',
        options: [{ type: 1, name: 'dashboard', description: 'Open the settings dashboard' }],
    };
    const client = {
        commands: new Map([['honeypot', {
            category: 'Moderation',
            data: { name: 'honeypot', toJSON: () => commandData },
        }]]),
        guilds: { cache: { values: () => [] } },
        rest: {
            put: async (route, options) => calls.push({ method: 'put', route, options }),
            get: async route => {
                calls.push({ method: 'get', route });
                return registeredGuildCommands;
            },
            post: async (route, options) => calls.push({ method: 'post', route, options }),
            patch: async (route, options) => calls.push({ method: 'patch', route, options }),
        },
    };
    return { client, calls, commandData };
}

test('registers honeypot immediately for its target guild without replacing other guild commands', async () => {
    const { client, calls, commandData } = createClient([
        { id: 'existing-id', name: 'moderation', type: 1 },
    ]);

    await registerCommands(client, {
        clientId: 'application-id',
        honeypotGuildId: 'target-guild-id',
    });

    assert.ok(calls.some(call =>
        call.method === 'put' && call.route === '/applications/application-id/commands',
    ));
    assert.ok(calls.some(call =>
        call.method === 'post'
        && call.route === '/applications/application-id/guilds/target-guild-id/commands'
        && call.options.body === commandData,
    ));
    assert.equal(calls.some(call => call.method === 'patch'), false);
});

test('updates an existing guild honeypot command instead of creating a duplicate', async () => {
    const { client, calls, commandData } = createClient([
        { id: 'existing-honeypot-id', name: 'honeypot', type: 1 },
    ]);

    await registerCommands(client, {
        clientId: 'application-id',
        honeypotGuildId: 'target-guild-id',
    });

    assert.ok(calls.some(call =>
        call.method === 'patch'
        && call.route === '/applications/application-id/guilds/target-guild-id/commands/existing-honeypot-id'
        && call.options.body === commandData,
    ));
    assert.equal(calls.some(call => call.method === 'post'), false);
});
